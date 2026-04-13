/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSCloneUnifiedChatViewPane } from '../../browser/vscloneUnifiedChatViewPane.js';
import { IVSCloneChatHistoryQuery, IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn, IVSCloneChatTurnUpdate, VSCloneChatHistoryScope } from '../../common/backend/vscloneChatHistoryService.js';
import { IVSCloneUnifiedChatBackendService } from '../../common/backend/vscloneUnifiedChatBackendService.js';
import { IVSCloneModelSelection, IVSCloneUnifiedChatSelectionState, VSCloneThreadModelSelectionService } from '../../common/backend/vscloneThreadModelSelectionService.js';
import { IVSCloneModelCatalogModelDescriptor, IVSCloneModelCatalogProviderDescriptor, IVSCloneModelCatalogService, IVSCloneModelCatalogState } from '../../common/vscloneModelCatalogService.js';
import { type VSCloneModelVendor } from '../../common/vscloneOAuthTypes.js';
import { IVSCloneUnifiedChatPlanModeState, VSCloneChatMode } from '../../common/vsclonePlanModeTypes.js';

class StaticModelCatalogService implements IVSCloneModelCatalogService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeCatalog = Event.None;

	private readonly providers: readonly IVSCloneModelCatalogProviderDescriptor[];
	private readonly models: readonly IVSCloneModelCatalogModelDescriptor[];

	constructor(models: readonly IVSCloneModelCatalogModelDescriptor[]) {
		this.models = models;
		this.providers = [
			{ vendor: 'openai', displayName: 'OpenAI', status: 'available', modelCount: models.filter(model => model.vendor === 'openai').length },
			{ vendor: 'google', displayName: 'Google', status: 'available', modelCount: models.filter(model => model.vendor === 'google').length },
		];
	}

	async refreshCatalog(): Promise<void> {
		return;
	}

	getState(): IVSCloneModelCatalogState {
		return {
			status: 'ready',
			providers: this.providers,
			models: this.models,
		};
	}

	getProviders(): readonly IVSCloneModelCatalogProviderDescriptor[] {
		return this.providers;
	}

	getModels(providerId?: VSCloneModelVendor): readonly IVSCloneModelCatalogModelDescriptor[] {
		return providerId ? this.models.filter(model => model.vendor === providerId) : this.models;
	}

	getModel(identifier: string): IVSCloneModelCatalogModelDescriptor | undefined {
		return this.models.find(model => model.identifier === identifier);
	}

	getSelectableModels(): readonly IVSCloneModelCatalogModelDescriptor[] {
		return this.models.filter(model => model.isSelectable);
	}
}

class DelayedRestoreBackendService implements IVSCloneUnifiedChatBackendService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChange = Event.None;

	private readonly initGate = new DeferredPromise<void>();
	private readonly restoredSelectionState: IVSCloneUnifiedChatSelectionState;
	private selectionState: IVSCloneUnifiedChatSelectionState = {
		selectedByThread: {},
		selectedByLocation: {},
		recentModelIdentifiers: [],
	};
	private initialized = false;

	constructor(selection: IVSCloneModelSelection) {
		this.restoredSelectionState = {
			selectedByThread: {
				[selection.threadId ?? 'thread-1']: { ...selection, threadId: undefined },
			},
			selectedByLocation: {
				[selection.location]: { ...selection, threadId: undefined },
			},
			recentModelIdentifiers: [selection.modelIdentifier],
		};
	}

	async initialize(): Promise<void> {
		await this.initGate.p;
		this.initialized = true;
		this.selectionState = {
			selectedByThread: { ...this.restoredSelectionState.selectedByThread },
			selectedByLocation: { ...this.restoredSelectionState.selectedByLocation },
			recentModelIdentifiers: [...this.restoredSelectionState.recentModelIdentifiers],
		};
	}

	completeInitialization(): void {
		this.initGate.complete(undefined);
	}

	getThreads(_query?: IVSCloneChatHistoryQuery): readonly IVSCloneChatHistoryThread[] {
		return [];
	}

	getTurns(): readonly IVSCloneChatHistoryTurn[] {
		return [];
	}

	applyTurnUpdate(_update: IVSCloneChatTurnUpdate): void {
		return;
	}

	async archiveThread(_threadId: string, _archived: boolean): Promise<void> {
		return;
	}

	async deleteThread(_threadId: string): Promise<void> {
		return;
	}

	async clearAll(_scope: VSCloneChatHistoryScope): Promise<void> {
		return;
	}

	getSelectionState(): IVSCloneUnifiedChatSelectionState {
		if (!this.initialized) {
			return {
				selectedByThread: {},
				selectedByLocation: {},
				recentModelIdentifiers: [],
			};
		}

		return {
			selectedByThread: { ...this.selectionState.selectedByThread },
			selectedByLocation: { ...this.selectionState.selectedByLocation },
			recentModelIdentifiers: [...this.selectionState.recentModelIdentifiers],
		};
	}

	async replaceSelectionState(state: IVSCloneUnifiedChatSelectionState): Promise<void> {
		this.selectionState = {
			selectedByThread: { ...state.selectedByThread },
			selectedByLocation: { ...state.selectedByLocation },
			recentModelIdentifiers: [...state.recentModelIdentifiers],
		};
	}

	getPlanModeState(): IVSCloneUnifiedChatPlanModeState {
		return { modeByThread: {} };
	}

	async replacePlanModeState(_state: IVSCloneUnifiedChatPlanModeState): Promise<void> {
		return;
	}
}

