/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IVSCloneAgentLoopHandle, IVSCloneAgentLoopOptions, IVSCloneAgentLoopService } from '../../browser/vscloneAgentLoopService.js';
import { VSCloneChatSessionService } from '../../browser/vscloneChatSessionService.js';
import { IVSCloneContextGatheringService } from '../../browser/vscloneContextGatheringService.js';
import {
	IVSCloneChatHistoryService,
	IVSCloneChatHistoryThread,
	IVSCloneChatHistoryTurn,
	IVSCloneChatTurnUpdate,
	VSCloneChatHistoryScope,
} from '../../common/backend/vscloneChatHistoryService.js';
import { IVSClonePlanModeService } from '../../common/vsclonePlanModeService.js';
import { type VSCloneChatMode } from '../../common/vsclonePlanModeTypes.js';
import { IVSClonePromptAssemblyService } from '../../common/vsclonePromptAssemblyService.js';
import { IVSCloneModelSelection, IVSCloneThreadModelSelectionService } from '../../common/backend/vscloneThreadModelSelectionService.js';

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
	private lastRunResolver: (() => void) | undefined;

	runAgentLoop(options: IVSCloneAgentLoopOptions): IVSCloneAgentLoopHandle {
		this.lastRunOptions = options;
		const done = new Promise<void>(resolve => {
			this.lastRunResolver = resolve;
		});
		return {
			done,
			cancel: () => { this.cancelCalls += 1; },
		};
	}

	completeLastRun(): void {
		this.lastRunResolver?.();
		this.lastRunResolver = undefined;
	}
}

class TestSelectionService implements IVSCloneThreadModelSelectionService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeSelection = Event.None;
	private readonly selectedByThread = new Map<string, IVSCloneModelSelection>();
	private locationSelection: IVSCloneModelSelection | undefined;

	async initialize(): Promise<void> { }

	getCurrentSelectionForThread(threadId: string, _location: 'chat' | 'editorInline' | 'notebook' | 'terminal'): IVSCloneModelSelection | undefined {
		return this.selectedByThread.get(threadId) ?? this.locationSelection;
	}

	async setSelectionForThread(threadId: string, selection: IVSCloneModelSelection): Promise<void> {
		this.selectedByThread.set(threadId, { ...selection, threadId });
		this.locationSelection = { ...selection, threadId: undefined };
	}

	async switchToNextModel(_threadId: string, _location: 'chat' | 'editorInline' | 'notebook' | 'terminal'): Promise<IVSCloneModelSelection | undefined> {
		return undefined;
	}

	async resetSelectionForThread(threadId: string): Promise<void> {
		this.selectedByThread.delete(threadId);
	}

	hasSelectionForThread(threadId: string): boolean {
		return this.selectedByThread.has(threadId);
	}

	getRecentModelIdentifiers(limit = 3): readonly string[] {
		return [];
	}
}

class TestPlanModeService implements IVSClonePlanModeService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeMode = Event.None;
	private readonly modeByThread = new Map<string, VSCloneChatMode>();
	private composerMode: VSCloneChatMode = 'act';

	async initialize(): Promise<void> { }

	getModeForThread(threadId?: string): VSCloneChatMode {
		if (!threadId) {
			return this.composerMode;
		}

		return this.modeByThread.get(threadId) ?? 'act';
	}

	async setModeForThread(threadId: string | undefined, mode: VSCloneChatMode): Promise<void> {
		if (!threadId) {
			this.composerMode = mode;
			return;
		}

		this.modeByThread.set(threadId, mode);
	}

	isToolAllowed(mode: VSCloneChatMode, toolName: string): boolean {
		return mode === 'act' || toolName === 'read_file' || toolName === 'list_directory' || toolName === 'search_files' || toolName === 'attempt_completion';
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
		assembleSystemMessage: (_context, vendor, mode) => `SYSTEM:${vendor}:${mode}`,
	};
}

