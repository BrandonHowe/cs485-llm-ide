/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { hasKey } from '../../../../../base/common/types.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildRequest } from '../../common/backend/vscloneCompletionApiAdapters.js';
import { resolveVSCloneApiModelId } from '../../common/vscloneChatApiAdapters.js';
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
		// Anthropic completions still allow temperature on the Haiku models that the OAuth-backed
		// transport can successfully use today.
		const anthropicRequest = buildRequest(baseEnvelope, createSelection('anthropic', 'claude-haiku-4-5-20251001'));
		const googleRequest = buildRequest(baseEnvelope, createSelection('google', 'gemini-2.5-pro'));

		assert.strictEqual(anthropicRequest.body.model, 'claude-haiku-4-5-20251001');
		assert.strictEqual(anthropicRequest.body.temperature, 0.01);
		assert.strictEqual(googleRequest.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
		assert.deepStrictEqual(googleRequest.body.systemInstruction, {
			parts: [{ text: 'system' }],
		});
		assert.strictEqual((googleRequest.body.generationConfig as { temperature?: number }).temperature, 0.01);
	});

	test('omits whitespace-only stop sequences for Anthropic completion models', () => {
		const anthropicRequest = buildRequest(baseEnvelope, createSelection('anthropic', 'claude-haiku-4-5-20251001'));

		assert.strictEqual(hasKey(anthropicRequest.body, { stop_sequences: true }), false);
	});

	test('preserves non-whitespace stop sequences for Anthropic completion models', () => {
		const anthropicRequest = buildRequest({
			...baseEnvelope,
			stopTokens: ['<END>'],
		}, createSelection('anthropic', 'claude-haiku-4-5-20251001'));

		assert.deepStrictEqual(anthropicRequest.body.stop_sequences, ['<END>']);
	});

	test('maps Anthropic picker IDs to real provider model aliases', () => {
		// The UI currently exposes VSClone compatibility labels, but the transport must emit the
		// exact Anthropic IDs from the current `/v1/models` response rather than the older aliases.
		assert.strictEqual(resolveVSCloneApiModelId('anthropic', 'claude-opus-4.6'), 'claude-opus-4-6');
		assert.strictEqual(resolveVSCloneApiModelId('anthropic', 'claude-sonnet-4.6'), 'claude-sonnet-4-6');
		assert.strictEqual(resolveVSCloneApiModelId('anthropic', 'claude-sonnet-4.0'), 'claude-sonnet-4-20250514');
		assert.strictEqual(resolveVSCloneApiModelId('anthropic', 'claude-haiku-4.5'), 'claude-haiku-4-5-20251001');
	});

	test('keeps Google picker IDs aligned with the live provider model aliases', () => {
		// The current catalog already exposes the provider-facing IDs for Google's supported VSClone
		// entries, so the resolver should preserve them exactly rather than reintroducing older aliases.
		assert.strictEqual(resolveVSCloneApiModelId('google', 'gemini-3.1-pro-preview'), 'gemini-3.1-pro-preview');
		assert.strictEqual(resolveVSCloneApiModelId('google', 'gemini-3-flash-preview'), 'gemini-3-flash-preview');
		assert.strictEqual(resolveVSCloneApiModelId('google', 'gemini-3.1-flash-lite-preview'), 'gemini-3.1-flash-lite-preview');
	});

	test('rejects Anthropic completion models that the OAuth Messages beta still fails to serve', () => {
		assert.throws(
			() => buildRequest(baseEnvelope, createSelection('anthropic', 'claude-sonnet-4.6')),
			/Anthropic OAuth messages currently support only Claude Haiku 4\.5 and Claude Haiku 3/,
		);
	});

	test('forwards reasoning effort without unsupported max output tokens for OpenAI completion models', () => {
		const request = buildRequest(baseEnvelope, createSelection('openai', 'gpt-5.3-codex-spark', 'lite'));

		assert.strictEqual(hasKey(request.body, { max_output_tokens: true }), false);
		assert.deepStrictEqual(request.body.reasoning, { effort: 'low' });
	});

	test('forwards explicit no-reasoning for the gpt-5-nano inline fallback', () => {
		const request = buildRequest(baseEnvelope, createSelection('openai', 'gpt-5-nano', 'none'));

		assert.deepStrictEqual(request.body.reasoning, { effort: 'none' });
	});
});
