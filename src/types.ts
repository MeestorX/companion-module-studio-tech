export interface CompanionInputChoice {
	id: string | number
	label: string
}

export interface DeviceSetting {
	type: string
	label: string
	default: string | number | boolean
	choices?: CompanionInputChoice[]
}

export interface DeviceInfo {
	model: string
	ip: string
	name?: string // Dante device name (user-configurable label, e.g. "Studio-TZ")
	manufacturer?: string // e.g. "Studio Technologies, Inc."
	firmware?: string
	mac?: string
	serial?: string
}

// ─── Studio-T Command ID Constants ────────────────────────────────────────────
export const CMD_BUS_GET = 0x03 // Get setting from specific bus/channel
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
