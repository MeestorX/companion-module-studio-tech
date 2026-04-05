import fs from 'fs'
import path from 'path'
import { Regex, type SomeCompanionConfigField, type JsonObject, createModuleLogger } from '@companion-module/base'
import type { DeviceInfo } from './types.js'

const logger = createModuleLogger('Config')

export type ModuleConfig = JsonObject & {
	/** MAC of the selected discovered device (e.g. "00:1d:c1:9b:a6:cd"), or '' for manual mode */
	deviceMac: string
	/** Manual IP address — only used when deviceMac is '' */
	host: string
	/** Manual model selection — only used when deviceMac is '' */
	activeModel: string
}

// ============================================================================
// CENTRALIZED DEVICE SCHEMA CACHE
// ============================================================================
// All device JSON files are loaded once into memory here. Other modules should
// use getDevicesFolder(), getDeviceSchemas(), and getDeviceSchema() instead of
// reading files directly. Call reloadDeviceSchemas() after writing to a file.
// ============================================================================

/**
 * Determines the correct devices folder path with fallback support.
 * Checks primary path first, then fallback, then throws error if neither exists.
 */
function resolveDevicesFolder(): string {
	const primaryPath = path.join(import.meta.dirname, '../devices')
	const fallbackPath = path.join(import.meta.dirname, './devices')

	// Check primary path
	if (fs.existsSync(primaryPath)) {
		logger.debug(`Using devices folder: ${primaryPath}`)
		return primaryPath
	}

	// Check fallback path
	if (fs.existsSync(fallbackPath)) {
		logger.warn(`Primary devices folder not found, using fallback: ${fallbackPath}`)
		return fallbackPath
	}

	// Neither path exists - fatal error
	const errorMsg = `Devices folder not found!\nTried:\n  - ${primaryPath}\n  - ${fallbackPath}\nModule cannot continue without device schemas.`
	logger.error(errorMsg)
	throw new Error(errorMsg)
}

// Resolve the devices folder path (with existence check and fallback)
const devicesFolder = resolveDevicesFolder()

// In-memory cache of all device schemas, keyed by model number
let deviceSchemasCache: Record<string, any> | null = null

/**
 * Returns the absolute path to the devices folder.
 * Use this instead of redefining the path in every file.
 */
export function getDevicesFolder(): string {
	return devicesFolder
}

/**
 * Loads all device JSON files from the devices folder into memory.
 * This should only be called once at initialization, or after a file is written.
 */
function loadDeviceSchemas(): Record<string, any> {
	const schemas: Record<string, any> = {}
	try {
		const files = fs.readdirSync(devicesFolder).filter((f) => f.endsWith('.json'))

		for (const f of files) {
			const fullPath = path.join(devicesFolder, f)
			const json = JSON.parse(fs.readFileSync(fullPath, 'utf8'))
			if (json?.model) {
				schemas[String(json.model)] = json
			}
		}

		logger.debug(`Loaded ${Object.keys(schemas).length} device schemas into cache`)
	} catch (e) {
		logger.error(`Failed to load device schemas: ${e}`)
	}
	return schemas
}

/**
 * Returns all device schemas from the cache.
 * Initializes the cache on first call.
 */
export function getDeviceSchemas(): Record<string, any> {
	if (!deviceSchemasCache) {
		deviceSchemasCache = loadDeviceSchemas()
	}
	return deviceSchemasCache
}

/**
 * Returns a specific device schema by model number.
 * Returns undefined if the model doesn't exist.
 */
export function getDeviceSchema(model: string): any {
	const schemas = getDeviceSchemas()
	return schemas[model]
}

/**
 * Reloads all device schemas from disk.
 * Call this after writing to a device JSON file.
 */
export function reloadDeviceSchemas(): void {
	logger.info('Reloading device schemas from disk...')
	deviceSchemasCache = loadDeviceSchemas()
}

/**
 * Returns a list of available model numbers, sorted.
 */
function loadAvailableModels(): string[] {
	const schemas = getDeviceSchemas()
	return Object.keys(schemas).sort()
}

export function GetConfigFields(discoveredDevices: DeviceInfo[] = []): SomeCompanionConfigField[] {
	const models = loadAvailableModels()

	// Dropdown id is the device MAC — stable across IP changes.
	// Empty id = Manual mode.
	const deviceChoices = [
		{ id: '', label: 'Manual (enter IP + model below)' },
		...discoveredDevices.map((d) => ({
			id: d.mac ?? '',
			label: `Model ${d.model} [${d.mac}] @ ${d.ip}`,
		})),
	]

	return [
		// ── Device selection dropdown ────────────────────────────────────────
		// Stores the MAC so re-discovery with a changed IP still matches.
		{
			type: 'dropdown',
			id: 'deviceMac',
			label: 'Device',
			width: 8,
			default: '',
			choices: deviceChoices,
			tooltip: 'Select an auto-discovered Studio Technologies device, or choose Manual to enter an IP address.',
		},

		// ── Manual IP entry — only visible in manual mode ────────────────────
		{
			type: 'textinput',
			id: 'host',
			label: 'Target IP',
			width: 8,
			default: '',
			regex: Regex.IP,
			isVisibleExpression: `!$(options:deviceMac)`,
			tooltip: 'Enter the IP address of the device manually.',
		},

		// ── Manual model selector — only visible in manual mode ──────────────
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
			isVisibleExpression: `!$(options:deviceMac)`,
			tooltip: 'Select which Studio Technologies model is active for actions and feedbacks.',
		},
	]
}

/**
 * Returns the effective host IP.
 * Auto mode (deviceMac set): finds the current IP of the discovered device with that MAC.
 * Manual mode (deviceMac empty): returns the manually entered host IP.
 */
export function resolveHost(config: ModuleConfig, discoveredDevices: DeviceInfo[]): string {
	if (config.deviceMac) {
		const device = discoveredDevices.find((d) => d.mac === config.deviceMac)
		return device?.ip ?? ''
	}
	return String(config.host ?? '')
}

/**
 * Returns the effective model.
 * Auto mode: uses the model from the discovered device matching the stored MAC.
 * Manual mode: uses the manually selected activeModel.
 */
export function resolveModel(config: ModuleConfig, discoveredDevices: DeviceInfo[]): string {
	if (config.deviceMac) {
		const device = discoveredDevices.find((d) => d.mac === config.deviceMac)
		logger.debug(`resolveModel: deviceMac="${config.deviceMac}", found device: ${device?.model ?? 'none'}`)
		return device?.model ?? ''
	}
	logger.debug(`resolveModel: manual mode, activeModel="${config.activeModel}"`)
	return String(config.activeModel ?? '')
}
