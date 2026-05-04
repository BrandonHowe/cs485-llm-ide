/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
// These pure provider-shape tests intentionally pass compact mock SDK payloads instead of fully
// populated OpenAI/Anthropic/Gemini SDK objects; runtime assertions below validate the behavior.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IVSCloneLLMMessageToolCall, IVSCloneLLMPreparedChatPayload, IVSCloneLLMPreparedFIMPayload } from '../../common/vscloneLLMMessageTypes.js';
import type { IVSCloneToolDefinition } from '../../common/vscloneToolDefinitions.js';
import { VSCloneLLMMessageTestHooks } from '../../electron-main/vscloneLLMMessageImpl.js';

const sampleTool: IVSCloneToolDefinition = {
	name: 'read_file',
	description: 'Read a file',
	planModeAllowed: true,
	parameters: [
		{ name: 'path', required: true, description: 'Path to read.' },
	],
};

const complexSchemaTool = {
	name: 'call_mcp_tool',
	description: 'Call an MCP tool with structured arguments.',
	planModeAllowed: true,
	parameters: [],
	inputSchema: {
		type: 'object',
		properties: {
			mode: {
				type: ['string', 'null'],
				description: 'Optional execution mode.',
				enum: ['fast', 'safe', null],
			},
			target: {
				anyOf: [
					{ type: 'string', description: 'File target.' },
					{ type: 'integer', description: 'Numeric target.' },
					{ type: 'null', description: 'No target.' },
				],
				description: 'Target selector.',
			},
			payload: {
				type: 'array',
				description: 'Nested payload entries.',
				items: {
					type: 'object',
					description: 'One payload entry.',
					properties: {
						value: { type: 'number', description: 'Numeric value.' },
					},
					required: ['value'],
					additionalProperties: false,
				},
			},
			nullOnly: {
				const: null,
				description: 'Must be absent semantically.',
			},
		},
		required: ['mode', 'payload'],
		additionalProperties: false,
	},
} as unknown as IVSCloneToolDefinition;

function createChatPayload(overrides: Partial<IVSCloneLLMPreparedChatPayload> = {}): IVSCloneLLMPreparedChatPayload {
	return {
		vendor: 'openai',
		modelId: 'gpt-5.4',
		modelIdentifier: 'openai/gpt-5.4',
		mode: 'act',
		separateSystemMessage: '  Be precise.  ',
		messages: [],
		toolDefinitions: [sampleTool],
		...overrides,
	};
}

function createFIMPayload(overrides: Partial<IVSCloneLLMPreparedFIMPayload> = {}): IVSCloneLLMPreparedFIMPayload {
	return {
		vendor: 'anthropic',
		modelId: 'claude-haiku-4-5-20251001',
		modelIdentifier: 'anthropic/claude-haiku-4-5-20251001',
		prompt: {
			prefix: 'const value = ',
			suffix: ';',
			maxTokens: 32,
			temperature: 0.25,
			stopTokens: ['\n\n', '   ', 'END'],
			systemMessage: 'Complete only the missing code.',
			promptText: 'const value = <FILL>',
		},
		...overrides,
	};
}

