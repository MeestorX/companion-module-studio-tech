/**
 * Studio-T Device Discovery
 *
 * Based on Wireshark capture analysis of STcontroller finding Model374A:
 *
 * Devices broadcast Studio-T heartbeat packets to multicast 224.0.0.233:8708
 * every ~1 second from source port 8700.
 *
 * Heartbeat payload structure:
 *   Bytes  0- 3: Magic header       ff fe 00 bc
 *   Bytes  4- 5: Packet sequence    (16-bit, incrementing)
 *   Bytes  6- 7: Reserved           00 00
 *   Bytes  8-15: Device EUI-64      (derived from Audinate MAC, e.g. 00:1d:c1:ff:fe:9b:a6:cd)
 *   Bytes 16-23: ASCII "Audinate"   41 75 64 69 6e 61 74 65
 *   Bytes 24-31: Header trailer     00 08 00 01 10 00 00 00
 *   Followed by 5 tagged blocks (tags 0x8001, 0x8000, 0x8002, 0x8003, 0x8004)
 *
 * Block 3 (tag 0x8003) contains sample rate at a known offset: 0xBB80 = 48000 Hz
 * Block 2 (tag 0x8002) contains channel routing bitmap: fe fe fe fe fd fd fd fd
 *
 * mDNS services advertised by device (all on 224.0.0.251:5353):
 *
 *   _netaudio-cmc._udp.local  → port 8800  (Control & Monitoring)
 *   _netaudio-arc._udp.local  → port 4440  (Audio Routing Control)
 *   _netaudio-dbc._udp.local              (Dante Brooklyn Control)
 *   _netaudio-chan._udp.local             (Individual channel info; not present on all hardware)
 *
 *   Studio-T._sub._netaudio-cmc._udp.local  (PTR subtype — use this to filter for Studio-T devices only)
 *
 * Port 8700 is NOT advertised via mDNS — it is the Studio-T heartbeat source port only.
 * Audio control (routing) is done via the _netaudio-arc._udp port (4440 or 4455).
 * Other known ports: 24440, 24455 (VIA audio control), 4455 (alternate audio control).
 *
 * mDNS hostname pattern: ST-M374A-{last6ofMAC}.local
 * e.g. ST-M374A-9ba6cd.local → 192.168.1.87
 *
 * Instance name pattern: ST-M374A-{label}._netaudio-{svc}._udp.local
 * e.g. ST-M374A-Beltpack._netaudio-cmc._udp.local
 */

import dgram from 'dgram'
import os from 'os'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Represents a discovered Studio-T device. */
export interface DeviceInfo {
	ip: string
	mac: string
	eui64?: string
	sequence?: number
	sampleRate?: number | null
	channelBitmap?: string | null
	lastSeen: number
	name?: string
	model?: string
	modelName?: string
	manufacturer?: string
	danteFirmware?: string
}

export interface StudioTDiscoveryOptions {
	onDeviceFound?: (device: DeviceInfo) => void
	onDeviceLost?: (device: DeviceInfo) => void
	log?: (level: string, msg: string) => void
}

export const STUDIO_T_MULTICAST_GROUP = '224.0.0.233'
export const STUDIO_T_LISTEN_PORT = 8708
export const STUDIO_T_MAGIC = Buffer.from([0xff, 0xfe, 0x00, 0xbc])

// mDNS service types
export const MDNS_MULTICAST = '224.0.0.251'
export const MDNS_PORT = 5353
/**
 * Substring present in the PTR owner name used to identify Studio-T mDNS announcements.
 * Full owner name: "Studio-T._sub._netaudio-cmc._udp.local"
 */
export const MDNS_STUDIO_T_FILTER = 'studio-t._sub._netaudio-cmc'

