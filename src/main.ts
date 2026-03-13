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

		// Wire feedback callback so stController can trigger feedback updates
		this.stController.setFeedbackCallback((feedbackId: string) => {
			//logger.debug(`checkFeedbacks called for: ${feedbackId}`)
			this.checkFeedbacks(feedbackId)
		})

		// Start discovery in the background - don't block init
		this.runDiscovery().catch((e) => {
			logger.error(`Discovery failed: ${e}`)
		})

		// Load device schema and sync to controller for message decoding
		// Use resolveModel to auto-detect model from discovered device if selected
		const effectiveModel = resolveModel(this.config, this.discoveredDevices)

		// Only sync model if we have a valid model
		if (effectiveModel) {
			this.syncModel(effectiveModel)
		} else {
			logger.warn('No model available - skipping model sync')
		}

		// NOW update actions/feedbacks/variables after discovery and model resolution
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariableDefinitions()
		this.updateVariableValues() // Set initial variable values from discovered device
	}

	/**
	 * Run device discovery in the background.
	 * Updates discoveredDevices and refreshes config options when complete.
	 */
	private async runDiscovery(): Promise<void> {
		logger.info('Starting device discovery...')

		// Run discovery to populate the device list
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

		// Re-resolve model now that devices are known
		const effectiveModel = resolveModel(this.config, this.discoveredDevices)
		if (effectiveModel) {
			this.syncModel(effectiveModel)
		}

		this.updateActions()
		this.updateFeedbacks()
		this.updateVariableValues()

		logger.info('Device discovery complete')

		// Fetch initial settings state now that model and devices are known
		const targetHost = this.host
		if (targetHost && effectiveModel) {
			logger.info(`Fetching initial settings from ${targetHost}`)
			try {
				await this.stController.requestAllSettings(targetHost)
				this.updateVariableValues()
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
