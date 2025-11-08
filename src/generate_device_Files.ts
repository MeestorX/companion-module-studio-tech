/**
 * generate_device_files.ts
 * - Generates UI JSON and Raw command JSON files for all supported models
 * - Run with: ts-node generate_device_files.ts
 *
 * Note: The content below was authored from the STcontroller PDF examples and the prior
 * commands.json. Values are constructed to be UI-ready and include example "current" values.
 */

import fs from 'fs'
import path from 'path'

type Choice = { id: string | number; label: string }
type UiSetting = {
	type: string
	label: string
	default?: string | number | boolean
	choices?: Choice[]
	current?: string | number | boolean
	group?: string
}

type UiFile = {
	model: string
	settings: Record<string, UiSetting>
}

type RawParam = {
	paramId: string // hex string like '0x0D'
	type: string // uint8, boolean, rgb, enum
	length: number
	validValues?: (number | string)[] | Record<string, string>
	examples?: { value: any; hex: string }[]
}

type RawCommand = {
	cmdId: number
	parameters: RawParam[]
}

type RawFile = {
	model: string
	commands: Record<string, RawCommand>
}

const outDir = path.join(import.meta.dirname, '../devices')
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

// Helper to write UI + raw files
function write(model: string, ui: UiFile, raw: RawFile) {
	const safe = model.replace(/\s+/g, '')
	fs.writeFileSync(path.join(outDir, `${safe}.json`), JSON.stringify(ui, null, 2), 'utf8')
	fs.writeFileSync(path.join(outDir, `${safe}_commands.json`), JSON.stringify(raw, null, 2), 'utf8')
}

/**
 * Below: concise but complete definitions for each model requested.
 * All choices/defaults/current values are examples (current values can be updated by parsing GetAll).
 */

// Model207
write(
	'Model207',
	{
		model: 'Model207',
		settings: {
			MainButtonMode: {
				type: 'dropdown',
				label: 'Main Button Mode',
				default: 'push_to_talk',
				choices: [
					{ id: 'push_to_mute', label: 'Push to Mute' },
					{ id: 'push_to_talk', label: 'Push to Talk' },
					{ id: 'latching', label: 'Latching' },
					{ id: 'ptt_tap_to_latch', label: 'PTT Tap to Latch' },
					{ id: 'ptm_tap_to_latch', label: 'PTM Tap to Latch' },
					{ id: 'always_on', label: 'Always On' },
				],
				current: 'push_to_talk',
			},
			TalkbackButtonMode: {
				type: 'dropdown',
				label: 'Talkback Button Mode',
				default: 'push_to_talk',
				choices: [
					{ id: 'push_to_talk', label: 'Push to Talk' },
					{ id: 'latching', label: 'Latching' },
					{ id: 'ptt_tap_to_latch', label: 'PTT Tap to Latch' },
					{ id: 'disabled', label: 'Disabled' },
				],
				current: 'latching',
			},
		},
	},
	{
		model: 'Model207',
		commands: {
			MainButtonMode: {
				cmdId: 7,
				parameters: [
					{
						paramId: '0x10',
						type: 'enum',
						length: 1,
						validValues: {
							'0': 'push_to_mute',
							'1': 'push_to_talk',
							'2': 'latching',
							'3': 'ptt_tap_to_latch',
							'9': 'ptm_tap_to_latch',
							'11': 'always_on',
						},
						examples: [{ value: 'latching', hex: '03 10 02' }],
					},
				],
			},
			TalkbackButtonMode: {
				cmdId: 7,
				parameters: [
					{
						paramId: '0x11',
						type: 'enum',
						length: 1,
						validValues: { '1': 'push_to_talk', '2': 'latching', '3': 'ptt_tap_to_latch', '4': 'disabled' },
						examples: [{ value: 'push_to_talk', hex: '03 11 01' }],
					},
				],
			},
		},
	},
)

