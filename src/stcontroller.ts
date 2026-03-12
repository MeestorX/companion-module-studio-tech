import dgram from 'dgram'
import os from 'os'
import { createModuleLogger } from '@companion-module/base'
import {
	CMD_BUS_GET,
	CMD_BUS_SET,
	CMD_DEV_SPEC,
	CMD_GET_ALL_SETTINGS,
	CMD_GLOBAL_MIC_KILL,
	CMD_MIC_PRE_BUS,
	CMD_RESET_DEVICE,
	CMD_SETTINGS_PUSH,
	getCommandName,
	makeSettingId,
	type DeviceInfo,
} from './types.js'
import {
	parseGetAllSettingsForModel,
	parseSettingsResponse,
	formatParsedSetting,
	type StAction,
} from './settingsParser.js'
import {
	DANTE_MSG_INFO_RESPONSE,
	parseDanteInfoResponse,
	discoverDevices,
	getLocalAddressForDestination,
} from './dante.js'

const logger = createModuleLogger('StController')

export class StController {
	private readonly defaultPort: number = 8700
	private readonly multicastGroup = '224.0.0.231'
	private readonly rxPort = 8702

	private txSocket: dgram.Socket
	private rxSocket: dgram.Socket // for receiving responses (8702)
	private pendingAcks: Map<
		string,
		{ resolve: (buf: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
	>
	private joinedInterfaces: Set<string> = new Set() // local IPs we've joined multicast on

	/** Resolves once txSocket is bound and ready to send */
	private txReady: Promise<void>

	/** Active device model and action definitions for settings decoding */
	private model: string = ''
	private actions: StAction[] = []
	private refreshAfterCommand: boolean = true // Default to true (most devices need it)

	/**
	 * Known state of every setting per device IP.
	 * Keyed by IP → Map of "${cmdId}/${settingId}" → current value byte.
	 * Populated on connect via requestAllSettings(), updated on every CMD_SETTINGS_PUSH (0x0b).
	 * Used to diff incoming pushes (changed = info, unchanged = debug) and for feedbacks.
	 */
	private deviceState: Map<string, Map<string, number>> = new Map()

	/** Callbacks registered by discoverDevices() — keyed by source IP */
	private discoveryListeners: Map<string, (device: DeviceInfo) => void> = new Map()

	/** Callback to trigger feedback updates when state changes */
	private feedbackCallback?: (feedbackId: string) => void

	constructor() {
		logger.info('StController initialized')

		this.pendingAcks = new Map()

		// Send socket — bind to ephemeral port. Responses always go to rxSocket on
		// port 8702 (Dante hardcodes the response destination port to 8702).
		this.txSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
		this.txReady = new Promise<void>((resolve) => {
			this.txSocket.bind(0, () => {
				logger.debug(`TX socket bound to port ${(this.txSocket.address() as { port: number }).port}`)
				resolve()
			})
		})
		this.txSocket.on('error', (err) => {
			logger.error(`TX socket error: ${err}`)
		})

		// Receive socket - bind to all addresses so kernel can deliver multicast packets
		this.rxSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

		this.rxSocket.on('listening', () => {
			const addr = this.rxSocket.address()
			logger.debug(`RX socket listening on ${JSON.stringify(addr)}`)
			try {
				this.rxSocket.setMulticastLoopback(true)
			} catch (_e) {
				/* ignore */
			}
		})

		this.rxSocket.on('error', (err) => {
			logger.error(`RX socket error: ${err}`)
		})

		this.rxSocket.on('message', (msg, rinfo) => {
			try {
				this.handleIncoming(msg, rinfo.address)
			} catch (_e) {
				logger.error(`Error handling incoming message: ${_e}`)
			}
		})

		// Bind to wildcard so kernel can deliver multicast packets for joined interfaces
		this.rxSocket.bind({ address: '0.0.0.0', port: this.rxPort }, () => {
			logger.debug(`RX socket bound to 0.0.0.0:${this.rxPort}`)
		})
	}

	public close(): void {
		try {
			for (const localAddr of Array.from(this.joinedInterfaces)) {
				try {
					this.rxSocket.dropMembership(this.multicastGroup, localAddr)
				} catch {
					/* ignore */
				}
			}
		} catch {
			/* ignore */
		}
		try {
			this.rxSocket.close()
		} catch {
			/* ignore */
		}
		try {
			this.txSocket.close()
		} catch {
			/* ignore */
		}
	}

	/**
	 * Provide the active device model and action definitions so incoming messages
	 * can be decoded into human-readable names. Call from main.ts after config load.
	 */
	public setModel(model: string, actions: StAction[], refreshAfterCommand: boolean = true): void {
		this.model = model
		this.actions = actions
		this.refreshAfterCommand = refreshAfterCommand
	}

	/**
	 * Set callback to trigger when device state changes (for feedbacks).
	 * Call from main.ts to wire up checkFeedbacks.
	 */
	public setFeedbackCallback(callback: (feedbackId: string) => void): void {
		this.feedbackCallback = callback
	}

	/**
	 * Send a CMD_GET_ALL_SETTINGS (0x0a) request to the device and store the response
	 * in deviceState. Returns the raw response buffer for parsing.
	 */
	public async requestAllSettings(deviceIp: string): Promise<Buffer> {
		logger.info(`Requesting all settings from ${deviceIp}`)
		const response = await this.sendAwaitAck(
			this.model,
			CMD_GET_ALL_SETTINGS,
			undefined,
			undefined,
			undefined,
			deviceIp,
			false,
		)

		// Debug: Log the raw response
		console.log('Raw response buffer:', response.toString('hex'))
		console.log('Response length:', response.length)

		// Parse and store in deviceState
		const parsed = parseGetAllSettingsForModel(this.model, response)
		console.log('Parsed settings count:', parsed.length)
		if (parsed.length > 0) {
			console.log('First few settings:', parsed.slice(0, 3))
		}

		const stateMap = new Map<string, number>()
		for (const setting of parsed) {
			const key = makeSettingId(this.model, setting.cmd_id, setting.id, setting.busCh)
			// For RGB colors (3 bytes), pack into single number: (R << 16) | (G << 8) | B
			const value =
				setting.valueBytes.length === 3
					? (setting.valueBytes[0] << 16) | (setting.valueBytes[1] << 8) | setting.valueBytes[2]
					: (setting.valueBytes[0] ?? 0)
			stateMap.set(key, value)
		}
		this.deviceState.set(deviceIp, stateMap) // Return buffer for caller to parse if needed
		return response
	} /** Return a snapshot of the current device state for a given IP (for feedbacks). */
	public getDeviceState(deviceIp: string): Map<string, number> {
		return this.deviceState.get(deviceIp) ?? new Map()
	}

	/**
	 * Discovers Studio Technologies Dante devices on the local network.
	 *
	 * Strategy:
	 *  Dante devices broadcast a 1-second announce to multicast 224.0.0.233:8708.
	 *  We listen on that group, collect source IPs, then send a unicast device info
	 *  request (0x0020) to each new IP on port 8700. The device responds to our IP
	 *  on port 8702 (rxSocket), where handleIncoming() picks it up and fires the
	 *  discoveryListeners callback.
	 */
	public async discoverDevices(timeoutMs = 5000): Promise<DeviceInfo[]> {
		// Register listener — handleIncoming() fires this for each 0x0170 response
		const DISCOVERY_KEY = '__discovery__'
		const foundDevices: DeviceInfo[] = []

		const onDeviceFound = (device: DeviceInfo) => {
			foundDevices.push(device)
		}

		// Register the callback so handleIncoming() can invoke it when 0x0170 arrives
		this.discoveryListeners.set(DISCOVERY_KEY, onDeviceFound)

		try {
			await this.txReady
			// discoverDevices() in dante.ts handles the announce listening and query sending
			// Responses come back to rxSocket → handleIncoming() → discoveryListeners
			await discoverDevices(
				this.txSocket,
				onDeviceFound, // dante.ts doesn't actually use this, but kept for compatibility
				async (destIp) => this.ensureMembershipFor(destIp),
				timeoutMs,
			)
			return foundDevices
		} finally {
			this.discoveryListeners.delete(DISCOVERY_KEY)
		}
	}

	/**
	 * Ensure we've joined the multicast group on the interface that routes to destIp.
	 * Option B behavior: join ONLY the interface used to reach the device.
	 */
	private async ensureMembershipFor(destIp: string): Promise<void> {
		try {
			const localAddr = await getLocalAddressForDestination(destIp)
			if (!localAddr) {
				logger.warn(`Could not determine local address for destination ${destIp}`)
				return
			}

			if (this.joinedInterfaces.has(localAddr)) {
				// already joined
				return
			}

			try {
				this.rxSocket.addMembership(this.multicastGroup, localAddr)
				this.joinedInterfaces.add(localAddr)
				logger.info(`Joined multicast ${this.multicastGroup} on ${localAddr}`)
			} catch (_e) {
				logger.warn(`Failed to join multicast on ${localAddr}: ${String(_e)}`)
			}
		} catch (_e) {
			logger.warn(`ensureMembershipFor failed: ${_e}`)
		}
	}

	public async sendAwaitAck(
		model: string,
		cmdId: number,
		busCh: number | undefined,
		settingId: number | undefined,
		value: unknown,
		destIp: string,
		addLen = true,
	): Promise<Buffer> {
		const timeoutMs = 2000

		// Ensure we are listening for replies on the interface that will receive them
		await this.ensureMembershipFor(destIp)

		const dataBlock: number[] = []
		if (settingId !== undefined) dataBlock.push(settingId & 0xff)
		if (value !== undefined) dataBlock.push(...StController.buildValueBytes(value))

		const payloadBody: number[] = [0x5a, cmdId & 0xff]

		if (busCh !== undefined) payloadBody.push(busCh & 0xff)
		if (addLen) payloadBody.push(dataBlock.length)

		if (dataBlock.length > 0) payloadBody.push(...dataBlock)

		const crc = StController.crc8DvbS2(payloadBody)
		const payloadWithCrc = Buffer.from([...payloadBody, crc])

		const totalLen = 24 + payloadWithCrc.length
		const header = await StController.buildHeader(totalLen, destIp)
		const packet = Buffer.concat([header, payloadWithCrc])

		// Human-readable info log for the outgoing command
		const cmdName = getCommandName(cmdId)
		if (settingId !== undefined && value !== undefined) {
			// Try exact match first
			let action = this.actions.find((a) => a.cmd_id === cmdId && a.id === settingId)

			// If no exact match, try to find action with idAdd option
			if (!action) {
				action = this.actions.find((a) => {
					if (a.cmd_id !== cmdId) return false
					const hasIdAdd = a.options?.some((opt) => opt.id === 'idAdd')
					if (!hasIdAdd) return false
					return settingId >= a.id && settingId < a.id + 10
				})
			}

			let settingName = action?.name ?? 'Unknown Setting'

			// If this action has idAdd and the setting id is offset from base, include channel info
			if (action) {
				const hasIdAdd = action.options?.some((opt) => opt.id === 'idAdd')
				if (hasIdAdd && settingId !== action.id) {
					const channelOffset = settingId - action.id
					settingName = `${settingName} Ch${channelOffset + 1}`
				}
			}

			// Look for the value option to get choices
			const valueOption = action?.options?.find((opt) => opt.id === 'value')
			const choices = valueOption?.choices
			const valueBytes = StController.buildValueBytes(value)
			const valueNum = valueBytes.length === 1 ? valueBytes[0] : undefined
			const choiceLabel = choices && valueNum !== undefined ? choices.find((c) => c.id === valueNum)?.label : undefined

			const cmdHex = `0x${cmdId.toString(16).padStart(2, '0')}`
			const idHex = `0x${settingId.toString(16).padStart(2, '0')}`
			const valHex = `0x${valueBytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`
			const valDec = valueBytes.length === 1 ? valueBytes[0] : valueBytes.join(',')

			const prefix = `cmd:${cmdHex} id:${idHex} val:${valHex}`
			const suffix = choiceLabel ? `${settingName}: ${choiceLabel} (${valDec})` : `${settingName}: ${valDec}`

			logger.info(`TX ${destIp} | ${prefix} | ${suffix}`)
		} else {
			logger.info(`TX ${destIp} | ${cmdName}`)
		}
		logger.debug(`Sending packet to ${destIp}: ${packet.toString('hex')}`)

		await this.txReady

		const key = `${destIp}:${cmdId}`

		return new Promise<Buffer>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingAcks.delete(key)
				reject(new Error(`Timeout waiting for ACK from Model${model} at ${destIp}:8700`))
			}, timeoutMs)

			this.pendingAcks.set(key, {
				resolve: (buf) => {
					clearTimeout(timer)

					// If device requires refresh after command, request all settings (non-blocking)
					if (this.refreshAfterCommand && settingId !== undefined) {
						this.requestAllSettings(destIp).catch((err) => {
							logger.warn(`Failed to refresh settings after command: ${err}`)
						})
					}

					resolve(buf)
				},
				reject: (err) => {
					clearTimeout(timer)
					reject(err)
				},
				timer,
			})

			this.txSocket.send(packet, this.defaultPort, destIp, (err) => {
				if (err) {
					this.pendingAcks.delete(key)
					clearTimeout(timer)
					reject(new Error(err.message ?? String(err)))
				}
			})
		})
	}

	private handleIncoming(msg: Buffer, srcIp: string) {
		if (msg.length < 4) return
		if (msg[0] !== 0xff || msg[1] !== 0xff) return

		const msgType = msg.readUInt16BE(2)

		// ── Dante device info response (0x0170) ──────────────────────────────
		// These have "Audinate" at offset 16, not "Studio-T" — handle before
		// the Studio-T signature check below.
		if (msgType === DANTE_MSG_INFO_RESPONSE && this.discoveryListeners.size > 0) {
			const device = parseDanteInfoResponse(msg, srcIp)
			if (device) {
				for (const cb of this.discoveryListeners.values()) {
					try {
						cb(device)
					} catch {
						/* ignore */
					}
				}
			}
			return
		}

		if (msg.length < 25) return

		// ── Studio-T control protocol ─────────────────────────────────────────
		const sig = msg.subarray(16, 24)
		if (sig.toString('ascii') !== 'Studio-T') return

		// Payload starts at offset 24
		// Layout: [0x5a] [cmdId|0x80] [data...] [crc]
		const stPayload = msg.subarray(24)
		if (stPayload.length < 2) return
		if (stPayload[0] !== 0x5a) return

		// Device replies with cmd | 0x80
		const respCmdId = stPayload[1]
		const isResponse = (respCmdId & 0x80) !== 0
		const originalCmdId = respCmdId & 0x7f // strip the response flag

		// Log the payload (works for both requests and responses)
		this.logStPayload(srcIp, originalCmdId, msg, stPayload, isResponse)

		// Only process as ACK if this is a response to our request
		if (isResponse) {
			const key = `${srcIp}:${originalCmdId}`
			const pending = this.pendingAcks.get(key)
			if (pending) {
				this.pendingAcks.delete(key)
				pending.resolve(msg)
			}
		}
		// Unsolicited messages and requests from other sources are logged above
	}

	/**
	 * Decodes and logs a Studio-T response payload.
	 * Receives both the full msg (for parsers that need the Studio-T header)
	 * and stPayload (msg.subarray(24), for direct byte access).
	 *
	 * stPayload layout:
	 *   [0]      0x5a  magic
	 *   [1]      cmdId | 0x80
	 *   [2..-2]  data bytes
	 *   [-1]     CRC-8/DVB-S2
	 */
	private logStPayload(srcIp: string, cmdId: number, msg: Buffer, stPayload: Buffer, isResponse = true): void {
		const cmdName = `cmd_0x${cmdId.toString(16).padStart(2, '0')}`
		const data = stPayload.subarray(2, stPayload.length - 1) // strip magic+cmdId header and CRC

		// Show complete payload structure: [0x5a] [cmdId|0x80] [data bytes...] [crc]
		const magic = stPayload[0]
		const respCmdId = stPayload[1]
		const crc = stPayload[stPayload.length - 1]
		const fullStructure = `[magic:0x${magic.toString(16).padStart(2, '0')} cmd:0x${respCmdId.toString(16).padStart(2, '0')} data:${data.toString('hex')} crc:0x${crc.toString(16).padStart(2, '0')}]`

		// Determine direction prefix
		const direction = isResponse ? 'RX' : 'SNIFF'

		// ── CMD_GET_ALL_SETTINGS (0x0a) and CMD_SETTINGS_PUSH (0x0b) ────────────────
		// Parse all settings, diff against deviceState, log changed at info / unchanged at debug,
		// then update deviceState. CMD_GET_ALL_SETTINGS also serves as the initial state population on connect.
		if (cmdId === CMD_GET_ALL_SETTINGS || cmdId === CMD_SETTINGS_PUSH) {
			if (!this.model) {
				logger.info(`${direction} ${srcIp} | ${cmdName} | ${fullStructure}`)
				return
			}
			try {
				const settings =
					cmdId === CMD_SETTINGS_PUSH
						? parseSettingsResponse(this.model, msg)
						: parseGetAllSettingsForModel(this.model, msg)

				const prevState = this.deviceState.get(srcIp) ?? new Map<string, number>()
				const newState = new Map<string, number>(prevState) // copy — update in place

				for (const s of settings) {
					const stateKey = makeSettingId(this.model, s.cmd_id, s.id, s.busCh)
					// For RGB colors (3 bytes), pack into single number: (R << 16) | (G << 8) | B
					const newValue =
						s.valueBytes.length === 3
							? (s.valueBytes[0] << 16) | (s.valueBytes[1] << 8) | s.valueBytes[2]
							: (s.valueBytes[0] ?? 0)
					const prevValue = prevState.get(stateKey)
					const changed = prevValue !== undefined && prevValue !== newValue

					newState.set(stateKey, newValue)

					const formatted = formatParsedSetting(s, this.actions)
					if (changed) {
						logger.info(`${direction} ${srcIp} | ${formatted}`)
						// Trigger feedback update for this setting
						if (this.feedbackCallback) {
							this.feedbackCallback(stateKey)
						}
					} else {
						logger.debug(`${direction} ${srcIp} | ${formatted}`)
					}
				}
				this.deviceState.set(srcIp, newState)
			} catch (e) {
				logger.warn(`${direction} ${srcIp} | ${cmdName} | parse failed: ${e} | ${fullStructure}`)
			}
			return
		}

		// ── All other commands ────────────────────────────────────────────────────
		const decoded = this.decodeStData(cmdId, data)
		if (decoded) {
			logger.info(`${direction} ${srcIp} | ${cmdName} | ${fullStructure} | ${decoded}`)
		} else {
			logger.info(`${direction} ${srcIp} | ${cmdName} | ${fullStructure}`)
		}
	}

	/**
	 * Attempts to decode the data bytes of a Studio-T response into a
	 * human-readable string. Returns null to fall back to raw hex.
	 *
	 * msg is the full packet buffer — required by the settings parsers which
	 * locate the Studio-T signature themselves.
	 */
	private decodeStData(cmdId: number, data: Buffer): string | null {
		if (data.length === 0) return 'ACK'

		// ── Check for single-byte responses (ACK or error) ──────────
		if (data.length === 1) {
			if (data[0] === 0x00) {
				return 'ACK ok'
			} else {
				return `ERROR 0x${data[0].toString(16).padStart(2, '0')}`
			}
		}

		switch (cmdId) {
			// ── CMD_DEV_SPEC (0x0d): single-byte ACK or echo of applied setting ──
			// Device sends two CMD_DEV_SPEC packets in response to a set:
			//   1. ACK:  [status]               (1 byte, 0x00 = ok)
			//   2. Echo: [busCh] [settingId] [value...]  (confirming what was applied)
			case CMD_DEV_SPEC: {
				if (data.length === 1) {
					return data[0] === 0x00 ? 'ACK ok' : `ACK err=0x${data[0].toString(16).padStart(2, '0')}`
				}
				if (data.length >= 3) {
					const busCh = data[0]
					const settingId = data[1]
					const valueBytes = data.subarray(2)
					const action = this.actions.find((a) => a.cmd_id === cmdId && a.id === settingId)
					const settingName = action?.name ?? `setting=0x${settingId.toString(16).padStart(2, '0')}`
					const choices = action?.options?.[0]?.choices
					const valueNum = valueBytes.length === 1 ? valueBytes[0] : undefined
					const choiceLabel =
						choices && valueNum !== undefined ? choices.find((c) => c.id === valueNum)?.label : undefined
					const valueStr = choiceLabel
						? `${choiceLabel} (0x${valueNum!.toString(16).padStart(2, '0')})`
						: `0x${Array.from(valueBytes)
								.map((b) => b.toString(16).padStart(2, '0'))
								.join('')}`
					const rawTag = `[0x${cmdId.toString(16).padStart(2, '0')}/0x${settingId.toString(16).padStart(2, '0')}]=0x${Array.from(
						valueBytes,
					)
						.map((b) => b.toString(16).padStart(2, '0'))
						.join('')}`
					return `echo ch=${busCh} | ${settingName}: ${valueStr} ${rawTag}`
				}
				return `raw: ${data.toString('hex')}`
			}

			// ── CMD_MIC_PRE_BUS (0x12): Multi-byte echo responses ─────────────
			case CMD_MIC_PRE_BUS: {
				// Already handled single-byte above, so multi-byte must be echo
				if (data.length >= 3) {
					const busCh = data[0]
					const settingId = data[1]
					const valueBytes = data.subarray(2)
					const action = this.actions.find((a) => a.cmd_id === cmdId && a.id === settingId)
					const settingName = action?.name ?? `setting=0x${settingId.toString(16).padStart(2, '0')}`
					const valueNum = valueBytes.length === 1 ? valueBytes[0] : undefined
					const choices = action?.options?.find((o) => o.id === 'value')?.choices
					const choiceLabel =
						choices && valueNum !== undefined ? choices.find((c) => c.id === valueNum)?.label : undefined
					const valueStr = choiceLabel ?? `0x${valueBytes.toString('hex')}`
					return `echo ch=${busCh} | ${settingName}: ${valueStr}`
				}
				return null
			}

			// ── Bus-scoped get/set ────────────────────────────────────────────
			case CMD_BUS_GET:
			case CMD_BUS_SET: {
				if (data.length < 2) return null
				const busCh = data[0]
				const settingId = data[1]
				const value = data.subarray(2)
				return `ch=${busCh} setting=0x${settingId.toString(16).padStart(2, '0')} value=${value.toString('hex')}`
			}

			default:
				return null // fall through to raw hex
		}
	}

	private static buildValueBytes(value: unknown): number[] {
		if (typeof value === 'boolean') return [value ? 1 : 0]
		if (Array.isArray(value)) return value.map((v) => Number(v) & 0xff)
		if (typeof value === 'number') {
			if (value > 0xff) return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
			return [value & 0xff]
		}
		throw new Error(`Unsupported value type for STcontroller: ${value}`)
	}

	private static async getMacForDestination(destIp: string): Promise<number[]> {
		return new Promise<number[]>((resolve, reject) => {
			const tmp = dgram.createSocket('udp4')

			tmp.once('error', (err) => {
				tmp.close()
				reject(new Error(err.message ?? String(err)))
			})

			tmp.connect(9, destIp, () => {
				try {
					const addr = tmp.address() as { address: string }
					const localAddr = addr.address

					tmp.close()

					const ifaces = os.networkInterfaces()
					for (const name of Object.keys(ifaces)) {
						for (const iface of ifaces[name] ?? []) {
							if (
								iface.family === 'IPv4' &&
								iface.address === localAddr &&
								iface.mac &&
								iface.mac !== '00:00:00:00:00:00'
							) {
								return resolve(iface.mac.split(':').map((b) => parseInt(b, 16) & 0xff))
							}
						}
					}

					reject(new Error(`No interface found for local address ${localAddr}`))
				} catch (_e) {
					reject(new Error(String(_e)))
				}
			})
		})
	}

	private static async buildHeader(totalLen: number, destIp: string): Promise<Buffer> {
		const mac = await StController.getMacForDestination(destIp)

		return Buffer.concat([
			Buffer.from([0xff, 0xff, 0x00, totalLen & 0xff, 0x07, 0xe1, 0x00, 0x00, ...mac, 0x00, 0x00]),
			Buffer.from('Studio-T', 'utf8'),
		])
	}

	private static crc8DvbS2(data: number[]): number {
		let crc = 0
		for (const b of data) {
			crc ^= b
			for (let i = 0; i < 8; i++) {
				crc = (crc & 0x80) !== 0 ? ((crc << 1) ^ 0xd5) & 0xff : (crc << 1) & 0xff
			}
		}
		return crc
	}

	/**
	 * Returns the current known value for a setting on a device, or undefined if unknown.
	 * Use for feedbacks — value is updated on every CMD_SETTINGS_PUSH (0x0b) from the device.
	 *
	 * @param ip        Device IP address
	 * @param cmdId     Command ID (e.g. CMD_DEV_SPEC)
	 * @param settingId Setting ID (e.g. 0x02 for Control Source)
	 * @param busCh     Optional bus/channel ID for multi-channel commands
	 */
	public getSettingValue(ip: string, cmdId: number, settingId: number, busCh?: number): number | undefined {
		const key = makeSettingId(this.model, cmdId, settingId, busCh)
		return this.deviceState.get(ip)?.get(key)
	}

	public async resetDevice(model: string, destIp: string): Promise<Buffer> {
		return this.sendAwaitAck(model, CMD_RESET_DEVICE, undefined, 0x00, undefined, destIp, false)
	}

	public async globalMicKill(model: string, destIp: string): Promise<Buffer> {
		return this.sendAwaitAck(model, CMD_GLOBAL_MIC_KILL, undefined, undefined, undefined, destIp, false)
	}
}
