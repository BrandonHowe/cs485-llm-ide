/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IChatService } from '../../../chat/common/chatService/chatService.js';
import { IVSCloneAgentLoopHandle, IVSCloneAgentLoopOptions, IVSCloneAgentLoopService } from '../../browser/vscloneAgentLoopService.js';
import { VSCloneChatSessionService } from '../../browser/vscloneChatSessionService.js';
import { IVSCloneContextGatheringService } from '../../browser/vscloneContextGatheringService.js';
import {
	IVSCloneChatHistoryService,
	IVSCloneChatHistoryThread,
	IVSCloneChatHistoryTurn,
	IVSCloneChatTurnUpdate,
	VSCloneChatHistoryScope,
} from '../../common/vscloneChatHistoryService.js';
import { IVSClonePromptAssemblyService } from '../../common/vsclonePromptAssemblyService.js';
import { IVSCloneModelSelection } from '../../common/vscloneThreadModelSelectionService.js';
import { VSCloneUseVSCodeChatBackendSetting } from '../../common/vscloneChatSettings.js';

class TestHistoryService implements IVSCloneChatHistoryService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChange = Event.None;
	readonly updates: IVSCloneChatTurnUpdate[] = [];
	readonly threads: IVSCloneChatHistoryThread[] = [];
	readonly turnsByThread = new Map<string, readonly IVSCloneChatHistoryTurn[]>();

	async initialize(): Promise<void> { }
	getThreads(): readonly IVSCloneChatHistoryThread[] { return this.threads; }
	getTurns(threadId: string): readonly IVSCloneChatHistoryTurn[] { return this.turnsByThread.get(threadId) ?? []; }
	applyTurnUpdate(update: IVSCloneChatTurnUpdate): void { this.updates.push(update); }
	async archiveThread(_threadId: string, _archived: boolean): Promise<void> { }
	async deleteThread(_threadId: string): Promise<void> { }
	async clearAll(_scope: VSCloneChatHistoryScope): Promise<void> { }
}

class TestAgentLoopService implements IVSCloneAgentLoopService {
	declare readonly _serviceBrand: undefined;
	lastRunOptions: IVSCloneAgentLoopOptions | undefined;
	cancelCalls = 0;

	runAgentLoop(options: IVSCloneAgentLoopOptions): IVSCloneAgentLoopHandle {
		this.lastRunOptions = options;
		return {
			done: Promise.resolve(),
			cancel: () => { this.cancelCalls += 1; },
		};
	}
}

function createModelSelection(): IVSCloneModelSelection {
	return {
		threadId: 'thread-1',
		location: 'chat',
		modelIdentifier: 'openai/gpt-5.3-codex',
		vendor: 'openai',
		modelId: 'gpt-5.3-codex',
		modelName: 'GPT-5.3-Codex',
		reasoningEffort: 'high',
		selectedAt: Date.now(),
	};
}

function createTurn(threadId: string): IVSCloneChatHistoryTurn {
	return {
		turnId: `${threadId}:turn-1`,
		threadId,
		sequence: 1,
		modelIdentifier: 'openai/gpt-5.3-codex',
		providerId: 'openai',
		promptText: 'Existing prompt',
		responseMarkdown: 'Existing response',
		responsePlainText: 'Existing response',
		startedAt: 1,
		completedAt: 2,
		status: 'completed',
		lastEventAt: 2,
	};
}

function createContextGatheringService(): IVSCloneContextGatheringService {
	return {
		_serviceBrand: undefined,
		gatherContext: async () => ({
			activeFile: undefined,
			openFiles: [],
			workspaceFolders: [],
			directoryTree: '(no workspace folders)',
			diagnostics: [],
		}),
	};
}

function createPromptAssemblyService(): IVSClonePromptAssemblyService {
	return {
		_serviceBrand: undefined,
		assembleSystemMessage: (_context, vendor) => `SYSTEM:${vendor}`,
	};
}

