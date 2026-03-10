import fs from 'fs'
import path from 'path'

/* ---------------------------------------------------------
 *  TYPES
 * --------------------------------------------------------*/

export interface ParsedSetting {
	cmd_id: number
	id: number
	valueBytes: number[]
}

export interface StActionOption {
	id?: string
	label: string
	type: string
	default: unknown
	tooltip?: string
	choices?: Array<{ id: number; label: string }>
}

export interface StAction {
	cmd_id: number
	id: number
	name: string
	options: StActionOption[]
	busCh?: number // Fixed channel value for actions that don't have a channel option
}

export interface StModelJson {
	model: string
	actions: StAction[]
}

/* ---------------------------------------------------------
 *  FORMAT HELPERS
 * --------------------------------------------------------*/

function isSectionedModel(model: string): boolean {
	return ['374A', '391'].includes(model)
}

function modelDistance(a: string, b: string): number {
	const na = parseInt(a.replace(/\D/g, ''), 10)
	const nb = parseInt(b.replace(/\D/g, ''), 10)
	if (Number.isNaN(na) || Number.isNaN(nb)) return Infinity
	return Math.abs(na - nb)
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

function parseFlatIdValSequence(block: Buffer): ParsedSetting[] {
	let p = 0
	const out: ParsedSetting[] = []

	while (p < block.length) {
		const id = block[p]
		if (p + 1 >= block.length) break

		// RGB case
		if (p + 3 < block.length) {
			const nextId = block[p + 4]
			if (nextId >= 0x00 && nextId <= 0x40) {
				out.push({
					cmd_id: 0x0d,
					id,
					valueBytes: [block[p + 1], block[p + 2], block[p + 3]],
				})
				p += 4
				continue
			}
		}

		out.push({ cmd_id: 0x0d, id, valueBytes: [block[p + 1]] })
		p += 2
	}

	return out
}

export function parseGetAllSettings_flat(buf: Buffer): ParsedSetting[] {
	const idx = extractStPayloadIndex(buf)
	const cmdId = buf[idx + 1] & 0x7f
	if (cmdId !== 0x0a && cmdId !== 0x0b) throw new Error('Not a getAllSettings reply')

	const blockLen = buf[idx + 2]
	const start = idx + 3
	const end = start + blockLen
	if (end > buf.length) throw new Error('Invalid block length')

	return parseFlatIdValSequence(buf.subarray(start, end))
}

/* ---------------------------------------------------------
 *  SECTIONED PARSER
 * --------------------------------------------------------*/

export function parseGetAllSettings_sectioned(buf: Buffer): ParsedSetting[] {
	const idx = extractStPayloadIndex(buf)
	const cmdId = buf[idx + 1] & 0x7f
	if (cmdId !== 0x0a && cmdId !== 0x0b) throw new Error('Not a getAllSettings reply')

	// 0x0a has a total-length byte at idx+2 before the sections; 0x0b does not.
	let p = cmdId === 0x0a ? idx + 3 : idx + 2
	const end = buf.length - 1
	const out: ParsedSetting[] = []

	while (p + 2 < end) {
		const cmdLen = buf[p]
		const sectionCmdId = buf[p + 1]
		const dataLen = buf[p + 2]

		const sectionEnd = p + 1 + cmdLen
		if (sectionEnd > end) break

		let q = p + 3
		const qEnd = q + dataLen

		while (q + 1 < qEnd) {
			out.push({
				cmd_id: sectionCmdId,
				id: buf[q],
				valueBytes: [buf[q + 1]],
			})
			q += 2
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
	if (cmdId !== 0x0a && cmdId !== 0x0b) {
		throw new Error(`Not a settings block (cmdId=0x${cmdId.toString(16)})`)
	}
	return isSectionedModel(model) ? parseGetAllSettings_sectioned(buf) : parseGetAllSettings_flat(buf)
}

/**
 * Formats a single parsed setting into a human-readable string using action
 * definitions from the device JSON. Falls back to hex IDs when unknown.
 */
export function formatParsedSetting(setting: ParsedSetting, actions: StAction[]): string {
	// Try exact match first
	let action = actions.find((a) => a.cmd_id === setting.cmd_id && a.id === setting.id)

	// If no exact match and id > base id, try to find action with idAdd option
	// This handles cases like cmd_id 5 (Phones Routing) and cmd_id 7 (Buttons)
	// where id 0-3 represents channels 1-4
	if (!action) {
		const baseAction = actions.find((a) => {
			if (a.cmd_id !== setting.cmd_id) return false
			// Check if this action has an idAdd option (indicating channel selection)
			const hasIdAdd = a.options?.some((opt) => opt.id === 'idAdd')
			if (!hasIdAdd) return false
			// Check if the setting.id could be this action's base id + offset
			return setting.id >= a.id && setting.id < a.id + 10 // reasonable offset range
		})
		if (baseAction) {
			action = baseAction
		}
	}

	const cmdHex = `0x${setting.cmd_id.toString(16).padStart(2, '0')}`
	const idHex = `0x${setting.id.toString(16).padStart(2, '0')}`
	const valHex = `0x${setting.valueBytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`
	const valDec = setting.valueBytes.length === 1 ? setting.valueBytes[0] : setting.valueBytes.join(',')

	// Build the prefix: cmd:0x12 id:0x01 val:0x14
	const prefix = `cmd:${cmdHex} id:${idHex} val:${valHex}`

	// If we have an action with a name and choice label, use it
	if (action) {
		let name = action.name

		// If this action has idAdd and the setting id is offset from base, include channel info
		const hasIdAdd = action.options?.some((opt) => opt.id === 'idAdd')
		if (hasIdAdd && setting.id !== action.id) {
			const channelOffset = setting.id - action.id
			name = `${name} Ch${channelOffset + 1}`
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
 *  PARSER DISPATCH
 * --------------------------------------------------------*/

export function parseGetAllSettingsForModel(model: string, buf: Buffer): ParsedSetting[] {
	return isSectionedModel(model) ? parseGetAllSettings_sectioned(buf) : parseGetAllSettings_flat(buf)
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
			default: `#${r.toString(16).padStart(2, '0')}${g
				.toString(16)
				.padStart(2, '0')}${b.toString(16).padStart(2, '0')}`,
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

	// Sort other models by numeric distance to current model
	const candidates = Object.values(allModels)
		.filter((m) => m.model !== modelJson.model) // exclude self
		.sort((a, b) => modelDistance(modelJson.model, a.model) - modelDistance(modelJson.model, b.model))

	console.log(`Updating model: ${modelJson.model}`)
	console.log(`Candidates for inference: ${candidates.map((c) => c.model)}`)

	for (const { cmd_id, id, valueBytes } of parsed) {
		let action = out.actions.find((a) => a.cmd_id === cmd_id && a.id === id)

		if (!action) {
			// Try candidates in order of proximity
			for (const c of candidates) {
				const match = c.actions?.find((a) => a.cmd_id === cmd_id && a.id === id)
				if (match) {
					action = structuredClone(match)
					action.name = `${match.name} (inferred from Model ${c.model})`
					console.log(`Inferred setting 0x${id.toString(16)} from Model ${c.model}`)
					break
				}
			}
		}

		if (!action) {
			action = {
				cmd_id,
				id,
				name: `Unknown Setting 0x${id.toString(16).toUpperCase()}`,
				options: [valueBytesToOption(valueBytes)],
			}
			console.log(`Could not infer setting 0x${id.toString(16)}`)
		} else {
			const opt = action.options?.[0]
			if (opt) opt.default = valueBytesToOption(valueBytes).default
		}

		// Avoid duplicates
		const exists = out.actions.some((a) => a.cmd_id === action.cmd_id && a.id === action.id)
		if (!exists) out.actions.push(action)
	}

	return out
}

/* ---------------------------------------------------------
 *  SAVE
 * --------------------------------------------------------*/

export function saveModelJsonPretty(filePath: string, jsonObj: StModelJson): void {
	try {
		// Custom formatter: keep choice objects compact on one line
		let json = JSON.stringify(jsonObj, null, 2)

		// Replace expanded choice objects with compact single-line format
		// Matches: {\n            "id": X,\n            "label": "Y"\n          }
		// Replaces with: { "id": X, "label": "Y" }
		json = json.replace(/\{\n\s+"id":\s*(\d+),\n\s+"label":\s*"([^"]*)"\n\s+\}/g, '{ "id": $1, "label": "$2" }')

		fs.writeFileSync(filePath, json + '\n', 'utf8')
	} catch (e) {
		console.log('File Write Error:', e)
	}
}

/* ---------------------------------------------------------
 *  LOAD DEVICE JSON
 * --------------------------------------------------------*/

/**
 * Loads the actions array for a given model from the devices folder.
 * Returns an empty array if the file is missing or unparseable.
 */
export function loadActionsForModel(devicesFolder: string, model: string): StAction[] {
	try {
		const filePath = path.join(devicesFolder, `Model${model}.json`)
		const json: StModelJson = JSON.parse(fs.readFileSync(filePath, 'utf8'))
		return json?.actions ?? []
	} catch {
		return []
	}
}
