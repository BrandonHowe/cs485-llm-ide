/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { VSCloneChatThreadService } from '../../browser/vscloneChatThreadService.js';
import { IVSCloneContextGatheringService } from '../../browser/vscloneContextGatheringService.js';
import { IVSCloneThreadRuntimeHandle, IVSCloneThreadRuntimeService } from '../../browser/vscloneThreadRuntimeService.js';
import { type IVSCloneModelSelection } from '../../common/vscloneModelSelectionTypes.js';
import { type VSCloneChatMode } from '../../common/vsclonePlanModeTypes.js';
import { IVSClonePlanModeService } from '../../common/vsclonePlanModeService.js';
import type { IVSClonePromptContext } from '../../common/vsclonePrompts.js';
import { IVSCloneSettingsService } from '../../common/vscloneSettingsService.js';
import type { IVSCloneSettingsState } from '../../common/vscloneSettingsTypes.js';
import { VSCloneUnifiedChatBackendService } from '../../common/backend/vscloneUnifiedChatBackendService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { createVSCloneTestFileService } from '../common/vscloneTestFileService.js';

function createThreadSelection(threadId: string): IVSCloneModelSelection {
	return {
		threadId,
		location: 'chat',
		modelIdentifier: 'openai/gpt-5.3-codex',
		vendor: 'openai',
		modelId: 'gpt-5.3-codex',
		modelName: 'GPT-5.3-Codex',
		selectedAt: 1,
	};
}

function createBackendService(
	testDisposables: DisposableStore,
	storageService: TestStorageService,
	workspaceId: string = 'vsclone-thread-lifecycle-workspace',
): VSCloneUnifiedChatBackendService {
	const instantiationService = testDisposables.add(new TestInstantiationService());
	const workspaceContextService = {
		// The integration target is the public thread lifecycle API plus the real backend cleanup
		// path, so the store still needs a stable workspace identity to behave like production.
		getWorkspace: () => ({ id: workspaceId }),
	} as Partial<IWorkspaceContextService> as IWorkspaceContextService;

	instantiationService.set(IStorageService, storageService);
	instantiationService.set(IWorkspaceContextService, workspaceContextService);
	instantiationService.set(ILogService, new NullLogService());

	return testDisposables.add(new VSCloneUnifiedChatBackendService(
		instantiationService,
		new TestConfigurationService(),
		new NullLogService(),
		new TestNotificationService(),
	));
}

class UnusedSettingsService implements IVSCloneSettingsService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeState = Event.None;
	readonly onDidChangeSelection = Event.None;

	async initialize(): Promise<void> { }
	async refreshState(): Promise<void> { }
	getState(): IVSCloneSettingsState { throw new Error('Settings state is not needed in thread lifecycle integration tests.'); }
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
	getCurrentSelectionForFeatureName(): IVSCloneModelSelection | undefined { return undefined; }
	getCurrentSelectionForFeature(): IVSCloneModelSelection | undefined { return undefined; }
	getThreadSelectionSnapshot() { return undefined; }
	async setSelectionForFeature(): Promise<void> { }
	async switchToNextModel(): Promise<IVSCloneModelSelection | undefined> { return undefined; }
	async resetSelectionForThread(): Promise<void> { }
	hasSelectionForThread(): boolean { return false; }
	getRecentModels() { return []; }
	getRecentModelIdentifiers(): readonly string[] { return []; }
	getEligibilityRecords() { return []; }
	getIneligibilityRecord() { return undefined; }
	async markModelIneligible(): Promise<void> { }
	async clearIneligibilityForVendor(): Promise<void> { }
}

class UnusedPlanModeService implements IVSClonePlanModeService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeMode = Event.None;

	async initialize(): Promise<void> { }
	getModeForThread(): VSCloneChatMode { return 'act'; }
	async setModeForThread(): Promise<void> { }
	isToolAllowed(): boolean { return true; }
}

class UnusedContextGatheringService implements IVSCloneContextGatheringService {
	declare readonly _serviceBrand: undefined;

	async gatherContext(): Promise<IVSClonePromptContext> {
		return {};
	}
}