suite('VSCloneChatSessionService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('routes to OAuth-backed API mode even when legacy mock transport setting is true', async () => {
		const testDisposables = store.add(new DisposableStore());
		const historyService = new TestHistoryService();
		historyService.turnsByThread.set('thread-1', [createTurn('thread-1')]);

		const agentLoopService = new TestAgentLoopService();
		const configService = new TestConfigurationService({
			[VSCloneUseVSCodeChatBackendSetting]: false,
			// This old setting remains in user configs; routing must now ignore it.
			'vsclone.chat.useMockProviderTransport': true,
		});

		const chatService = {
			_serviceBrand: undefined,
			isEnabled: () => false,
			getOrRestoreSession: async () => undefined,
			startSession: () => ({ object: { sessionResource: URI.parse('vsclone://chat/fallback') }, dispose: () => undefined }),
			sendRequest: async () => { throw new Error('unused in this test'); },
			cancelCurrentRequestForSession: (_sessionResource: URI) => undefined,
		} as unknown as IChatService;

		const service = testDisposables.add(new VSCloneChatSessionService(
			chatService,
			historyService,
			configService,
			new NullLogService(),
			agentLoopService,
			createContextGatheringService(),
			createPromptAssemblyService(),
		));

		const result = await service.submitPrompt('Implement a fix', {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
			modelSelection: createModelSelection(),
		});

		assert.ok(result);
		assert.ok(agentLoopService.lastRunOptions);
		assert.strictEqual(agentLoopService.lastRunOptions?.vendor, 'openai');
		assert.strictEqual(agentLoopService.lastRunOptions?.modelIdentifier, 'openai/gpt-5.3-codex');
		assert.strictEqual(agentLoopService.lastRunOptions?.systemMessage, 'SYSTEM:openai');
		assert.deepStrictEqual(agentLoopService.lastRunOptions?.previousTurns, [
			{ role: 'user', content: 'Existing prompt' },
			{ role: 'assistant', content: 'Existing response' },
		]);
		assert.strictEqual(historyService.updates.length, 0);
	});

	test('rejects direct API sends when no model is selected', async () => {
		const testDisposables = store.add(new DisposableStore());
		const historyService = new TestHistoryService();
		const agentLoopService = new TestAgentLoopService();
		const configService = new TestConfigurationService({ [VSCloneUseVSCodeChatBackendSetting]: false });

		const chatService = {
			_serviceBrand: undefined,
			isEnabled: () => false,
			getOrRestoreSession: async () => undefined,
			startSession: () => ({ object: { sessionResource: URI.parse('vsclone://chat/fallback') }, dispose: () => undefined }),
			sendRequest: async () => { throw new Error('unused in this test'); },
			cancelCurrentRequestForSession: (_sessionResource: URI) => undefined,
		} as unknown as IChatService;

		const service = testDisposables.add(new VSCloneChatSessionService(
			chatService,
			historyService,
			configService,
			new NullLogService(),
			agentLoopService,
			createContextGatheringService(),
			createPromptAssemblyService(),
		));

		const result = await service.submitPrompt('Fallback prompt');

		assert.ok(result);
		assert.strictEqual(agentLoopService.lastRunOptions, undefined);
		assert.deepStrictEqual(historyService.updates.map(update => update.phase), ['prompt', 'error']);
		assert.strictEqual(historyService.updates[1]?.responsePlainTextReplace, 'Sign in to a provider and choose a model before sending messages through VSClone.');
	});

	test('cancelThread forwards cancellation to VS Code chat backend regardless of legacy mock flag', () => {
		const testDisposables = store.add(new DisposableStore());
		const historyService = new TestHistoryService();
		historyService.threads.push({
			threadId: 'thread-backend',
			sessionResource: 'vsclone://chat/session-backend',
			title: 'Backend thread',
			createdAt: 1,
			updatedAt: 1,
			status: 'active',
			archived: false,
			turnCount: 1,
			lastTurnPreview: 'preview',
		});

		const cancelledSessions: URI[] = [];
		const chatService = {
			_serviceBrand: undefined,
			isEnabled: () => true,
			getOrRestoreSession: async () => undefined,
			startSession: () => ({ object: { sessionResource: URI.parse('vsclone://chat/fallback') }, dispose: () => undefined }),
			sendRequest: async () => { throw new Error('unused in this test'); },
			cancelCurrentRequestForSession: (sessionResource: URI) => {
				cancelledSessions.push(sessionResource);
			},
		} as unknown as IChatService;

		const service = testDisposables.add(new VSCloneChatSessionService(
			chatService,
			historyService,
			new TestConfigurationService({
				[VSCloneUseVSCodeChatBackendSetting]: true,
				'vsclone.chat.useMockProviderTransport': true,
			}),
			new NullLogService(),
			new TestAgentLoopService(),
			createContextGatheringService(),
			createPromptAssemblyService(),
		));

		service.cancelThread('thread-backend');

		assert.strictEqual(cancelledSessions.length, 1);
		assert.strictEqual(cancelledSessions[0].toString(), 'vsclone://chat/session-backend');
	});
});
