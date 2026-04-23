/**
 * build-commands.ts
 * - Uses centralized device schema cache from config.ts
 * - Produces Companion action definitions and feedbacks
 */

import {
	CompanionActionDefinitions,
	CompanionActionDefinition,
	CompanionFeedbackDefinitions,
} from '@companion-module/base'
import { makeSettingId } from './types.js'
import { getDeviceSchemas } from './config.js'

/* ----------------------------- */
/* ------ Option Builder ------- */
/* ----------------------------- */

function buildOption(o: any): any {
	const base = {
		type: o.type,
		id: o.id,
		label: o.label,
		default: o.default,
		tooltip: o.tooltip,
	}

	switch (o.type) {
		case 'dropdown':
			return { ...base, choices: o.choices ?? [] }

		case 'number':
			return {
				...base,
				min: o.min,
				max: o.max,
				step: o.step ?? 1,
				range: true,
			}

		case 'checkbox':
			return { ...base, default: o.default ?? false }

		case 'static-text':
			return { ...base, value: o.value ?? '' }

		case 'textinput':
		case 'colorpicker':
		default:
			return base
	}
}

/* ----------------------------- */
/* --------- Actions ----------- */
/* ----------------------------- */

export function buildActions(): CompanionActionDefinitions {
	const schemas = getDeviceSchemas()
	const actions: CompanionActionDefinitions = {}

	for (const [model, schema] of Object.entries(schemas)) {
		const cmdSchema = schema.cmdSchema
		if (!Array.isArray(cmdSchema)) continue

		for (const a of cmdSchema) {
			const actionId = makeSettingId(model, a.cmd_id, a.id)

			const options = (a.options ?? []).map(buildOption)

			const action: CompanionActionDefinition = {
				name: `[Model${model}] ${a.name}`,
				options,
				callback: async () => {
					/* wired later in UpdateActions */
				},
			}

			actions[actionId] = action
		}
	}

	return actions
}

/* ----------------------------- */
/* --------- Feedbacks --------- */
/* ----------------------------- */

export function buildFeedbacks(): CompanionFeedbackDefinitions {
	const schemas = getDeviceSchemas()
	const feedbacks: CompanionFeedbackDefinitions = {}

	for (const [model, schema] of Object.entries(schemas)) {
		const cmdSchema = schema.cmdSchema
		if (!Array.isArray(cmdSchema)) continue

		for (const setting of cmdSchema) {
			const baseFeedbackId = makeSettingId(model, setting.cmd_id, setting.id)

			// Build options
			const allOptions = (setting.options ?? []).map(buildOption)

			// Filter out 'value' option for value feedback (keep only busCh/idAdd)
			const valueOptions = allOptions.filter((opt: any) => opt.id !== 'value')

			// Add a checkbox option to return label instead of value
			valueOptions.push({
				type: 'checkbox',
				id: 'showLabel',
				label: 'Show Label',
				default: false,
				tooltip: 'Return the label text instead of the numeric value',
			})

			// Value feedback for all settings (appears in Variables list)
			const valueFeedback: any = {
				type: 'value',
				name: `[Model${model}] ${setting.name}`,
				options: valueOptions,
				callback: () => {
					/* wired later in UpdateFeedbacks */
					return 0
				},
			}

			feedbacks[baseFeedbackId] = valueFeedback
		}
	}

	return feedbacks
}
