import ModuleInstance from './main.js'

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	self.setVariableDefinitions({
		variable1: { name: 'My first variable' },
		variable2: { name: 'My second variable' },
		variable3: { name: 'Another variable' },
	})
}
