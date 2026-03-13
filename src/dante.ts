import dgram from 'dgram'
import os from 'os'
import { createModuleLogger } from '@companion-module/base'
import type { DeviceInfo } from './types.js'

const logger = createModuleLogger('Dante')

// ─── Dante discovery constants ────────────────────────────────────────────────

/** Dante device info request message type (sent to port 8700) */
export const DANTE_MSG_INFO_REQUEST = 0x0020
/** Dante device info response message type (received on port 8702) */
export const DANTE_MSG_INFO_RESPONSE = 0x0170

/**
 * Dante device info response layout (all offsets are into the UDP payload):
 *   0x00  uint16BE  Magic (0xffff)
 *   0x02  uint16BE  Message type (0x0170)
 *   0x04  uint16BE  Sequence number
 *   0x06  2 bytes   Padding
 *   0x08  8 bytes   EUI-64 (source MAC with ff:fe inserted mid)
 *   0x10  8 bytes   "Audinate" ASCII identifier
 *   0x18  2 bytes   Dante module firmware version (major, minor)
 *   0x20  31 bytes  Device name, null-padded ASCII (max 31 chars per Dante spec)
 *   0x2e  uint16BE  Product ID
 *   0x4c  64 bytes  Manufacturer string, null-padded ASCII
 *   0xcc  64 bytes  Model string, null-padded ASCII
 */
export const DANTE_INFO_MIN_LEN = 0xcc + 64 // 268 bytes — need full model field

/**
 * Builds a Dante device info request packet (type 0x0020).
 *
 * Packet layout (32 bytes) — derived from live capture analysis:
 *   0x00  uint16BE  Magic (0xffff)
 *   0x02  uint16BE  Message type (0x0020 = device info request)
 *   0x04  uint16BE  Sequence number (random)
 *   0x06  2 bytes   Padding
 *   0x08  6 bytes   Source MAC
 *   0x0e  2 bytes   Padding
 *   0x10  8 bytes   "Audinate" ASCII identifier
 *   0x18  2 bytes   Protocol version (0x0739)
 *   0x1a  2 bytes   Sub-type (0x00c1)
 *   0x1c  uint32BE  Capability mask (0x000f4240)
 */
export function buildDanteInfoRequest(): Buffer {
	const buf = Buffer.alloc(32, 0)
	const seq = Math.floor(Math.random() * 0xffff)

	buf.writeUInt16BE(0xffff, 0)
	buf.writeUInt16BE(DANTE_MSG_INFO_REQUEST, 2)
	buf.writeUInt16BE(seq, 4)

	const mac = getFirstLocalMac()
	mac.copy(buf, 8)

	Buffer.from('Audinate', 'ascii').copy(buf, 16)
	buf.writeUInt16BE(0x0739, 24)
	buf.writeUInt16BE(0x00c1, 26)
	buf.writeUInt32BE(0x000f4240, 28)

	return buf
}

/** Returns the first non-loopback MAC as a 6-byte Buffer, or zeros. */
export function getFirstLocalMac(): Buffer {
	try {
		const ifaces = os.networkInterfaces()
		for (const name of Object.keys(ifaces)) {
			for (const addr of ifaces[name] ?? []) {
				if (!addr.internal && addr.family === 'IPv4' && addr.mac && addr.mac !== '00:00:00:00:00:00') {
					return Buffer.from(addr.mac.split(':').map((h: string) => parseInt(h, 16)))
				}
			}
		}
	} catch {
		/* ignore */
	}
	return Buffer.alloc(6, 0)
}

/**
 * Parses a Dante device info response (type 0x0170) into a DeviceInfo.
 *
 * Response layout (key offsets):
 *   0x08  8 bytes   EUI-64 — convert to MAC by dropping bytes [3] and [4] (ff:fe)
 *   0x10  8 bytes   "Audinate" identifier (used to verify this is a real response)
 *   0x18  1 byte    Dante FW major
 *   0x19  1 byte    Dante FW minor
 *   0x20  31 bytes  Device name (Dante label), null-padded ASCII (max 31 chars)
 *   0x2e  uint16BE  Product ID
 *   0x4c  64 bytes  Manufacturer, null-padded ASCII
 *   0xcc  64 bytes  Model string, null-padded ASCII
 *
 * Returns null if buffer is too short, wrong magic, or missing model string.
 */
export function parseDanteInfoResponse(msg: Buffer, srcIp: string): DeviceInfo | null {
	if (msg.length < DANTE_INFO_MIN_LEN) return null
	if (msg.readUInt16BE(0) !== 0xffff) return null
	if (msg.readUInt16BE(2) !== DANTE_MSG_INFO_RESPONSE) return null
	if (msg.subarray(16, 24).toString('ascii') !== 'Audinate') return null

	const readStr = (offset: number, len: number): string =>
		msg
			.subarray(offset, offset + len)
			.toString('ascii')
			.split('\0')[0]
			.trim()

	const eui64 = msg.subarray(8, 16)
	const macBytes = [eui64[0], eui64[1], eui64[2], eui64[5], eui64[6], eui64[7]]
	const mac = macBytes.map((b) => b.toString(16).padStart(2, '0')).join(':')

	const name = readStr(0x20, 31) // Dante device label (can be up to 31 chars per Dante spec)
	const manufacturer = readStr(0x4c, 64) // e.g. "Studio Technologies, Inc."
	const modelRaw = readStr(0xcc, 64)
	const danteFirmware = `${msg[0x18]}.${msg[0x19]}`

	if (!modelRaw) return null

	// Extract just the model number/code (e.g. "Model 391 Alerting Unit" → "391")
	// Strip "Model " prefix, then take only the first word (the model number)
	const model = modelRaw
		.replace(/^Model\s+/i, '')
		.trim()
		.split(/\s+/)[0]

	return {
		ip: srcIp,
		name,
		manufacturer,
		model,
		modelName: modelRaw, // Full model description
		mac,
		danteFirmware,
	}
}

