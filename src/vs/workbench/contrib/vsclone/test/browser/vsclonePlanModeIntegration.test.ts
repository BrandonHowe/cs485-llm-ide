/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IVSCloneChatHistoryService, IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn, IVSCloneChatTurnUpdate, VSCloneChatHistoryScope } from '../../common/backend/vscloneChatHistoryService.js';
import { TestVSCloneUnifiedChatBackendService } from '../common/vscloneTestUnifiedChatBackendService.js';
import { VSCloneChatSessionService } from '../../browser/vscloneChatSessionService.js';
import { IVSCloneContextGatheringService } from '../../browser/vscloneContextGatheringService.js';
import { IVSCloneThreadRuntimeHandle, IVSCloneThreadRuntimeRunOptions, IVSCloneThreadRuntimeService } from '../../browser/vscloneThreadRuntimeService.js';
import { VSClonePlanModeService } from '../../common/vsclonePlanModeService.js';
import { IVSClonePromptAssemblyService, IVSClonePromptContext, VSClonePromptAssemblyService } from '../../common/vsclonePromptAssemblyService.js';
import { IVSCloneModelSelection, IVSCloneThreadModelSelectionService } from '../../common/backend/vscloneThreadModelSelectionService.js';
import { type VSCloneChatMode } from '../../common/vsclonePlanModeTypes.js';

class TestHistoryService implements IVSCloneChatHistoryService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChange = Event.None;

	async initialize(): Promise<void> { }
	getThreads(): readonly IVSCloneChatHistoryThread[] { return []; }
	getTurns(): readonly IVSCloneChatHistoryTurn[] { return []; }
	applyTurnUpdate(_update: IVSCloneChatTurnUpdate): void { }
	async archiveThread(_threadId: string, _archived: boolean): Promise<void> { }
	async deleteThread(_threadId: string): Promise<void> { }
	async clearAll(_scope: VSCloneChatHistoryScope): Promise<void> { }
}

class SlowSelectionService implements IVSCloneThreadModelSelectionService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeSelection = Event.None;
	readonly initializeGate = new DeferredPromise<void>();
	readonly setSelections: Array<{ threadId: string; selection: IVSCloneModelSelection }> = [];

	async initialize(): Promise<void> {
		await this.initializeGate.p;
	}

	getCurrentSelectionForThread(_threadId: string, _location: 'chat' | 'editorInline' | 'notebook' | 'terminal'): IVSCloneModelSelection | undefined {
		return undefined;
	}

	async setSelectionForThread(threadId: string, selection: IVSCloneModelSelection): Promise<void> {
		this.setSelections.push({ threadId, selection: { ...selection } });
	}

	async switchToNextModel(_threadId: string, _location: 'chat' | 'editorInline' | 'notebook' | 'terminal'): Promise<IVSCloneModelSelection | undefined> {
		return undefined;
	}

	async resetSelectionForThread(_threadId: string): Promise<void> { }

	hasSelectionForThread(_threadId: string): boolean {
		return false;
	}

	getRecentModelIdentifiers(_limit?: number): readonly string[] {
		return [];
	}
}

class RecordingThreadRuntimeHandle implements IVSCloneThreadRuntimeHandle {
	readonly done = Promise.resolve();
	cancel(): void { }
}

class RecordingThreadRuntimeService implements IVSCloneThreadRuntimeService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeState = Event.None;
	lastOptions: IVSCloneThreadRuntimeRunOptions | undefined;

	runThread(options: IVSCloneThreadRuntimeRunOptions): IVSCloneThreadRuntimeHandle {
		this.lastOptions = options;
		return new RecordingThreadRuntimeHandle();
	}

	recordRejectedTurn(): void { }
	cancelThread(): void { }
	approveLatestToolRequest(): boolean { return false; }
	rejectLatestToolRequest(): boolean { return false; }
	getState(): undefined { return undefined; }
	async rewindToCheckpoint(): Promise<boolean> { return false; }
}

class StaticContextGatheringService implements IVSCloneContextGatheringService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly context: IVSClonePromptContext) { }

	async gatherContext(): Promise<IVSClonePromptContext> {
		return this.context;
	}
}

class RecordingPromptAssemblyService implements IVSClonePromptAssemblyService {
	declare readonly _serviceBrand: undefined;
	lastMode: VSCloneChatMode | undefined;
	lastMessage: string | undefined;

	constructor(private readonly inner = new VSClonePromptAssemblyService()) { }

	assembleSystemMessage(context: IVSClonePromptContext, vendor: 'openai' | 'anthropic' | 'google', mode: VSCloneChatMode): string {
		this.lastMode = mode;
		this.lastMessage = this.inner.assembleSystemMessage(context, vendor, mode);
		return this.lastMessage;
	}
}

function createSelection(overrides: Partial<IVSCloneModelSelection> = {}): IVSCloneModelSelection {
	return {
		threadId: 'thread-1',
		location: 'chat',
		modelIdentifier: 'openai/gpt-5.3-codex',
		vendor: 'openai',
		modelId: 'gpt-5.3-codex',
		modelName: 'GPT-5.3-Codex',
		selectedAt: Date.now(),
		...overrides,
	};
}

function createContext(): IVSClonePromptContext {
	return {
		openFiles: [],
		workspaceFolders: [],
		directoryTree: '(empty)',
		diagnostics: [],
	};
}

suite('VSClonePlanModeIntegration', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('captures the submitted thread mode before a slow frontend dependency can drift the snapshot', async () => {
		const testDisposables = store.add(new DisposableStore());
		const backendService = new TestVSCloneUnifiedChatBackendService();
		const planModeService = testDisposables.add(new VSClonePlanModeService(backendService));
		const selectionService = new SlowSelectionService();
		const historyService = new TestHistoryService();
		const threadRuntimeService = new RecordingThreadRuntimeService();
		const contextGatheringService = new StaticContextGatheringService(createContext());
		const promptAssemblyService = new RecordingPromptAssemblyService();
		const chatSessionService = testDisposables.add(new VSCloneChatSessionService(
			historyService,
			selectionService,
			planModeService,
			new NullLogService(),
			threadRuntimeService,
			contextGatheringService,
			promptAssemblyService,
		));

		await planModeService.setModeForThread('thread-1', 'plan');

		// Keep the frontend-side dependency unresolved long enough to simulate a slow submit path.
		// If the snapshot is taken too late, a mode flip that lands during initialization will leak
		// into the submitted turn and the prompt will be shaped as act mode instead of plan mode.
		const submission = chatSessionService.submitPrompt('Refactor the feature in read-only mode', {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
			modelSelection: createSelection(),
		});

		await planModeService.setModeForThread('thread-1', 'act');
		selectionService.initializeGate.complete();

		const result = await submission;

		assert.deepStrictEqual(result, {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
		});
		assert.strictEqual(promptAssemblyService.lastMode, 'plan');
		assert.strictEqual(threadRuntimeService.lastOptions?.mode, 'plan');
		assert.ok(promptAssemblyService.lastMessage?.includes('PLAN MODE'));
		assert.ok(!promptAssemblyService.lastMessage?.includes('### edit_file'));
		assert.deepStrictEqual(backendService.getPlanModeState(), {
			modeByThread: {
				'thread-1': 'plan',
			},
		});
	});
});
