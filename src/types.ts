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
	firmware?: string
	mac?: string
	serial?: string
}

export const CMD_MIC_PRE_BUS = 0x12