// Model209
write(
	'Model209',
	{
		model: 'Model209',
		settings: {
			TalkbackToggle: { type: 'boolean', label: 'Talkback Toggle', default: false, current: true },
			RxCh1Dim: {
				type: 'dropdown',
				label: 'RX Ch1 Dim (steps)',
				default: 0,
				choices: Array.from({ length: 11 }, (_, i) => ({ id: i, label: `${(i * 1.5).toFixed(1)} dB` })),
				current: 4,
			},
			RxCh2Dim: {
				type: 'dropdown',
				label: 'RX Ch2 Dim (steps)',
				default: 0,
				choices: Array.from({ length: 11 }, (_, i) => ({ id: i, label: `${(i * 1.5).toFixed(1)} dB` })),
				current: 2,
			},
			EncoderPosition: { type: 'number', label: 'Encoder Position', default: 0, current: 12 },
			EncoderState: {
				type: 'dropdown',
				label: 'Encoder State',
				default: 'off',
				choices: [
					{ id: 'off', label: 'Off' },
					{ id: 'on', label: 'On' },
					{ id: 'pushed', label: 'Pushed' },
				],
				current: 'on',
			},
			EncoderColor: { type: 'colorpicker', label: 'Encoder Color', default: '#FFFFFF', current: '#FF8000' },
		},
	},
	{
		model: 'Model209',
		commands: {
			TalkbackToggle: {
				cmdId: 13,
				parameters: [
					{ paramId: '0x0A', type: 'uint8', length: 1, validValues: [0, 1], examples: [{ value: 1, hex: '03 0A 01' }] },
				],
			},
			RxCh1Dim: {
				cmdId: 13,
				parameters: [
					{
						paramId: '0x07',
						type: 'uint8',
						length: 1,
						validValues: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
						examples: [{ value: 4, hex: '03 07 04' }],
					},
				],
			},
			RxCh2Dim: {
				cmdId: 13,
				parameters: [
					{
						paramId: '0x08',
						type: 'uint8',
						length: 1,
						validValues: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
						examples: [{ value: 2, hex: '03 08 02' }],
					},
				],
			},
			EncoderPosition: {
				cmdId: 13,
				parameters: [
					{
						paramId: '0x04',
						type: 'uint8',
						length: 1,
						validValues: Array.from(Array(32).keys()),
						examples: [{ value: 12, hex: '03 04 0C' }],
					},
				],
			},
			EncoderState: {
				cmdId: 13,
				parameters: [
					{
						paramId: '0x05',
						type: 'enum',
						length: 1,
						validValues: { '0': 'off', '1': 'on', '2': 'pushed' },
						examples: [{ value: 'on', hex: '03 05 01' }],
					},
				],
			},
			EncoderColor: {
				cmdId: 13,
				parameters: [
					{ paramId: '0x06', type: 'rgb', length: 3, examples: [{ value: [255, 128, 0], hex: '05 06 FF 80 00' }] },
				],
			},
		},
	},
)

// Models 232/234/236 (Mic Pre share)
const micPreUi = {
	model: 'Model532-style',
	settings: {
		MicPreGain: {
			type: 'dropdown',
			label: 'Mic Pre Gain (dB)',
			default: 36,
			choices: [
				{ id: 18, label: '18 dB' },
				{ id: 24, label: '24 dB' },
				{ id: 30, label: '30 dB' },
				{ id: 36, label: '36 dB' },
				{ id: 42, label: '42 dB' },
			],
			current: 36,
		},
		PhantomPower: { type: 'boolean', label: '48V Phantom', default: false, current: false },
	},
}

const micPreRaw = {
	model: 'ModelMicPreShared',
	commands: {
		MicPreGain: {
			cmdId: 18,
			parameters: [
				{
					paramId: '0x0D',
					type: 'uint8',
					length: 1,
					validValues: [18, 24, 30, 36, 42],
					examples: [{ value: 36, hex: '03 0D 24' }],
				},
			],
		},
		PhantomPower: {
			cmdId: 18,
			parameters: [
				{
					paramId: '0x0E',
					type: 'boolean',
					length: 1,
					validValues: [0, 1],
					examples: [{ value: true, hex: '03 0E 01' }],
				},
			],
		},
	},
}

write('Model232', { model: 'Model232', settings: micPreUi.settings }, micPreRaw)
write('Model234', { model: 'Model234', settings: micPreUi.settings }, micPreRaw)
write('Model236', { model: 'Model236', settings: micPreUi.settings }, micPreRaw)