suite('VSCloneLLMMessage pure provider translators', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('builds OpenAI chat requests with native input items, tool calls, and reasoning', () => {
		const request = VSCloneLLMMessageTestHooks.buildOpenAIChatRequest(createChatPayload({
			reasoningEffort: 'xhigh',
			messages: [
				{ role: 'developer', content: 'Prefer short answers.' },
				{ role: 'user', content: [{ type: 'text', text: 'Read this.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'auto' } }] },
				{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden', signature: 'sig' }, { type: 'text', text: 'I will call a tool.' }], tool_calls: [{ type: 'function', id: 'ignored-id', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
				{ role: 'tool', tool_call_id: 'call-1', content: 'contents' },
			],
		}));

		assert.strictEqual(request.model, 'gpt-5.4');
		assert.strictEqual(request.instructions, 'Be precise.');
		assert.deepStrictEqual(request.reasoning, { effort: 'high' });
		assert.strictEqual(request.parallel_tool_calls, false);
		assert.deepStrictEqual(request.tools?.[0]?.parameters.required, ['path']);
		assert.deepStrictEqual(request.input, [
			{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Prefer short answers.' }] },
			{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read this.' }, { type: 'input_image', image_url: 'data:image/png;base64,abc', detail: 'auto' }] },
			{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'I will call a tool.', annotations: [] }] },
			{ type: 'function_call', call_id: 'ignored-id', name: 'read_file', arguments: '{"path":"README.md"}', status: 'completed' },
			{ type: 'function_call_output', call_id: 'call-1', output: 'contents' },
		]);
	});

	test('builds Anthropic and Google chat requests with provider-specific tool and thinking shapes', () => {
		const anthropic = VSCloneLLMMessageTestHooks.buildAnthropicChatRequest(createChatPayload({
			vendor: 'anthropic',
			modelId: 'claude-haiku-4-5-20251001',
			modelIdentifier: 'anthropic/claude-haiku-4-5-20251001',
			reasoningEnabled: true,
			reasoningEffort: 'max',
			messages: [{ role: 'user', content: 'Question' }],
		}));
		const google = VSCloneLLMMessageTestHooks.buildGoogleChatRequest(createChatPayload({
			vendor: 'google',
			modelId: 'gemini-2.5-flash',
			modelIdentifier: 'google/gemini-2.5-flash',
			messages: [{ role: 'user', parts: [{ text: 'Question' }] }],
			toolDefinitions: [sampleTool],
		}), new AbortController().signal);
		const googleMinimal = VSCloneLLMMessageTestHooks.buildGoogleChatRequest(createChatPayload({
			vendor: 'google',
			modelId: 'gemini-3-flash-preview',
			modelIdentifier: 'google/gemini-3-flash-preview',
			reasoningEffort: 'minimal',
			messages: [{ role: 'user', parts: [{ text: 'Question' }] }],
		}), new AbortController().signal);

		// Anthropic chat requests use the transport-local Claude Code preset map. The lower budget
		// keeps normal chat responses usable while the catalog-level reasoning adapter still pins
		// Haiku's provider maximum separately.
		assert.deepStrictEqual(anthropic.thinking, { type: 'enabled', budget_tokens: 7999 });
		assert.strictEqual(anthropic.max_tokens, 64000);
		assert.deepStrictEqual(anthropic.tools?.[0]?.input_schema.required, ['path']);

		assert.throws(() => VSCloneLLMMessageTestHooks.buildAnthropicChatRequest(createChatPayload({
			vendor: 'anthropic',
			modelId: 'claude-sonnet-4.6',
			modelIdentifier: 'anthropic/claude-sonnet-4.6',
			messages: [{ role: 'user', content: 'Question' }],
		})), /re-select Claude Haiku/i);

		assert.strictEqual(google.config.systemInstruction, 'Be precise.');
		assert.strictEqual(google.config.toolConfig.functionCallingConfig.mode, 'AUTO');
		assert.strictEqual(google.config.tools[0].functionDeclarations[0].parameters.properties.path.type, 'STRING');
		// Gemini's reasoning dropdown maps only `minimal` to provider config. The default/high option
		// omits config so Gemini keeps its provider-native dynamic thinking behavior.
		assert.strictEqual(google.config.thinkingConfig, undefined);
		assert.deepStrictEqual(googleMinimal.config.thinkingConfig, { thinkingLevel: 'minimal' });
	});

	test('converts structured MCP JSON schema into Gemini-compatible tool declarations', () => {
		const google = VSCloneLLMMessageTestHooks.buildGoogleChatRequest(createChatPayload({
			vendor: 'google',
			modelId: 'gemini-2.5-flash',
			modelIdentifier: 'google/gemini-2.5-flash',
			messages: [{ role: 'user', parts: [{ text: 'Question' }] }],
			toolDefinitions: [complexSchemaTool],
		}), new AbortController().signal);
		const parameters = google.config.tools?.[0]?.functionDeclarations[0].parameters;
		assert.ok(parameters?.properties);

		// Gemini has nullable schemas but no draft-07 null type. Pinning the exact approximation
		// keeps MCP schemas usable without broadening null-only branches into unconstrained values.
		assert.deepStrictEqual(parameters.required, ['mode', 'payload']);
		assert.deepStrictEqual(parameters.properties.mode, {
			type: 'STRING',
			nullable: true,
			description: 'Optional execution mode.',
			enum: ['fast', 'safe'],
		});
		assert.deepStrictEqual(parameters.properties.target, {
			description: 'Target selector.',
			nullable: true,
			anyOf: [
				{ type: 'STRING', description: 'File target.' },
				{ type: 'INTEGER', description: 'Numeric target.' },
			],
		});
		assert.deepStrictEqual(parameters.properties.payload, {
			type: 'ARRAY',
			description: 'Nested payload entries.',
			items: {
				type: 'OBJECT',
				description: 'One payload entry.',
				required: ['value'],
				properties: {
					value: {
						type: 'NUMBER',
						description: 'Numeric value.',
					},
				},
			},
		});
		assert.deepStrictEqual(parameters.properties.nullOnly, {
			type: 'STRING',
			nullable: true,
			description: 'Must be absent semantically.\n\nOnly null is valid for this value.',
		});
	});

	test('builds non-OpenAI FIM requests and sanitizes provider-specific stop tokens', () => {
		const anthropic = VSCloneLLMMessageTestHooks.buildAnthropicFIMRequest(createFIMPayload());
		const google = VSCloneLLMMessageTestHooks.buildGoogleFIMRequest(createFIMPayload({
			vendor: 'google',
			modelId: 'gemini-2.5-flash-lite',
			modelIdentifier: 'google/gemini-2.5-flash-lite',
		}));

		// Anthropic rejects whitespace-only stop sequences, so the FIM bridge drops both blank and
		// newline-only tokens while Google preserves the caller's generation config verbatim.
		assert.deepStrictEqual(anthropic.body.stop_sequences, ['END']);
		assert.strictEqual(anthropic.body.temperature, 0.25);
		assert.ok(String(google.url).endsWith('/gemini-2.5-flash-lite:streamGenerateContent?alt=sse'));
		assert.deepStrictEqual(google.body.generationConfig.stopSequences, ['\n\n', '   ', 'END']);
	});

	test('parses FIM SSE payload variants for all providers', () => {
		const state = { remainder: '', accumulatedText: '', currentEventType: undefined };
		assert.deepStrictEqual(VSCloneLLMMessageTestHooks.processFIMSseLine('event: content_block_delta', 'anthropic', state), undefined);
		assert.strictEqual(state.currentEventType, 'content_block_delta');
		assert.deepStrictEqual(VSCloneLLMMessageTestHooks.processFIMSseLine('data: {"delta":{"type":"text_delta","text":"hi"}}', 'anthropic', state), { type: 'delta', text: 'hi' });
		assert.deepStrictEqual(VSCloneLLMMessageTestHooks.parseFIMSsePayload('openai', '{"type":"response.output_text.delta","delta":"OA"}', undefined), { type: 'delta', text: 'OA' });
		assert.deepStrictEqual(VSCloneLLMMessageTestHooks.parseFIMSsePayload('openai', '{"error":{"message":"bad"}}', undefined), { type: 'error', message: 'bad' });
		assert.deepStrictEqual(VSCloneLLMMessageTestHooks.parseFIMSsePayload('google', '{"candidates":[{"content":{"parts":[{"text":"G"}]},"finishReason":"STOP"}]}', undefined), { type: 'delta', text: 'G' });
		assert.deepStrictEqual(VSCloneLLMMessageTestHooks.parseFIMSsePayload('google', '{"promptFeedback":{"blockReason":"SAFETY","blockReasonMessage":"blocked"}}', undefined), { type: 'error', message: 'Google completion blocked: SAFETY (blocked).' });
		assert.deepStrictEqual(VSCloneLLMMessageTestHooks.parseFIMSsePayload('google', '{"candidates":[{"finishReason":"RECITATION","finishMessage":"cite"}]}', undefined), { type: 'error', message: 'Google completion finished with RECITATION: cite.' });
		assert.strictEqual(VSCloneLLMMessageTestHooks.parseFIMSsePayload('google', '{bad json', undefined), undefined);
	});

	test('normalizes native provider tool calls into the VSClone runtime shape', () => {
		const current: IVSCloneLLMMessageToolCall = { name: '', rawParams: {}, doneParams: [], id: '', isDone: false };
		assert.deepStrictEqual(VSCloneLLMMessageTestHooks.toVSCloneToolCallFromOpenAIEventItem({
			type: 'function_call',
			id: 'item-1',
			call_id: 'call-1',
			name: 'edit_file',
			arguments: '{}',
			status: 'completed',
		}, current, '{"path":"src/app.ts","nested":{"a":1}}'), {
			name: 'edit_file',
			rawParams: { path: 'src/app.ts', nested: '{"a":1}' },
			doneParams: ['nested', 'path'],
			id: 'call-1',
			isDone: true,
		});
		assert.deepStrictEqual(VSCloneLLMMessageTestHooks.toVSCloneToolCallFromOpenAIResponse({
			id: 'response-1',
			output_text: '',
			output: [{ type: 'function_call', id: 'item-2', call_id: '', name: 'read_file', arguments: '{"path":"README.md"}', status: 'in_progress' }],
		}), {
			name: 'read_file',
			rawParams: { path: 'README.md' },
			doneParams: ['path'],
			id: 'item-2',
			isDone: false,
		});
		assert.deepStrictEqual(VSCloneLLMMessageTestHooks.toVSCloneToolCallFromAnthropicMessage({
			id: 'msg-1',
			content: [{ type: 'tool_use', id: 'tool-1', name: 'ask_user', input: { question: 'Proceed?', options: ['yes'] } }],
			usage: { input_tokens: 1, output_tokens: 2 },
		}), {
			name: 'ask_user',
			rawParams: { question: 'Proceed?', options: '["yes"]' },
			doneParams: ['options', 'question'],
			id: 'tool-1',
			isDone: true,
		});
	});

	test('handles auth header helpers case-insensitively', () => {
		assert.strictEqual(VSCloneLLMMessageTestHooks.requireBearerToken({ authorization: '  Bearer token-1  ' }, 'openai'), 'token-1');
		assert.throws(() => VSCloneLLMMessageTestHooks.requireBearerToken({ Authorization: 'Basic abc' }, 'google'), /Bearer token/);
		assert.deepStrictEqual(VSCloneLLMMessageTestHooks.withoutHeader({ Authorization: 'secret', 'X-Test': '1' }, 'authorization'), { 'X-Test': '1' });
		assert.deepStrictEqual(VSCloneLLMMessageTestHooks.buildGoogleHttpOptions({ Authorization: 'Bearer g' }), {
			baseUrl: 'https://generativelanguage.googleapis.com',
			apiVersion: 'v1beta',
			headers: { Authorization: 'Bearer g' },
		});
	});

	test('covers pure helper edge cases used by provider adapters', () => {
		// These helpers are intentionally pinned through the test hook so provider-wire regressions
		// are caught without needing live SDK streams or OAuth credentials.
		assert.deepStrictEqual(VSCloneLLMMessageTestHooks.parseToolArgsJson('["not","object"]'), {});
		assert.deepStrictEqual(VSCloneLLMMessageTestHooks.parseToolArgsJson('{"ok":true,"count":2,"nested":{"x":1},"nil":null}'), {
			ok: 'true',
			count: '2',
			nested: '{"x":1}',
			nil: 'null',
		});
		assert.strictEqual(VSCloneLLMMessageTestHooks.stringifyToolParamValue(['a', 'b']), '["a","b"]');
		assert.deepStrictEqual(VSCloneLLMMessageTestHooks.toVSCloneToolCallFromOpenAIEventItem({ type: 'message' } as never, {
			name: 'existing',
			rawParams: {},
			doneParams: [],
			id: 'same',
			isDone: false,
		}, '{}'), {
			name: 'existing',
			rawParams: {},
			doneParams: [],
			id: 'same',
			isDone: false,
		});
		assert.strictEqual(VSCloneLLMMessageTestHooks.toVSCloneToolCallFromOpenAIResponse({ id: 'response-2', output_text: '', output: [] }), undefined);
		assert.strictEqual(VSCloneLLMMessageTestHooks.toVSCloneToolCallFromAnthropicMessage({
			id: 'msg-empty',
			content: [{ type: 'text', text: 'no tool' }],
			usage: { input_tokens: 0, output_tokens: 0 },
		}), undefined);

		assert.deepStrictEqual(VSCloneLLMMessageTestHooks.toGoogleToolSchema({
			type: 'object',
			properties: {
				flag: { type: 'boolean' },
				mixed: { type: ['string', 'number', 'null'] },
				allNull: { anyOf: [{ type: 'null' }, { enum: [null] }], description: 'Null union' },
				ignored: 'not a schema',
			},
		}), {
			type: 'OBJECT',
			properties: {
				flag: { type: 'BOOLEAN' },
				mixed: { nullable: true, anyOf: [{ type: 'STRING' }, { type: 'NUMBER' }] },
				allNull: { type: 'STRING', nullable: true, description: 'Null union\n\nOnly null is valid for this value.' },
			},
		});
		assert.deepStrictEqual(VSCloneLLMMessageTestHooks.toGoogleToolSchema('invalid'), { type: 'OBJECT', properties: {} });

		assert.strictEqual(VSCloneLLMMessageTestHooks.getGoogleCandidateText(undefined), undefined);
		assert.strictEqual(VSCloneLLMMessageTestHooks.getGoogleCandidateText({ content: { parts: [{ text: 'a' }, {}, { text: 'b' }] } }), 'ab');
		assert.strictEqual(VSCloneLLMMessageTestHooks.getGooglePromptFeedbackErrorMessage({ promptFeedback: { blockReason: 'SAFETY' } }), 'Google completion blocked: SAFETY.');
		assert.strictEqual(VSCloneLLMMessageTestHooks.getGoogleFinishReasonErrorMessage({ finishReason: 'OTHER' }), 'Google completion finished with OTHER.');
		assert.strictEqual(VSCloneLLMMessageTestHooks.getGoogleFinishReasonErrorMessage({ finishReason: 'MAX_TOKENS' }), undefined);
		assert.ok(VSCloneLLMMessageTestHooks.getOpenAIBaseUrl().endsWith('/backend-api/codex'));
		assert.deepStrictEqual(VSCloneLLMMessageTestHooks.cloneToolJsonSchema({
			type: 'object',
			properties: { path: { type: 'string', description: 'Path' } },
			required: ['path'],
			additionalProperties: false,
		}), {
			type: 'object',
			properties: { path: { type: 'string', description: 'Path' } },
			required: ['path'],
			additionalProperties: false,
		});
	});
});
