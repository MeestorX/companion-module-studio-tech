/**
 * build-commands.ts
 * - Loads ./devices/*.json (UI schemas)
 * - Produces Companion action definitions and feedbacks
 */

import fs from 'fs'
import path from 'path'
import {
	CompanionActionDefinitions,
	CompanionActionDefinition,
	CompanionFeedbackDefinitions,
	CompanionBooleanFeedbackDefinition,
} from '@companion-module/base'

const devicesFolder = path.join(import.meta.dirname, '../devices')

/* ----------------------------- */
/* --------- Load JSON --------- */
/* ----------------------------- */

export function loadUiSchemas(dir = devicesFolder): Record<string, any> {
	const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
	const out: Record<string, any> = {}

	for (const f of files) {
		const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
		out[j.model] = j
	}

	return out
}

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

		case 'textinput':
		case 'colorpicker':
		case 'static-text':
		default:
			return base
	}
}

/* ----------------------------- */
/* --------- Actions ----------- */
/* ----------------------------- */

export function buildActions(dir = devicesFolder): CompanionActionDefinitions {
	const schemas = loadUiSchemas(dir)
	const actions: CompanionActionDefinitions = {}

	for (const [model, schema] of Object.entries(schemas)) {
		const actionDefs = schema.actions
		if (!Array.isArray(actionDefs)) continue

		for (const a of actionDefs) {
			const actionId = `${model}_${a.cmd_id}_${a.id}`

			const options = (a.options ?? []).map(buildOption)

			const action: CompanionActionDefinition = {
				name: `[Model${model}] Set ${a.name}`,
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

export function buildFeedbacks(dir = devicesFolder): CompanionFeedbackDefinitions {
	const schemas = loadUiSchemas(dir)
	const feedbacks: CompanionFeedbackDefinitions = {}

	for (const [model, schema] of Object.entries(schemas)) {
		const feedbackDefs = schema.feedbacks
		if (!Array.isArray(feedbackDefs)) continue

		for (const f of feedbackDefs) {
			const feedbackId = `${model}_${f.cmd_id}_${f.id}_state`

			const feedback: CompanionBooleanFeedbackDefinition = {
				type: 'boolean',
				name: `[Model${model}] ${f.label}`,
				defaultStyle: {
					bgcolor: 0xff0000,
					color: 0xffffff,
				},

				// ✅ MUST BE ARRAY (per Companion type)
				options: [buildOption(f)],

				callback: (feedbackInstance: any, state: any) => {
					const optionId = f.id
					const expected = feedbackInstance.options[optionId]
					const current = state?.[model]?.[optionId]
					return current === expected
				},
			}

			feedbacks[feedbackId] = feedback
		}
	}

	return feedbacks
}
