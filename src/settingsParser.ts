import fs from 'fs'
import { getDeviceSchema } from './config.js'
import { createModuleLogger } from '@companion-module/base'
import {
	CMD_BUS_SET,
	CMD_CHANNEL,
	CMD_DEV_SPEC,
	CMD_GET_ALL_SETTINGS,
	CMD_MIC_PRE_BUS,
	CMD_SETTINGS_PUSH,
	toHex,
	bytesToHex,
	formatRgbColor,
	modelDistance,
} from './types.js'

const logger = createModuleLogger('SettingsParser')

/* ---------------------------------------------------------
 *  TYPES
 * --------------------------------------------------------*/

export type ParsedSetting = {
	cmd_id: number
	id: number
	busCh?: number // Optional: only present for commands with busCh (0x04, 0x12, 0x14)
	valueBytes: number[]
}

export type StActionOption = {
	id?: string
	label: string
	type: string
	default: unknown
	tooltip?: string
	choices?: Array<{ id: number; label: string }>
}

export type StAction = {
	cmd_id: number
	id: number
	name: string
	options: StActionOption[]
	busCh?: number // Fixed channel value for actions that don't have a channel option
}

export type StModelJson = {
	model: string
	sectioned?: boolean
	refreshAfterCommand?: boolean
	cmdSchema: StAction[]
}

/* ---------------------------------------------------------
 *  FORMAT HELPERS
 * --------------------------------------------------------*/

function getModelConfig(model: string): { sectioned: boolean; rgbIds: Set<number> } {
	const rgbIds = new Set<number>()
	let sectioned = false

	try {
		// Use centralized cache instead of reading from disk
		const json = getDeviceSchema(model)
		if (!json) {
			// If we can't load the schema, return defaults
			return { sectioned, rgbIds }
		}

		// Read sectioned property (default to false if not specified)
		sectioned = json.sectioned ?? false

		// Build RGB IDs set
		for (const action of json.cmdSchema || []) {
			const hasColorpicker = action.options?.some((opt: StActionOption) => opt.type === 'colorpicker')
			if (hasColorpicker) {
				// Add the base ID
				rgbIds.add(action.id)

				// If this action has idAdd choices, add all the offset IDs too
				const idAddOption = action.options?.find((opt: StActionOption) => opt.id === 'idAdd')
				if (idAddOption?.choices) {
					for (const choice of idAddOption.choices) {
						if (typeof choice.id === 'number') {
							rgbIds.add(action.id + choice.id)
						}
					}
				}
			}
		}
	} catch (_err) {
		// If we can't load the schema, return defaults
	}

	return { sectioned, rgbIds }
}

/* ---------------------------------------------------------
 *  FIND THE REAL 5A PAYLOAD INDEX
 * --------------------------------------------------------*/

function extractStPayloadIndex(buf: Buffer): number {
	const sigIndex = buf.indexOf(Buffer.from('Studio-T'))
	if (sigIndex < 0) throw new Error('No Studio-T signature in packet')

	const payloadIndex = sigIndex + 8
	if (buf[payloadIndex] !== 0x5a) {
		throw new Error(`Expected 0x5A after Studio-T, found ${buf[payloadIndex].toString(16)}`)
	}

	return payloadIndex
}

/* ---------------------------------------------------------
 *  FLAT PARSER
 * --------------------------------------------------------*/

function parseFlatIdValSequence(block: Buffer, rgbIds: Set<number> = new Set()): ParsedSetting[] {
	let p = 0
	const out: ParsedSetting[] = []

	while (p < block.length) {
		const id = block[p]
		if (p + 1 >= block.length) break

		// RGB case - check if this ID is a known colorpicker
		if (rgbIds.has(id) && p + 3 < block.length) {
			out.push({
				cmd_id: CMD_DEV_SPEC,
				id,
				valueBytes: [block[p + 1], block[p + 2], block[p + 3]],
			})
			p += 4
			continue
		}

		out.push({ cmd_id: CMD_DEV_SPEC, id, valueBytes: [block[p + 1]] })
		p += 2
	}

	return out
}