export const MDNS_SERVICE_CMC = '_netaudio-cmc._udp.local' // Control & Monitoring, port 8800
export const MDNS_SERVICE_ARC = '_netaudio-arc._udp.local' // Audio Routing Control, port 4440 / 4455
export const MDNS_SERVICE_DBC = '_netaudio-dbc._udp.local' // Dante Brooklyn Control
export const MDNS_SERVICE_CHAN = '_netaudio-chan._udp.local' // Per-channel info (not on all hardware)
export const MDNS_SUBTYPE = 'Studio-T._sub._netaudio-cmc._udp.local' // Filter for Studio-T devices only

// Known service ports (informational — not all are mDNS-advertised)
export const PORT_CMC = 8800 // Control & Monitoring (_netaudio-cmc)
export const PORT_ARC = 4440 // Audio Routing Control (_netaudio-arc)
export const PORT_ARC_ALT = 4455 // Alternate Audio Routing Control
export const PORT_VIA = 24440 // VIA Audio Control
export const PORT_VIA_ALT = 24455 // VIA Audio Control (alternate)
// NOTE: Port 8700 is the Studio-T heartbeat SOURCE port and is NOT advertised via mDNS

const DEVICE_TIMEOUT_MS = 5000 // Remove device if no heartbeat for 5 seconds

// ─── mDNS packet parsing ──────────────────────────────────────────────────────

/**
 * Minimal mDNS/DNS packet parser — returns all PTR, SRV, and A records.
 * Returns null if the packet is not a valid DNS response (QR=1).
 *
 * For PTR records we collect both the record owner name AND the target so
 * callers can check either "Studio-T._sub._netaudio-cmc._udp.local" (owner)
 * or the instance name it points to.
 */
export function parseMdnsPacket(buf: Buffer): {
	/** Owner names of PTR records (e.g. "Studio-T._sub._netaudio-cmc._udp.local") */
	ptrNames: string[]
	/** Target values of PTR records (e.g. "ST-M374A-Beltpack._netaudio-cmc._udp.local") */
	ptrTargets: string[]
	srvs: Array<{ name: string; port: number; target: string }>
	aRecords: Array<{ name: string; ip: string }>
} | null {
	if (buf.length < 12) return null
	const flags = buf.readUInt16BE(2)
	const isResponse = (flags & 0x8000) !== 0
	if (!isResponse) return null

	const anCount = buf.readUInt16BE(6)
	const nsCount = buf.readUInt16BE(8)
	const arCount = buf.readUInt16BE(10)
	const totalRR = anCount + nsCount + arCount

	let offset = 12

	// Skip questions
	const qdCount = buf.readUInt16BE(4)
	for (let i = 0; i < qdCount; i++) {
		offset = _skipDnsName(buf, offset)
		offset += 4 // type + class
	}

	const ptrNames: string[] = []
	const ptrTargets: string[] = []
	const srvs: Array<{ name: string; port: number; target: string }> = []
	const aRecords: Array<{ name: string; ip: string }> = []

	for (let i = 0; i < totalRR; i++) {
		if (offset >= buf.length) break
		const nameResult = _readDnsName(buf, offset)
		const name = nameResult.name
		offset = nameResult.next
		if (offset + 10 > buf.length) break
		const type = buf.readUInt16BE(offset)
		const rdLen = buf.readUInt16BE(offset + 8)
		offset += 10

		if (offset + rdLen > buf.length) break

		if (type === 12) {
			// PTR — record the owner name AND the target value
			const target = _readDnsName(buf, offset).name
			ptrNames.push(name)
			ptrTargets.push(target)
		} else if (type === 33) {
			// SRV
			const port = buf.readUInt16BE(offset + 4)
			const target = _readDnsName(buf, offset + 6).name
			srvs.push({ name, port, target })
		} else if (type === 1) {
			// A
			if (rdLen === 4) {
				const ip = `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`
				aRecords.push({ name, ip })
			}
		}

		offset += rdLen
	}

	return { ptrNames, ptrTargets, srvs, aRecords }
}

/** Skip a DNS name (handles pointers) — returns offset after the name field. */
function _skipDnsName(buf: Buffer, offset: number): number {
	while (offset < buf.length) {
		const len = buf[offset]
		if (len === 0) return offset + 1
		if ((len & 0xc0) === 0xc0) return offset + 2 // pointer
		offset += 1 + len
	}
	return offset
}

