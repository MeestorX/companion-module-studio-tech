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
type actionDef = {
	cmd_id: number
	id: number
	name: string
	label: string
	options: optionDef[]
}

type optionDef = {
	id: string
	type: 'static-text' | 'textinput' | 'dropdown' | 'colorpicker' | 'number' | 'checkbox'
	label: string
	default?: any
	min?: number
	max?: number
	step?: number
	range?: boolean
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
	sendFn?: (model: string, cmdId: number, busCh: number | undefined, settingId: number, value: any) => Promise<void>,
): CompanionActionDefinitions {
	const schemas = loadUiSchemas(dir)
	const actions: Record<string, any> = {}

	for (const [model, schema] of Object.entries(schemas)) {
		const actionDef = schema.actions as Array<actionDef>
		if (!actionDef) return actions

		for (const a of actionDef) {
			const actionId = `${model}_${a.cmd_id}_${a.id}`
			const options: optionDef[] = []
			for (const o of a.options) {
				const option: optionDef = {
					id: o.id,
					type: o.type,
					label: o.label,
					default: o.default,
					tooltip: o.tooltip,
				}
				if (o.type === 'dropdown' && o.choices) {
					option.choices = o.choices
				} else if (o.type === 'number') {
					option.min = o.min
					option.max = o.max
					option.step = o.step ?? 1
					option.range = true
				}
				options.push(option)
			}

			actions[actionId] = {
				name: `Model${model}: Set ${a.name}`,
				options,
				callback: async (event: any) => {
					console.log('Event:', event)
					const busCh = event.options['busCh']
					const value = event.options['value']
					if (sendFn) {
						await sendFn(model, a.cmd_id, busCh, a.id, value)
					} else {
						console.log('Send not provided, would send:', model, a.cmd_id, busCh, a.id, value)
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
		const feedbackDef = schema.feedbacks as Array<optionDef & { cmd_id: number; id: number }>
		console.log('feedbackDef:', JSON.stringify(feedbackDef, null, 2))
		if (!feedbackDef) return feedbacks

		for (const s of feedbackDef) {
			const fbId = `${model}_${s.cmd_id}_${s.id}_state`
			feedbacks[fbId] = {
				name: `${model}: ${s.label} state`,
				type: 'boolean',
				options: [
					{
						id: s.id,
						type: s.type === 'checkbox' ? 'checkbox' : s.type === 'dropdown' ? 'dropdown' : 'textinput',
						label: s.label,
						default: s.default,
						choices: s.choices ?? undefined,
					},
				],
				callback: (feedback: any, state: any) => {
					const current = state?.[model]?.[s.id]
					return current === feedback.options[s.id]
				},
			}
		}
	}

	return feedbacks
}
