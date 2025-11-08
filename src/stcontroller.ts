import dgram from 'dgram'
import type { DeviceInfo } from './types.js'

/**
 * StController UDP packet builder + sender
 */
export class StController {
	private readonly defaultPort = 8700
	private readonly discoveryPort = 8700
	private readonly broadcastAddr: string

	constructor(options: { broadcast?: string } = {}) {
		this.broadcastAddr = options.broadcast ?? '255.255.255.255'
	}

	/* ----------------------------
	 * Discovery
	 * ---------------------------- */

	public async discoverDevices(timeoutMs = 2000): Promise<DeviceInfo[]> {
		const socket = dgram.createSocket('udp4')
		const discovered: Record<string, DeviceInfo> = {}

		await new Promise<void>((resolve) => {
			socket.bind(() => {
				socket.setBroadcast(true)
				resolve()
			})
		})

		const discoveryPacket = Buffer.from([
			0xff,
			0xff,
			0x00,
			0x20,
			0x07,
			0xe1,
			0x00,
			0x00,
			...Buffer.from('Studio-Technologies-Discovery\0'),
		])

		socket.send(discoveryPacket, this.discoveryPort, this.broadcastAddr)

		return await new Promise<DeviceInfo[]>((resolve) => {
			const timer = setTimeout(() => {
				socket.close()
				resolve(Object.values(discovered))
			}, timeoutMs)

			socket.on('message', (msg, rinfo) => {
				const text = msg.toString('utf8')
				const modelMatch = text.match(/Model\d+/i)
				const fwMatch = text.match(/v?(\d+\.\d+\.\d+)/i)
				const hex = msg.toString('hex')
				const macMatch = hex.match(/(?:[0-9a-f]{2}){6}/i)

				const info: DeviceInfo = {
					model: modelMatch ? modelMatch[0] : 'Unknown',
					ip: rinfo.address,
					firmware: fwMatch ? fwMatch[1] : undefined,
					mac: macMatch ? macMatch[0].match(/.{2}/g)?.join(':') : undefined,
					serial: undefined,
				}

				discovered[rinfo.address] = info
			})

			socket.on('error', () => {
				clearTimeout(timer)
				socket.close()
				resolve(Object.values(discovered))
			})
		})
	}

	/* ----------------------------
	 * Send / ACK
	 * ---------------------------- */

	/**
	 * Send command using the new UI-based definition:
	 * cmdId and subId are passed directly; params contains values for that action.
	 */
	public async sendAwaitAck(opts: {
		model: string
		cmdId: number
		subId: number
		value: unknown
		destIp: string
		timeoutMs?: number
		port?: number
	}): Promise<Buffer> {
		const { cmdId, subId, value, destIp } = opts
		const timeoutMs = opts.timeoutMs ?? 2000
		const destPort = opts.port ?? this.defaultPort

		// Build data block: [len, subId, value...]
		const valueBytes: number[] = StController.buildValueBytes(value)
		const dataBlock = [subId & 0xff, ...valueBytes]

		// Build payload: [0x5A, cmdId, payloadLen, ...dataBlock, crc]
		const payloadBody: number[] = [0x5a, cmdId & 0xff, dataBlock.length, ...dataBlock]
		const crc = StController.crc8DvbS2(payloadBody)
		const payloadWithCrc = [...payloadBody, crc]

		// Header total length = header (24 bytes) + payloadWithCrc length
		const totalLen = 24 + payloadWithCrc.length

		const header = Buffer.from(StController.buildHeader(totalLen))
		const packet = Buffer.concat([header, Buffer.from(payloadWithCrc)])

		const socket = dgram.createSocket('udp4')
		return await new Promise<Buffer>((resolve, reject) => {
			const timer = setTimeout(() => {
				socket.close()
				reject(new Error(`Timeout waiting for ACK from ${destIp}:${destPort}`))
			}, timeoutMs)

			socket.once('error', (err) => {
				clearTimeout(timer)
				socket.close()
				reject(err)
			})

			socket.once('message', (msg) => {
				clearTimeout(timer)
				socket.close()
				resolve(msg)
			})

			console.log('Sending', packet, `to ${destIp}:${destPort}`)
			socket.send(packet, destPort, destIp, (err) => {
				if (err) {
					clearTimeout(timer)
					socket.close()
					reject(err)
				}
			})
		})
	}

	/* ----------------------------
	 * Helpers
	 * ---------------------------- */

	private static buildValueBytes(value: unknown): number[] {
		if (typeof value === 'number') return [value & 0xff]
		if (typeof value === 'boolean') return [value ? 1 : 0]
		if (Array.isArray(value)) return value.map((v) => Number(v) & 0xff)
		throw new Error(`Unsupported value type for STcontroller: ${value}`)
	}

	private static buildHeader(totalLength: number): number[] {
		return [
			0xff,
			0xff,
			0x00,
			totalLength & 0xff,
			0x07,
			0xe1,
			0x00,
			0x00,
			0x90,
			0xb1,
			0x1c,
			0x5b,
			0xd2,
			0x85,
			0x00,
			0x00,
			0x53,
			0x74,
			0x75,
			0x64,
			0x69,
			0x6f,
			0x2d,
			0x54,
		]
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
}
