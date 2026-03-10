import fs from 'fs'
import path from 'path'
import { Regex, type SomeCompanionConfigField, type JsonObject, createModuleLogger } from '@companion-module/base'

const logger = createModuleLogger('Config')
import type { DeviceInfo } from './types.js'

export interface ModuleConfig extends JsonObject {
	host: string
	activeModel: string
	/** IP of a discovered Dante device, or '' when the user chooses Manual */
	discoveredHost: string
}

// Adjust this path if your folder layout differs
const devicesFolder = path.join(import.meta.dirname, '../devices')

function loadAvailableModels(): string[] {
	try {
		const files = fs.readdirSync(devicesFolder).filter((f) => f.endsWith('.json'))
		const models: string[] = []

		for (const f of files) {
			const fullPath = path.join(devicesFolder, f)
			const j = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
			if (j?.model) {
				models.push(String(j.model))
			}
		}

		return models.sort()
	} catch (_e) {
		logger.error(`Failed to load device models: ${_e}`)
		return []
	}
}

export function GetConfigFields(discoveredDevices: DeviceInfo[] = []): SomeCompanionConfigField[] {
	const models = loadAvailableModels()

	// Build choices mirroring the bonjour-device pattern:
	//   first entry is always 'Manual' (empty value)
	//   then one entry per discovered device
	const deviceChoices = [
		{ id: '', label: 'Manual' },
		...discoveredDevices.map((d) => ({
			id: d.ip,
			label: `Model ${d.model} (${d.ip})`,
		})),
	]

	return [
		// ── Device discovery dropdown ────────────────────────────────────────
		// Mirrors the bonjour-device field: selecting a device populates the
		// host automatically; selecting 'Manual' shows the textinput below.
		{
			type: 'dropdown',
			id: 'discoveredHost',
			label: 'Device',
			width: 8,
			default: '',
			choices: deviceChoices,
			tooltip: 'Select an auto-discovered Studio Technologies Dante device, or choose Manual to enter an IP address.',
		},

		// ── Manual IP entry ──────────────────────────────────────────────────
		// Only visible when discoveredHost is '' (Manual selected).
		// Matches the pattern from the bonjour-device docs.
		{
			type: 'textinput',
			id: 'host',
			label: 'Target IP',
			width: 8,
			default: '',
			regex: Regex.IP,
			isVisibleExpression: `!$(options:discoveredHost)`,
			tooltip: 'Enter the IP address of the device manually.',
		},

		// ── Model selector ───────────────────────────────────────────────────
		// Only visible when Manual mode is selected (no discovered device).
		// When a discovered device is selected, the model is auto-detected.
		{
			type: 'dropdown',
			id: 'activeModel',
			label: 'Active Device Model',
			width: 8,
			default: models[0] ?? '',
			choices: models.map((model) => ({
				id: model,
				label: `Model ${model}`,
			})),
			isVisibleExpression: `!$(options:discoveredHost)`,
			tooltip: 'Select which Studio Technologies model is active for actions and Get All Settings',
		},
	]
}

/**
 * Returns the effective host IP from config — prefers the discovered device
 * IP when one is selected, falls back to the manually entered host.
 */
export function resolveHost(config: ModuleConfig): string {
	return config.discoveredHost || config.host
}

/**
 * Returns the effective model — if a discovered device is selected, extracts
 * its model from the discoveredDevices list; otherwise uses activeModel.
 */
export function resolveModel(config: ModuleConfig, discoveredDevices: DeviceInfo[]): string {
	if (config.discoveredHost) {
		const device = discoveredDevices.find((d) => d.ip === config.discoveredHost)
		console.log(`resolveModel: discoveredHost="${config.discoveredHost}", found device:`, device)
		if (device?.model) {
			return device.model
		}
	}
	console.log(`resolveModel: falling back to activeModel="${config.activeModel}"`)
	return config.activeModel
}