export function parseGetAllSettings_flat(buf: Buffer, model: string): ParsedSetting[] {
	const idx = extractStPayloadIndex(buf)
	const cmdId = buf[idx + 1] & 0x7f
	if (cmdId !== CMD_GET_ALL_SETTINGS && cmdId !== CMD_SETTINGS_PUSH) {
		throw new Error('Not a getAllSettings reply')
	}

	const blockLen = buf[idx + 2]
	const start = idx + 3
	const end = start + blockLen
	if (end > buf.length) throw new Error('Invalid block length')

	const { rgbIds } = getModelConfig(model)
	return parseFlatIdValSequence(buf.subarray(start, end), rgbIds)
}

/* ---------------------------------------------------------
 *  SECTIONED PARSER
 * --------------------------------------------------------*/

export function parseGetAllSettings_sectioned(buf: Buffer, model: string): ParsedSetting[] {
	const idx = extractStPayloadIndex(buf)
	const cmdId = buf[idx + 1] & 0x7f
	if (cmdId !== CMD_GET_ALL_SETTINGS && cmdId !== CMD_SETTINGS_PUSH) {
		throw new Error('Not a getAllSettings reply')
	}

	// CMD_GET_ALL_SETTINGS has a total-length byte at idx+2 before the sections; CMD_SETTINGS_PUSH does not.
	let p = cmdId === CMD_GET_ALL_SETTINGS ? idx + 3 : idx + 2
	const end = buf.length - 1
	const out: ParsedSetting[] = []

	// Get RGB IDs for this model
	const { rgbIds } = getModelConfig(model)

	// Command IDs that include a busCh byte in their section structure
	const commandsWithBusCh = [CMD_BUS_SET, CMD_MIC_PRE_BUS, CMD_CHANNEL]

	while (p + 2 < end) {
		const cmdLen = buf[p]
		const sectionCmdId = buf[p + 1]

		const sectionEnd = p + 1 + cmdLen
		if (sectionEnd > end) break

		// Check if this command includes a busCh byte
		const hasBusCh = commandsWithBusCh.includes(sectionCmdId)

		let busCh: number | undefined
		let dataLen: number
		let q: number

		if (hasBusCh) {
			// Structure: [cmdLen] [cmdId] [busCh] [dataLen] [id:val pairs]
			busCh = buf[p + 2]
			dataLen = buf[p + 3]
			q = p + 4 // Data starts after cmdLen, cmdId, busCh, dataLen
		} else {
			// Structure: [cmdLen] [cmdId] [dataLen] [id:val pairs]
			dataLen = buf[p + 2]
			q = p + 3 // Data starts after cmdLen, cmdId, dataLen
		}

		const qEnd = q + dataLen

		while (q + 1 < qEnd) {
			const id = buf[q]
			let valueBytes: number[]

			// Check if this ID is an RGB colorpicker (needs 3 bytes)
			if (rgbIds.has(id) && q + 3 < qEnd) {
				valueBytes = [buf[q + 1], buf[q + 2], buf[q + 3]]
				q += 4
			} else {
				valueBytes = [buf[q + 1]]
				q += 2
			}

			const setting: ParsedSetting = {
				cmd_id: sectionCmdId,
				id,
				valueBytes,
			}
			if (busCh !== undefined) {
				setting.busCh = busCh
			}
			out.push(setting)
		}

		p = sectionEnd
	}

	return out
}

/* ---------------------------------------------------------
 *  GENERIC SETTINGS RESPONSE PARSER (0x0a get-all + 0x0b unsolicited push)
 * --------------------------------------------------------*/

/**
 * Parses any full settings block regardless of whether the cmdId is 0x0a
 * (response to Get All Settings) or 0x0b (unsolicited push after a set).
 * Both use the same sectioned or flat block layout.
 */
export function parseSettingsResponse(model: string, buf: Buffer): ParsedSetting[] {
	const idx = extractStPayloadIndex(buf)
	const cmdId = buf[idx + 1] & 0x7f
	if (cmdId !== CMD_GET_ALL_SETTINGS && cmdId !== CMD_SETTINGS_PUSH) {
		throw new Error(`Not a settings block (cmdId=0x${cmdId.toString(16)})`)
	}
	const { sectioned } = getModelConfig(model)
	return sectioned ? parseGetAllSettings_sectioned(buf, model) : parseGetAllSettings_flat(buf, model)
}

/**
 * Formats a single parsed setting into a human-readable string using action
 * definitions from the device JSON. Falls back to hex IDs when unknown.
 */
