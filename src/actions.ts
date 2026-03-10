import ModuleInstance from './main.js'
import { buildActions, loadUiSchemas } from './build-commands.js'
import { resolveModel } from './config.js'
import path from 'path'

/* // For GET ALL SETTINGS ACTION
import fs from 'fs'
import {
	parseGetAllSettingsForModel,
	saveModelJsonPretty,
	updateModelJsonFromSettings,
*/

import { StModelJson } from './settingsParser.js'

export function UpdateActions(self: ModuleInstance): void {
	const devicesFolder = path.join(import.meta.dirname, '../devices')

	const schemasRaw = loadUiSchemas(devicesFolder)
	const rawActions = buildActions(devicesFolder)
	const schemas: Record<string, StModelJson> = {}
	for (const [model, json] of Object.entries(schemasRaw)) {
		schemas[model] = {
			model: json.model,
			actions: Array.isArray(json.actions) ? json.actions : [],
		}
	}
	const wiredActions: any = {}

	// Get the active model using resolveModel
	const activeModel = resolveModel(self.config, self.devices)
	console.log(
		`UpdateActions: activeModel="${activeModel}", discoveredHost="${self.config.discoveredHost}", devices count=${self.devices.length}`,
	)

	// ---------------------------------------------
	// ✅ GLOBAL: GET ALL SETTINGS (AUTO JSON UPDATE)
	// ---------------------------------------------
	/*
	wiredActions['global_getAllSettings'] = {
		name: 'GLOBAL: Get All Settings (Auto-Update JSON)',
		options: [],
		callback: async () => {
			const model = activeModel
			const ip = self.host

			const buf = await self.stController.requestAllSettings(ip)

			const schemaPath = path.join(devicesFolder, `model${model}.json`)
			const modelJson = JSON.parse(fs.readFileSync(schemaPath, 'utf8'))

			// Model-aware parsing
			const parsed = parseGetAllSettingsForModel(model, buf)
			console.log('parsed reply: ', parsed)

			const updated = updateModelJsonFromSettings(modelJson, parsed, schemas)
			console.log('new Actions json: ', JSON.stringify(updated, null, 2))

			saveModelJsonPretty(schemaPath, updated)

			console.log(`Model ${model} JSON auto-updated from getAllSettings`)
		},
	}
	*/
	// ---------------------------------------------
	// ✅ BUILD PER-SETTING ACTIONS (FILTERED BY ACTIVE MODEL)
	// ---------------------------------------------

	for (const [actionId, action] of Object.entries(rawActions)) {
		const [model, cmdIdStr, idStr] = actionId.split('_')

		// Only include actions for the currently active model
		if (model !== activeModel) continue

		const cmdId = Number(cmdIdStr)
		const baseId = Number(idStr)

		// Get the raw action schema to access fixed busCh value
		const schema = schemas[model]
		const rawAction = schema?.actions?.find((a: any) => a.cmd_id === cmdId && a.id === baseId)

		wiredActions[actionId] = {
			...action,
			callback: async (event: any) => {
				const ip = self.host
				// Use busCh from options if present, otherwise use fixed value from schema
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
		const supportsMicKill = (activeSchema.actions ?? []).some((a: any) => a.name.includes('Kill'))

		if (supportsMicKill) {
			const actionId = `${activeModel}_micKill`

			wiredActions[actionId] = {
				name: `[Model${activeModel}] Mic Kill`,
				options: [],
				callback: async () => {
					const ip = self.host
					console.log(`Mic Kill → Model ${activeModel} @ ${ip}`)
					await self.stController.globalMicKill(activeModel, ip)
				},
			}
		}
	}

	self.setActionDefinitions(wiredActions)

	console.log('UpdateActions: wired actions:', Object.keys(wiredActions).length)
}
