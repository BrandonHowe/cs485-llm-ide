/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IVSCloneAgentLoopObserver, VSCloneAgentLoopService } from '../../browser/vscloneAgentLoopService.js';
import { IVSCloneApiRequestHandle, IVSCloneApiStreamObserver, IVSCloneChatApiService } from '../../browser/vscloneChatApiService.js';
import { IVSCloneToolExecutionResult, IVSCloneToolExecutionService } from '../../browser/vscloneToolExecutionService.js';
import { IVSCloneApiSubmitOptions } from '../../common/vscloneChatApiAdapters.js';
import { VSCloneModelVendor } from '../../common/vscloneOAuthTypes.js';
import { type VSCloneChatMode } from '../../common/vsclonePlanModeTypes.js';
import type { VSCloneThreadToolApprovalDecision } from '../../common/vscloneThreadRuntimeTypes.js';

class TestChatApiService implements IVSCloneChatApiService {
	declare readonly _serviceBrand: undefined;
	readonly observedAgentLoopOptions: IVSCloneApiSubmitOptions[] = [];
	private readonly scriptedResponses: readonly string[];
	private requestIndex = 0;

	constructor(scriptedResponse: string | readonly string[]) {
		this.scriptedResponses = Array.isArray(scriptedResponse) ? scriptedResponse : [scriptedResponse];
	}

	submitApiPrompt(_options: IVSCloneApiSubmitOptions): IVSCloneApiRequestHandle {
		throw new Error('submitApiPrompt is not used in this test');
	}

	submitApiPromptForAgentLoop(options: IVSCloneApiSubmitOptions, observer: IVSCloneApiStreamObserver): IVSCloneApiRequestHandle {
		this.observedAgentLoopOptions.push(options);
		const scriptedResponse = this.scriptedResponses[Math.min(this.requestIndex, this.scriptedResponses.length - 1)] ?? '';
		this.requestIndex += 1;
		const done = Promise.resolve().then(() => {
			observer.onDelta?.(scriptedResponse);
			observer.onComplete?.();
		});
		return {
			done,
			cancel: () => undefined,
		};
	}
}

class TestToolExecutionService implements IVSCloneToolExecutionService {
	declare readonly _serviceBrand: undefined;
	editFileCalls = 0;

	async executeTool(toolName: string, params: Record<string, string>, _mode?: VSCloneChatMode, _token: CancellationToken = CancellationToken.None): Promise<IVSCloneToolExecutionResult> {
		switch (toolName) {
			case 'list_directory':
				return {
					success: true,
					output: 'Directory listing for file:///workspace:\n(empty directory)',
				};
			case 'edit_file':
				this.editFileCalls += 1;
				return {
					success: true,
					output: `Applied edit to ${params.path ?? '(missing path)'}`,
				};
			case 'attempt_completion':
				return {
					success: true,
					output: params.result,
				};
			default:
				return {
					success: false,
					output: `Unexpected tool ${toolName}`,
				};
		}
	}
}

async function withMutedConsole(run: () => Promise<void>): Promise<void> {
	const originalConsole = {
		debug: console.debug,
		info: console.info,
		warn: console.warn,
		error: console.error,
	};
	console.debug = () => undefined;
	console.info = () => undefined;
	console.warn = () => undefined;
	console.error = () => undefined;

	try {
		await run();
	} finally {
		console.debug = originalConsole.debug;
		console.info = originalConsole.info;
		console.warn = originalConsole.warn;
		console.error = originalConsole.error;
	}
}

function createTranscriptRecorder(): {
	readonly observer: IVSCloneAgentLoopObserver;
	readonly state: {
		responseText: string;
		replaceCalls: number;
		completed: number;
		cancelled: number;
		errors: string[];
	};
} {
	const state = {
		responseText: '',
		replaceCalls: 0,
		completed: 0,
		cancelled: 0,
		errors: [] as string[],
	};
	return {
		observer: {
			onResponseDelta: delta => {
				state.responseText += delta;
			},
			// The runtime service replaces the streamed assistant transcript when the sanitizer
			// removes fabricated tool output. Mirror that contract here so the agent-loop tests
			// validate the same observer shape the runtime now depends on.
			onResponseReplace: responseText => {
				state.replaceCalls += 1;
				state.responseText = responseText;
			},
			onComplete: () => {
				state.completed += 1;
			},
			onCancel: () => {
				state.cancelled += 1;
			},
			onError: message => {
				state.errors.push(message);
			},
		},
		state,
	};
}

