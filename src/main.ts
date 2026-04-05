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

	/** Currently active model — resolved once in syncModel() and cached here
	 *  so UpdateActions, UpdateFeedbacks etc. don't each call resolveModel independently. */
	activeModel: string = ''

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = config
		if (!this.stController) {
			this.stController = new StController()
		}
		this.updateStatus(InstanceStatus.Connecting, 'Discovering devices...')

		// Wire feedback callback so stController can trigger feedback updates
		this.stController.setFeedbackCallback((feedbackId: string) => {
			this.checkFeedbacks(feedbackId)
		})

		// Start discovery in the background — all model resolution, schema sync,
		// and UI updates happen inside runDiscovery() once the device list is known.
		this.runDiscovery().catch((e) => {
			logger.error(`Discovery failed: ${e}`)
		})
	}

	/**
	 * Run device discovery, then resolve the model and update all UI.
	 * - If discovery finds devices, resolveModel picks from those.
	 * - Only if the list is empty do we fall back to the manual config selection.
	 * All actions/feedbacks/variables are built after the model is known.
	 */
	private async runDiscovery(): Promise<void> {
		logger.info('Starting device discovery...')

		this.discoveredDevices = await this.stController.discoverDevices()

		// Determine effective model — from discovered devices first, manual config only as fallback
		let effectiveModel: string
		if (this.discoveredDevices.length === 0) {
			// If a specific device MAC was saved in config, it wasn't found — stop here.
			if (this.config.deviceMac) {
				const modelLabel = this.config.activeModel ? `Model ${this.config.activeModel} ` : ''
				logger.warn(`Saved device MAC "${this.config.deviceMac}" not found during discovery — stopping`)
				this.updateStatus(InstanceStatus.ConnectionFailure, `${modelLabel}[${this.config.deviceMac}] not found`)
				return
			}
			const manualModel = this.config.activeModel
			if (!this.config.host || !manualModel) {
				logger.warn('No devices discovered and no manual IP/model configured')
				return
			}
			logger.info('No devices discovered — will probe manual IP during authorization')
			effectiveModel = manualModel
		} else {
			logger.info(`Discovered ${this.discoveredDevices.length} device(s):`)
			for (const d of this.discoveredDevices) {
				logger.info(`  - Model ${d.model} ${d.manufacturer ?? ''} @ ${d.ip}`)
			}

			// Authorize all discovered devices so firmware requests can proceed.
			// verifyAuthorization (called below) will revoke any that don't match
			// the current config selection.
			for (const device of this.discoveredDevices) {
				this.stController.authorizeDevice(device.ip)
			}

			// Request firmware version from each discovered device
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

			effectiveModel = resolveModel(this.config, this.discoveredDevices)

			// If a specific MAC was saved but isn't in the discovered list, stop.
			if (!effectiveModel && this.config.deviceMac) {
				const modelLabel = this.config.activeModel ? `Model ${this.config.activeModel} ` : ''
				logger.warn(`Saved device MAC "${this.config.deviceMac}" not found among discovered devices — stopping`)
				this.updateStatus(InstanceStatus.ConnectionFailure, `${modelLabel}[${this.config.deviceMac}] not found`)
				return
			}
		}

		// Sync model schema to controller
		this.syncModel(effectiveModel)

		// Verify that the currently configured host+model is valid now that
		// discovery results are known. This is the same check configUpdated uses.
		const targetHost = this.host
		await this.verifyAuthorization('', targetHost)

		// Build all UI now that model and authorization state are known
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariableDefinitions()
		this.updateVariableValues()

		this.updateStatus(InstanceStatus.Ok)
		logger.info('Device discovery complete')
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

		// Clear variables immediately — the new selection isn't authorized yet.
		// They'll be repopulated below once verifyAuthorization completes.
		this.updateVariableValues()

		const newHost = this.host

		// Re-verify authorization on every config change (model or IP).
		// This handles switching from a valid device to an invalid one and back.
		await this.verifyAuthorization(previousHost, newHost)

		// Rebuild UI after authorization state is settled
		this.updateActions()
		this.updateFeedbacks()
		this.updateVariableDefinitions()
		this.updateVariableValues()
	}

	/**
	 * Re-evaluates whether the current config is authorized to send commands.
	 *
	 * Auto mode (deviceMac set):
	 *   - Find the discovered device with matching MAC → get its current IP
	 *   - Revoke the previous IP, authorize the new IP
	 *   - If MAC not found in discovery, revoke and block
	 *
	 * Manual mode (deviceMac empty):
	 *   - Check discovered list by IP+model match, or probe directly
	 */
	private async verifyAuthorization(previousHost: string, newHost: string): Promise<void> {
		if (!newHost) {
			if (previousHost) this.stController.revokeDevice(previousHost)
			return
		}

		if (this.config.deviceMac) {
			// Auto mode — match by MAC, use whatever IP discovery found it at
			const device = this.discoveredDevices.find((d) => d.mac === this.config.deviceMac)
			if (!device) {
				logger.warn(`Device MAC "${this.config.deviceMac}" not found in current discovery — not authorizing`)
				if (previousHost) this.stController.revokeDevice(previousHost)
				return
			}

			if (previousHost && previousHost !== newHost) {
				this.stController.revokeDevice(previousHost)
			}
			const wasAuthorized = this.stController.isDeviceAuthorized(newHost)
			if (!wasAuthorized) {
				this.stController.authorizeDevice(newHost)
			}
			if (newHost !== previousHost || !wasAuthorized) {
				await this.fetchSettingsAndEnsureSchema(device.model, newHost)
			}
			return
		}

		// Manual mode — config.host + config.activeModel must match
		const manualModel = String(this.config.activeModel ?? '')
		const discoveredAtIp = this.discoveredDevices.find((d) => d.ip === newHost)

		if (discoveredAtIp) {
			if (discoveredAtIp.model === manualModel) {
				if (previousHost && previousHost !== newHost) this.stController.revokeDevice(previousHost)
				const wasAuthorized = this.stController.isDeviceAuthorized(newHost)
				if (!wasAuthorized) {
					this.stController.authorizeDevice(newHost)
				}
				if (newHost !== previousHost || !wasAuthorized) {
					await this.fetchSettingsAndEnsureSchema(manualModel, newHost)
				}
			} else {
				logger.error(
					`Device selected (Model ${manualModel}) does not match detected device (Model ${discoveredAtIp.model}) at ${newHost} — commands blocked`,
				)
				this.stController.revokeDevice(newHost)
				this.updateStatus(
					InstanceStatus.ConnectionFailure,
					`Model mismatch: expected ${manualModel}, got ${discoveredAtIp.model}`,
				)
			}
			return
		}

		// IP not in discovered list — probe it directly via Dante
		logger.info(`${newHost} not in discovered list — probing`)
		if (previousHost && previousHost !== newHost) this.stController.revokeDevice(previousHost)
		this.stController.revokeDevice(newHost)

		const probed = await this.stController.probeDevice(newHost)
		if (!probed) {
			logger.error(`No device responded at ${newHost} — commands blocked`)
			this.updateStatus(InstanceStatus.UnknownWarning, `Device offline: ${newHost}`)
		} else if (probed.model !== manualModel) {
			logger.error(
				`Device selected (Model ${manualModel}) does not match detected device (Model ${probed.model}) at ${newHost} — commands blocked`,
			)
			this.updateStatus(
				InstanceStatus.ConnectionFailure,
				`Model mismatch: expected ${manualModel}, got ${probed.model}`,
			)
		} else {
			logger.info(`Verified Model ${probed.model} at ${newHost}`)
			this.stController.authorizeDevice(newHost)
			await this.fetchSettingsAndEnsureSchema(manualModel, newHost)
			this.updateStatus(InstanceStatus.Ok)
		}
	}

	/**
	 * Fetches all settings from the device. If no schema exists for the model,
	 * creates one from the response and reloads the schema cache.
	 */
	private async fetchSettingsAndEnsureSchema(model: string, ip: string): Promise<void> {
		try {
			await this.stController.requestAllSettings(ip)

			if (!getDeviceSchema(model)) {
				// No schema exists — do NOT auto-create one here.
				// The user must run "GLOBAL: Get All Settings" to create it.
				logger.warn(`No schema found for Model ${model} — run "GLOBAL: Get All Settings" to create one`)
				return
			}
		} catch (e) {
			logger.warn(`Failed to fetch settings from ${ip}: ${e}`)
		}
	}

	/** Loads the device JSON for the given model, caches it as activeModel, and pushes it to the controller. */
	private syncModel(model: string): void {
		this.activeModel = model
		const schema = getDeviceSchema(model)
		if (!schema) {
			logger.warn(`Model "${model}" not found in device schemas`)
			this.stController.setModel(model, [], true)
			return
		}

		const actions = Array.isArray(schema.cmdSchema) ? schema.cmdSchema : []
		const refreshAfterCommand = schema.refreshAfterCommand ?? true

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

	/** Returns the effective host IP, resolved from MAC→IP via discoveredDevices (auto) or config.host (manual). */
	get host(): string {
		return resolveHost(this.config, this.discoveredDevices)
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