// Model391
write(
	'Model391',
	{
		model: 'Model391',
		settings: {
			AlertingState: { type: 'boolean', label: 'Alerting', default: false, current: false },
			LightMode1Color: { type: 'colorpicker', label: 'Light Color Mode 1', default: '#FFFFFF', current: '#83E6E2' },
			LightMode2Color: { type: 'colorpicker', label: 'Light Color Mode 2', default: '#FFFFFF', current: '#83E6E2' },
		},
	},
	{
		model: 'Model391',
		commands: {
			AlertingState: {
				cmdId: 9,
				parameters: [
					{
						paramId: '0x19',
						type: 'boolean',
						length: 1,
						validValues: [0, 1],
						examples: [{ value: true, hex: '03 19 01' }],
					},
				],
			},
			LightMode1Color: {
				cmdId: 13,
				parameters: [
					{ paramId: '0x04', type: 'rgb', length: 3, examples: [{ value: [131, 230, 226], hex: '05 04 83 E6 E2' }] },
				],
			},
			LightMode2Color: {
				cmdId: 13,
				parameters: [
					{ paramId: '0x0F', type: 'rgb', length: 3, examples: [{ value: [131, 230, 226], hex: '05 0F 83 E6 E2' }] },
				],
			},
		},
	},
)

// Model392
write(
	'Model392',
	{
		model: 'Model392',
		settings: {
			ActiveState: { type: 'boolean', label: 'Active', default: false, current: true },
			OnColor: { type: 'colorpicker', label: 'On Color', default: '#FF0000', current: '#FF0000' },
			OffColor: { type: 'colorpicker', label: 'Off Color', default: '#0000FF', current: '#0000FF' },
			OnIntensity: {
				type: 'dropdown',
				label: 'On Intensity',
				default: 'medium',
				choices: [
					{ id: 'low', label: 'Low' },
					{ id: 'medium', label: 'Medium' },
					{ id: 'high', label: 'High' },
				],
				current: 'high',
			},
			OffIntensity: {
				type: 'dropdown',
				label: 'Off Intensity',
				default: 'low',
				choices: [
					{ id: 'low', label: 'Low' },
					{ id: 'medium', label: 'Medium' },
					{ id: 'high', label: 'High' },
					{ id: 'off', label: 'Off' },
				],
				current: 'low',
			},
			ControlSource: {
				type: 'dropdown',
				label: 'Control Source',
				default: 'stcontroller',
				choices: [
					{ id: 'stcontroller', label: 'STcontroller' },
					{ id: 'tone_detect', label: 'Tone Detect' },
					{ id: 'udp', label: 'UDP' },
					{ id: 'input_audio', label: 'Input Audio' },
				],
				current: 'udp',
			},
		},
	},
	{
		model: 'Model392',
		commands: {
			ActiveState: {
				cmdId: 9,
				parameters: [
					{
						paramId: '0x19',
						type: 'boolean',
						length: 1,
						validValues: [0, 1],
						examples: [{ value: true, hex: '03 19 01' }],
					},
				],
			},
			OnColor: {
				cmdId: 13,
				parameters: [
					{ paramId: '0x04', type: 'rgb', length: 3, examples: [{ value: [255, 0, 0], hex: '05 04 FF 00 00' }] },
				],
			},
			OffColor: {
				cmdId: 13,
				parameters: [
					{ paramId: '0x15', type: 'rgb', length: 3, examples: [{ value: [0, 0, 255], hex: '05 15 00 00 FF' }] },
				],
			},
			OnIntensity: {
				cmdId: 13,
				parameters: [
					{
						paramId: '0x05',
						type: 'enum',
						length: 1,
						validValues: { '0': 'off', '1': 'low', '2': 'medium', '3': 'high' },
						examples: [{ value: 'high', hex: '03 05 03' }],
					},
				],
			},
			OffIntensity: {
				cmdId: 13,
				parameters: [
					{
						paramId: '0x16',
						type: 'enum',
						length: 1,
						validValues: { '0': 'off', '1': 'low', '2': 'medium', '3': 'high' },
						examples: [{ value: 'low', hex: '03 16 01' }],
					},
				],
			},
			ControlSource: {
				cmdId: 13,
				parameters: [
					{
						paramId: '0x02',
						type: 'enum',
						length: 1,
						validValues: { '0': 'stcontroller', '1': 'tone_detect', '4': 'udp', '5': 'input_audio' },
						examples: [{ value: 'udp', hex: '03 02 04' }],
					},
				],
			},
		},
	},
)

