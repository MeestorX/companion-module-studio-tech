/**
 * build-commands.ts
 * - Loads ./devices/*.json (UI schemas)
 * - Produces Companion action definitions and feedbacks
 *
 * Intended usage inside Companion module:
 *  const actions = buildCompanionActionsFromDir(path.join(import.meta.dirname,'devices'));
 *  self.setActionDefinitions(actions);
 *
 * This file exports buildCompanionActionsFromDir() and buildFeedbacksFromDir()
 */

import fs from 'fs'
import path from 'path'
import { CompanionActionDefinitions, CompanionFeedbackDefinitions } from '@companion-module/base'
const devicesFolder = path.join(import.meta.dirname, '../devices')

type Choice = { id: string | number; label: string }
type UiSetting = {
	name: string
	type: 'static-text' | 'textinput' | 'dropdown' | 'colorpicker' | 'number' | 'checkbox'
	label: string
	default?: any
	min?: number
	max?: number
	step?: number
	choices?: Choice[]
	tooltip?: string
	current?: any
}

export function loadUiSchemas(dir = devicesFolder): Record<string, any> {
	const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('_commands.json'))
	const out: Record<string, any> = {}
	for (const f of files) {
		const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
		out[j.model] = j
	}
	return out
}

export function buildActions(
	dir = devicesFolder,
	sendFn?: (model: string, cmdId: number, settingId: number, value: any) => Promise<void>,
): CompanionActionDefinitions {
	const schemas = loadUiSchemas(dir)
	const actions: Record<string, any> = {}

	for (const [model, schema] of Object.entries(schemas)) {
		const actionDef = schema.actions as Array<UiSetting & { cmd_id: number; id: number }>
		if (!actionDef) return actions

		for (const s of actionDef) {
			const actionId = `${model}_${s.id}`
			const option: any = {
				id: s.id.toString(),
				type: s.type,
				label: s.label,
				default: s.default,
				tooltip: s.tooltip,
			}

			if (s.type === 'dropdown' && s.choices) {
				option.choices = s.choices
			} else if (s.type === 'number') {
				option.min = s.min
				option.max = s.max
				option.step = s.step ?? 1
				option.range = true
			}

			actions[actionId] = {
				name: `Model${model}: Set ${s.name}`,
				options: [option],
				callback: async (event: any) => {
					const value = event.options[s.id.toString()]
					if (sendFn) {
						await sendFn(model, s.cmd_id, s.id, value)
					} else {
						console.log('Send not provided, would send:', model, s.cmd_id, s.id, value)
					}
				},
			}
		}
	}

	return actions
}

export function buildFeedbacks(dir = devicesFolder): CompanionFeedbackDefinitions {
	const schemas = loadUiSchemas(dir)
	const feedbacks: Record<string, any> = {}

	for (const [model, schema] of Object.entries(schemas)) {
		const feedbackDef = schema.feedbacks as Array<UiSetting & { cmd_id: number; id: number }>
		console.log('feedbackDef:', JSON.stringify(feedbackDef, null, 2))
		if (!feedbackDef) return feedbacks

		for (const s of feedbackDef) {
			const fbId = `${model}_${s.id}_state`
			feedbacks[fbId] = {
				name: `${model}: ${s.label} state`,
				type: 'boolean',
				options: [
					{
						id: s.id.toString(),
						type: s.type === 'checkbox' ? 'checkbox' : s.type === 'dropdown' ? 'dropdown' : 'textinput',
						label: s.label,
						default: s.default,
						choices: s.choices ?? undefined,
					},
				],
				callback: (feedback: any, state: any) => {
					const current = state?.[model]?.[s.id]
					return current === feedback.options[s.id.toString()]
				},
			}
		}
	}

	return feedbacks
}
