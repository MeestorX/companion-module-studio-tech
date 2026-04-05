import ModuleInstance from './main.js'
import { buildFeedbacks } from './build-commands.js'
import { getDeviceSchemas } from './config.js'
import { parseSettingId, getNormalizedSchemas, findActionForSetting } from './types.js'
import { createModuleLogger } from '@companion-module/base'

const logger = createModuleLogger('Feedbacks')

/**
 * Helper function to get label from choices based on value
 */
function getLabelForValue(
	schemas: Record<string, { model: string; cmdSchema: any[] }>,
	model: string,
	cmdId: number,
	settingId: number,
	value: number,
): string | number {
	const setting = findActionForSetting(schemas, model, cmdId, settingId)
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
	const schemasRaw = getDeviceSchemas()
	const rawFeedbacks = buildFeedbacks()
	const schemas = getNormalizedSchemas(schemasRaw)
	const wiredFeedbacks: any = {}

	// Get the active model from the cached value set by syncModel()
	const activeModel = self.activeModel

	// ---------------------------------------------
	// ✅ BUILD PER-SETTING FEEDBACKS (FILTERED BY ACTIVE MODEL)
	// ---------------------------------------------

	for (const [feedbackId, feedback] of Object.entries(rawFeedbacks)) {
		const { model, cmdId, baseId } = parseSettingId(feedbackId)

		// Only include feedbacks for the currently active model
		if (model !== activeModel) continue

		// VALUE FEEDBACK: Returns current value for local variable
		wiredFeedbacks[feedbackId] = {
			...feedback,
			callback: (feedbackEvent: any) => {
				const ip = self.host
				const idAdd = feedbackEvent.options['idAdd'] ?? 0
				const settingId = baseId + idAdd

				// busCh from options takes priority; fall back to fixed busCh in schema
				let busCh = feedbackEvent.options['busCh']
				if (busCh === undefined) {
					const schemaAction = findActionForSetting(schemas, model, cmdId, settingId)
					if (schemaAction?.busCh !== undefined) {
						busCh = schemaAction.busCh
					}
				}

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

	logger.info(`UpdateFeedbacks: wired feedbacks: ${Object.keys(wiredFeedbacks).length}`)
}
