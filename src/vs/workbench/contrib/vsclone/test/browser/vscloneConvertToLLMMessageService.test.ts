/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSCloneConvertToLLMMessageService } from '../../browser/vscloneConvertToLLMMessageService.js';
import { type IVSCloneChatTransportRequestOptions } from '../../common/vscloneChatTransportTypes.js';

function createSubmitOptions(overrides: Partial<IVSCloneChatTransportRequestOptions> = {}): IVSCloneChatTransportRequestOptions {
	return {
		threadId: 'thread-1',
		turnId: 'thread-1:turn-1',
		sequence: 1,
		sessionResource: 'vsclone://api/thread-1',
		mode: 'act',
		vendor: 'openai',
		modelId: 'gpt-5.3-codex',
		modelIdentifier: 'openai/gpt-5.3-codex',
		currentTurn: { role: 'user', content: 'Continue from the tool output' },
		...overrides,
	};
}

suite('VSCloneConvertToLLMMessageService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('prepares OpenAI chat history as tool_calls plus tool messages and keeps current multimodal input separate from system instructions', () => {
		const service = new VSCloneConvertToLLMMessageService();

		const prepared = service.prepareChatRequest(createSubmitOptions({
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelIdentifier: 'openai/gpt-5.3-codex',
			systemMessage: 'system prompt',
			currentTurn: {
				role: 'user',
				content: 'Now fix the bug',
				imageAttachments: [{ mimeType: 'image/png', base64Data: 'Zm9v' }],
			},
			previousTurns: [
				{ role: 'user', content: 'Inspect src/app.ts' },
				{
					role: 'assistant',
					content: 'Thinking: I should inspect the file first.',
				},
				{
					role: 'tool',
					id: 'tool-call-1',
					name: 'read_file',
					rawParams: { path: 'src/app.ts' },
					content: '<tool_result tool_name="read_file" success="true">\nconst answer = 42;\n</tool_result>',
				},
			],
		}));

		assert.deepStrictEqual(prepared, {
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelIdentifier: 'openai/gpt-5.3-codex',
			mode: 'act',
			reasoningEffort: undefined,
			reasoningEnabled: undefined,
			reasoningBudget: undefined,
			separateSystemMessage: 'system prompt',
			toolDefinitions: undefined,
			messages: [
				{ role: 'user', content: 'Inspect src/app.ts' },
				{
					role: 'assistant',
					content: 'Thinking: I should inspect the file first.',
					tool_calls: [{
						type: 'function',
						id: 'tool-call-1',
						function: {
							name: 'read_file',
							arguments: '{"path":"src/app.ts"}',
						},
					}],
				},
				{
					role: 'tool',
					tool_call_id: 'tool-call-1',
					content: '<tool_result tool_name="read_file" success="true">\nconst answer = 42;\n</tool_result>',
				},
				{
					role: 'user',
					content: [
						{
							type: 'text',
							text: 'This user turn includes 1 image attachment. Inspect it directly when answering.\n\nNow fix the bug',
						},
						{
							type: 'image_url',
							image_url: {
								url: 'data:image/png;base64,Zm9v',
								detail: 'auto',
							},
						},
					],
				},
			],
		});
	});

	test('prepares Anthropic chat history as tool_use plus tool_result blocks', () => {
		const service = new VSCloneConvertToLLMMessageService();

		const prepared = service.prepareChatRequest(createSubmitOptions({
			vendor: 'anthropic',
			modelId: 'claude-haiku-4-5-20251001',
			modelIdentifier: 'anthropic/claude-haiku-4-5-20251001',
			previousTurns: [
				{ role: 'user', content: 'Search the workspace' },
				{
					role: 'assistant',
					content: 'Thinking: I should search the project first.',
				},
				{
					role: 'tool',
					id: 'tool-call-2',
					name: 'search_files',
					rawParams: { path: '.', pattern: 'TODO' },
					content: '<tool_result tool_name="search_files" success="true">\nsrc/app.ts:1: // TODO fix me\n</tool_result>',
				},
			],
		}));

		assert.deepStrictEqual(prepared.messages, [
			{ role: 'user', content: 'Search the workspace' },
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: 'Thinking: I should search the project first.' },
					{
						type: 'tool_use',
						id: 'tool-call-2',
						name: 'search_files',
						input: { path: '.', pattern: 'TODO' },
					},
				],
			},
			{
				role: 'user',
				content: [{
					type: 'tool_result',
					tool_use_id: 'tool-call-2',
					content: '<tool_result tool_name="search_files" success="true">\nsrc/app.ts:1: // TODO fix me\n</tool_result>',
				}],
			},
			{ role: 'user', content: 'Continue from the tool output' },
		]);
	});

	test('prepares Google chat history as functionCall plus functionResponse parts', () => {
		const service = new VSCloneConvertToLLMMessageService();

		const prepared = service.prepareChatRequest(createSubmitOptions({
			vendor: 'google',
			modelId: 'gemini-2.5-pro',
			modelIdentifier: 'google/gemini-2.5-pro',
			previousTurns: [
				{ role: 'user', content: 'List the src folder' },
				{
					role: 'assistant',
					content: 'Thinking: I need the directory contents first.',
				},
				{
					role: 'tool',
					id: 'tool-call-3',
					name: 'list_directory',
					rawParams: { path: 'src' },
					content: '<tool_result tool_name="list_directory" success="true">\nsrc/app.ts\nsrc/util.ts\n</tool_result>',
				},
			],
		}));

		assert.deepStrictEqual(prepared.messages, [
			{ role: 'user', parts: [{ text: 'List the src folder' }] },
			{
				role: 'model',
				parts: [
					{
						functionCall: {
							id: 'tool-call-3',
							name: 'list_directory',
							args: { path: 'src' },
						},
					},
				],
			},
			{
				role: 'user',
				parts: [{
					functionResponse: {
						id: 'tool-call-3',
						name: 'list_directory',
						response: {
							output: '<tool_result tool_name="list_directory" success="true">\nsrc/app.ts\nsrc/util.ts\n</tool_result>',
						},
					},
				}],
			},
			{ role: 'user', parts: [{ text: 'Continue from the tool output' }] },
		]);
	});

	test('passes through already-structured messages without reparsing assistant content', () => {
		const service = new VSCloneConvertToLLMMessageService();

		const prepared = service.prepareChatRequest(createSubmitOptions({
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelIdentifier: 'openai/gpt-5.3-codex',
			previousTurns: [
				{
					role: 'assistant',
					content: 'Thinking: I should inspect the file first.',
				},
				{
					role: 'tool',
					id: 'tool-call-4',
					name: 'read_file',
					rawParams: { path: 'src/app.ts' },
					content: '<tool_result tool_name="read_file" success="true">\ncontents\n</tool_result>',
				},
			],
		}));

		assert.deepStrictEqual(prepared.messages, [
			{
				role: 'assistant',
				content: 'Thinking: I should inspect the file first.',
				tool_calls: [{
					type: 'function',
					id: 'tool-call-4',
					function: {
						name: 'read_file',
						arguments: '{"path":"src/app.ts"}',
					},
				}],
			},
			{
				role: 'tool',
				tool_call_id: 'tool-call-4',
				content: '<tool_result tool_name="read_file" success="true">\ncontents\n</tool_result>',
			},
			{ role: 'user', content: 'Continue from the tool output' },
		]);
	});
});
