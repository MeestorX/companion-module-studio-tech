import type { ModuleInstance } from './main.js'
import { buildFeedbacks } from './build-commands.js'

/**
 * Build Companion feedback definitions from buildFeedbacks() output
 */

export function UpdateFeedbacks(self: ModuleInstance): void {
	const feedbacks = buildFeedbacks()
	console.log('Feedbacks built:', Object.keys(feedbacks).length)

	self.setFeedbackDefinitions(feedbacks)
}