// Model5205
write(
	'Model5205',
	{
		model: 'Model5205',
		settings: {
			MicPreGain: {
				type: 'dropdown',
				label: 'Mic Pre Gain (dB)',
				default: 40,
				choices: [
					{ id: 0, label: '0 dB' },
					{ id: 20, label: '20 dB' },
					{ id: 30, label: '30 dB' },
					{ id: 40, label: '40 dB' },
					{ id: 50, label: '50 dB' },
					{ id: 60, label: '60 dB' },
				],
				current: 40,
			},
			PhantomPower: { type: 'boolean', label: '48V Phantom', default: false, current: false },
		},
	},
	{
		model: 'Model5205',
		commands: {
			MicPreGain: {
				cmdId: 18,
				parameters: [
					{
						paramId: '0x01',
						type: 'uint8',
						length: 1,
						validValues: [0, 20, 30, 40, 50, 60],
						examples: [{ value: 40, hex: '03 01 28' }],
					},
				],
			},
			PhantomPower: {
				cmdId: 18,
				parameters: [
					{
						paramId: '0x02',
						type: 'boolean',
						length: 1,
						validValues: [0, 48],
						examples: [{ value: true, hex: '03 02 30' }],
					},
				],
			},
		},
	},
)

// Model5364
write(
	'Model5364',
	{
		model: 'Model5364',
		settings: {
			MicPreGain: {
				type: 'dropdown',
				label: 'Mic Pre Gain (dB)',
				default: 36,
				choices: [
					{ id: 18, label: '18' },
					{ id: 24, label: '24' },
					{ id: 30, label: '30' },
					{ id: 36, label: '36' },
					{ id: 42, label: '42' },
				],
				current: 36,
			},
			HeadphoneSidetone: {
				type: 'dropdown',
				label: 'Sidetone',
				default: 'medium',
				choices: [
					{ id: 'off', label: 'Off' },
					{ id: 'low', label: 'Low' },
					{ id: 'medium', label: 'Medium' },
					{ id: 'medhigh', label: 'Medium-High' },
					{ id: 'high', label: 'High' },
				],
				current: 'medium',
			},
		},
	},
	{
		model: 'Model5364',
		commands: {
			DeviceSpecific: {
				cmdId: 13,
				parameters: [
					{
						paramId: '0x02',
						type: 'pairs',
						length: 0 /* variable */,
						examples: [
							{
								value: [
									[2, 31],
									[3, 31],
									[4, 31],
									[5, 31],
								],
								hex: '0x...',
							},
						],
					},
				],
			},
			MicPreGain: {
				cmdId: 18,
				parameters: [
					{
						paramId: '0x0D',
						type: 'uint8',
						length: 1,
						validValues: [18, 24, 30, 36, 42],
						examples: [{ value: 36, hex: '03 0D 24' }],
					},
				],
			},
			HeadphoneSidetone: {
				cmdId: 5,
				parameters: [
					{
						paramId: '0x15',
						type: 'enum',
						length: 1,
						validValues: { '0': 'off', '1': 'low', '3': 'medium', '4': 'medhigh', '5': 'high' },
						examples: [{ value: 'medium', hex: '03 15 03' }],
					},
				],
			},
		},
	},
)

// Model5365
write(
	'Model5365',
	{
		model: 'Model5365',
		settings: {
			MicPreGain: {
				type: 'dropdown',
				label: 'Mic Pre Gain (dB)',
				default: 36,
				choices: [
					{ id: 18, label: '18' },
					{ id: 24, label: '24' },
					{ id: 30, label: '30' },
					{ id: 36, label: '36' },
					{ id: 42, label: '42' },
				],
				current: 36,
			},
			PhantomPower: { type: 'boolean', label: '48V Phantom', default: false, current: false },
			HeadphoneSidetone: {
				type: 'dropdown',
				label: 'Headphone Sidetone',
				default: 'medium',
				choices: [
					{ id: 'off', label: 'Off' },
					{ id: 'low', label: 'Low' },
					{ id: 'medium', label: 'Medium' },
					{ id: 'medhigh', label: 'Medium-High' },
					{ id: 'high', label: 'High' },
				],
				current: 'medium',
			},
		},
	},
	{
		model: 'Model5365',
		commands: {
			MicPreGain: {
				cmdId: 18,
				parameters: [
					{
						paramId: '0x0D',
						type: 'uint8',
						length: 1,
						validValues: [18, 24, 30, 36, 42],
						examples: [{ value: 36, hex: '03 0D 24' }],
					},
				],
			},
			PhantomPower: {
				cmdId: 18,
				parameters: [
					{
						paramId: '0x0E',
						type: 'boolean',
						length: 1,
						validValues: [0, 5],
						examples: [
							{ value: false, hex: '03 0E 00' },
							{ value: true, hex: '03 0E 05' },
						],
					},
				],
			},
			HeadphoneSidetone: {
				cmdId: 5,
				parameters: [
					{
						paramId: '0x15',
						type: 'enum',
						length: 1,
						validValues: { '0': 'off', '1': 'low', '3': 'medium', '4': 'medhigh', '5': 'high' },
						examples: [{ value: 'medium', hex: '03 15 03' }],
					},
				],
			},
		},
	},
)

