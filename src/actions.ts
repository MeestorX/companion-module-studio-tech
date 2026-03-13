import ModuleInstance from './main.js'
import { buildActions } from './build-commands.js'
import { resolveModel, getDevicesFolder, getDeviceSchema, getDeviceSchemas, reloadDeviceSchemas } from './config.js'
import { parseSettingId, getNormalizedSchemas } from './types.js'
import { createModuleLogger } from '@companion-module/base'
import path from 'path'

import { parseGetAllSettingsWithDetection, saveModelJsonPretty, updateModelJsonFromSettings } from './settingsParser.js'

const logger = createModuleLogger('Actions')

export function UpdateActions(self: ModuleInstance): void {
	const schemasRaw = getDeviceSchemas()
	const rawActions = buildActions()
	const schemas = getNormalizedSchemas(schemasRaw)
	const wiredActions: any = {}

	// Get the active model using resolveModel
	const activeModel = resolveModel(self.config, self.devices)
	logger.info(
		`UpdateActions: activeModel="${activeModel}", discoveredHost="${self.config.discoveredHost}", devices count=${self.devices.length}`,
	)

	// ---------------------------------------------
	// ✅ GLOBAL: GET ALL SETTINGS (AUTO JSON UPDATE)
	// ---------------------------------------------

	wiredActions['global_getAllSettings'] = {
		name: 'GLOBAL: Get All Settings (Auto-Update JSON)',
		options: [],
		callback: async () => {
			const model = activeModel
			const ip = self.host

			const buf = await self.stController.requestAllSettings(ip)

			// Use centralized cache to get the schema
			let modelJson = getDeviceSchema(model)
			if (!modelJson) {
				logger.error(`Model ${model} schema not found in cache`)
				return
			}

			// Parse with auto-detection
			const { settings: parsed, detectedSectioned } = parseGetAllSettingsWithDetection(model, buf)
			logger.debug(`parsed reply: ${JSON.stringify(parsed)}`)

			// If we auto-detected the format, add it to the JSON
			if (detectedSectioned !== null) {
				logger.info(`Auto-detected sectioned=${detectedSectioned}, adding to model JSON`)
				modelJson = { ...modelJson, sectioned: detectedSectioned }
			}

			const updated = updateModelJsonFromSettings(modelJson, parsed, schemas)
			logger.debug(`new Actions json: ${JSON.stringify(updated, null, 2)}`)

			// Save the updated JSON to disk
			const devicesFolder = getDevicesFolder()
			const schemaPath = path.join(devicesFolder, `Model${model}.json`)
			saveModelJsonPretty(schemaPath, updated)

			// Reload the cache after writing to file
			reloadDeviceSchemas()

			logger.info(`Model ${model} JSON auto-updated from getAllSettings`)
		},
	}

	// ---------------------------------------------
	// ✅ BUILD PER-SETTING ACTIONS (FILTERED BY ACTIVE MODEL)
	// ---------------------------------------------

	for (const [actionId, action] of Object.entries(rawActions)) {
		const { model, cmdId, baseId } = parseSettingId(actionId)

		// Only include actions for the currently active model
		if (model !== activeModel) continue

		// Get the raw action schema to access fixed busCh value
		const schema = schemas[model]
		const rawAction = schema?.cmdSchema?.find((a: any) => a.cmd_id === cmdId && a.id === baseId)

		wiredActions[actionId] = {
			...action,
			callback: async (event: any) => {
				const ip = self.host
				const busCh = event.options['busCh'] !== undefined ? event.options['busCh'] : rawAction?.busCh
				const value = event.options['value']
				const idAdd = event.options['idAdd'] ?? 0
				const settingId = baseId + idAdd

				await self.stController.sendAwaitAck(activeModel, cmdId, busCh, settingId, value, ip)
			},
		}
	}

	// ---------------------------------------------
	// ✅ MIC KILL (ONLY IF ACTIVE MODEL SUPPORTS IT)
	// ---------------------------------------------
	const activeSchema = schemas[activeModel]
	if (activeSchema) {
		const supportsMicKill = (activeSchema.cmdSchema ?? []).some((a: any) => a.name.includes('Kill'))

		if (supportsMicKill) {
			const actionId = `${activeModel}_micKill`

			wiredActions[actionId] = {
				name: `[Model${activeModel}] Mic Kill`,
				options: [],
				callback: async () => {
					const ip = self.host
					logger.info(`Mic Kill → Model ${activeModel} @ ${ip}`)
					await self.stController.globalMicKill(activeModel, ip)
				},
			}
		}
	}

	self.setActionDefinitions(wiredActions)

	logger.info(`UpdateActions: wired actions: ${Object.keys(wiredActions).length}`)
}
