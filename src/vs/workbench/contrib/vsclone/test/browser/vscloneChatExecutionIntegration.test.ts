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
import { IVSCloneThreadRuntimeHandle, IVSCloneThreadRuntimeRunOptions, IVSCloneThreadRuntimeService } from '../../browser/vscloneThreadRuntimeService.js';
import { IVSClonePlanModeService } from '../../common/vsclonePlanModeService.js';
import { type VSCloneChatMode } from '../../common/vsclonePlanModeTypes.js';
import { IVSCloneModelSelection } from '../../common/vscloneModelSelectionTypes.js';
import type { IVSClonePromptContext } from '../../common/vsclonePrompts.js';
import { IVSCloneReasoningFieldOverrides, IVSCloneSettingsService } from '../../common/vscloneSettingsService.js';
import type { IVSCloneSettingsState } from '../../common/vscloneSettingsTypes.js';
import { IVSCloneThreadRuntimeState } from '../../common/vscloneThreadRuntimeTypes.js';
import { TestVSCloneUnifiedChatBackendService } from '../common/vscloneTestUnifiedChatBackendService.js';
import { createVSCloneTestFileService } from '../common/vscloneTestFileService.js';

class StaticSettingsService implements IVSCloneSettingsService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeState = Event.None;
	readonly onDidChangeSelection = Event.None;

	constructor(private readonly selection: IVSCloneModelSelection) { }

	async initialize(): Promise<void> { }
	async refreshState(): Promise<void> { }
	getState(): IVSCloneSettingsState { throw new Error('State access is not needed in this integration test.'); }
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
	getIneligibilityRecord() { return undefined; }
	async markModelIneligible(): Promise<void> { }
	async clearIneligibilityForVendor(): Promise<void> { }
	sanitizeReasoningFields(_modelIdentifier: string, fields: IVSCloneReasoningFieldOverrides): IVSCloneReasoningFieldOverrides { return { ...fields }; }
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

	runThread(options: IVSCloneThreadRuntimeRunOptions): IVSCloneThreadRuntimeHandle {
		this.lastOptions = options;
		return new RecordingThreadRuntimeHandle();
	}

	recordRejectedTurn(): void { }
	cancelThread(): void { }
	approveLatestToolRequest(): boolean { return false; }
	rejectLatestToolRequest(): boolean { return false; }
	isAutoApproveEdits(): boolean { return false; }
	setAutoApproveEdits(): void { }
	readonly onDidChangeAutoApproveEdits = Event.None;
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

suite('VSCloneChatExecutionIntegration', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('submit should preserve previous assistant context from runtime', async () => {
		const testDisposables = store.add(new DisposableStore());
		const settingsService = new StaticSettingsService(createSelection());
		const threadRuntimeService = new RecordingThreadRuntimeService();
		// The session layer should read previous turns from runtime state without any history fallback.
		threadRuntimeService.statesByThreadId.set('thread-1', {
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
		const chatThreadService = testDisposables.add(new VSCloneChatThreadService(
			settingsService,
			new StaticPlanModeService(),
			new NullLogService(),
			threadRuntimeService,
			new StaticContextGatheringService(),
			new TestVSCloneUnifiedChatBackendService(),
			createVSCloneTestFileService(),
		));

		const result = await chatThreadService.sendMessage('Follow up on the earlier answer', {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
		});

		assert.deepStrictEqual(result, {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
		});
		assert.deepStrictEqual(threadRuntimeService.lastOptions?.previousTurns, [
			{ role: 'user', content: 'Initial prompt' },
			{ role: 'assistant', content: 'Assistant response' },
		]);
		assert.ok(threadRuntimeService.lastOptions?.systemMessage?.includes('## Available Tools'));
	});
});