suite('VSCloneAgentLoopService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('sanitizes fabricated tool results before persisting the canonical tool transcript', async () => {
		const summary = [
			'I inspected the workspace and it appears empty.',
			'',
			'Game idea: Pizza Panic',
		].join('\n');
		const scriptedResponse = [
			'Thinking: I’ll inspect the workspace first.',
			'<tool_call>',
			'<tool_name>list_directory</tool_name>',
			'<path>.</path>',
			'<recursive>true</recursive>',
			'</tool_call>',
			'<tool_result>',
			'testgame/',
			'</tool_result>',
			'Thinking: I have enough context to summarize.',
			'<tool_call>',
			'<tool_name>attempt_completion</tool_name>',
			`<result>${summary}</result>`,
			'</tool_call>',
			summary,
		].join('\n');

		const transcript = createTranscriptRecorder();
		const service = new VSCloneAgentLoopService(
			new TestChatApiService(scriptedResponse),
			new TestToolExecutionService(),
			new NullLogService(),
		);

		try {
			await withMutedConsole(async () => {
				const handle = service.runAgentLoop({
					threadId: 'thread-1',
					turnId: 'turn-1',
					sequence: 1,
					sessionResource: 'vsclone://api/thread-1',
					promptText: 'Make a browser game idea',
					mode: 'plan',
					vendor: 'openai' as VSCloneModelVendor,
					modelId: 'gpt-5.3-codex',
					modelIdentifier: 'openai/gpt-5.3-codex',
					previousTurns: [],
					systemMessage: 'SYSTEM',
					observer: transcript.observer,
				});

				await handle.done;
			});

			assert.ok(!transcript.state.responseText.includes('<tool_result>\ntestgame/\n</tool_result>'));
			assert.ok(!transcript.state.responseText.includes(`</tool_call>\n${summary}`));
			assert.ok(transcript.state.responseText.includes('<tool_result tool_name="list_directory" success="true">'));
			assert.ok(transcript.state.responseText.includes('<tool_result tool_name="attempt_completion" success="true">'));
			assert.ok(transcript.state.replaceCalls > 0, 'expected the sanitizer path to replace the streamed transcript at least once');
		} finally {
			service.dispose();
		}
	});

	test('cancel() aborts an in-flight tool execution and finalizes the turn as cancelled', async () => {
		// Stalls forever until the agent loop cancels its token, modeling a hung tool call so the
		// test can verify that pressing Stop unblocks the chat instead of leaving it spinning.
		class HangingToolExecutionService implements IVSCloneToolExecutionService {
			declare readonly _serviceBrand: undefined;
			toolStarted = new DeferredPromise<void>();
			cancellationObserved = false;

			async executeTool(_toolName: string, _params: Record<string, string>, _mode?: VSCloneChatMode, token: CancellationToken = CancellationToken.None): Promise<IVSCloneToolExecutionResult> {
				this.toolStarted.complete();
				const cancelled = new DeferredPromise<void>();
				const listener = token.onCancellationRequested(() => cancelled.complete());
				if (token.isCancellationRequested) {
					cancelled.complete();
				}
				try {
					await cancelled.p;
				} finally {
					listener.dispose();
				}
				this.cancellationObserved = true;
				return {
					success: false,
					output: 'cancelled',
				};
			}
		}

		const scriptedResponse = [
			'Thinking: I will run a long search.',
			'<tool_call>',
			'<tool_name>search_files</tool_name>',
			'<path>.</path>',
			'<pattern>foo</pattern>',
			'</tool_call>',
		].join('\n');
		const toolService = new HangingToolExecutionService();
		const transcript = createTranscriptRecorder();
		const service = new VSCloneAgentLoopService(
			new TestChatApiService(scriptedResponse),
			toolService,
			new NullLogService(),
		);

		try {
			await withMutedConsole(async () => {
				const handle = service.runAgentLoop({
					threadId: 'thread-cancel',
					turnId: 'turn-cancel',
					sequence: 1,
					sessionResource: 'vsclone://api/thread-cancel',
					promptText: 'search the workspace for foo',
					mode: 'act',
					vendor: 'openai' as VSCloneModelVendor,
					modelId: 'gpt-5.3-codex',
					modelIdentifier: 'openai/gpt-5.3-codex',
					previousTurns: [],
					systemMessage: 'SYSTEM',
					observer: transcript.observer,
				});

				await toolService.toolStarted.p;
				handle.cancel();
				await handle.done;
			});

			assert.strictEqual(toolService.cancellationObserved, true);
			assert.strictEqual(transcript.state.cancelled, 1);
		} finally {
			service.dispose();
		}
	});

	test('sends image attachments only with the initial model request', async () => {
		const imageAttachments = [{ mimeType: 'image/png', base64Data: 'ZmFrZS1pbWFnZQ==' }];
		const apiService = new TestChatApiService([
			[
				'Thinking: I will inspect the workspace before answering.',
				'<tool_call>',
				'<tool_name>list_directory</tool_name>',
				'<path>.</path>',
				'</tool_call>',
			].join('\n'),
			[
				'Thinking: I have enough context to finish.',
				'<tool_call>',
				'<tool_name>attempt_completion</tool_name>',
				'<result>Done.</result>',
				'</tool_call>',
			].join('\n'),
		]);
		const service = new VSCloneAgentLoopService(
			apiService,
			new TestToolExecutionService(),
			new NullLogService(),
		);

		try {
			await withMutedConsole(async () => {
				const handle = service.runAgentLoop({
					threadId: 'thread-images',
					turnId: 'turn-images',
					sequence: 1,
					sessionResource: 'vsclone://api/thread-images',
					promptText: 'Look at this screenshot and inspect the workspace',
					mode: 'act',
					vendor: 'openai' as VSCloneModelVendor,
					modelId: 'gpt-5.3-codex',
					modelIdentifier: 'openai/gpt-5.3-codex',
					previousTurns: [],
					systemMessage: 'SYSTEM',
					imageAttachments,
				});

				await handle.done;
			});

			// Images are part of the original user prompt only; the follow-up request after tool
			// execution should reuse prior transcript context instead of re-uploading the same image.
			assert.deepStrictEqual(
				apiService.observedAgentLoopOptions.map(options => options.imageAttachments),
				[
					imageAttachments,
					undefined,
				],
			);
		} finally {
			service.dispose();
		}
	});

	test('multi-iteration transcript replacement keeps earlier assistant output in the runtime buffer', async () => {
		const transcript = createTranscriptRecorder();
		const service = new VSCloneAgentLoopService(
			new TestChatApiService([
				[
					'Thinking: I will inspect the workspace first.',
					'<tool_call>',
					'<tool_name>list_directory</tool_name>',
					'<path>.</path>',
					'</tool_call>',
				].join('\n'),
				[
					'Thinking: I can finish now.',
					'<tool_call>',
					'<tool_name>attempt_completion</tool_name>',
					'<result>Done.</result>',
					'</tool_call>',
				].join('\n'),
			]),
			new TestToolExecutionService(),
			new NullLogService(),
		);

		try {
			await withMutedConsole(async () => {
				const handle = service.runAgentLoop({
					threadId: 'thread-multi-iteration',
					turnId: 'turn-multi-iteration',
					sequence: 1,
					sessionResource: 'vsclone://api/thread-multi-iteration',
					promptText: 'Inspect and finish',
					mode: 'act',
					vendor: 'openai' as VSCloneModelVendor,
					modelId: 'gpt-5.3-codex',
					modelIdentifier: 'openai/gpt-5.3-codex',
					previousTurns: [],
					systemMessage: 'SYSTEM',
					observer: transcript.observer,
				});

				await handle.done;
			});

			assert.ok(transcript.state.responseText.includes('tool_name="list_directory" success="true"'));
			assert.ok(transcript.state.responseText.includes('tool_name="attempt_completion" success="true"'));
			assert.ok(transcript.state.responseText.includes('[Agent iteration 2]'));
		} finally {
			service.dispose();
		}
	});

	test('tool execution pauses until approval resolves', async () => {
		const approvalGate = new DeferredPromise<VSCloneThreadToolApprovalDecision>();
		const toolService = new TestToolExecutionService();
		const service = new VSCloneAgentLoopService(
			new TestChatApiService([
				[
					'Thinking: I will edit the file.',
					'<tool_call>',
					'<tool_name>edit_file</tool_name>',
					'<path>src/app.ts</path>',
					'<changes><![CDATA[before]]></changes>',
					'</tool_call>',
				].join('\n'),
				[
					'Thinking: The edit is complete.',
					'<tool_call>',
					'<tool_name>attempt_completion</tool_name>',
					'<result>Done.</result>',
					'</tool_call>',
				].join('\n'),
			]),
			toolService,
			new NullLogService(),
		);

		try {
			await withMutedConsole(async () => {
				const handle = service.runAgentLoop({
					threadId: 'thread-approval',
					turnId: 'turn-approval',
					sequence: 1,
					sessionResource: 'vsclone://api/thread-approval',
					promptText: 'edit src/app.ts',
					mode: 'act',
					vendor: 'openai' as VSCloneModelVendor,
					modelId: 'gpt-5.3-codex',
					modelIdentifier: 'openai/gpt-5.3-codex',
					previousTurns: [],
					systemMessage: 'SYSTEM',
					observer: {
						onToolRequested: () => approvalGate.p,
					},
				});

				await Promise.resolve();
				assert.strictEqual(toolService.editFileCalls, 0);

				approvalGate.complete({ kind: 'approved' });
				await handle.done;
			});

			assert.strictEqual(toolService.editFileCalls, 1);
		} finally {
			service.dispose();
		}
	});

	test('rejected approvals surface as failed tool results without executing the tool', async () => {
		const transcript = createTranscriptRecorder();
		const toolService = new TestToolExecutionService();
		const observedToolResults: IVSCloneToolExecutionResult[] = [];
		const service = new VSCloneAgentLoopService(
			new TestChatApiService([
				[
					'Thinking: I will edit the file.',
					'<tool_call>',
					'<tool_name>edit_file</tool_name>',
					'<path>src/app.ts</path>',
					'<changes><![CDATA[before]]></changes>',
					'</tool_call>',
				].join('\n'),
				[
					'Thinking: I will explain the rejection.',
					'<tool_call>',
					'<tool_name>attempt_completion</tool_name>',
					'<result>Could not continue because the edit was rejected.</result>',
					'</tool_call>',
				].join('\n'),
			]),
			toolService,
			new NullLogService(),
		);

		try {
			await withMutedConsole(async () => {
				const handle = service.runAgentLoop({
					threadId: 'thread-rejected-approval',
					turnId: 'turn-rejected-approval',
					sequence: 1,
					sessionResource: 'vsclone://api/thread-rejected-approval',
					promptText: 'edit src/app.ts',
					mode: 'act',
					vendor: 'openai' as VSCloneModelVendor,
					modelId: 'gpt-5.3-codex',
					modelIdentifier: 'openai/gpt-5.3-codex',
					previousTurns: [],
					systemMessage: 'SYSTEM',
					observer: {
						...transcript.observer,
						onToolRequested: () => ({ kind: 'rejected', reason: 'Denied by reviewer.' }),
						onToolResult: (_toolName, _params, result) => {
							observedToolResults.push(result);
						},
					},
				});

				await handle.done;
			});

			assert.strictEqual(toolService.editFileCalls, 0);
			assert.strictEqual(observedToolResults.length >= 1, true);
			assert.deepStrictEqual(observedToolResults[0], {
				success: false,
				output: 'Denied by reviewer.',
			});
			assert.ok(transcript.state.responseText.includes('tool_name="edit_file" success="false"'));
			assert.ok(transcript.state.responseText.includes('Denied by reviewer.'));
		} finally {
			service.dispose();
		}
	});
});