/**
 * Read a DNS name (follows pointers).
 * Returns { name, next } where next is the offset after the name field
 * at the original position (not after the pointer target).
 */
function _readDnsName(buf: Buffer, offset: number): { name: string; next: number } {
	const parts: string[] = []
	let jumped = false
	let next = offset
	let safety = 0
	while (offset < buf.length && safety++ < 128) {
		const len = buf[offset]
		if (len === 0) {
			if (!jumped) next = offset + 1
			break
		}
		if ((len & 0xc0) === 0xc0) {
			if (!jumped) next = offset + 2
			jumped = true
			offset = ((len & 0x3f) << 8) | buf[offset + 1]
			continue
		}
		parts.push(buf.subarray(offset + 1, offset + 1 + len).toString('ascii'))
		offset += 1 + len
	}
	return { name: parts.join('.'), next }
}

/**
 * Extract model string from a Studio-T mDNS hostname.
 * e.g. "ST-M374A-9ba6cd.local" → "374A", "ST-M370A-001122.local" → "370A"
 * Returns null if the pattern doesn't match.
 */
export function modelFromMdnsHostname(hostname: string): string | null {
	// hostname: ST-M374A-9ba6cd  (with or without trailing .local)
	const m = hostname.replace(/\.local\.?$/, '').match(/^ST-M(\w+)-[0-9a-f]{6}$/i)
	return m ? m[1] : null
}

// ─── Studio-T heartbeat parsing ───────────────────────────────────────────────

/**
 * Parse a Studio-T heartbeat UDP payload.
 * Returns null if not a valid Studio-T heartbeat.
 */
export function parseHeartbeat(buf: Buffer, srcIp: string): DeviceInfo | null {
	// Must be at least 32 bytes and start with magic
	if (buf.length < 32) return null
	if (!buf.subarray(0, 4).equals(STUDIO_T_MAGIC)) return null

	// Verify "Audinate" string at bytes 16-23
	const audinate = buf.subarray(16, 24).toString('ascii')
	if (audinate !== 'Audinate') return null

	const sequence = buf.readUInt16BE(4)

	// EUI-64 at bytes 8-15
	const eui64 = buf.subarray(8, 16).toString('hex').match(/.{2}/g)!.join(':')

	// Derive MAC from EUI-64 (remove ff:fe bytes at positions 3-4)
	// EUI-64: xx:xx:xx:ff:fe:xx:xx:xx → MAC: xx:xx:xx:xx:xx:xx
	const eui64Bytes = buf.subarray(8, 16)
	const mac = [eui64Bytes[0], eui64Bytes[1], eui64Bytes[2], eui64Bytes[5], eui64Bytes[6], eui64Bytes[7]]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join(':')

	// Parse tagged blocks starting at byte 32
	// Layout from capture: 00 LL TT TT SS SS ... where LL = block data length
	let sampleRate: number | null = null
	let channelBitmap: string | null = null
	let offset = 32

	while (offset + 4 <= buf.length) {
		const blockLen = buf.readUInt16BE(offset) // total block size after this field
		if (blockLen === 0 || offset + 2 + blockLen > buf.length) break

		const tag = buf.readUInt16BE(offset + 2)

		// Block 3 (tag 0x8003): sample rate
		// Structure: 00 20 80 03 00 04 00 14 <subseq 2B> 00 00 00 02 00 00 00 18 00 00 00 00 <samplerate 4B> ...
		if (tag === 0x8003 && offset + 24 <= buf.length) {
			sampleRate = buf.readUInt32BE(offset + 20)
		}

		// Block 2 (tag 0x8002): channel routing bitmap
		// Structure: 00 20 80 02 ... 00 00 <8 bitmap bytes>
		if (tag === 0x8002 && offset + 26 <= buf.length) {
			channelBitmap = buf.subarray(offset + 18, offset + 26).toString('hex')
		}

		offset += 2 + blockLen
	}

	return { ip: srcIp, mac, eui64, sequence, sampleRate, channelBitmap, lastSeen: Date.now() }
}