suite('VSCloneModelSelectionPersistence', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('reopened thread should submit with the restored model instead of the fallback default', async () => {
		const testDisposables = store.add(new DisposableStore());
		const restoredModel: IVSCloneModelSelection = {
			threadId: 'thread-1',
			location: 'chat',
			modelIdentifier: 'google/gemini-3.1-flash-lite-preview',
			vendor: 'google',
			modelId: 'gemini-3.1-flash-lite-preview',
			modelName: 'Gemini 3.1 Flash Lite',
			reasoningEffort: 'minimal',
			selectedAt: Date.now(),
		};

		const catalogService = new StaticModelCatalogService([
			{
				identifier: 'openai/gpt-5.3-codex-spark',
				vendor: 'openai',
				modelId: 'gpt-5.3-codex-spark',
				modelName: 'GPT-5.3-Codex-Spark',
				supportsImages: false,
				isSelectable: true,
				reasoningEffortLevels: ['standard', 'lite'],
				defaultReasoningEffort: 'lite',
			},
			{
				identifier: 'google/gemini-3.1-flash-lite-preview',
				vendor: 'google',
				modelId: 'gemini-3.1-flash-lite-preview',
				modelName: 'Gemini 3.1 Flash Lite',
				supportsImages: true,
				isSelectable: true,
				reasoningEffortLevels: ['minimal', 'low'],
				defaultReasoningEffort: 'minimal',
			},
		]);
		const backendService = new DelayedRestoreBackendService(restoredModel);
		const selectionService = testDisposables.add(new VSCloneThreadModelSelectionService(backendService, catalogService));

		const selectionInit = selectionService.initialize();
		const submitPromise = new DeferredPromise<{ modelSelection?: IVSCloneModelSelection }>();

		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane & {
			activeThreadId?: string;
			composerInput: HTMLTextAreaElement;
			composerSendButton: HTMLButtonElement;
			threadsById: Map<string, IVSCloneChatHistoryThread>;
			historyService: { getTurns(threadId: string): readonly { status?: string }[]; getThreads(): readonly never[] };
			rail: { setSelectedThread(threadId: string | undefined): void };
			sessionService: { submitPrompt(prompt: string, options: { modelSelection?: IVSCloneModelSelection }): Promise<{ threadId: string; sessionResource: string }> };
			modelSelectionService: VSCloneThreadModelSelectionService;
			modelCatalogService: IVSCloneModelCatalogService;
			planModeService: { getModeForThread(threadId?: string): VSCloneChatMode };
			pendingImages: readonly [];
			submittingPrompt: boolean;
			railVisible: boolean;
			refreshConversation: () => void;
			renderImageStrip: () => void;
			refreshModelControls: () => void;
			updateComposerMetrics: () => void;
			applyRailLayout: () => void;
		};

		pane.activeThreadId = 'thread-1';
		pane.composerInput = document.createElement('textarea');
		pane.composerInput.value = 'Use the restored model';
		pane.composerSendButton = document.createElement('button');
		pane.threadsById = new Map();
		pane.historyService = {
			getTurns: () => [],
			getThreads: () => [],
		};
		pane.rail = {
			setSelectedThread: () => undefined,
		};
		pane.sessionService = {
			async submitPrompt(_prompt: string, options: { modelSelection?: IVSCloneModelSelection }) {
				submitPromise.complete({ modelSelection: options.modelSelection });
				return { threadId: 'thread-1', sessionResource: 'vsclone://thread/thread-1' };
			},
		};
		pane.modelSelectionService = selectionService;
		pane.modelCatalogService = catalogService;
		pane.planModeService = {
			initialize: async () => undefined,
			getModeForThread: () => 'act',
		};
		pane.pendingImages = [];
		pane.submittingPrompt = false;
		pane.railVisible = false;
		pane.refreshConversation = () => undefined;
		pane.renderImageStrip = () => undefined;
		pane.refreshModelControls = () => undefined;
		pane.updateComposerMetrics = () => undefined;
		pane.applyRailLayout = () => undefined;

		// Keep backend restoration in flight while the prompt is submitted so the test covers the
		// race between composer send and async restore/reconciliation.
		const submission = pane.submitPrompt();
		backendService.completeInitialization();
		await selectionInit;
		await submission;
		const capturedSelection = await submitPromise.p;

		try {
			assert.strictEqual(capturedSelection.modelSelection?.modelIdentifier, restoredModel.modelIdentifier);
		} finally {
			testDisposables.dispose();
		}
	});
});
