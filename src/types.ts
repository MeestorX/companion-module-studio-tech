export type CompanionInputChoice = {
	id: string | number
	label: string
}

export type DeviceSetting = {
	type: string
	label: string
	default: string | number | boolean
	choices?: CompanionInputChoice[]
}

export type DeviceInfo = {
	model: string // Model number (e.g., "374A")
	modelName?: string // Full model description (e.g., "Model 374A Intercom Beltpack")
	ip: string
	name?: string // Dante device name (user-configurable label, e.g. "ST-M374A-Beltpack")
	manufacturer?: string // e.g. "Studio Technologies, Inc."
	firmwareMain?: string // Device firmware version from Dante discovery (e.g., "4.9.0")
	danteFirmware?: string // Dante module firmware version
	mac?: string
}

// ─── Studio-T Command ID Constants ────────────────────────────────────────────
export const CMD_GET_FIRMWARE = 0x00 // Request device firmware version
export const CMD_BUS_GET = 0x03 // Heartbeat / keepalive ping
export const CMD_BUS_SET = 0x04 // Set setting on specific bus/channel
export const CMD_HEADPHONE = 0x05 // Headphone controls (reserved for future use)
export const CMD_BUTTON_MODE = 0x07 // Button mode configuration (reserved for future use)
export const CMD_SYSTEM = 0x09 // System-level commands (reserved for future use)
export const CMD_GET_ALL_SETTINGS = 0x0a // Request all current settings from device
export const CMD_SETTINGS_PUSH = 0x0b // Unsolicited settings update from device
export const CMD_DEV_SPEC = 0x0d // Device-specific setting get/set with ACK
export const CMD_RESET_DEVICE = 0x0e // Factory reset command
export const CMD_GLOBAL_MIC_KILL = 0x10 // Emergency mic kill (all channels)
export const CMD_MIC_PRE_BUS = 0x12 // Mic/preamp settings per bus (gain, phantom, etc)
export const CMD_CHANNEL = 0x14 // Channel-specific controls (reserved for future use)

// ─── Command Name Helper ──────────────────────────────────────────────────────
export function getCommandName(cmdId: number): string {
	switch (cmdId) {
		case CMD_GET_FIRMWARE:
			return 'Get Firmware Version'
		case CMD_BUS_GET:
			return 'Heartbeat'
		case CMD_BUS_SET:
			return 'Set Bus Setting'
		case CMD_HEADPHONE:
			return 'Headphone Control'
		case CMD_BUTTON_MODE:
			return 'Button Mode'
		case CMD_SYSTEM:
			return 'System Command'
		case CMD_GET_ALL_SETTINGS:
			return 'Request All Settings'
		case CMD_SETTINGS_PUSH:
			return 'Settings Push'
		case CMD_MIC_PRE_BUS:
			return 'Mic/Pre Bus'
		case CMD_DEV_SPEC:
			return 'Device Setting'
		case CMD_CHANNEL:
			return 'Channel Setting'
		case CMD_RESET_DEVICE:
			return 'Reset Device'
		case CMD_GLOBAL_MIC_KILL:
			return 'Global Mic Kill'
		default:
			return `cmd_0x${cmdId.toString(16).padStart(2, '0')}`
	}
}

// ─── ID Generation Helper ──────────────────────────────────────────────────────
/**
 * Creates a consistent ID for actions, feedbacks, and state keys.
 * Format: `${model}_${cmd_id}_${busCh}_${id}` for commands with busCh (e.g., "5304_14_0_0")
 * Format: `${model}_${cmd_id}_${id}` for commands without busCh (e.g., "5304_12_d")
 */
export function makeSettingId(
	model: string,
	cmdId: number | string,
	settingId: number | string,
	busCh?: number | string,
): string {
	const cmd = typeof cmdId === 'number' ? cmdId.toString(16) : cmdId
	const id = typeof settingId === 'number' ? settingId.toString(16) : settingId

	if (busCh !== undefined) {
		const ch = typeof busCh === 'number' ? busCh.toString(16) : busCh
		return `${model}_${cmd}_${ch}_${id}`
	}

	return `${model}_${cmd}_${id}`
}

// ─── Hex Formatting Helpers ───────────────────────────────────────────────────
/**
 * Converts a number to a hex string with 0x prefix and padding.
 * @param value - The number to convert
 * @param padLength - Number of hex digits to pad to (default: 2)
 * @returns Formatted hex string (e.g., "0x0d", "0xff")
 */
