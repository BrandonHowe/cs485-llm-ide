/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { hasKey } from '../../../../../base/common/types.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildRequest } from '../../common/backend/vscloneCompletionApiAdapters.js';
import { IVSCloneCompletionPromptEnvelope } from '../../common/vscloneCompletionTypes.js';
import { IVSCloneModelSelection } from '../../common/vscloneModelSelectionTypes.js';

const baseEnvelope: IVSCloneCompletionPromptEnvelope = {
	prefix: 'console.',
	suffix: '\n',
	languageId: 'typescript',
	filePath: '/workspace/src/app.ts',
	predictionType: 'single-line',
	maxTokens: 96,
	temperature: 0.01,
	stopTokens: ['\n'],
	systemMessage: 'system',
	promptText: 'prompt',
};

function createSelection(vendor: IVSCloneModelSelection['vendor'], modelId: string, reasoningEffort?: IVSCloneModelSelection['reasoningEffort']): IVSCloneModelSelection {
	return {
		location: 'editorInline',
		modelIdentifier: `${vendor}/${modelId}`,
		vendor,
		modelId,
		modelName: modelId,
		reasoningEffort,
		selectedAt: Date.now(),
	};
}

suite('VSCloneCompletionApiAdapters', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('omits temperature for OpenAI GPT-5 completion models', () => {
		const request = buildRequest(baseEnvelope, createSelection('openai', 'gpt-5.3-codex'));
		assert.strictEqual(hasKey(request.body, { temperature: true }), false);
	});

	test('forwards temperature for Anthropic and Google completion models', () => {
		// Anthropic completions still allow temperature, even after the picker moved to the 4.6 aliases.
		const anthropicRequest = buildRequest(baseEnvelope, createSelection('anthropic', 'claude-sonnet-4.6'));
		const googleRequest = buildRequest(baseEnvelope, createSelection('google', 'gemini-2.5-pro'));

		assert.strictEqual(anthropicRequest.body.temperature, 0.01);
		assert.strictEqual((googleRequest.body.generationConfig as { temperature?: number }).temperature, 0.01);
	});

	test('forwards reasoning effort without unsupported max output tokens for OpenAI completion models', () => {
		const request = buildRequest(baseEnvelope, createSelection('openai', 'gpt-5.3-codex-spark', 'lite'));

		assert.strictEqual(hasKey(request.body, { max_output_tokens: true }), false);
		assert.deepStrictEqual(request.body.reasoning, { effort: 'low' });
	});
});
