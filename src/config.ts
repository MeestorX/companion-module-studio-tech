import fs from 'fs'
import path from 'path'
import { Regex, type SomeCompanionConfigField, type JsonObject, createModuleLogger } from '@companion-module/base'

const logger = createModuleLogger('Config')
import type { DeviceInfo } from './types.js'

export type ModuleConfig = JsonObject & {
	host: string
	activeModel: string
	/** IP of a discovered Dante device, or '' when the user chooses Manual */
	discoveredHost: string
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
		logger.debug(`resolveModel: discoveredHost="${config.discoveredHost}", found device: ${device?.model ?? 'none'}`)
		if (device?.model) {
			return device.model
		}
	}
	logger.debug(`resolveModel: falling back to activeModel="${config.activeModel}"`)
	return config.activeModel
}
