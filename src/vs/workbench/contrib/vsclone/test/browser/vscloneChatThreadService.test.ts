/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { VSCloneChatThreadService } from '../../browser/vscloneChatThreadService.js';
import { IVSCloneContextGatheringService } from '../../browser/vscloneContextGatheringService.js';
import { IVSCloneThreadRuntimeHandle, IVSCloneThreadRuntimeService } from '../../browser/vscloneThreadRuntimeService.js';
import { TestVSCloneUnifiedChatBackendService } from '../common/vscloneTestUnifiedChatBackendService.js';
import { type VSCloneChatMode } from '../../common/vsclonePlanModeTypes.js';
import { IVSClonePlanModeService } from '../../common/vsclonePlanModeService.js';
import { IVSCloneModelSelection } from '../../common/vscloneModelSelectionTypes.js';
import type { IVSClonePromptContext } from '../../common/vsclonePrompts.js';
import { IVSCloneSettingsService } from '../../common/vscloneSettingsService.js';
import type { IVSCloneSettingsState } from '../../common/vscloneSettingsTypes.js';
import { IVSCloneThreadRuntimeRunOptions, IVSCloneThreadRuntimeState } from '../../common/vscloneThreadRuntimeTypes.js';

class StaticSettingsService implements IVSCloneSettingsService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeState = Event.None;
	readonly onDidChangeSelection = Event.None;

	constructor(private readonly selection: IVSCloneModelSelection) { }

	async initialize(): Promise<void> { }
	async refreshState(): Promise<void> { }
	getState(): IVSCloneSettingsState { throw new Error('State access is not needed in this focused submit test.'); }
	getProviders() { return []; }
	getModels() { return []; }
	getModelsForFeature() { return []; }
	getModel() { return undefined; }
	getSelectableModels() { return []; }
	getFeatureSelection() { return undefined; }
	getFeatureDefaults() {
		return {
			Chat: { featureName: 'Chat' as const, location: 'chat' as const, selection: undefined },
			Autocomplete: { featureName: 'Autocomplete' as const, location: 'editorInline' as const, selection: undefined },
			Notebook: { featureName: 'Notebook' as const, location: 'notebook' as const, selection: undefined },
			Terminal: { featureName: 'Terminal' as const, location: 'terminal' as const, selection: undefined },
		};
	}
	getCurrentSelectionForFeatureName(): IVSCloneModelSelection | undefined { return this.selection; }
	getCurrentSelectionForFeature(): IVSCloneModelSelection | undefined { return this.selection; }
	getThreadSelectionSnapshot() { return undefined; }
	async setSelectionForFeature(): Promise<void> { }
	async switchToNextModel(): Promise<IVSCloneModelSelection | undefined> { return undefined; }
	async resetSelectionForThread(): Promise<void> { }
	hasSelectionForThread(): boolean { return true; }
	getRecentModels() { return []; }
	getRecentModelIdentifiers(): readonly string[] { return [this.selection.modelIdentifier]; }
	getEligibilityRecords() { return []; }
	async setProviderEnabled(): Promise<void> { }
	getIneligibilityRecord() { return undefined; }
	async markModelIneligible(): Promise<void> { }
	async clearIneligibilityForVendor(): Promise<void> { }
}

class RecordingSettingsService implements IVSCloneSettingsService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeState = Event.None;
	readonly onDidChangeSelection = Event.None;
	readonly setSelections: IVSCloneModelSelection[] = [];
	private selection: IVSCloneModelSelection | undefined;

	constructor(selection: IVSCloneModelSelection | undefined) {
		this.selection = selection;
	}

	async initialize(): Promise<void> { }
	async refreshState(): Promise<void> { }
	getState(): IVSCloneSettingsState { throw new Error('State access is not needed in this focused submit test.'); }
	getProviders() { return []; }
	getModels() { return []; }
	getModelsForFeature() { return []; }
	getModel() { return undefined; }
	getSelectableModels() { return []; }
	getFeatureSelection() { return undefined; }
	getFeatureDefaults() {
		return {
			Chat: { featureName: 'Chat' as const, location: 'chat' as const, selection: undefined },
			Autocomplete: { featureName: 'Autocomplete' as const, location: 'editorInline' as const, selection: undefined },
			Notebook: { featureName: 'Notebook' as const, location: 'notebook' as const, selection: undefined },
			Terminal: { featureName: 'Terminal' as const, location: 'terminal' as const, selection: undefined },
		};
	}
	getCurrentSelectionForFeatureName(): IVSCloneModelSelection | undefined { return this.selection; }
	getCurrentSelectionForFeature(): IVSCloneModelSelection | undefined { return this.selection; }
	getThreadSelectionSnapshot() { return undefined; }
	async setSelectionForFeature(_threadId: string, selection: IVSCloneModelSelection): Promise<void> {
		this.selection = { ...selection };
		this.setSelections.push({ ...selection });
	}
	async switchToNextModel(): Promise<IVSCloneModelSelection | undefined> { return undefined; }
	async resetSelectionForThread(): Promise<void> { this.selection = undefined; }
	hasSelectionForThread(): boolean { return this.selection !== undefined; }
	getRecentModels() { return []; }
	getRecentModelIdentifiers(): readonly string[] { return this.selection ? [this.selection.modelIdentifier] : []; }
	getEligibilityRecords() { return []; }
	async setProviderEnabled(): Promise<void> { }
	getIneligibilityRecord() { return undefined; }
	async markModelIneligible(): Promise<void> { }
	async clearIneligibilityForVendor(): Promise<void> { }
}

class StaticPlanModeService implements IVSClonePlanModeService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeMode = Event.None;

	async initialize(): Promise<void> { }
	getModeForThread(): VSCloneChatMode { return 'act'; }
	async setModeForThread(): Promise<void> { }
	isToolAllowed(): boolean { return true; }
}

