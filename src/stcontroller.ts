import dgram from 'dgram'
import { createModuleLogger } from '@companion-module/base'
import {
	CMD_BUS_GET,
	CMD_BUS_SET,
	CMD_DEV_SPEC,
	CMD_GET_ALL_SETTINGS,
	CMD_GET_FIRMWARE,
	CMD_GLOBAL_MIC_KILL,
	CMD_MIC_PRE_BUS,
	CMD_RESET_DEVICE,
	CMD_SETTINGS_PUSH,
	getCommandName,
	makeSettingId,
	toHex,
	bytesToHex,
	type DeviceInfo,
} from './types.js'
import {
	parseGetAllSettingsForModel,
	parseSettingsResponse,
	formatParsedSetting,
	type StAction,
	type ParsedSetting,
} from './settingsParser.js'
import {
	DANTE_MSG_INFO_RESPONSE,
	parseDanteInfoResponse,
	discoverDevices,
	buildDanteInfoRequest,
	getMacForDestination,
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
	> = new Map()
	private joinedInterfaces: Set<string> = new Set() // local IPs we've joined multicast on

	/** Serializes outgoing commands so each waits for ACK before the next is sent */
	private sendQueue: Promise<void> = Promise.resolve()

	/** Tracks how many commands are queued/in-flight, to defer requestAllSettings */
	private pendingCommandCount = 0

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

	/**
	 * IPs that have been verified against the configured model and are allowed
	 * to receive Studio-T commands. Populated by authorizeDevice() after a
	 * successful probeDevice() model match, or after multicast discovery.
	 * _sendAwaitAck() rejects any destIp not in this set.
	 */
	private authorizedIps: Set<string> = new Set()

	/** Callbacks registered by discoverDevices() — keyed by source IP */
	private discoveryListeners: Map<string, (device: DeviceInfo) => void> = new Map()

	/** Callback to trigger feedback updates when state changes */
	private feedbackCallback?: (feedbackId: string) => void

	/** Cache of local interface MAC bytes per destination IP, to avoid repeated OS lookups */
	private macCache: Map<string, number[]> = new Map()

	constructor() {
		logger.info('StController initialized')

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

	/** Returns true if the device at the given IP has been authorized to receive commands. */
	public isDeviceAuthorized(ip: string): boolean {
		return this.authorizedIps.has(ip)
	}

	/** Mark an IP as verified and allowed to receive Studio-T commands. */
	public authorizeDevice(ip: string): void {
		this.authorizedIps.add(ip)
		logger.debug(`Authorized device at ${ip}`)
	}

	/** Remove authorization for an IP (e.g. on config change or model mismatch). */
	public revokeDevice(ip: string): void {
		this.authorizedIps.delete(ip)
		this.deviceState.delete(ip)
		this.macCache.delete(ip)
		logger.debug(`Revoked device at ${ip}`)
	}

	/**
	 * Sends a unicast Dante info request to a specific IP and waits for the
	 * device info response. Returns the DeviceInfo if the device responds within
	 * timeoutMs, or null if no response. Used to verify a manually configured IP.
	 * Does NOT require authorization — this is how authorization is established.
	 */
	public async probeDevice(ip: string, timeoutMs = 3000): Promise<DeviceInfo | null> {
		return new Promise<DeviceInfo | null>((resolve) => {
			const key = `__probe_${ip}__`
			let resolved = false

			const finish = (result: DeviceInfo | null) => {
				if (resolved) return
				resolved = true
				this.discoveryListeners.delete(key)
				resolve(result)
			}

			this.discoveryListeners.set(key, (device: DeviceInfo) => {
				if (device.ip === ip) finish(device)
			})

			const timer = setTimeout(() => finish(null), timeoutMs)
			timer.unref?.()

			const run = async () => {
				await this.ensureMembershipFor(ip)
				await this.txReady
				const query = buildDanteInfoRequest()
				this.txSocket.send(query, this.defaultPort, ip, (err) => {
					if (err) {
						logger.warn(`Probe to ${ip} failed: ${err.message}`)
						clearTimeout(timer)
						finish(null)
					}
				})
			}

			run().catch((e) => {
				logger.warn(`probeDevice setup failed for ${ip}: ${e}`)
				clearTimeout(timer)
				finish(null)
			})
		})
	}

	/**
	 * Send a CMD_GET_ALL_SETTINGS (0x0a) request to the device and store the response
	 * in deviceState. Returns the raw response buffer for parsing.
	 */
	public async requestAllSettings(deviceIp: string): Promise<Buffer> {
		logger.info(`Requesting all settings from ${deviceIp}`)
		const response = await this.sendAwaitAck(CMD_GET_ALL_SETTINGS, undefined, undefined, undefined, deviceIp, false)
		// deviceState is populated by logStPayload when the CMD_GET_ALL_SETTINGS response arrives
		return response
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
			if (!foundDevices.some((d) => d.ip === device.ip)) {
				foundDevices.push(device)
			}
		}

		// Register the callback so handleIncoming() can invoke it when 0x0170 arrives
		this.discoveryListeners.set(DISCOVERY_KEY, onDeviceFound)

		try {
			await this.txReady
			// discoverDevices() in dante.ts handles the announce listening and query sending.
			// Responses come back to rxSocket → handleIncoming() → discoveryListeners.
			await discoverDevices(this.txSocket, async (destIp) => this.ensureMembershipFor(destIp), timeoutMs)
			return foundDevices
		} finally {
			this.discoveryListeners.delete(DISCOVERY_KEY)
		}
	}

	/**
	 * Requests device firmware version via Studio-T protocol (CMD_GET_FIRMWARE).
	 * Returns the firmware version string (e.g., "3.01", "2.2", "1.05").
	 */
	public async requestFirmwareVersion(deviceIp: string): Promise<string> {
		logger.info(`Requesting firmware version from ${deviceIp}`)
		const response = await this.sendAwaitAck(CMD_GET_FIRMWARE, undefined, undefined, undefined, deviceIp, false)

		// Response structure: [header] 0x5a 0x80 [firmware_data] CRC
		// Firmware data starts at byte 26 (24-byte header + 0x5a + 0x80)
		const dataStart = 26

		if (response.length < dataStart + 3) {
			logger.warn(`Firmware response too short: ${response.length} bytes`)
			return 'Unknown'
		}

		// Firmware format: [unknown_byte, major, minor]
		const major = response[dataStart + 1]
		const minor = response[dataStart + 2]

		const minorStr =
			minor < 10
				? minor.toString().padStart(2, '0') // e.g. 1 → "01", 5 → "05"
				: minor.toString() // e.g. 10 → "10"

		const firmware = `${major}.${minorStr}`

		logger.info(`Firmware version: ${firmware}`)
		return firmware
	}

	/**
	 * Joins the multicast response group on the interface that routes to destIp.
	 * Only joins the specific interface used to reach the device, and only once per interface.
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
		cmdId: number,
		busCh: number | undefined,
		settingId: number | undefined,
		value: unknown,
		destIp: string,
		addLen = true,
	): Promise<Buffer> {
		this.pendingCommandCount++
		return new Promise<Buffer>((resolve, reject) => {
			this.sendQueue = this.sendQueue.then(async () =>
				this._sendAwaitAck(cmdId, busCh, settingId, value, destIp, addLen)
					.then((buf) => {
						this.pendingCommandCount--
						// Only trigger requestAllSettings when the queue is fully drained
						if (this.pendingCommandCount === 0 && this.refreshAfterCommand && settingId !== undefined) {
							this.requestAllSettings(destIp).catch((err) => {
								logger.warn(`Failed to refresh settings after command: ${err}`)
							})
						}
						resolve(buf)
					})
					.catch((err) => {
						this.pendingCommandCount--
						reject(err instanceof Error ? err : new Error(String(err)))
					}),
			)
		})
	}

	private async _sendAwaitAck(
		cmdId: number,
		busCh: number | undefined,
		settingId: number | undefined,
		value: unknown,
		destIp: string,
		addLen = true,
	): Promise<Buffer> {
		const timeoutMs = 2000

		// Reject commands to unverified devices. probeDevice() bypasses this
		// because it uses the Dante protocol directly via txSocket, not sendAwaitAck.
		if (!this.authorizedIps.has(destIp)) {
			throw new Error(`Device at ${destIp} is not authorized — verify the IP and model match before sending commands`)
		}

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
		const header = await this.buildHeader(totalLen, destIp)
		const packet = Buffer.concat([header, payloadWithCrc])

		// Human-readable info log for the outgoing command
		if (settingId !== undefined && value !== undefined) {
			const valueBytes = StController.buildValueBytes(value)
			const setting: ParsedSetting = {
				cmd_id: cmdId,
				id: settingId,
				busCh,
				valueBytes,
			}
			logger.info(`TX ${destIp} | ${formatParsedSetting(setting, this.actions)}`)
		} else {
			logger.info(`TX ${destIp} | ${getCommandName(cmdId)}`)
		}
		logger.debug(`Sending packet to ${destIp}: ${packet.toString('hex')}`)

		const key = `${destIp}:${cmdId}`

		return new Promise<Buffer>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingAcks.delete(key)
				reject(new Error(`Timeout waiting for ACK from Model ${this.model} at ${destIp}:8700`))
			}, timeoutMs)

			this.pendingAcks.set(key, {
				resolve: (buf) => {
					clearTimeout(timer)
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
				logger.debug(
					`Dante info response from ${srcIp}: ` +
						`DeviceID="${device.name}", ` +
						`Model="${device.model}", ` +
						`ModelName="${device.modelName}", ` +
						`Manufacturer="${device.manufacturer}"`,
				)

				// Only accept Studio Technologies devices (identified by DeviceID "Studio-T")
				if (device.name === 'Studio-T') {
					for (const cb of this.discoveryListeners.values()) {
						try {
							cb(device)
						} catch {
							/* ignore */
						}
					}
				} else {
					logger.debug(`Ignoring non-Studio Technologies device: DeviceID="${device.name}" @ ${srcIp}`)
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

		// Log raw packet for CMD_GET_ALL_SETTINGS (0x0a) responses before parsing
		if (isResponse && originalCmdId === CMD_GET_ALL_SETTINGS) {
			logger.debug(`Received packet from ${srcIp}: ${msg.toString('hex')}`)
		}

		// Log the payload (works for both requests and responses)
		this.logStPayload(srcIp, originalCmdId, msg, stPayload)

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
	private logStPayload(srcIp: string, cmdId: number, msg: Buffer, stPayload: Buffer): void {
		const cmdName = getCommandName(cmdId)
		const data = stPayload.subarray(2, stPayload.length - 1) // strip magic+cmdId header and CRC

		// Payload structure: [cmd:0x8d] [data bytes...] [crc]
		const respCmdId = stPayload[1]
		const crc = stPayload[stPayload.length - 1]
		const fullStructure = `[cmd:${toHex(respCmdId)} data:${data.toString('hex')} crc:${toHex(crc)}]`

		// ── CMD_GET_ALL_SETTINGS (0x0a) and CMD_SETTINGS_PUSH (0x0b) ────────────────
		// Parse all settings, diff against deviceState, log changed at info / unchanged at debug,
		// then update deviceState. CMD_GET_ALL_SETTINGS also serves as the initial state population on connect.
		if (cmdId === CMD_GET_ALL_SETTINGS || cmdId === CMD_SETTINGS_PUSH) {
			if (!this.model) {
				logger.info(`RX ${srcIp} | ${cmdName} | ${fullStructure}`)
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
					const changed = prevValue === undefined || prevValue !== newValue

					newState.set(stateKey, newValue)

					const formatted = formatParsedSetting(s, this.actions)
					if (changed) {
						logger.info(`RX ${srcIp} | ${formatted}`)
						// Trigger feedback update — use base key without busCh so it matches the feedback definition ID
						if (this.feedbackCallback) {
							const baseFeedbackKey = makeSettingId(this.model, s.cmd_id, s.id)
							//logger.debug(`Triggering feedback update for key: ${baseFeedbackKey}`)
							this.feedbackCallback(baseFeedbackKey)
						} else {
							logger.warn(`feedbackCallback not set — skipping feedback update for ${stateKey}`)
						}
					} else {
						logger.debug(`RX ${srcIp} | ${formatted}`)
					}
				}
				this.deviceState.set(srcIp, newState)
			} catch (e) {
				logger.warn(`RX ${srcIp} | ${cmdName} | parse failed: ${e} | ${fullStructure}`)
			}
			return
		}

		// ── All other commands ────────────────────────────────────────────────────
		const decoded = this.decodeStData(cmdId, data)
		if (decoded) {
			logger.info(`RX ${srcIp} | ${cmdName} | ${fullStructure} | ${decoded}`)
		} else {
			logger.info(`RX ${srcIp} | ${cmdName} | ${fullStructure}`)
		}
	}

	/**
	 * Attempts to decode the data bytes of a Studio-T response into a
	 * human-readable string. Returns null to fall back to raw hex.
	 */
	private decodeStData(cmdId: number, data: Buffer): string | null {
		if (data.length === 0) return 'ACK'

		// ── Check for single-byte responses (ACK or error) ──────────
		if (data.length === 1) {
			if (data[0] === 0x00) {
				return 'ACK ok'
			} else {
				return `ERROR ${toHex(data[0])}`
			}
		}

		switch (cmdId) {
			// ── CMD_DEV_SPEC (0x0d): single-byte ACK or echo of applied setting ──
			// Device sends two CMD_DEV_SPEC packets in response to a set:
			//   1. ACK:  [status]               (1 byte, 0x00 = ok)
			//   2. Echo: [busCh] [settingId] [value...]  (confirming what was applied)
			case CMD_DEV_SPEC: {
				if (data.length === 1) {
					return data[0] === 0x00 ? 'ACK ok' : `ACK err=${toHex(data[0])}`
				}
				if (data.length >= 3) {
					const busCh = data[0]
					const settingId = data[1]
					const valueBytes = data.subarray(2)
					const action = this.actions.find((a) => a.cmd_id === cmdId && a.id === settingId)
					const settingName = action?.name ?? `setting=${toHex(settingId)}`
					const choices = action?.options?.[0]?.choices
					const valueNum = valueBytes.length === 1 ? valueBytes[0] : undefined
					const choiceLabel =
						choices && valueNum !== undefined ? choices.find((c) => c.id === valueNum)?.label : undefined
					const valueStr = choiceLabel ? `${choiceLabel} (${toHex(valueNum!)})` : bytesToHex(Array.from(valueBytes))
					const rawTag = `[${toHex(cmdId)}/${toHex(settingId)}]=${bytesToHex(Array.from(valueBytes))}`
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
					const settingName = action?.name ?? `setting=${toHex(settingId)}`
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
				return `ch=${busCh} setting=${toHex(settingId)} value=${value.toString('hex')}`
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

	private async buildHeader(totalLen: number, destIp: string): Promise<Buffer> {
		let mac = this.macCache.get(destIp)
		if (!mac) {
			mac = await getMacForDestination(destIp)
			this.macCache.set(destIp, mac)
		}

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

	public async resetDevice(destIp: string): Promise<Buffer> {
		return this.sendAwaitAck(CMD_RESET_DEVICE, undefined, 0x00, undefined, destIp, false)
	}

	public async globalMicKill(destIp: string): Promise<Buffer> {
		return this.sendAwaitAck(CMD_GLOBAL_MIC_KILL, undefined, undefined, undefined, destIp, false)
	}
}