export function formatParsedSetting(setting: ParsedSetting, actions: StAction[]): string {
	// Try exact match first
	let action = actions.find((a) => a.cmd_id === setting.cmd_id && a.id === setting.id)

	// If no exact match and id > base id, try to find action with idAdd option
	// This handles cases like CMD_HEADPHONE (0x05, e.g. Phones Routing) and
	// CMD_BUTTON_MODE (0x07, e.g. Buttons) where id 0-3 represents channels 1-4
	if (!action) {
		const baseAction = actions.find((a) => {
			if (a.cmd_id !== setting.cmd_id) return false
			// Check if this action has an idAdd option (indicating channel selection)
			const idAddOption = a.options?.find((opt) => opt.id === 'idAdd')
			if (!idAddOption?.choices) return false
			// Check if the setting.id offset matches one of the idAdd choice IDs
			const channelOffset = setting.id - a.id
			return idAddOption.choices.some((c) => c.id === channelOffset)
		})
		if (baseAction) {
			action = baseAction
		}
	}

	const cmdHex = toHex(setting.cmd_id)
	const idHex = toHex(setting.id)
	const valHex = bytesToHex(setting.valueBytes)
	const valDec =
		setting.valueBytes.length === 3
			? formatRgbColor(setting.valueBytes[0], setting.valueBytes[1], setting.valueBytes[2])
			: setting.valueBytes.length === 1
				? setting.valueBytes[0]
				: setting.valueBytes.join(',')

	// Build the prefix: cmd:0x12 ch:0 id:0x01 val:0x14 (ch only for commands with busCh)
	const busChStr = setting.busCh !== undefined ? ` ch:${setting.busCh}` : ''
	const prefix = `cmd:${cmdHex}${busChStr} id:${idHex} val:${valHex}`

	// If we have an action with a name and choice label, use it
	if (action) {
		let name = action.name

		// If setting has busCh, add channel info to name
		if (setting.busCh !== undefined) {
			name = `${name} Ch${setting.busCh + 1}`
		}
		// Otherwise, if this action has idAdd, include the idAdd label
		else {
			const idAddOption = action.options?.find((opt) => opt.id === 'idAdd')
			if (idAddOption?.choices) {
				const channelOffset = setting.id - action.id
				const idAddChoice = idAddOption.choices.find((c) => c.id === channelOffset)
				if (idAddChoice) {
					name = `${name} ${idAddChoice.label}`
				}
			}
		}

		// Look for the value option (not busCh or idAdd)
		const valueOption = action.options?.find((opt) => opt.id === 'value')
		if (valueOption?.choices && setting.valueBytes.length === 1) {
			const choice = valueOption.choices.find((c) => c.id === setting.valueBytes[0])
			if (choice) {
				return `${prefix} | ${name}: ${choice.label} (${valDec})`
			}
		}
		return `${prefix} | ${name}: ${valDec}`
	}

	// No action found - just show the raw values
	return `${prefix} | Unknown Setting`
}

/* ---------------------------------------------------------
 *  PARSER DISPATCH WITH AUTO-DETECTION
 * --------------------------------------------------------*/

/**
 * Parses getAllSettings response with automatic format detection.
 *
 * Strategy:
 * 1. If model has explicit "sectioned" property, use that
 * 2. Otherwise, try FLAT parser first (it's simpler)
 * 3. If FLAT returns 0 settings, try SECTIONED parser
 * 4. Use whichever parser returns more settings
 *
 * @returns {settings: ParsedSetting[], detectedSectioned: boolean | null}
 */
