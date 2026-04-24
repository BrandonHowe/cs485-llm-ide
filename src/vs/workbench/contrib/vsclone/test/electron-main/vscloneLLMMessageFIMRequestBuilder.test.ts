/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IVSCloneLLMPreparedFIMPayload } from '../../common/vscloneLLMMessageTypes.js';
import { buildOpenAIFIMRequest } from '../../electron-main/vscloneLLMMessageImpl.js';

function createPreparedFIMPayload(overrides: Partial<IVSCloneLLMPreparedFIMPayload> = {}): IVSCloneLLMPreparedFIMPayload {
	return {
		vendor: 'openai',
		modelId: 'gpt-5-nano',
		modelIdentifier: 'openai/gpt-5-nano',
		prompt: {
			prefix: 'const answer = ',
			suffix: ';',
			maxTokens: 64,
			temperature: 0,
			stopTokens: [],
			systemMessage: 'Complete the code.',
			promptText: 'Finish the line',
		},
		...overrides,
	};
}

suite('VSCloneLLMMessage OpenAI FIM request builder', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('suppresses reasoning field for "none" effort and preserves it for non-off efforts', () => {
		// Pins the R3 suppression path: `buildOpenAIFIMRequest` must route reasoning through
		// `buildOpenAIFIMReasoningFragment` / `getVSCloneSendableReasoningInfo` so an autocomplete
		// caller that explicitly opts out with `reasoningEffort: 'none'` produces a request body with
		// no `reasoning` property at all (instead of the old fallback `{ effort: 'minimal' }`). Paired
		// with the positive case, the VSClone-level 'standard' effort is normalized to the Responses
		// API's `medium` label via `toVSCloneOpenAIReasoningEffort`.
		const none = buildOpenAIFIMRequest(createPreparedFIMPayload({ reasoningEffort: 'none' }));
		const undefinedEffort = buildOpenAIFIMRequest(createPreparedFIMPayload({ reasoningEffort: undefined }));
		// The gpt-5-nano catalog entry has the 'none' slot in its `effort_slider.values`, so the
		// default resolution also yields 'high' (the model default) when an autocomplete selection
		// passes through with no explicit effort. For the explicit 'high' case we use a model whose
		// effort slider does not list 'none' so the two cases stay independent.
		const high = buildOpenAIFIMRequest(createPreparedFIMPayload({
			modelId: 'gpt-5.3-codex-spark',
			modelIdentifier: 'openai/gpt-5.3-codex-spark',
			reasoningEffort: 'standard',
		}));
		const nonReasoningModel = buildOpenAIFIMRequest(createPreparedFIMPayload({
			// gpt-3.5-turbo is not in the VSClone catalog, so the capability lookup returns no
			// reasoning capabilities and the sendable-info helper returns null even when an effort is
			// present on the selection. This pins the "unknown/non-reasoning model ⇒ no reasoning
			// field" branch of the suppression.
			modelId: 'gpt-3.5-turbo',
			modelIdentifier: 'openai/gpt-3.5-turbo',
			reasoningEffort: 'high',
		}));

		assert.deepStrictEqual({
			noneHasReasoning: Object.prototype.hasOwnProperty.call(none.body, 'reasoning'),
			undefinedHasReasoning: Object.prototype.hasOwnProperty.call(undefinedEffort.body, 'reasoning'),
			highReasoning: high.body.reasoning,
			nonReasoningModelHasReasoning: Object.prototype.hasOwnProperty.call(nonReasoningModel.body, 'reasoning'),
		}, {
			noneHasReasoning: false,
			// An undefined `reasoningEffort` falls back to the slider default. gpt-5-nano's default is
			// 'high' (not 'none'), so the reasoning field should still be emitted for this case.
			undefinedHasReasoning: true,
			highReasoning: { effort: 'medium' },
			nonReasoningModelHasReasoning: false,
		});
	});
});
