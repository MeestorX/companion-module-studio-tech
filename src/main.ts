import {
	InstanceTypes,
	InstanceBase,
	InstanceStatus,
	SomeCompanionConfigField,
	createModuleLogger,
} from '@companion-module/base'
import { GetConfigFields, resolveHost, resolveModel, getDeviceSchema, type ModuleConfig } from './config.js'
import { UpdateVariableDefinitions, UpdateVariableValues } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { StController } from './stcontroller.js'
import type { DeviceInfo } from './types.js'

const logger = createModuleLogger('ModuleInstance')

export type ModuleTypes = InstanceTypes & {
	config: ModuleConfig
}

export default class ModuleInstance extends InstanceBase<ModuleTypes> {
	config!: ModuleConfig // Setup in init()
	stController!: StController

	/** Cached discovery results — passed into getConfigFields() so the UI
	 *  can show the discovered device dropdown on subsequent config opens. */
	private discoveredDevices: DeviceInfo[] = []

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = config
		if (!this.stController) {
			this.stController = new StController()
		}
		this.updateStatus(InstanceStatus.Ok)

		// Run discovery to populate the device list FIRST
		this.discoveredDevices = await this.stController.discoverDevices()
		if (this.discoveredDevices.length === 0) {
			logger.warn('No devices discovered')
		} else {
			logger.info(`Discovered ${this.discoveredDevices.length} device(s):`)
			for (const d of this.discoveredDevices) {
				logger.info(`  - Model ${d.model} ${d.manufacturer ?? ''} @ ${d.ip}`)
			}

			// Request device firmware from each discovered device via Studio-T protocol
			for (const device of this.discoveredDevices) {
				try {
					const firmware = await this.stController.requestFirmwareVersion(device.ip)
					device.firmwareMain = firmware
					logger.info(`  - ${device.ip}: Firmware ${firmware}, Dante ${device.danteFirmware}`)
				} catch (e) {
					logger.warn(`  - ${device.ip}: Failed to get firmware: ${e}`)
					device.firmwareMain = 'Unknown'
				}
			}
		}

		// Load device schema and sync to controller for message decoding
		// Use resolveModel to auto-detect model from discovered device if selected
		const effectiveModel = resolveModel(this.config, this.discoveredDevices)
		this.syncModel(effectiveModel)

		// Wire feedback callback so stController can trigger feedback updates
		this.stController.setFeedbackCallback((feedbackId: string) => {
			this.checkFeedbacks(feedbackId)
		})

		// NOW update actions/feedbacks/variables after discovery and model resolution
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariableDefinitions()
		this.updateVariableValues() // Set initial variable values from discovered device

		// Fetch initial settings state from the configured device only
		const targetHost = this.host
		if (targetHost) {
			try {
				await this.stController.requestAllSettings(targetHost)
			} catch (e) {
				logger.warn(`Failed to get all settings from ${targetHost}: ${e}`)
			}
		}
	}

	// When module gets deleted
	async destroy(): Promise<void> {
		this.stController?.close()
		logger.debug('destroy')
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		const previousHost = this.host
		this.config = config
		const effectiveModel = resolveModel(config, this.discoveredDevices)
		this.syncModel(effectiveModel)

		// Rebuild actions, feedbacks, and variables when config changes (model or device selection changed)
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariableDefinitions()
		this.updateVariableValues() // Update variable values when config changes

		// If the host changed, request settings from the new device
		const newHost = this.host
		if (newHost && newHost !== previousHost) {
			try {
				await this.stController.requestAllSettings(newHost)
			} catch (e) {
				logger.warn(`Failed to get all settings from ${newHost}: ${e}`)
			}
		}
	}

	/** Loads the device JSON for the given model and pushes it to the controller. */
	private syncModel(model: string): void {
		const schema = getDeviceSchema(model)
		if (!schema) {
			logger.warn(`Model "${model}" not found in device schemas`)
			this.stController.setModel(model, [], true)
			return
		}

		const actions = Array.isArray(schema.cmdSchema) ? schema.cmdSchema : []
		const refreshAfterCommand = schema.refreshAfterCommand ?? true // Default to true if not specified

		this.stController.setModel(model, actions, refreshAfterCommand)
		if (actions.length === 0) {
			logger.warn(`No actions found for model "${model}" — settings decoding will use raw IDs`)
		} else {
			logger.debug(
				`Loaded ${actions.length} actions for model "${model}", sectioned=${schema.sectioned}, refreshAfterCommand=${refreshAfterCommand}`,
			)
		}
	}

	// Return config fields for web config — include discovered devices so the
	// dropdown is populated. Called by Companion on first load and after
	// setConfigSchemaVersion() triggers a refresh.
	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields(this.discoveredDevices)
	}

	/** Returns the effective host IP, preferring the discovered device selection. */
	get host(): string {
		return resolveHost(this.config)
	}

	/** Returns discovered devices for use in actions/config */
	get devices(): DeviceInfo[] {
		return this.discoveredDevices
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}

	updateVariableValues(): void {
		UpdateVariableValues(this)
	}
}

export { UpgradeScripts }
