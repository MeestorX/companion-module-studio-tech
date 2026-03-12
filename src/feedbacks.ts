import ModuleInstance from './main.js'
import { buildFeedbacks, loadUiSchemas } from './build-commands.js'
import { resolveModel } from './config.js'
import { StModelJson } from './settingsParser.js'
import path from 'path'

/**
 * Helper function to get label from choices based on value
 */
function getLabelForValue(
	schemas: Record<string, StModelJson>,
	model: string,
	cmdId: number,
	settingId: number,
	value: number,
): string | number {
	const schema = schemas[model]
	if (!schema || !Array.isArray(schema.actions)) return value

	// Try exact match first
	let setting = schema.actions.find((s: any) => s.cmd_id === cmdId && s.id === settingId)

	// If no exact match, try to find base action with idAdd
	if (!setting) {
		setting = schema.actions.find((s: any) => {
			if (s.cmd_id !== cmdId) return false
			const idAddOption = s.options?.find((opt: any) => opt.id === 'idAdd')
			if (!idAddOption?.choices) return false
			// Check if settingId matches base + any idAdd offset
			const offset = settingId - s.id
			return idAddOption.choices.some((c: any) => c.id === offset)
		})
	}

	if (!setting || !Array.isArray(setting.options)) return value

	// Find the 'value' option which contains the choices
	const valueOption = setting.options.find((opt: any) => opt.id === 'value')
	if (!valueOption || !Array.isArray(valueOption.choices)) return value

	// Find the choice with matching id
	const choice = valueOption.choices.find((c: any) => c.id === value)
	return choice?.label ?? value
}

/**
 * Build and wire Companion feedback definitions
 * Pattern matches actions.ts - filters by active model and wires callbacks
 */
export function UpdateFeedbacks(self: ModuleInstance): void {
	const devicesFolder = path.join(import.meta.dirname, '../devices')

	const schemasRaw = loadUiSchemas(devicesFolder)
	const rawFeedbacks = buildFeedbacks(devicesFolder)
	const schemas: Record<string, StModelJson> = {}
	for (const [model, json] of Object.entries(schemasRaw)) {
		schemas[model] = {
			model: json.model,
			actions: Array.isArray(json.cmdSchema) ? json.cmdSchema : [],
		}
	}
	const wiredFeedbacks: any = {}

	// Get the active model using resolveModel
	const activeModel = resolveModel(self.config, self.devices)
	console.log(
		`UpdateFeedbacks: activeModel="${activeModel}", discoveredHost="${self.config.discoveredHost}", devices count=${self.devices.length}`,
	)

	// ---------------------------------------------
	// ✅ BUILD PER-SETTING FEEDBACKS (FILTERED BY ACTIVE MODEL)
	// ---------------------------------------------

	for (const [feedbackId, feedback] of Object.entries(rawFeedbacks)) {
		const [model, cmdIdStr, idStr] = feedbackId.split('_')

		// Only include feedbacks for the currently active model
		if (model !== activeModel) continue

		const cmdId = parseInt(cmdIdStr, 16)
		const baseId = parseInt(idStr, 16)

		// VALUE FEEDBACK: Returns current value for local variable
		wiredFeedbacks[feedbackId] = {
			...feedback,
			callback: (feedbackEvent: any) => {
				const ip = self.host
				const busCh = feedbackEvent.options['busCh']
				const idAdd = feedbackEvent.options['idAdd'] ?? 0
				const settingId = baseId + idAdd
				const current = self.stController.getSettingValue(ip, cmdId, settingId, busCh)

				// Check if user wants label instead of numeric value
				const showLabel = feedbackEvent.options['showLabel'] ?? false

				if (showLabel && current !== undefined) {
					// Return the label from choices
					return getLabelForValue(schemas, model, cmdId, settingId, current)
				}

				// Return numeric value directly for local variable (type: 'value')
				return current ?? 0
			},
		}
	}

	self.setFeedbackDefinitions(wiredFeedbacks)

	console.log('UpdateFeedbacks: wired feedbacks:', Object.keys(wiredFeedbacks).length)
}