/**
 * Returns the local IP address used by the OS to route to destIp.
 * Uses a temporary UDP socket connect to let the OS select the outgoing interface.
 */
export async function getLocalAddressForDestination(destIp: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const tmp = dgram.createSocket('udp4')

		let resolved = false
		tmp.once('error', (err) => {
			if (!resolved) {
				resolved = true
				tmp.close()
				reject(new Error(err.message ?? String(err)))
			}
		})

		// Use an arbitrary port for connect; we only need the kernel to assign a local address.
		tmp.connect(9, destIp, () => {
			try {
				const addr = tmp.address() as { address: string }
				const localAddr = addr.address
				if (!resolved) {
					resolved = true
					tmp.close()
					resolve(localAddr)
				}
			} catch (_e) {
				if (!resolved) {
					resolved = true
					tmp.close()
					reject(new Error(String(_e)))
				}
			}
		})
	})
}

/**
 * Discovers Studio Technologies Dante devices on the local network.
 *
 * Strategy:
 *  Dante devices broadcast a 1-second announce to multicast 224.0.0.233:8708.
 *  We listen on that group, collect source IPs, then send a unicast device info
 *  request (0x0020) to each new IP on port 8700. The device responds on port 8702,
 *  where the provided onDeviceFound callback is invoked.
 *
 * @param txSocket - The socket to use for sending discovery requests
 * @param onDeviceFound - Callback invoked when a device info response (0x0170) is received
 * @param ensureMembership - Callback to ensure multicast membership for device IP
 * @param timeoutMs - Discovery timeout in milliseconds
 */
export async function discoverDevices(
	txSocket: dgram.Socket,
	_onDeviceFound: (device: DeviceInfo) => void, // Invoked by StController.handleIncoming(), not here
	ensureMembership: (destIp: string) => Promise<void>,
	timeoutMs = 5000,
): Promise<DeviceInfo[]> {
	const DANTE_ANNOUNCE_GROUP = '224.0.0.233'
	const DANTE_ANNOUNCE_PORT = 8708
	const DEFAULT_PORT = 8700

	const found = new Map<string, DeviceInfo>()
	const queriedIps = new Set<string>()

	return new Promise<DeviceInfo[]>((resolve) => {
		// Note: onDeviceFound callback is invoked by StController.handleIncoming()
		// when it receives 0x0170 responses. We don't call it here to avoid duplicates.

		// Open a short-lived socket just to receive the Dante periodic announces
		const announceSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

		const cleanup = () => {
			try {
				announceSocket.dropMembership(DANTE_ANNOUNCE_GROUP)
			} catch {
				/* ignore */
			}
			try {
				announceSocket.close()
			} catch {
				/* ignore */
			}
			resolve(Array.from(found.values()))
		}

		const timer = setTimeout(cleanup, timeoutMs)
		timer.unref?.()

		announceSocket.on('error', (err) => {
			logger.warn(`Announce socket error: ${err.message}`)
		})

		announceSocket.on('message', (msg, rinfo) => {
			const srcIp = rinfo.address
			// Validate it's a Dante announce (magic 0xfffe + "Audinate" at offset 16)
			if (msg.length < 24) return
			if (msg.readUInt16BE(0) !== 0xfffe) return
			if (msg.subarray(16, 24).toString('ascii') !== 'Audinate') return

			if (queriedIps.has(srcIp)) return
			queriedIps.add(srcIp)
			logger.debug(`Announce from ${srcIp} — sending unicast query`)

			// Join 224.0.0.231 on the interface that routes to this device BEFORE sending
			// the query. The device multicasts its 0x0170 response to 224.0.0.231:8702
			// in addition to unicasting it — rxSocket must be a member to receive it.
			ensureMembership(srcIp)
				.then(() => {
					const query = buildDanteInfoRequest()
					txSocket.send(query, DEFAULT_PORT, srcIp, (err) => {
						if (err) logger.warn(`Unicast query to ${srcIp} failed: ${err.message}`)
					})
				})
				.catch((err) => logger.warn(`Query setup failed: ${err}`))
		})

		announceSocket.bind(DANTE_ANNOUNCE_PORT, () => {
			try {
				announceSocket.addMembership(DANTE_ANNOUNCE_GROUP)
				logger.info(`Listening for Dante announces on ${DANTE_ANNOUNCE_GROUP}:${DANTE_ANNOUNCE_PORT}`)
			} catch (err) {
				logger.warn(`Could not join announce multicast group: ${err}`)
			}
		})

		// Store callback for cleanup
	})
}