export function toHex(value: number, padLength = 2): string {
	return `0x${value.toString(16).padStart(padLength, '0')}`
}

/**
 * Converts an array of bytes to a hex string with 0x prefix.
 * @param bytes - Array of bytes or Buffer
 * @returns Formatted hex string (e.g., "0x0aff12")
 */
export function bytesToHex(bytes: number[] | Buffer): string {
	return `0x${Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')}`
}

/**
 * Formats RGB color bytes as a CSS hex color string.
 * @param r - Red component (0-255)
 * @param g - Green component (0-255)
 * @param b - Blue component (0-255)
 * @returns CSS hex color string (e.g., "#FF00AB")
 */
export function formatRgbColor(r: number, g: number, b: number): string {
	return `#${[r, g, b]
		.map((v) => v.toString(16).padStart(2, '0'))
		.join('')
		.toUpperCase()}`
}

// ─── ID Parsing Helper ────────────────────────────────────────────────────────
/**
 * Parses a setting ID string into its components.
 * @param id - Setting ID string (e.g., "391_d_0" or "5304_14_0_1")
 * @returns Parsed components with hex strings converted to numbers
 */
export function parseSettingId(id: string): { model: string; cmdId: number; baseId: number } {
	const [model, cmdIdStr, idStr] = id.split('_')
	return {
		model,
		cmdId: parseInt(cmdIdStr, 16),
		baseId: parseInt(idStr, 16),
	}
}

// ─── Model Distance Helper ────────────────────────────────────────────────────
/**
 * Calculates numeric distance between two model numbers.
 * Used for finding similar models for setting inference.
 * @param modelA - First model number (e.g., "391")
 * @param modelB - Second model number (e.g., "392")
 * @returns Numeric distance between models, or Infinity if either is non-numeric
 */
export function modelDistance(modelA: string, modelB: string): number {
	const na = parseInt(modelA.replace(/\D/g, ''), 10)
	const nb = parseInt(modelB.replace(/\D/g, ''), 10)
	if (Number.isNaN(na) || Number.isNaN(nb)) return Infinity
	return Math.abs(na - nb)
}

// ─── Schema Normalization Helper ──────────────────────────────────────────────
/**
 * Normalizes device schemas to ensure cmdSchema is always an array.
 * This helper eliminates duplicate schema transformation code.
 * @param schemasRaw - Raw schemas from getDeviceSchemas()
 * @returns Normalized schemas with guaranteed cmdSchema arrays
 */
export function getNormalizedSchemas(
	schemasRaw: Record<string, any>,
): Record<string, { model: string; cmdSchema: any[] }> {
	const normalized: Record<string, { model: string; cmdSchema: any[] }> = {}
	for (const [model, json] of Object.entries(schemasRaw)) {
		normalized[model] = {
			model: json.model,
			cmdSchema: Array.isArray(json.cmdSchema) ? json.cmdSchema : [],
		}
	}
	return normalized
}

// ─── Action Lookup Helper ─────────────────────────────────────────────────────
/**
 * Finds an action/setting in the schema, supporting both exact matches and idAdd offsets.
 * This helper eliminates duplicate action lookup logic across multiple files.
 * @param schemas - Normalized device schemas
 * @param model - Device model (e.g., "391")
 * @param cmdId - Command ID
 * @param settingId - Setting ID (may include idAdd offset)
 * @returns Matching action/setting or undefined
 */
export function findActionForSetting(
	schemas: Record<string, { model: string; cmdSchema: any[] }>,
	model: string,
	cmdId: number,
	settingId: number,
): any {
	const schema = schemas[model]
	if (!schema || !Array.isArray(schema.cmdSchema)) return undefined

	// Try exact match first
	let action = schema.cmdSchema.find((s: any) => s.cmd_id === cmdId && s.id === settingId)

	// If no exact match, try to find base action with idAdd
	if (!action) {
		action = schema.cmdSchema.find((s: any) => {
			if (s.cmd_id !== cmdId) return false
			const idAddOption = s.options?.find((opt: any) => opt.id === 'idAdd')
			if (!idAddOption?.choices) return false
			// Check if settingId matches base + any idAdd offset
			const offset = settingId - s.id
			return idAddOption.choices.some((c: any) => c.id === offset)
		})
	}

	return action
}
