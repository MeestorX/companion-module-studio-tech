import type { ModuleInstance } from './main.js'
import { buildActions } from './build-commands.js'
import path from 'path'

/**
 * Build Companion action definitions from buildActions() output
 */

export function UpdateActions(self: ModuleInstance): void {
	// Generate JSON files (if you haven't already) by running generate_device_files.ts
	const devicesFolder = path.join(import.meta.dirname, '../devices')

	// Build Companion actions (sendFn should call ctl.sendCommandAwaitAck mapping)
	const sendFn = async (model: string, cmdId: number, busCh: number | undefined, settingId: number, value: any) => {
		// Map commandName -> cmdId and param mapping using the *_commands.json
		// For demo: just log
		console.log('busCh:', busCh)
		console.log(
			`Sending Model: Model${model}, cmdId: ${cmdId.toString(16).padStart(2, '0')}, busCh: ${busCh?.toString(16).padStart(2, '0')}, settingId: ${settingId.toString(16).padStart(2, '0')}, value: ${value.toString(16).padStart(2, '0')}`,
			`to Model${model} at ${self.config.host}`,
		)
		console.log(
			`Reply from Model${model}`,
			await self.stController.sendAwaitAck(model, cmdId, busCh, settingId, value, self.config.host),
		)
	}

	const actions = buildActions(devicesFolder, sendFn)
	console.log('Actions built:', Object.keys(actions).length)

	self.setActionDefinitions(actions)
}