export function parseGetAllSettingsWithDetection(
	model: string,
	buf: Buffer,
): { settings: ParsedSetting[]; detectedSectioned: boolean | null } {
	const schema = getDeviceSchema(model)
	const declaredSectioned = schema?.sectioned

	// If explicitly declared in JSON, use that
	if (declaredSectioned !== undefined) {
		const settings = declaredSectioned
			? parseGetAllSettings_sectioned(buf, model)
			: parseGetAllSettings_flat(buf, model)
		return { settings, detectedSectioned: null } // null = used declared value
	}

	// No declaration - try both parsers and pick the best one
	let flatSettings: ParsedSetting[] = []
	let sectionedSettings: ParsedSetting[] = []

	try {
		flatSettings = parseGetAllSettings_flat(buf, model)
	} catch (e) {
		logger.debug(`Flat parser failed: ${e}`)
	}

	try {
		sectionedSettings = parseGetAllSettings_sectioned(buf, model)
	} catch (e) {
		logger.debug(`Sectioned parser failed: ${e}`)
	}

	// Pick the parser that returned more settings
	if (sectionedSettings.length > flatSettings.length) {
		logger.info(`Auto-detected SECTIONED format (sectioned=${sectionedSettings.length} vs flat=${flatSettings.length})`)
		return { settings: sectionedSettings, detectedSectioned: true }
	} else if (flatSettings.length > 0) {
		logger.info(`Auto-detected FLAT format (flat=${flatSettings.length} vs sectioned=${sectionedSettings.length})`)
		return { settings: flatSettings, detectedSectioned: false }
	} else {
		// Both parsers returned 0 settings
		logger.warn(`Warning: Both parsers returned 0 settings for model ${model}`)
		return { settings: [], detectedSectioned: null }
	}
}

export function parseGetAllSettingsForModel(model: string, buf: Buffer): ParsedSetting[] {
	const { sectioned } = getModelConfig(model)
	return sectioned ? parseGetAllSettings_sectioned(buf, model) : parseGetAllSettings_flat(buf, model)
}

/* ✅ backward-compatible export */
export const parseGetAllSettings = parseGetAllSettingsForModel

/* ---------------------------------------------------------
 *  VALUE → OPTION
 * --------------------------------------------------------*/

function valueBytesToOption(valueBytes: number[]): StActionOption {
	if (valueBytes.length === 1) {
		return { id: 'value', label: 'Value', type: 'number', default: valueBytes[0] }
	}

	if (valueBytes.length === 3) {
		const [r, g, b] = valueBytes
		return {
			id: 'value',
			label: 'Color',
			type: 'colorpicker',
			default: formatRgbColor(r, g, b),
		}
	}

	return { id: 'value', label: 'Value', type: 'raw', default: [...valueBytes] }
}

/* ---------------------------------------------------------
 *  SMART JSON UPDATE
 * --------------------------------------------------------*/