// Model5401A & Model5402 (read-only leader clocks)
write(
	'Model5401A',
	{
		model: 'Model5401A',
		settings: {
			Status: { type: 'static-text', label: 'Status', default: 'Unknown', current: 'OK' },
			Info: { type: 'static-text', label: 'Info', default: 'N/A', current: 'GPS OK' },
		},
	},
	{
		model: 'Model5401A',
		commands: {
			ReadOnly: {
				cmdId: 10,
				parameters: [{ paramId: '0x1E', type: 'uint8', length: 1, examples: [{ value: 14, hex: '03 1E 0E' }] }],
			},
		},
	},
)

write(
	'Model5402',
	{
		model: 'Model5402',
		settings: {
			Status: { type: 'static-text', label: 'Status', default: 'Unknown', current: 'OK' },
			GNSS: { type: 'static-text', label: 'GNSS', default: 'Disabled', current: 'Active' },
		},
	},
	{
		model: 'Model5402',
		commands: {
			ReadOnly: {
				cmdId: 10,
				parameters: [
					{ paramId: '0x1E', type: 'uint8', length: 1, examples: [{ value: 14, hex: '03 1E 0E' }] },
					{ paramId: '0x1F', type: 'uint8', length: 1, examples: [{ value: 20, hex: '03 1F 14' }] },
				],
			},
		},
	},
)

// ZEVO (generic device in PDF)
write(
	'ZEVO',
	{
		model: 'ZEVO',
		settings: {
			OverallLevel: { type: 'number', label: 'Overall Level', default: 31, current: 31 },
			SidetoneLevel: { type: 'number', label: 'Sidetone Level', default: 8, current: 8 },
			TallyOut: {
				type: 'dropdown',
				label: 'Tally Out',
				default: 'both_off',
				choices: [
					{ id: 'both_off', label: 'Both Off' },
					{ id: 'tally1', label: 'Tally1' },
					{ id: 'tally2', label: 'Tally2' },
				],
				current: 'both_off',
			},
			EncoderColor: { type: 'colorpicker', label: 'Encoder Color', default: '#FFFFFF', current: '#FFFFFF' },
		},
	},
	{
		model: 'ZEVO',
		commands: {
			OverallLevel: {
				cmdId: 13,
				parameters: [
					{
						paramId: '0x00',
						type: 'uint8',
						length: 1,
						validValues: Array.from(Array(32).keys()),
						examples: [{ value: 31, hex: '03 00 1F' }],
					},
				],
			},
			SidetoneLevel: {
				cmdId: 13,
				parameters: [
					{
						paramId: '0x01',
						type: 'uint8',
						length: 1,
						validValues: Array.from(Array(33).keys()),
						examples: [{ value: 8, hex: '03 01 08' }],
					},
				],
			},
			TallyOut: {
				cmdId: 13,
				parameters: [
					{
						paramId: '0x03',
						type: 'enum',
						length: 1,
						validValues: { '0': 'both_off', '1': 'tally1', '2': 'tally2' },
						examples: [{ value: 'tally1', hex: '03 03 01' }],
					},
				],
			},
			EncoderColor: {
				cmdId: 13,
				parameters: [
					{ paramId: '0x06', type: 'rgb', length: 3, examples: [{ value: [255, 255, 255], hex: '05 06 FF FF FF' }] },
				],
			},
		},
	},
)

console.log('Device files written to ./devices')
