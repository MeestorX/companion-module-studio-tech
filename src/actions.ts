import type { ModuleInstance } from './main.js'
import { buildCompanionActionsFromDir } from './build-commands.js'
import path from 'path'

//const TEMP_NAME = 'Model391'
/**
 * Build Companion action definitions from getCommandParams() output
 */

export function UpdateActions(self: ModuleInstance): void {
	// Generate JSON files (if you haven't already) by running generate_device_files.ts
	const devicesFolder = path.join(import.meta.dirname, '../devices')

	// Build Companion actions (sendFn should call ctl.sendCommandAwaitAck mapping)
	const sendFn = async (model: string, cmdId: number, subId: number, value: any) => {
		// Map commandName -> cmdId and param mapping using the *_commands.json
		// For demo: just log
		console.log('Would send to', model, cmdId, subId, value)
		await self.stController.sendAwaitAck({ model, cmdId, subId, value, destIp: '192.168.1.100' })
	}

	const actions = buildCompanionActionsFromDir(devicesFolder, sendFn)
	console.log('Actions built:', Object.keys(actions))

	self.setActionDefinitions(actions)
}