export function updateModelJsonFromSettings(
	modelJson: StModelJson,
	parsed: ParsedSetting[],
	allModels: Record<string, StModelJson>,
): StModelJson {
	const out = structuredClone(modelJson)

	// Ensure cmdSchema array exists
	if (!out.cmdSchema) {
		out.cmdSchema = []
	}

	// Sort other models by numeric distance to current model
	const candidates = Object.values(allModels)
		.filter((m) => m.model !== modelJson.model) // exclude self
		.sort((a, b) => modelDistance(modelJson.model, a.model) - modelDistance(modelJson.model, b.model))

	logger.info(`Updating model: ${modelJson.model}`)
	logger.debug(`Candidates for inference: ${candidates.map((c) => c.model).join(', ')}`)

	// Pre-scan: for each candidate idAdd base entry, find the maximum sequential
	// offset the packet contains (even beyond what the reference model knows).
	// Key: `${cmd_id}_${base_id}`, value: max sequential offset seen in parsed data.
	const idAddDeferRanges = new Map<string, number>()
	for (const c of candidates) {
		for (const baseEntry of c.cmdSchema ?? []) {
			const idAddOpt = baseEntry.options?.find((o: any) => o.id === 'idAdd')
			if (!idAddOpt?.choices) continue
			const baseId = baseEntry.id
			const cmdId = baseEntry.cmd_id
			const key = `${cmdId}_${baseId}`
			if (idAddDeferRanges.has(key)) continue
			// Find the max sequential offset present in the parsed packet for this base
			const parsedOffsets = parsed
				.filter((p) => p.cmd_id === cmdId && p.id > baseId)
				.map((p) => p.id - baseId)
				.sort((a, b) => a - b)
			// Walk from 1 upward — stop at first gap
			let maxSeq = 0
			for (const off of parsedOffsets) {
				if (off === maxSeq + 1) maxSeq = off
				else if (off > maxSeq + 1) break
			}
			if (maxSeq > 0) {
				idAddDeferRanges.set(key, maxSeq)
				logger.debug(`idAdd defer range for cmd_id=${toHex(cmdId)} base_id=${toHex(baseId)}: offsets 1–${maxSeq}`)
			}
		}
	}

	// Pre-compute the set of all busCh values seen per (cmd_id, id) pair across the full
	// parsed response — used later to decide fixed vs. selectable busCh.
	const busChSeen = new Map<string, Set<number>>()
	for (const { cmd_id, id, busCh } of parsed) {
		if (busCh === undefined) continue
		const key = `${cmd_id}_${id}`
		if (!busChSeen.has(key)) busChSeen.set(key, new Set())
		busChSeen.get(key)!.add(busCh)
	}

	// -------------------------------------------------------
	// PASS 1: resolve each parsed entry — exact match, inferred,
	// idAdd-fold (offset into an already-added base entry), or unknown
	// -------------------------------------------------------
	for (const { cmd_id, id, busCh, valueBytes } of parsed) {
		// 1a. Exact match already in output schema — just refresh the default
		const existingExact = out.cmdSchema.find((a) => a.cmd_id === cmd_id && a.id === id)
		if (existingExact) {
			const opt = existingExact.options?.find((o) => o.id === 'value')
			if (opt) opt.default = valueBytesToOption(valueBytes).default
			continue
		}

		// 1b. Check if this id folds into an already-added base entry via idAdd.
		//     Gate: the offset must actually exist in the reference model's idAdd choices
		//     to avoid swallowing unrelated same-cmd_id entries (e.g. Sidetone at id=21).
		const idAddBase = out.cmdSchema.find((a) => {
			if (a.cmd_id !== cmd_id) return false
			const idAddOpt = a.options?.find((o) => o.id === 'idAdd')
			if (!idAddOpt?.choices) return false
			if (id <= a.id) return false
			const offset = id - a.id
			// Only fold if a reference model explicitly lists this offset in its idAdd choices
			return candidates.some((c) => {
				const refEntry = c.cmdSchema?.find((r) => r.cmd_id === cmd_id && r.id === a.id)
				const refIdAdd = refEntry?.options?.find((o) => o.id === 'idAdd')
				return refIdAdd?.choices?.some((ch: any) => ch.id === offset)
			})
		})
		if (idAddBase) {
			const offset = id - idAddBase.id
			const idAddOpt = idAddBase.options?.find((o) => o.id === 'idAdd')
			if (idAddOpt?.choices && !idAddOpt.choices.some((c: any) => c.id === offset)) {
				let label = `Channel ${offset + 1}`
				for (const c of candidates) {
					const refEntry = c.cmdSchema?.find((a) => a.cmd_id === cmd_id && a.id === idAddBase.id)
					const refIdAdd = refEntry?.options?.find((o) => o.id === 'idAdd')
					const refChoice = refIdAdd?.choices?.find((ch: any) => ch.id === offset)
					if (refChoice) {
						label = refChoice.label
						break
					}
				}
				idAddOpt.choices.push({ id: offset, label })
				logger.info(
					`Folded cmd_id=${toHex(cmd_id)} id=${toHex(id)} into idAdd base id=${toHex(idAddBase.id)} as offset ${offset} ("${label}")`,
				)
			}
			continue
		}

		// 1c. No exact match — try inference from candidate models
		let action: StAction | undefined

		for (const c of candidates) {
			const match = c.cmdSchema?.find((a) => a.cmd_id === cmd_id && a.id === id)
			if (match) {
				action = structuredClone(match)
				// Strip any existing "(inferred from Model X)" suffixes before adding our own
				const baseName = match.name.replace(/\s*\(inferred from Model [^)]+\)/g, '').trim()
				action.name = `${baseName} (inferred from Model ${c.model})`
				logger.info(`Inferred cmd_id=${toHex(cmd_id)} id=${toHex(id)} from Model ${c.model} (exact)`)
				break
			}
		}

		// Check if this id should be deferred to pass 2 —
		// it's a sequential idAdd offset of a known candidate base entry.
		if (!action) {
			let shouldDefer = false
			for (const c of candidates) {
				const baseEntry = c.cmdSchema?.find((a: any) => {
					if (a.cmd_id !== cmd_id) return false
					const idAddOpt = a.options?.find((o: any) => o.id === 'idAdd')
					if (!idAddOpt?.choices) return false
					if (id <= a.id) return false
					const offset = id - a.id
					const maxSeq = idAddDeferRanges.get(`${cmd_id}_${a.id}`) ?? 0
					return offset <= maxSeq
				})
				if (baseEntry) {
					shouldDefer = true
					logger.debug(
						`cmd_id=${toHex(cmd_id)} id=${toHex(id)} is an idAdd offset of candidate base id=${toHex(baseEntry.id)} — deferring to pass 2`,
					)
					break
				}
			}
			if (shouldDefer) continue
		}

		// Fallback: unknown setting
		if (!action) {
			action = {
				cmd_id,
				id,
				name: `Unknown cmd:${toHex(cmd_id)} id:${toHex(id).toUpperCase()}`,
				options: [valueBytesToOption(valueBytes)],
			}
			if (busCh !== undefined) action.busCh = busCh
			logger.warn(`Could not infer cmd_id=${toHex(cmd_id)} id=${toHex(id)}`)
		} else {
			// ── Fix 1: busCh handling ──────────────────────────────────────
			// Strip any inherited busCh option from the candidate — we'll re-derive
			// it from what the packet actually reported for this device.
			action.options = action.options?.filter((o) => o.id !== 'busCh') ?? []
			delete action.busCh

			const seenBusChValues = busChSeen.get(`${cmd_id}_${id}`)
			if (seenBusChValues && seenBusChValues.size > 0) {
				const maxBusCh = Math.max(...seenBusChValues)
				if (maxBusCh === 0) {
					// Only ever saw busCh=0 → fixed property, not an option
					action.busCh = 0
				} else {
					// Multiple channels observed → selectable option
					const busChChoices = Array.from({ length: maxBusCh + 1 }, (_, i) => ({
						id: i,
						label: `Channel ${i + 1}`,
					}))
					action.options.unshift({
						id: 'busCh',
						label: 'Channel',
						type: 'dropdown',
						choices: busChChoices,
						default: 0,
					} as any)
				}
			}

			// ── Fix 2: default must exist in choices ───────────────────────
			// Set the default to the observed value. If that value isn't in the
			// inherited choices list, the choices are from a structurally different
			// model and can't be trusted — discard them and fall back to a plain number.
			const observedDefault = valueBytesToOption(valueBytes).default
			const valueOpt = action.options?.find((o) => o.id === 'value')
			if (valueOpt) {
				if (valueOpt.choices && Array.isArray(valueOpt.choices)) {
					const inChoices = valueOpt.choices.some((c: any) => c.id === observedDefault)
					if (!inChoices) {
						logger.warn(
							`Inferred choices for cmd_id=${toHex(cmd_id)} id=${toHex(id)} don't contain observed value ${observedDefault} — discarding inherited choices`,
						)
						// Keep label/tooltip but drop choices, switch to plain number
						valueOpt.type = 'number'
						delete (valueOpt as any).choices
					}
				}
				valueOpt.default = observedDefault
			}
		}

		out.cmdSchema.push(action)
	}

	// -------------------------------------------------------
	// PASS 2: fold any deferred idAdd offsets whose base entry
	// is now present in the output schema.
	// Gate: the offset must either exist in a reference model's choices,
	// OR the base entry itself was inferred (has idAdd) and the offset
	// continues sequentially beyond the reference model's known range.
	// -------------------------------------------------------
	for (const { cmd_id, id } of parsed) {
		const alreadyTopLevel = out.cmdSchema.some((a) => a.cmd_id === cmd_id && a.id === id)
		if (alreadyTopLevel) continue

		// Find a base entry in the output that has idAdd and whose id < this id
		const idAddBase = out.cmdSchema.find((a) => {
			if (a.cmd_id !== cmd_id) return false
			const idAddOpt = a.options?.find((o) => o.id === 'idAdd')
			return !!idAddOpt?.choices && id > a.id
		})
		if (!idAddBase) continue

		const offset = id - idAddBase.id
		const idAddOpt = idAddBase.options?.find((o) => o.id === 'idAdd')
		if (!idAddOpt?.choices || idAddOpt.choices.some((c: any) => c.id === offset)) continue

		// Accept the fold if: a reference model explicitly has this offset,
		// OR the offsets are strictly sequential from 0 (device has more channels than reference)
		const refHasOffset = candidates.some((c) => {
			const refEntry = c.cmdSchema?.find((r) => r.cmd_id === cmd_id && r.id === idAddBase.id)
			const refIdAdd = refEntry?.options?.find((o) => o.id === 'idAdd')
			return refIdAdd?.choices?.some((ch: any) => ch.id === offset)
		})
		const existingOffsets = idAddOpt.choices.map((c: any) => c.id as number).sort((a, b) => a - b)
		const isSequential = existingOffsets.length > 0 && offset === existingOffsets[existingOffsets.length - 1] + 1

		if (!refHasOffset && !isSequential) continue

		// Inherit label from reference model if available, otherwise generate one
		let label = `Channel ${offset + 1}`
		for (const c of candidates) {
			const refEntry = c.cmdSchema?.find((a) => a.cmd_id === cmd_id && a.id === idAddBase.id)
			const refIdAdd = refEntry?.options?.find((o) => o.id === 'idAdd')
			const refChoice = refIdAdd?.choices?.find((ch: any) => ch.id === offset)
			if (refChoice) {
				label = refChoice.label
				break
			}
		}

		idAddOpt.choices.push({ id: offset, label })
		logger.info(
			`Pass 2: Folded cmd_id=${toHex(cmd_id)} id=${toHex(id)} into idAdd base id=${toHex(idAddBase.id)} as offset ${offset} ("${label}")`,
		)
	}

	return out
}