suite('VSCloneChatSessionService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('routes prompts through the VSClone API when a model is selected', async () => {
		const testDisposables = store.add(new DisposableStore());
		const historyService = new TestHistoryService();
		historyService.turnsByThread.set('thread-1', [createTurn('thread-1')]);

		const agentLoopService = new TestAgentLoopService();
		const selectionService = new TestSelectionService();
		const planModeService = new TestPlanModeService();
		await selectionService.setSelectionForThread('thread-1', createModelSelection());
		await planModeService.setModeForThread('thread-1', 'plan');

		const service = testDisposables.add(new VSCloneChatSessionService(
			historyService,
			selectionService,
			planModeService,
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
		assert.strictEqual(agentLoopService.lastRunOptions?.mode, 'plan');
		assert.strictEqual(agentLoopService.lastRunOptions?.vendor, 'openai');
		assert.strictEqual(agentLoopService.lastRunOptions?.modelIdentifier, 'openai/gpt-5.3-codex');
		assert.strictEqual(agentLoopService.lastRunOptions?.systemMessage, 'SYSTEM:openai:plan');
		assert.deepStrictEqual(agentLoopService.lastRunOptions?.previousTurns, [
			{ role: 'user', content: 'Existing prompt' },
			{ role: 'assistant', content: 'Existing response' },
		]);
		assert.strictEqual(historyService.updates.length, 0);
		agentLoopService.completeLastRun();
	});

	test('rejects sends when no model is selected', async () => {
		const testDisposables = store.add(new DisposableStore());
		const historyService = new TestHistoryService();
		const agentLoopService = new TestAgentLoopService();
		const selectionService = new TestSelectionService();
		const planModeService = new TestPlanModeService();
		await planModeService.setModeForThread(undefined, 'plan');

		const service = testDisposables.add(new VSCloneChatSessionService(
			historyService,
			selectionService,
			planModeService,
			new NullLogService(),
			agentLoopService,
			createContextGatheringService(),
			createPromptAssemblyService(),
		));

		const result = await service.submitPrompt('Fallback prompt');

		assert.ok(result);
		assert.strictEqual(agentLoopService.lastRunOptions, undefined);
		assert.deepStrictEqual(historyService.updates.map(update => update.phase), ['prompt', 'error']);
		assert.strictEqual(historyService.updates[0]?.executionMode, 'plan');
		assert.strictEqual(historyService.updates[1]?.executionMode, 'plan');
		assert.strictEqual(historyService.updates[1]?.responsePlainTextReplace, 'Sign in to a provider and choose a model before sending messages through VSClone.');
	});

	test('cancelThread cancels active API requests for the matching thread', async () => {
		const testDisposables = store.add(new DisposableStore());
		const historyService = new TestHistoryService();
		const selectionService = new TestSelectionService();
		const agentLoopService = new TestAgentLoopService();
		const planModeService = new TestPlanModeService();
		await selectionService.setSelectionForThread('thread-api', createModelSelection());

		const service = testDisposables.add(new VSCloneChatSessionService(
			historyService,
			selectionService,
			planModeService,
			new NullLogService(),
			agentLoopService,
			createContextGatheringService(),
			createPromptAssemblyService(),
		));

		await service.submitPrompt('Cancel this request', {
			threadId: 'thread-api',
			sessionResource: 'vsclone://api/thread-api',
			modelSelection: createModelSelection(),
		});

		service.cancelThread('thread-api');

		assert.strictEqual(agentLoopService.cancelCalls, 1);
		agentLoopService.completeLastRun();
	});

	test('rehydrates stored prompt images into previous-turn context', async () => {
		const testDisposables = store.add(new DisposableStore());
		const historyService = new TestHistoryService();
		historyService.turnsByThread.set('thread-images', [{
			...createTurn('thread-images'),
			promptImages: [{ mimeType: 'image/png', base64Data: 'ZmFrZQ==' }],
		}]);

		const agentLoopService = new TestAgentLoopService();
		const selectionService = new TestSelectionService();
		const planModeService = new TestPlanModeService();
		await selectionService.setSelectionForThread('thread-images', createModelSelection());

		const service = testDisposables.add(new VSCloneChatSessionService(
			historyService,
			selectionService,
			planModeService,
			new NullLogService(),
			agentLoopService,
			createContextGatheringService(),
			createPromptAssemblyService(),
		));

		await service.submitPrompt('Follow-up question', {
			threadId: 'thread-images',
			sessionResource: 'vsclone://api/thread-images',
			modelSelection: createModelSelection(),
		});

		assert.deepStrictEqual(agentLoopService.lastRunOptions?.previousTurns, [
			{
				role: 'user',
				content: 'Existing prompt',
				imageAttachments: [{ mimeType: 'image/png', base64Data: 'ZmFrZQ==' }],
			},
			{
				role: 'assistant',
				content: 'Existing response',
			},
		]);
		agentLoopService.completeLastRun();
	});
});
