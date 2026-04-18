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
import { VSCloneChatThreadService } from '../../browser/vscloneChatThreadService.js';
import { TestVSCloneUnifiedChatBackendService } from '../common/vscloneTestUnifiedChatBackendService.js';
import { IVSCloneContextGatheringService } from '../../browser/vscloneContextGatheringService.js';
import { IVSCloneThreadRuntimeHandle, IVSCloneThreadRuntimeRunOptions, IVSCloneThreadRuntimeService } from '../../browser/vscloneThreadRuntimeService.js';
import { VSClonePlanModeService } from '../../common/vsclonePlanModeService.js';
import { IVSCloneModelSelection } from '../../common/vscloneModelSelectionTypes.js';
import type { IVSClonePromptContext } from '../../common/vsclonePrompts.js';
import { IVSCloneSettingsService } from '../../common/vscloneSettingsService.js';
import type { IVSCloneSettingsState } from '../../common/vscloneSettingsTypes.js';

class SlowSettingsService implements IVSCloneSettingsService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeState = Event.None;
	readonly onDidChangeSelection = Event.None;
	readonly initializeGate = new DeferredPromise<void>();
	readonly setSelections: Array<{ threadId: string; selection: IVSCloneModelSelection }> = [];
	private selectionByThread = new Map<string, IVSCloneModelSelection>();

	async initialize(): Promise<void> {
		await this.initializeGate.p;
	}

	async refreshState(): Promise<void> { }
	getState(): IVSCloneSettingsState { throw new Error('State access is not needed in this mode snapshot test.'); }
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
	getCurrentSelectionForFeatureName(threadId: string): IVSCloneModelSelection | undefined {
		return this.selectionByThread.get(threadId);
	}
	getCurrentSelectionForFeature(threadId: string): IVSCloneModelSelection | undefined {
		return this.selectionByThread.get(threadId);
	}
	getThreadSelectionSnapshot() { return undefined; }
	async setSelectionForFeature(threadId: string, selection: IVSCloneModelSelection): Promise<void> {
		this.setSelections.push({ threadId, selection: { ...selection } });
		this.selectionByThread.set(threadId, { ...selection });
	}

	async switchToNextModel(): Promise<IVSCloneModelSelection | undefined> {
		return undefined;
	}

	async resetSelectionForThread(threadId: string): Promise<void> {
		this.selectionByThread.delete(threadId);
	}

	hasSelectionForThread(threadId: string): boolean {
		return this.selectionByThread.has(threadId);
	}

	getRecentModels() { return []; }
	getRecentModelIdentifiers(_limit?: number): readonly string[] {
		return [];
	}
	getEligibilityRecords() { return []; }
	async setProviderEnabled(): Promise<void> { }
	getIneligibilityRecord() { return undefined; }
	async markModelIneligible(): Promise<void> { }
	async clearIneligibilityForVendor(): Promise<void> { }
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
	getThreads(): readonly [] { return []; }
	isDeletedThread(): boolean { return false; }
	archiveThread(): boolean { return false; }
	deleteThread(): boolean { return false; }
	clearAll(): void { }
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
	return {};
}

suite('VSClonePlanModeIntegration', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('captures the submitted thread mode before a slow frontend dependency can drift the snapshot', async () => {
		const testDisposables = store.add(new DisposableStore());
		const backendService = new TestVSCloneUnifiedChatBackendService();
		const planModeService = testDisposables.add(new VSClonePlanModeService(backendService));
		const settingsService = new SlowSettingsService();
		const threadRuntimeService = new RecordingThreadRuntimeService();
		const contextGatheringService = new StaticContextGatheringService(createContext());
		const chatThreadService = testDisposables.add(new VSCloneChatThreadService(
			settingsService,
			planModeService,
			new NullLogService(),
			threadRuntimeService,
			contextGatheringService,
			backendService,
		));

		await planModeService.setModeForThread('thread-1', 'plan');

		// Keep the frontend-side dependency unresolved long enough to simulate a slow submit path.
		// If the snapshot is taken too late, a mode flip that lands during initialization will leak
		// into the submitted turn and the prompt will be shaped as act mode instead of plan mode.
		const submission = chatThreadService.sendMessage('Refactor the feature in read-only mode', {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
			modelSelection: createSelection(),
		});

		await planModeService.setModeForThread('thread-1', 'act');
		settingsService.initializeGate.complete();

		const result = await submission;

		assert.deepStrictEqual(result, {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
		});
		assert.strictEqual(threadRuntimeService.lastOptions?.mode, 'plan');
		assert.ok(threadRuntimeService.lastOptions?.systemMessage?.includes('PLAN MODE'));
		assert.ok(!threadRuntimeService.lastOptions?.systemMessage?.includes('### edit_file'));
		assert.deepStrictEqual(backendService.getPlanModeState(), {
			modeByThread: {
				'thread-1': 'plan',
			},
		});
	});
});
