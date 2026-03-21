/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
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

	constructor(private readonly scriptedResponse: string) { }

	submitApiPrompt(_options: IVSCloneApiSubmitOptions): IVSCloneApiRequestHandle {
		throw new Error('submitApiPrompt is not used in this test');
	}

	submitApiPromptForAgentLoop(_options: IVSCloneApiSubmitOptions, observer: IVSCloneApiStreamObserver): IVSCloneApiRequestHandle {
		const done = Promise.resolve().then(() => {
			observer.onDelta?.(this.scriptedResponse);
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

	async executeTool(toolName: string, params: Record<string, string>, _mode?: VSCloneChatMode): Promise<IVSCloneToolExecutionResult> {
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

			const replacementUpdate = historyService.updates.find(update => typeof update.responsePlainTextReplace === 'string');
			assert.ok(replacementUpdate);
			assert.ok(!replacementUpdate?.responsePlainTextReplace?.includes('<tool_result>\ntestgame/\n</tool_result>'));
			assert.ok(!replacementUpdate?.responsePlainTextReplace?.includes(`</tool_call>\n${summary}`));

			const persistedTurn = historyService.getTurns('thread-1')[0];
			assert.ok(persistedTurn.responsePlainText.includes('<tool_result tool_name="list_directory" success="true">'));
			assert.ok(persistedTurn.responsePlainText.includes('<tool_result tool_name="attempt_completion" success="true">'));
			assert.ok(!persistedTurn.responsePlainText.includes('<tool_result>\ntestgame/\n</tool_result>'));
		} finally {
			console.debug = originalConsole.debug;
			console.info = originalConsole.info;
			console.warn = originalConsole.warn;
			console.error = originalConsole.error;
			service.dispose();
		}
	});
});
