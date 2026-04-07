/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { VSCloneAgentLoopService } from '../../browser/vscloneAgentLoopService.js';
import { IVSCloneApiRequestHandle, IVSCloneApiStreamObserver, IVSCloneChatApiService } from '../../browser/vscloneChatApiService.js';
import { IVSCloneToolExecutionResult, IVSCloneToolExecutionService } from '../../browser/vscloneToolExecutionService.js';
import { IVSCloneApiSubmitOptions } from '../../common/vscloneChatApiAdapters.js';
import {
	IVSCloneChatHistoryService,
	IVSCloneChatHistoryThread,
	IVSCloneChatHistoryTurn,
	IVSCloneChatTurnUpdate,
	VSCloneChatHistoryScope,
} from '../../common/backend/vscloneChatHistoryService.js';
import { reduceThreadTurns } from '../../common/backend/vscloneChatHistoryStateMachine.js';
import { VSCloneModelVendor } from '../../common/vscloneOAuthTypes.js';
import { type VSCloneChatMode } from '../../common/vsclonePlanModeTypes.js';

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

	async executeTool(toolName: string, params: Record<string, string>, _mode?: VSCloneChatMode, _token: CancellationToken = CancellationToken.None): Promise<IVSCloneToolExecutionResult> {
		switch (toolName) {
			case 'list_directory':
				return {
					success: true,
					output: 'Directory listing for file:///workspace:\n(empty directory)',
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

class TestHistoryService implements IVSCloneChatHistoryService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChange = Event.None;
	readonly updates: IVSCloneChatTurnUpdate[] = [];

	private readonly threadsById = new Map<string, IVSCloneChatHistoryThread>();
	private readonly turnsByThreadId = new Map<string, readonly IVSCloneChatHistoryTurn[]>();

	async initialize(): Promise<void> { }

	getThreads(): readonly IVSCloneChatHistoryThread[] {
		return [...this.threadsById.values()];
	}

	getTurns(threadId: string): readonly IVSCloneChatHistoryTurn[] {
		return this.turnsByThreadId.get(threadId) ?? [];
	}

	applyTurnUpdate(update: IVSCloneChatTurnUpdate): void {
		this.updates.push(update);
		const currentThread = this.threadsById.get(update.threadId);
		const currentTurns = this.turnsByThreadId.get(update.threadId);
		const reduced = reduceThreadTurns(currentThread, currentTurns, update, {
			sessionResource: update.sessionResource,
			maxTurnsPerThread: 100,
		});
		this.threadsById.set(update.threadId, reduced.thread);
		this.turnsByThreadId.set(update.threadId, reduced.turns);
	}

	async archiveThread(_threadId: string, _archived: boolean): Promise<void> { }
	async deleteThread(_threadId: string): Promise<void> { }
	async clearAll(_scope: VSCloneChatHistoryScope): Promise<void> { }
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

		const historyService = new TestHistoryService();
		const service = new VSCloneAgentLoopService(
			new TestChatApiService(scriptedResponse),
			new TestToolExecutionService(),
			historyService,
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
				});

				await handle.done;
			});

			const replacementUpdate = historyService.updates.find(update => typeof update.responsePlainTextReplace === 'string');
			assert.ok(replacementUpdate);
			assert.ok(!replacementUpdate?.responsePlainTextReplace?.includes('<tool_result>\ntestgame/\n</tool_result>'));
			assert.ok(!replacementUpdate?.responsePlainTextReplace?.includes(`</tool_call>\n${summary}`));

			const persistedTurn = historyService.getTurns('thread-1')[0];
			assert.ok(persistedTurn.responsePlainText.includes('<tool_result tool_name="list_directory" success="true">'));
			assert.ok(persistedTurn.responsePlainText.includes('<tool_result tool_name="attempt_completion" success="true">'));
			assert.ok(!persistedTurn.responsePlainText.includes('<tool_result>\ntestgame/\n</tool_result>'));
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
		const historyService = new TestHistoryService();
		const toolService = new HangingToolExecutionService();
		const service = new VSCloneAgentLoopService(
			new TestChatApiService(scriptedResponse),
			toolService,
			historyService,
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
				});

				await toolService.toolStarted.p;
				handle.cancel();
				await handle.done;
			});

			assert.strictEqual(toolService.cancellationObserved, true);
			const cancelUpdate = historyService.updates.find(update => update.phase === 'cancel');
			assert.ok(cancelUpdate, 'expected the agent loop to emit a cancel turn update after Stop is pressed');
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
			new TestHistoryService(),
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
});