/**
 * StudioTDiscovery
 *
 * Listens on the Studio-T multicast group for device heartbeats and
 * maintains a map of discovered devices. Calls onDeviceFound / onDeviceLost
 * callbacks as devices appear and disappear.
 */
export class StudioTDiscovery {
	private readonly _onDeviceFound: (device: DeviceInfo) => void
	private readonly _onDeviceLost: (device: DeviceInfo) => void
	private readonly _log: (level: string, msg: string) => void
	private readonly _devices = new Map<string, DeviceInfo>()
	private _socket: dgram.Socket | null = null
	private _sweepTimer: ReturnType<typeof setInterval> | null = null

	constructor({ onDeviceFound, onDeviceLost, log }: StudioTDiscoveryOptions = {}) {
		this._onDeviceFound = onDeviceFound ?? (() => undefined)
		this._onDeviceLost = onDeviceLost ?? (() => undefined)
		this._log = log ?? ((level, msg) => console.log(`[StudioTDiscovery][${level}] ${msg}`))
	}

	/** Start listening for Studio-T heartbeats. */
	start(bindInterface?: string): void {
		if (this._socket) {
			this._log('warn', 'Discovery already running')
			return
		}

		const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
		this._socket = socket

		socket.on('error', (err: Error) => {
			this._log('error', `Discovery socket error: ${err.message}`)
		})

		socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
			this._handleMessage(msg, rinfo)
		})

		socket.bind(STUDIO_T_LISTEN_PORT, () => {
			try {
				const iface = bindInterface ?? this._getDefaultInterface()
				socket.addMembership(STUDIO_T_MULTICAST_GROUP, iface)
				this._log(
					'info',
					`Joined multicast ${STUDIO_T_MULTICAST_GROUP}:${STUDIO_T_LISTEN_PORT} on ${iface ?? 'default'}`,
				)
			} catch (err) {
				this._log('error', `Failed to join multicast group: ${(err as Error).message}`)
			}
		})

		this._sweepTimer = setInterval(() => this._sweepDevices(), 2000)
		this._log('info', 'Studio-T discovery started')
	}

	/** Stop listening and clean up. */
	stop(): void {
		if (this._sweepTimer) {
			clearInterval(this._sweepTimer)
			this._sweepTimer = null
		}
		if (this._socket) {
			try {
				this._socket.close()
			} catch (err) {
				this._log('warn', `Error closing discovery socket: ${(err as Error).message}`)
			}
			this._socket = null
		}
		this._devices.clear()
		this._log('info', 'Studio-T discovery stopped')
	}

	/** Get current list of discovered devices. */
	getDevices(): DeviceInfo[] {
		return Array.from(this._devices.values())
	}

	private _handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
		const info = parseHeartbeat(msg, rinfo.address)
		if (!info) return

		const existing = this._devices.get(info.ip)
		if (!existing) {
			this._devices.set(info.ip, info)
			this._log('info', `Device found: ${info.ip} MAC=${info.mac} sampleRate=${info.sampleRate}`)
			this._onDeviceFound(info)
		} else {
			Object.assign(existing, info)
		}
	}

	private _sweepDevices(): void {
		const now = Date.now()
		for (const [key, device] of this._devices) {
			if (now - device.lastSeen > DEVICE_TIMEOUT_MS) {
				this._devices.delete(key)
				this._log('info', `Device lost: ${device.ip} MAC=${device.mac}`)
				this._onDeviceLost(device)
			}
		}
	}

	/** Prefer the first non-loopback IPv4 interface for multicast membership. */
	private _getDefaultInterface(): string | undefined {
		for (const ifaces of Object.values(os.networkInterfaces())) {
			for (const iface of ifaces ?? []) {
				if (iface.family === 'IPv4' && !iface.internal) return iface.address
			}
		}
		return undefined
	}
}
