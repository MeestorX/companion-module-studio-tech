import type ModuleInstance from './main.js'

/**
 * Define Companion variables for this module.
 * Variables can be used to display dynamic state in button labels, triggers, etc.
 */
export function UpdateVariableDefinitions(self: ModuleInstance): void {
	self.setVariableDefinitions({
		model: { name: 'Device Model Number' },
		modelName: { name: 'Device Model Name (Full Description)' },
		manufacturer: { name: 'Device Manufacturer' },
		firmware: { name: 'Device Firmware Version' },
		danteFW: { name: 'Dante Module Firmware Version' },
		mac: { name: 'Device MAC Address' },
		ip: { name: 'Device IP Address' },
	})
}

/**
 * Update variable values from discovered device information.
 * Call this after device discovery or when device info changes.
 */
export function UpdateVariableValues(self: ModuleInstance): void {
	// Find the device info for the current host
	const currentHost = self.host
	const device = self.devices.find((d) => d.ip === currentHost)

	if (device) {
		self.setVariableValues({
			model: device.model || 'Unknown',
			modelName: device.modelName || '',
			manufacturer: device.manufacturer || '',
			firmware: device.firmwareMain || 'Unknown',
			danteFW: device.danteFirmware || 'Unknown',
			mac: device.mac || '',
			ip: device.ip || currentHost,
		})
	} else {
		// No device info available - show minimal info
		self.setVariableValues({
			model: self.config.activeModel || 'Unknown',
			modelName: '',
			manufacturer: '',
			firmware: 'Unknown',
			danteFW: 'Unknown',
			mac: '',
			ip: currentHost,
		})
	}
}