/* ---------------------------------------------------------
 *  SAVE
 * --------------------------------------------------------*/

export function saveModelJsonPretty(filePath: string, jsonObj: StModelJson): void {
	try {
		// Ensure proper key ordering: model, sectioned (if present), refreshAfterCommand, cmdSchema
		const orderedObj: any = { model: jsonObj.model }

		// Add sectioned key if present (right after model)
		if ('sectioned' in jsonObj) {
			orderedObj.sectioned = jsonObj.sectioned
		}

		// Add other keys in order
		if ('refreshAfterCommand' in jsonObj) {
			orderedObj.refreshAfterCommand = jsonObj.refreshAfterCommand
		}
		if ('cmdSchema' in jsonObj) {
			orderedObj.cmdSchema = jsonObj.cmdSchema.map((entry: any) => {
				// Enforce key order within each schema entry: cmd_id, id, busCh, name, options
				const orderedEntry: any = {}
				if ('cmd_id' in entry) orderedEntry.cmd_id = entry.cmd_id
				if ('id' in entry) orderedEntry.id = entry.id
				if ('busCh' in entry) orderedEntry.busCh = entry.busCh
				if ('name' in entry) orderedEntry.name = entry.name
				if ('options' in entry) orderedEntry.options = entry.options
				// Copy any remaining keys
				for (const key of Object.keys(entry)) {
					if (!(key in orderedEntry)) orderedEntry[key] = entry[key]
				}
				return orderedEntry
			})
		}
		// Copy any other keys that might exist
		for (const key of Object.keys(jsonObj)) {
			if (!(key in orderedObj)) {
				orderedObj[key] = (jsonObj as any)[key]
			}
		}

		// Custom formatter: keep choice objects compact on one line
		let json = JSON.stringify(orderedObj, null, 2)

		// Replace expanded choice objects with compact single-line format
		// Matches: {\n            "id": X,\n            "label": "Y"\n          }
		// Replaces with: { "id": X, "label": "Y" }
		json = json.replace(/\{\n\s+"id":\s*(\d+),\n\s+"label":\s*"([^"]*)"\n\s+\}/g, '{ "id": $1, "label": "$2" }')

		fs.writeFileSync(filePath, json + '\n', 'utf8')
	} catch (e) {
		logger.error(`File Write Error: ${e}`)
	}
}

/* ---------------------------------------------------------
 *  LOAD DEVICE JSON
 * --------------------------------------------------------*/

/**
 * Loads the actions array for a given model from the centralized cache.
 * Returns an empty array if the model is not found.
 * @deprecated - This function is no longer needed. Use getDeviceSchema() from config.ts instead.
 */
export function loadActionsForModel(_devicesFolder: string, model: string): StAction[] {
	const schema = getDeviceSchema(model)
	return schema?.cmdSchema ?? []
}

/**
 * Loads the model configuration from the centralized cache.
 * @deprecated - This function is no longer needed. Use getDeviceSchema() from config.ts instead.
 */
export function loadModelConfig(
	_devicesFolder: string,
	model: string,
): { actions: StAction[]; refreshAfterCommand: boolean } {
	const schema = getDeviceSchema(model)
	return {
		actions: schema?.cmdSchema ?? [],
		refreshAfterCommand: schema?.refreshAfterCommand ?? true, // Default to true if not specified
	}
}
