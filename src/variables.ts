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

const CLEARED_VARIABLES = {
	model: '',
	modelName: '',
	manufacturer: '',
	firmware: '',
	danteFW: '',
	mac: '',
	ip: '',
}

/**
 * Update variable values from discovered device information.
 * Only populates variables when the current host is authorized.
 * Clears all variables if the device is not authorized or not found.
 */
export function UpdateVariableValues(self: ModuleInstance): void {
	const currentHost = self.host

	// Clear variables if no host configured or device is not authorized
	if (!currentHost || !self.stController.isDeviceAuthorized(currentHost)) {
		self.setVariableValues(CLEARED_VARIABLES)
		return
	}

	const device = self.devices.find((d) => d.ip === currentHost)
	if (device) {
		self.setVariableValues({
			model: device.model || '',
			modelName: device.modelName || '',
			manufacturer: device.manufacturer || '',
			firmware: device.firmwareMain || '',
			danteFW: device.danteFirmware || '',
			mac: device.mac || '',
			ip: device.ip,
		})
	} else {
		// Authorized but not in discovered list (manual IP that probed successfully)
		// We know it's the right device but don't have full info yet
		self.setVariableValues({
			...CLEARED_VARIABLES,
			ip: currentHost,
		})
	}
}