class RecordingThreadRuntimeService implements IVSCloneThreadRuntimeService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeState = Event.None;
	readonly lifecycleCalls: string[] = [];

	deleteResult = true;
	clearAllCallCount = 0;

	runThread(): IVSCloneThreadRuntimeHandle {
		throw new Error('Prompt submission is not part of the thread lifecycle integration tests.');
	}
	recordRejectedTurn(): void { }
	cancelThread(threadId: string): void { this.lifecycleCalls.push(`cancel:${threadId}`); }
	approveLatestToolRequest(): boolean { return false; }
	rejectLatestToolRequest(): boolean { return false; }
	isAutoApproveEdits(): boolean { return false; }
	setAutoApproveEdits(): void { }
	readonly onDidChangeAutoApproveEdits = Event.None;
	getThreads(): readonly [] { return []; }
	isDeletedThread(): boolean { return false; }
	archiveThread(): boolean { return false; }
	deleteThread(threadId: string): boolean {
		this.lifecycleCalls.push(`delete:${threadId}`);
		return this.deleteResult;
	}
	clearAll(): void {
		this.clearAllCallCount += 1;
		this.lifecycleCalls.push('clearAll');
	}
	getState() { return undefined; }
	async rewindToCheckpoint(): Promise<boolean> { return false; }
}

suite('VSCloneChatThread lifecycle integration', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('deleteThread clears backend sidecars through the public chat thread lifecycle API', async () => {
		const testDisposables = store.add(new DisposableStore());
		const storageService = testDisposables.add(new TestStorageService());
		const backendService = createBackendService(testDisposables, storageService);
		const runtimeService = new RecordingThreadRuntimeService();
		await backendService.replaceSelectionState({
			selectedByThread: {
				'thread-1': {
					chat: createThreadSelection('thread-1'),
				},
			},
			selectedByLocation: {},
			recentModelIdentifiers: ['openai/gpt-5.3-codex'],
		});
		await backendService.replacePlanModeState({
			modeByThread: {
				'thread-1': 'plan',
			},
		});
		const chatThreadService = testDisposables.add(new VSCloneChatThreadService(
			new UnusedSettingsService(),
			new UnusedPlanModeService(),
			new NullLogService(),
			runtimeService,
			new UnusedContextGatheringService(),
			backendService,
			createVSCloneTestFileService(),
		));

		// The public delete API is the seam that matters here because it owns the contract between
		// visible runtime deletion and backend sidecar cleanup. Calling the runtime directly would
		// skip the cross-layer behavior the user actually depends on.
		const deleted = await chatThreadService.deleteThread('thread-1');

		assert.strictEqual(deleted, true);
		assert.deepStrictEqual(runtimeService.lifecycleCalls, [
			'cancel:thread-1',
			'delete:thread-1',
		]);
		assert.deepStrictEqual(backendService.getSelectionState().selectedByThread, {});
		assert.deepStrictEqual(backendService.getPlanModeState().modeByThread, {});
	});

	test('clearAll clears backend sidecars for every thread through the public chat thread lifecycle API', async () => {
		const testDisposables = store.add(new DisposableStore());
		const storageService = testDisposables.add(new TestStorageService());
		const backendService = createBackendService(testDisposables, storageService);
		const runtimeService = new RecordingThreadRuntimeService();
		await backendService.replaceSelectionState({
			selectedByThread: {
				'thread-1': {
					chat: createThreadSelection('thread-1'),
				},
				'thread-2': {
					chat: createThreadSelection('thread-2'),
				},
			},
			selectedByLocation: {
				chat: createThreadSelection('thread-1'),
			},
			recentModelIdentifiers: [
				'openai/gpt-5.3-codex',
				'openai/gpt-5.4-codex',
			],
		});
		await backendService.replacePlanModeState({
			modeByThread: {
				'thread-1': 'plan',
				'thread-2': 'plan',
			},
		});
		const chatThreadService = testDisposables.add(new VSCloneChatThreadService(
			new UnusedSettingsService(),
			new UnusedPlanModeService(),
			new NullLogService(),
			runtimeService,
			new UnusedContextGatheringService(),
			backendService,
			createVSCloneTestFileService(),
		));

		await chatThreadService.clearAll();

		assert.strictEqual(runtimeService.clearAllCallCount, 1);
		assert.deepStrictEqual(runtimeService.lifecycleCalls, ['clearAll']);
		assert.deepStrictEqual(backendService.getSelectionState(), {
			selectedByThread: {},
			selectedByLocation: {},
			recentModelIdentifiers: [],
		});
		assert.deepStrictEqual(backendService.getPlanModeState(), {
			modeByThread: {},
		});
	});
});
