/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { hasKey } from '../../../../../base/common/types.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getVendorAdapter, type IVSCloneApiSubmitOptions } from '../../common/vscloneChatApiAdapters.js';

function createSubmitOptions(overrides: Partial<IVSCloneApiSubmitOptions> = {}): IVSCloneApiSubmitOptions {
	return {
		threadId: 'thread-1',
		turnId: 'turn-1',
		sequence: 1,
		sessionResource: 'vsclone://thread-1',
		promptText: 'what model are you',
		vendor: 'anthropic',
		modelId: 'claude-haiku-4-5-20251001',
		modelIdentifier: 'anthropic/claude-haiku-4-5-20251001',
		reasoningEffort: 'high',
		...overrides,
	};
}

suite('VSCloneChatApiAdapters', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('anthropic requests stay on the plain Messages API shape by default', () => {
		const request = getVendorAdapter('anthropic').buildRequest(createSubmitOptions());

		assert.deepStrictEqual({
			model: request.body.model,
			max_tokens: request.body.max_tokens,
			system: request.body.system,
			stream: request.body.stream,
		}, {
			model: 'claude-haiku-4-5-20251001',
			max_tokens: 16384,
			system: 'You are VSClone, a helpful coding assistant. Answer clearly and concisely. User turns may include image attachments in addition to text. Inspect attached images directly when they are present. Do not claim a request was text-only unless no image attachments were provided or the runtime reports an image-processing failure.',
			stream: true,
		});
		// Anthropic OAuth should stay on the plain Messages API surface, so the optional thinking block must be omitted entirely.
		assert.strictEqual(hasKey(request.body, { thinking: true }), false);
	});

	test('anthropic requests fail fast for OAuth-unsupported Sonnet selections', () => {
		assert.throws(
			() => getVendorAdapter('anthropic').buildRequest(createSubmitOptions({
				modelId: 'claude-sonnet-4.0',
				modelIdentifier: 'anthropic/claude-sonnet-4.0',
			})),
			/Anthropic OAuth messages currently support only Claude Haiku 4\.5 and Claude Haiku 3/,
		);
	});

	test('google requests target the public Gemini streaming endpoint with a dedicated system instruction', () => {
		const request = getVendorAdapter('google').buildRequest(createSubmitOptions({
			vendor: 'google',
			modelId: 'gemini-2.5-pro',
			modelIdentifier: 'google/gemini-2.5-pro',
			systemMessage: 'system prompt',
		}));

		assert.strictEqual(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
		assert.deepStrictEqual(request.body.systemInstruction, {
			parts: [{ text: 'system prompt' }],
		});
		assert.deepStrictEqual(request.body.contents, [{
			role: 'user',
			parts: [{ text: 'what model are you' }],
		}]);
	});

	test('openai requests preserve images on earlier user turns when rebuilding conversation history', () => {
		const request = getVendorAdapter('openai').buildRequest(createSubmitOptions({
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelIdentifier: 'openai/gpt-5.3-codex',
			previousTurns: [
				{
					role: 'user',
					content: 'Describe the screenshot',
					imageAttachments: [{ mimeType: 'image/png', base64Data: 'Zmlyc3Q=' }],
				},
				{
					role: 'assistant',
					content: 'I see a game menu.',
				},
			],
			imageAttachments: [{ mimeType: 'image/jpeg', base64Data: 'c2Vjb25k' }],
		}));

		assert.deepStrictEqual(request.body.input, [
			{
				type: 'message',
				role: 'user',
				content: [
					{ type: 'input_text', text: 'This user turn includes 1 image attachment. Inspect it directly when answering.\n\nDescribe the screenshot' },
					{ type: 'input_image', image_url: 'data:image/png;base64,Zmlyc3Q=', detail: 'auto' },
				],
			},
			{
				type: 'message',
				role: 'assistant',
				content: 'I see a game menu.',
			},
			{
				type: 'message',
				role: 'user',
				content: [
					{ type: 'input_text', text: 'This user turn includes 1 image attachment. Inspect it directly when answering.\n\nwhat model are you' },
					{ type: 'input_image', image_url: 'data:image/jpeg;base64,c2Vjb25k', detail: 'auto' },
				],
			},
		]);
	});

	test('google parser surfaces prompt feedback blocks as explicit errors', () => {
		const parsed = getVendorAdapter('google').parseLine(`data: ${JSON.stringify({
			promptFeedback: {
				blockReason: 'SAFETY',
				blockReasonMessage: 'blocked for testing',
			},
		})}`, undefined);

		assert.deepStrictEqual(parsed, {
			type: 'error',
			message: 'Google completion blocked: SAFETY (blocked for testing).',
		});
	});

	test('google parser surfaces non-stop finish reasons as explicit errors', () => {
		const parsed = getVendorAdapter('google').parseLine(`data: ${JSON.stringify({
			candidates: [{
				finishReason: 'SAFETY',
				finishMessage: 'candidate blocked',
			}],
		})}`, undefined);

		assert.deepStrictEqual(parsed, {
			type: 'error',
			message: 'Google completion finished with SAFETY: candidate blocked.',
		});
	});
});