class RecordingThreadRuntimeHandle implements IVSCloneThreadRuntimeHandle {
	readonly done = Promise.resolve();
	cancel(): void { }
}

class RecordingThreadRuntimeService implements IVSCloneThreadRuntimeService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeState = Event.None;
	readonly statesByThreadId = new Map<string, IVSCloneThreadRuntimeState>();
	lastOptions: IVSCloneThreadRuntimeRunOptions | undefined;
	cancelledThreadId: string | undefined;

	runThread(options: IVSCloneThreadRuntimeRunOptions): IVSCloneThreadRuntimeHandle {
		this.lastOptions = options;
		return new RecordingThreadRuntimeHandle();
	}

	recordRejectedTurn(): void { }
	cancelThread(threadId: string): void { this.cancelledThreadId = threadId; }
	approveLatestToolRequest(): boolean { return false; }
	rejectLatestToolRequest(): boolean { return false; }
	getThreads(): readonly [] { return []; }
	isDeletedThread(): boolean { return false; }
	archiveThread(): boolean { return false; }
	deleteThread(): boolean { return false; }
	clearAll(): void { }
	getState(threadId: string): IVSCloneThreadRuntimeState | undefined { return this.statesByThreadId.get(threadId); }
	async rewindToCheckpoint(): Promise<boolean> { return false; }
}

class StaticContextGatheringService implements IVSCloneContextGatheringService {
	declare readonly _serviceBrand: undefined;

	async gatherContext(): Promise<IVSClonePromptContext> {
		return {};
	}
}

function createSelection(): IVSCloneModelSelection {
	return {
		threadId: 'thread-1',
		location: 'chat',
		modelIdentifier: 'openai/gpt-5.3-codex',
		vendor: 'openai',
		modelId: 'gpt-5.3-codex',
		modelName: 'GPT-5.3-Codex',
		selectedAt: Date.now(),
	};
}

function createSelectionWithOverrides(overrides: Partial<IVSCloneModelSelection>): IVSCloneModelSelection {
	return {
		...createSelection(),
		...overrides,
	};
}

suite('VSCloneChatThreadService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('owns prompt submission and thread cancellation without going through the legacy session facade', async () => {
		const testDisposables = store.add(new DisposableStore());
		const settingsService = new StaticSettingsService(createSelection());
		const runtimeService = new RecordingThreadRuntimeService();
		runtimeService.statesByThreadId.set('thread-1', {
			threadId: 'thread-1',
			catalog: {
				threadId: 'thread-1',
				title: 'Existing thread',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Assistant response',
			},
			streamState: { kind: 'idle' },
			messages: [
				{
					id: 'thread-1:turn-1:user',
					role: 'user',
					mode: 'act',
					createdAt: 1,
					content: 'Initial prompt',
				},
				{
					id: 'thread-1:turn-1:assistant',
					role: 'assistant',
					mode: 'act',
					createdAt: 2,
					content: 'Assistant response',
				},
			],
			checkpoints: [],
			lastUpdatedAt: 2,
		});
		const threadService = testDisposables.add(new VSCloneChatThreadService(
			settingsService,
			new StaticPlanModeService(),
			new NullLogService(),
			runtimeService,
			new StaticContextGatheringService(),
			new TestVSCloneUnifiedChatBackendService(),
		));

		const result = await threadService.sendMessage('Follow up on the earlier answer', {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
		});
		threadService.cancelThread('thread-1');

		assert.deepStrictEqual(result, {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
		});
		assert.deepStrictEqual(runtimeService.lastOptions?.previousTurns, [
			{ role: 'user', content: 'Initial prompt' },
			{ role: 'assistant', content: 'Assistant response' },
		]);
		assert.ok(runtimeService.lastOptions?.systemMessage?.includes('## Available Tools'));
		assert.ok(runtimeService.lastOptions?.systemMessage?.includes('(no active text editor; use tools to inspect the relevant files)'));
		assert.strictEqual(runtimeService.lastOptions?.mode, 'act');
		assert.strictEqual(runtimeService.cancelledThreadId, 'thread-1');
	});

	test('updates an existing thread binding when the submit-time selection changes', async () => {
		const testDisposables = store.add(new DisposableStore());
		const settingsService = new RecordingSettingsService(createSelectionWithOverrides({
			reasoningEffort: 'minimal',
		}));
		const runtimeService = new RecordingThreadRuntimeService();
		const threadService = testDisposables.add(new VSCloneChatThreadService(
			settingsService,
			new StaticPlanModeService(),
			new NullLogService(),
			runtimeService,
			new StaticContextGatheringService(),
			new TestVSCloneUnifiedChatBackendService(),
		));

		await threadService.sendMessage('Use the updated selection for this turn', {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
			// Follow-up sends must honor the picker snapshot passed with this submission instead of
			// reusing the stale per-thread binding that was stored on an earlier turn.
			modelSelection: createSelectionWithOverrides({
				modelIdentifier: 'openai/gpt-5.4-codex',
				modelId: 'gpt-5.4-codex',
				modelName: 'GPT-5.4-Codex',
				reasoningEffort: 'high',
			}),
		});

		assert.strictEqual(settingsService.setSelections.length, 1);
		assert.strictEqual(settingsService.setSelections[0].modelIdentifier, 'openai/gpt-5.4-codex');
		assert.strictEqual(settingsService.setSelections[0].reasoningEffort, 'high');
		assert.strictEqual(runtimeService.lastOptions?.modelIdentifier, 'openai/gpt-5.4-codex');
		assert.strictEqual(runtimeService.lastOptions?.reasoningEffort, 'high');
	});
});
