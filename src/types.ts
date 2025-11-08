export interface CompanionInputChoice {
	id: string | number
	label: string
}

export interface CompanionOption {
	type: string
	label: string
	id: string
	default: string | number | boolean
	choices?: CompanionInputChoice[]
}

export interface DeviceSetting {
	type: string
	label: string
	default: string | number | boolean
	choices?: CompanionInputChoice[]
}

export interface DeviceSchema {
	model: string
	settings: Record<string, DeviceSetting>
}

export interface DeviceInfo {
	model: string
	ip: string
	firmware?: string
	mac?: string
	serial?: string
}
