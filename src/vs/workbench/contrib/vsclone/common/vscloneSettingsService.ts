/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IVSCloneUnifiedChatBackendService } from './backend/vscloneUnifiedChatBackendService.js';
import {
	normalizeVSCloneThreadId,
	type IVSCloneChatLocation,
	type IVSCloneModelSelection,
	type IVSCloneModelSelectionChangeEvent,
	type IVSCloneThreadSelectionMap,
	type IVSCloneUnifiedChatSelectionState,
} from './vscloneModelSelectionTypes.js';
import {
	getVSCloneModelCapabilityMetadata,
	getVSCloneStaticModelDefinitionByIdentifier,
	VSCLONE_MODEL_DEFINITIONS_BY_PROVIDER,
	VSCLONE_MODEL_IDENTIFIERS,
	VSCLONE_PROVIDER_SETTINGS_DEFAULTS,
	type VSCloneReasoningEffortLevel,
	type VSCloneSettingsFeatureName,
} from './vscloneModelCapabilities.js';
import { IVSCloneOAuthService } from './vscloneOAuthService.js';
import type { VSCloneModelVendor } from './vscloneOAuthTypes.js';
import {
	VSCLONE_SETTINGS_FEATURE_DEFINITIONS,
	createEmptyVSCloneFeatureDefaults,
	createEmptyVSCloneModelSelectionOfFeature,
	toVSCloneFeatureLocation,
	toVSCloneFeatureName,
	type IVSCloneModelIneligibilityRecord,
	type IVSCloneSettingsEligibilityRecord,
	type IVSCloneSettingsFeatureState,
	type IVSCloneSettingsModelState,
	type IVSCloneSettingsProviderState,
	type IVSCloneSettingsRecentModelState,
	type IVSCloneSettingsState,
	type VSCloneSettingsStatus,
	type IVSCloneSettingsThreadSelectionSnapshot,
	type IVSCloneSettingsThreadSelectionSnapshotMap,
	type IVSCloneStoredModelIneligibility,
	type IVSCloneStoredSettingsState,
	type VSCloneFeatureModelSelection,
} from './vscloneSettingsTypes.js';

export const IVSCloneSettingsService = createDecorator<IVSCloneSettingsService>('vscloneSettingsService');

export interface IVSCloneSettingsService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<void>;
	readonly onDidChangeSelection: Event<IVSCloneModelSelectionChangeEvent>;
	initialize(): Promise<void>;
	refreshState(): Promise<void>;
	getState(): IVSCloneSettingsState;
	getProviders(): readonly IVSCloneSettingsProviderState[];
	getModels(vendor?: VSCloneModelVendor): readonly IVSCloneSettingsModelState[];
	getModelsForFeature(featureName: VSCloneSettingsFeatureName, options?: { selectableOnly?: boolean }): readonly IVSCloneSettingsModelState[];
	getModel(identifier: string): IVSCloneSettingsModelState | undefined;
	getSelectableModels(): readonly IVSCloneSettingsModelState[];
	getFeatureSelection(featureName: VSCloneSettingsFeatureName): VSCloneFeatureModelSelection | undefined;
	getFeatureDefaults(): Readonly<Record<VSCloneSettingsFeatureName, IVSCloneSettingsFeatureState>>;
	getCurrentSelectionForFeatureName(threadId: string, featureName: VSCloneSettingsFeatureName): IVSCloneModelSelection | undefined;
	getCurrentSelectionForFeature(threadId: string, location: IVSCloneChatLocation): IVSCloneModelSelection | undefined;
	getThreadSelectionSnapshot(threadId: string, location?: IVSCloneChatLocation): IVSCloneSettingsThreadSelectionSnapshot | undefined;
	setSelectionForFeature(threadId: string, selection: IVSCloneModelSelection): Promise<void>;
	switchToNextModel(threadId: string, location: IVSCloneChatLocation): Promise<IVSCloneModelSelection | undefined>;
	resetSelectionForThread(threadId: string): Promise<void>;
	hasSelectionForThread(threadId: string): boolean;
	getRecentModels(limit?: number): readonly IVSCloneSettingsRecentModelState[];
	getRecentModelIdentifiers(limit?: number): readonly string[];
	getEligibilityRecords(): readonly IVSCloneSettingsEligibilityRecord[];
	getIneligibilityRecord(modelIdentifier: string): IVSCloneModelIneligibilityRecord | undefined;
	markModelIneligible(modelIdentifier: string, reason: string): Promise<void>;
	clearIneligibilityForVendor(vendor: VSCloneModelVendor): Promise<void>;
	/**
	 * Capability-aware sanitization of reasoning fields for the given model. Drops fields whose
	 * capability is absent on the current model so stale persisted values cannot survive a model
	 * capability change. Mirrors the normalization applied to `IVSCloneModelSelection` on load.
	 */
	sanitizeReasoningFields(modelIdentifier: string, fields: IVSCloneReasoningFieldOverrides): IVSCloneReasoningFieldOverrides;
}

export interface IVSCloneReasoningFieldOverrides {
	readonly reasoningEffort?: VSCloneReasoningEffortLevel;
	readonly reasoningEnabled?: boolean;
	readonly reasoningBudget?: number;
}

interface IVSCloneStoredSettingsPayload {
	readonly version?: 1;
	readonly ineligibility?: Record<string, IVSCloneStoredModelIneligibility>;
}

interface IVSCloneSelectionFallbackCandidate {
	readonly modelIdentifier: string;
	readonly reasoningEffort?: VSCloneReasoningEffortLevel;
}

const settingsStorageKey = 'vsclone.settings.v1';
const legacyModelEligibilityStorageKey = 'vsclone.modelEligibility.v1';

const providerOrder = new Map(VSCLONE_PROVIDER_SETTINGS_DEFAULTS.map((provider, index) => [provider.vendor, index]));
const featureFallbackCandidates: Partial<Record<VSCloneSettingsFeatureName, readonly IVSCloneSelectionFallbackCandidate[]>> = {
	Autocomplete: [
		{ modelIdentifier: 'openai/gpt-5.3-codex-spark', reasoningEffort: 'lite' },
		{ modelIdentifier: 'openai/gpt-5-nano', reasoningEffort: 'none' },
		// Gemini has no VSClone-side thinking slider; keep the fallback preset-only so selection
		// normalization does not carry a stale effort into chat/tool requests.
		{ modelIdentifier: 'google/gemini-2.5-flash-lite' },
		{ modelIdentifier: 'google/gemini-3.1-flash-lite-preview' },
		{ modelIdentifier: 'anthropic/claude-haiku-4-5-20251001' },
	],
};

function createEmptyStoredSettingsState(): IVSCloneStoredSettingsState {
	return {
		ineligibility: {},
	};
}

function byProviderOrder(first: { vendor: VSCloneModelVendor }, second: { vendor: VSCloneModelVendor }): number {
	return (providerOrder.get(first.vendor) ?? Number.MAX_SAFE_INTEGER) - (providerOrder.get(second.vendor) ?? Number.MAX_SAFE_INTEGER);
}

function cloneFeatureSelection(selection: VSCloneFeatureModelSelection | undefined): VSCloneFeatureModelSelection | undefined {
	return selection ? { ...selection } : undefined;
}

function toLocationSelection(selection: VSCloneFeatureModelSelection | undefined): IVSCloneModelSelection | undefined {
	if (!selection) {
		return undefined;
	}

	return {
		threadId: undefined,
		location: selection.location,
		modelIdentifier: selection.modelIdentifier,
		vendor: selection.vendor,
		modelId: selection.modelId,
		modelName: selection.modelName,
		reasoningEffort: selection.reasoningEffort,
		reasoningEnabled: selection.reasoningEnabled,
		reasoningBudget: selection.reasoningBudget,
		selectedAt: selection.selectedAt,
	};
}

function cloneModelSelection(selection: IVSCloneModelSelection): IVSCloneModelSelection {
	return { ...selection };
}

function cloneModelState(model: IVSCloneSettingsModelState): IVSCloneSettingsModelState {
	return {
		...model,
		reasoningEffortLevels: model.reasoningEffortLevels ? [...model.reasoningEffortLevels] : undefined,
		supportedFeatures: [...model.supportedFeatures],
		selectableFeatures: [...model.selectableFeatures],
		capabilities: {
			...model.capabilities,
			reasoningEffortLevels: model.capabilities.reasoningEffortLevels ? [...model.capabilities.reasoningEffortLevels] : undefined,
			supportedFeatures: [...model.capabilities.supportedFeatures],
		},
	};
}

function cloneProviderState(provider: IVSCloneSettingsProviderState): IVSCloneSettingsProviderState {
	return { ...provider };
}

function cloneFeatureDefaults(featureDefaults: Readonly<Record<VSCloneSettingsFeatureName, IVSCloneSettingsFeatureState>>): Record<VSCloneSettingsFeatureName, IVSCloneSettingsFeatureState> {
	return Object.fromEntries(
		Object.entries(featureDefaults).map(([featureName, featureState]) => [featureName, {
			...featureState,
			selection: cloneFeatureSelection(featureState.selection),
		}]),
	) as Record<VSCloneSettingsFeatureName, IVSCloneSettingsFeatureState>;
}

function cloneThreadSelectionSnapshot(snapshot: IVSCloneSettingsThreadSelectionSnapshot): IVSCloneSettingsThreadSelectionSnapshot {
	return {
		...snapshot,
		selection: cloneModelSelection(snapshot.selection),
	};
}

function cloneThreadSelections(selections: IVSCloneThreadSelectionMap): IVSCloneThreadSelectionMap {
	return Object.fromEntries(
		Object.entries(selections).map(([location, selection]) => [location, selection ? cloneModelSelection(selection) : undefined]),
	) as IVSCloneThreadSelectionMap;
}

function cloneThreadSelectionSnapshotMap(snapshotMap: IVSCloneSettingsThreadSelectionSnapshotMap): IVSCloneSettingsThreadSelectionSnapshotMap {
	return Object.fromEntries(
		Object.entries(snapshotMap).map(([featureName, snapshot]) => [featureName, snapshot ? cloneThreadSelectionSnapshot(snapshot) : undefined]),
	) as IVSCloneSettingsThreadSelectionSnapshotMap;
}

function cloneRecentModelState(recentModel: IVSCloneSettingsRecentModelState): IVSCloneSettingsRecentModelState {
	return {
		...recentModel,
		model: recentModel.model ? cloneModelState(recentModel.model) : undefined,
	};
}

function cloneEligibilityRecord(record: IVSCloneSettingsEligibilityRecord): IVSCloneSettingsEligibilityRecord {
	return { ...record };
}

function cloneIneligibilityRecord(record: IVSCloneModelIneligibilityRecord): IVSCloneModelIneligibilityRecord {
	return { ...record };
}

function cloneUnifiedSelectionState(state: IVSCloneUnifiedChatSelectionState): IVSCloneUnifiedChatSelectionState {
	return {
		selectedByThread: Object.fromEntries(
			Object.entries(state.selectedByThread).map(([threadId, selections]) => [threadId, Object.fromEntries(
				Object.entries(selections).map(([location, selection]) => [location, selection ? { ...selection, threadId: undefined } : undefined]),
			) as IVSCloneThreadSelectionMap]),
		),
		selectedByLocation: Object.fromEntries(
			Object.entries(state.selectedByLocation).map(([location, selection]) => [location, selection ? { ...selection, threadId: undefined } : undefined]),
		),
		recentModelIdentifiers: [...state.recentModelIdentifiers],
	};
}

function toFeatureSelection(selection: IVSCloneModelSelection): VSCloneFeatureModelSelection {
	return {
		location: selection.location,
		modelIdentifier: selection.modelIdentifier,
		vendor: selection.vendor,
		modelId: selection.modelId,
		modelName: selection.modelName,
		reasoningEffort: selection.reasoningEffort,
		reasoningEnabled: selection.reasoningEnabled,
		reasoningBudget: selection.reasoningBudget,
		selectedAt: selection.selectedAt,
	};
}

function parseStoredSettings(raw: string | undefined): IVSCloneStoredSettingsState {
	if (!raw) {
		return createEmptyStoredSettingsState();
	}

	try {
		const parsed = JSON.parse(raw) as IVSCloneStoredSettingsPayload | undefined;
		if (!parsed || typeof parsed !== 'object') {
			return createEmptyStoredSettingsState();
		}

		const ineligibility: Record<string, IVSCloneStoredModelIneligibility> = {};

		for (const [modelIdentifier, record] of Object.entries(parsed.ineligibility ?? {})) {
			if (!record || typeof record.reason !== 'string' || typeof record.markedAt !== 'number') {
				continue;
			}
			ineligibility[modelIdentifier] = {
				reason: record.reason,
				markedAt: record.markedAt,
			};
		}

		return { ineligibility };
	} catch {
		return createEmptyStoredSettingsState();
	}
}

function parseLegacyEligibility(raw: string | undefined): Record<string, IVSCloneStoredModelIneligibility> {
	if (!raw) {
		return {};
	}

	try {
		const parsed = JSON.parse(raw) as {
			version?: number;
			records?: Record<string, { reason?: string; markedAt?: number }>;
		} | undefined;
		if (!parsed || parsed.version !== 1 || typeof parsed.records !== 'object' || !parsed.records) {
			return {};
		}

		const records: Record<string, IVSCloneStoredModelIneligibility> = {};
		for (const [modelIdentifier, record] of Object.entries(parsed.records)) {
			if (!record || typeof record.reason !== 'string' || typeof record.markedAt !== 'number') {
				continue;
			}
			records[modelIdentifier] = {
				reason: record.reason,
				markedAt: record.markedAt,
			};
		}
		return records;
	} catch {
		return {};
	}
}

function toStoredPayload(state: IVSCloneStoredSettingsState): IVSCloneStoredSettingsPayload {
	return {
		version: 1,
		ineligibility: state.ineligibility,
	};
}

function selectionsEqual(first: IVSCloneModelSelection | undefined, second: IVSCloneModelSelection | undefined): boolean {
	if (!first || !second) {
		return first === second;
	}

	return first.threadId === second.threadId
		&& first.location === second.location
		&& first.modelIdentifier === second.modelIdentifier
		&& first.vendor === second.vendor
		&& first.modelId === second.modelId
		&& first.modelName === second.modelName
		&& first.reasoningEffort === second.reasoningEffort
		&& first.reasoningEnabled === second.reasoningEnabled
		&& first.reasoningBudget === second.reasoningBudget
		&& first.selectedAt === second.selectedAt;
}

/**
 * Phase 2 replaces the old catalog/preferences/eligibility split with one owner that projects the
 * live OAuth state plus the unified-chat selection sidecars into a Void-shaped settings model.
 * Thread selections still persist through `VSCloneUnifiedChatBackendService` because those sidecars
 * are workspace data, while provider visibility and discovered ineligibility remain profile data.
 */
export class VSCloneSettingsService extends Disposable implements IVSCloneSettingsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<void>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly _onDidChangeSelection = this._register(new Emitter<IVSCloneModelSelectionChangeEvent>());
	readonly onDidChangeSelection = this._onDidChangeSelection.event;

	private initialized = false;
	private initializing: Promise<void> | undefined;
	private refreshing: Promise<void> | undefined;
	private failNextRefreshForTest = false;
	private storedSettingsLoaded = false;
	private storedSettingsState: IVSCloneStoredSettingsState = createEmptyStoredSettingsState();
	private state: IVSCloneSettingsState = {
		status: 'idle',
		providers: [],
		models: [],
		featureSelections: {},
		modelSelectionOfFeature: createEmptyVSCloneModelSelectionOfFeature(),
		featureDefaults: createEmptyVSCloneFeatureDefaults(),
		threadSelections: {},
		threadSelectionSnapshots: {},
		recentModels: [],
		recentModelIdentifiers: [],
		eligibilityRecords: [],
		ineligibilityRecords: [],
	};

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IVSCloneOAuthService private readonly oauthService: IVSCloneOAuthService,
		@IVSCloneUnifiedChatBackendService private readonly unifiedChatBackendService: IVSCloneUnifiedChatBackendService,
	) {
		super();

		this._register(this.oauthService.onDidChangeState(event => {
			// Ineligibility is tied to the currently signed-in account. Clearing a vendor on sign-out
			// prevents the next identity on that provider from inheriting stale hidden-model state.
			if (event.current === 'signed_out') {
				void this.clearIneligibilityForVendor(event.vendor);
				return;
			}
			void this.refreshState();
		}));
		this._register(this.unifiedChatBackendService.onDidChange(() => {
			if (!this.initialized) {
				return;
			}
			this.syncState('ready');
		}));
	}

	setFailNextRefreshForTest(): void {
		this.failNextRefreshForTest = true;
	}

	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		if (this.initializing) {
			return this.initializing;
		}

		this.initializing = this.refreshState().finally(() => {
			this.initialized = true;
			this.initializing = undefined;
		});
		return this.initializing;
	}

	async refreshState(): Promise<void> {
		if (this.refreshing) {
			return this.refreshing;
		}

		this.refreshing = this.doRefreshState().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	getState(): IVSCloneSettingsState {
		return {
			...this.state,
			providers: this.state.providers.map(cloneProviderState),
			models: this.state.models.map(cloneModelState),
			featureSelections: Object.fromEntries(
				Object.entries(this.state.featureSelections).map(([location, selection]) => [location, cloneFeatureSelection(selection)]),
			),
			modelSelectionOfFeature: Object.fromEntries(
				Object.entries(this.state.modelSelectionOfFeature).map(([featureName, selection]) => [featureName, cloneFeatureSelection(selection)]),
			) as Record<VSCloneSettingsFeatureName, VSCloneFeatureModelSelection | undefined>,
			featureDefaults: cloneFeatureDefaults(this.state.featureDefaults),
			threadSelections: Object.fromEntries(
				Object.entries(this.state.threadSelections).map(([threadId, selections]) => [threadId, cloneThreadSelections(selections)]),
			),
			threadSelectionSnapshots: Object.fromEntries(
				Object.entries(this.state.threadSelectionSnapshots).map(([threadId, snapshotMap]) => [threadId, cloneThreadSelectionSnapshotMap(snapshotMap)]),
			),
			recentModels: this.state.recentModels.map(cloneRecentModelState),
			recentModelIdentifiers: [...this.state.recentModelIdentifiers],
			eligibilityRecords: this.state.eligibilityRecords.map(cloneEligibilityRecord),
			ineligibilityRecords: this.state.ineligibilityRecords.map(cloneIneligibilityRecord),
		};
	}

	getProviders(): readonly IVSCloneSettingsProviderState[] {
		return this.state.providers.map(cloneProviderState);
	}

	getModels(vendor?: VSCloneModelVendor): readonly IVSCloneSettingsModelState[] {
		const models = vendor
			? this.state.models.filter(model => model.vendor === vendor)
			: this.state.models;
		return models.map(cloneModelState);
	}

	getModelsForFeature(featureName: VSCloneSettingsFeatureName, options?: { selectableOnly?: boolean }): readonly IVSCloneSettingsModelState[] {
		const selectableOnly = options?.selectableOnly === true;
		return this.state.models
			.filter(model => (selectableOnly ? model.selectableFeatures : model.supportedFeatures).includes(featureName))
			.map(cloneModelState);
	}

	getModel(identifier: string): IVSCloneSettingsModelState | undefined {
		const model = this.state.models.find(candidate => candidate.identifier === identifier);
		return model ? cloneModelState(model) : undefined;
	}

	getSelectableModels(): readonly IVSCloneSettingsModelState[] {
		return this.state.models.filter(model => model.isSelectable).map(cloneModelState);
	}

	getFeatureSelection(featureName: VSCloneSettingsFeatureName): VSCloneFeatureModelSelection | undefined {
		return cloneFeatureSelection(this.state.modelSelectionOfFeature[featureName]);
	}

	getFeatureDefaults(): Readonly<Record<VSCloneSettingsFeatureName, IVSCloneSettingsFeatureState>> {
		return cloneFeatureDefaults(this.state.featureDefaults);
	}

	getCurrentSelectionForFeatureName(threadId: string, featureName: VSCloneSettingsFeatureName): IVSCloneModelSelection | undefined {
		return this.getCurrentSelectionForFeature(threadId, toVSCloneFeatureLocation(featureName));
	}

	getCurrentSelectionForFeature(threadId: string, location: IVSCloneChatLocation): IVSCloneModelSelection | undefined {
		const normalizedThreadId = normalizeVSCloneThreadId(threadId);
		if (normalizedThreadId) {
			const threadSelection = this.state.threadSelections[normalizedThreadId]?.[location];
			if (threadSelection) {
				return cloneModelSelection(threadSelection);
			}
		}

		const featureName = toVSCloneFeatureName(location);
		if (!featureName) {
			return undefined;
		}

		const selection = this.state.modelSelectionOfFeature[featureName];
		return selection ? { ...selection } : undefined;
	}

	getThreadSelectionSnapshot(threadId: string, location: IVSCloneChatLocation = 'chat'): IVSCloneSettingsThreadSelectionSnapshot | undefined {
		const normalizedThreadId = normalizeVSCloneThreadId(threadId);
		if (!normalizedThreadId) {
			return undefined;
		}
		const featureName = toVSCloneFeatureName(location);
		if (!featureName) {
			return undefined;
		}
		const snapshot = this.state.threadSelectionSnapshots[normalizedThreadId]?.[featureName];
		return snapshot ? cloneThreadSelectionSnapshot(snapshot) : undefined;
	}

	async setSelectionForFeature(threadId: string, selection: IVSCloneModelSelection): Promise<void> {
		await this.ensureSelectionBackendReady();

		const normalizedThreadId = normalizeVSCloneThreadId(threadId);
		const normalizedSelection = this.normalizeSelection(selection.location, selection, normalizedThreadId);
		const currentSelectionState = cloneUnifiedSelectionState(this.unifiedChatBackendService.getSelectionState());
		if (normalizedThreadId) {
			currentSelectionState.selectedByThread[normalizedThreadId] = {
				...(currentSelectionState.selectedByThread[normalizedThreadId] ?? {}),
				[selection.location]: this.toPersistedSelection(normalizedSelection),
			};
		} else {
			// Feature defaults apply only before a thread is bound. Thread-specific picks should not
			// silently rewrite the default model that brand-new chats or inline requests inherit.
			currentSelectionState.selectedByLocation[selection.location] = this.toPersistedSelection(normalizedSelection);
		}
		currentSelectionState.recentModelIdentifiers = this.rememberRecentModel(
			currentSelectionState.recentModelIdentifiers,
			normalizedSelection.modelIdentifier,
		);

		await this.unifiedChatBackendService.replaceSelectionState(currentSelectionState);
		this.syncState('ready');
	}

	async switchToNextModel(threadId: string, location: IVSCloneChatLocation): Promise<IVSCloneModelSelection | undefined> {
		await this.initialize();
		const featureName = toVSCloneFeatureName(location);
		if (!featureName) {
			return undefined;
		}

		const selectableModels = this.getModelsForFeature(featureName, { selectableOnly: true });
		if (selectableModels.length === 0) {
			return undefined;
		}

		const currentSelection = this.getCurrentSelectionForFeature(threadId, location);
		const currentIndex = currentSelection
			? selectableModels.findIndex(model => model.identifier === currentSelection.modelIdentifier)
			: -1;
		const nextModel = selectableModels[(currentIndex + 1 + selectableModels.length) % selectableModels.length];
		const sameModelAsBefore = currentSelection?.modelIdentifier === nextModel.identifier;
		const nextSelection: IVSCloneModelSelection = {
			threadId: normalizeVSCloneThreadId(threadId),
			location,
			modelIdentifier: nextModel.identifier,
			vendor: nextModel.vendor,
			modelId: nextModel.modelId,
			modelName: nextModel.modelName,
			// Cycling preserves the current level when the user stays on the same model, but otherwise
			// falls back to the model/location default so switching providers does not carry invalid
			// reasoning settings into a different model family.
			reasoningEffort: sameModelAsBefore
				? this.resolveReasoningEffort(currentSelection?.reasoningEffort, nextModel, location)
				: this.resolveReasoningEffort(undefined, nextModel, location),
			// Toggle and budget are model-specific: clear them on a model switch so stale raw budget
			// values from an older or future provider cannot leak into a preset-effort model.
			reasoningEnabled: sameModelAsBefore ? currentSelection?.reasoningEnabled : undefined,
			reasoningBudget: sameModelAsBefore ? currentSelection?.reasoningBudget : undefined,
			selectedAt: Date.now(),
		};

		await this.setSelectionForFeature(threadId, nextSelection);
		return this.getCurrentSelectionForFeature(threadId, location);
	}

	async resetSelectionForThread(threadId: string): Promise<void> {
		await this.ensureSelectionBackendReady();
		const normalizedThreadId = normalizeVSCloneThreadId(threadId);
		if (!normalizedThreadId) {
			return;
		}

		const currentSelectionState = cloneUnifiedSelectionState(this.unifiedChatBackendService.getSelectionState());
		if (!currentSelectionState.selectedByThread[normalizedThreadId]) {
			return;
		}

		delete currentSelectionState.selectedByThread[normalizedThreadId];
		await this.unifiedChatBackendService.replaceSelectionState(currentSelectionState);
		this.syncState('ready');
	}

	hasSelectionForThread(threadId: string): boolean {
		const normalizedThreadId = normalizeVSCloneThreadId(threadId);
		return !!normalizedThreadId && Object.keys(this.state.threadSelections[normalizedThreadId] ?? {}).length > 0;
	}

	getRecentModels(limit = 3): readonly IVSCloneSettingsRecentModelState[] {
		return this.state.recentModels.slice(0, Math.max(0, limit)).map(cloneRecentModelState);
	}

	getRecentModelIdentifiers(limit?: number): readonly string[] {
		return this.state.recentModelIdentifiers.slice(0, limit === undefined ? this.state.recentModelIdentifiers.length : Math.max(0, limit));
	}

	getEligibilityRecords(): readonly IVSCloneSettingsEligibilityRecord[] {
		return this.state.eligibilityRecords.map(cloneEligibilityRecord);
	}

	getIneligibilityRecord(modelIdentifier: string): IVSCloneModelIneligibilityRecord | undefined {
		const record = this.storedSettingsState.ineligibility[modelIdentifier];
		return record ? { modelIdentifier, reason: record.reason, markedAt: record.markedAt } : undefined;
	}

	async markModelIneligible(modelIdentifier: string, reason: string): Promise<void> {
		await this.initialize();
		const existing = this.storedSettingsState.ineligibility[modelIdentifier];
		if (existing?.reason === reason) {
			return;
		}

		this.storedSettingsState = {
			ineligibility: {
				...this.storedSettingsState.ineligibility,
				[modelIdentifier]: {
					reason,
					markedAt: Date.now(),
				},
			},
		};
		this.storeSettingsState();
		this.syncState('ready');
	}

	async clearIneligibilityForVendor(vendor: VSCloneModelVendor): Promise<void> {
		await this.initialize();
		let changed = false;
		const nextIneligibility: Record<string, IVSCloneStoredModelIneligibility> = {};
		for (const [modelIdentifier, record] of Object.entries(this.storedSettingsState.ineligibility)) {
			if (modelIdentifier.startsWith(`${vendor}/`)) {
				changed = true;
				continue;
			}
			nextIneligibility[modelIdentifier] = record;
		}
		if (!changed) {
			return;
		}

		this.storedSettingsState = {
			ineligibility: nextIneligibility,
		};
		this.storeSettingsState();
		this.syncState('ready');
	}

	private async doRefreshState(): Promise<void> {
		this.syncState('loading');

		try {
			this.ensureStoredSettingsLoaded();
			await this.oauthService.initialize();
			await this.unifiedChatBackendService.initialize();
			// Yield once so view code can render loading states even when OAuth and storage are warm.
			await timeout(0);

			if (this.failNextRefreshForTest) {
				this.failNextRefreshForTest = false;
				throw new Error('Failed to fetch model catalog. Check your network connection.');
			}

			this.syncState('ready');
		} catch (error) {
			this.state = {
				...this.state,
				status: 'error',
				errorMessage: error instanceof Error ? error.message : 'Failed to load VSClone settings.',
				updatedAt: Date.now(),
			};
			this._onDidChangeState.fire();
		}
	}

	private ensureStoredSettingsLoaded(): void {
		if (this.storedSettingsLoaded) {
			return;
		}

		const stored = parseStoredSettings(this.storageService.get(settingsStorageKey, StorageScope.PROFILE));
		const migratedIneligibility = Object.keys(stored.ineligibility).length > 0
			? stored.ineligibility
			: parseLegacyEligibility(this.storageService.get(legacyModelEligibilityStorageKey, StorageScope.PROFILE));

		this.storedSettingsState = {
			ineligibility: migratedIneligibility,
		};
		this.storedSettingsLoaded = true;

		if (Object.keys(migratedIneligibility).length > 0) {
			this.storeSettingsState();
		}
	}

	private storeSettingsState(): void {
		this.storageService.store(
			settingsStorageKey,
			JSON.stringify(toStoredPayload(this.storedSettingsState)),
			StorageScope.PROFILE,
			// The combined payload includes account-derived ineligibility, so it stays machine-scoped.
			StorageTarget.MACHINE,
		);
	}

	private async ensureSelectionBackendReady(): Promise<void> {
		this.ensureStoredSettingsLoaded();
		await this.oauthService.initialize();
		await this.unifiedChatBackendService.initialize();
		if (this.state.status === 'idle') {
			this.syncState('ready');
		}
	}

	private syncState(status: VSCloneSettingsStatus): void {
		this.ensureStoredSettingsLoaded();
		const previousState = this.state;
		const providers = this.buildProviders();
		const models = this.buildModels(providers);
		const modelByIdentifier = new Map(models.map(model => [model.identifier, model]));
		const selectionState = this.unifiedChatBackendService.getSelectionState();
		const featureSelections = this.buildFeatureSelections(selectionState.selectedByLocation, models);
		const modelSelectionOfFeature = this.toFeatureSelectionMap(featureSelections);
		const featureDefaults = this.toFeatureDefaults(modelSelectionOfFeature);
		const threadSelections = this.toThreadSelections(selectionState.selectedByThread, modelByIdentifier);
		const threadSelectionSnapshots = this.toThreadSelectionSnapshots(threadSelections);
		const recentModels = this.toRecentModels(selectionState, modelByIdentifier);
		const ineligibilityRecords = this.collectIneligibilityRecords();
		const eligibilityRecords = this.toEligibilityRecords(providers, ineligibilityRecords, modelByIdentifier);

		this.state = {
			status,
			providers,
			models,
			featureSelections,
			modelSelectionOfFeature,
			featureDefaults,
			threadSelections,
			threadSelectionSnapshots,
			recentModels,
			recentModelIdentifiers: [...selectionState.recentModelIdentifiers],
			eligibilityRecords,
			ineligibilityRecords,
			updatedAt: Date.now(),
			errorMessage: status === 'error' ? previousState.errorMessage : undefined,
		};
		this._onDidChangeState.fire();
		this.emitSelectionChanges(previousState, this.state);
	}

	private buildProviders(): readonly IVSCloneSettingsProviderState[] {
		return VSCLONE_PROVIDER_SETTINGS_DEFAULTS
			.map<IVSCloneSettingsProviderState>(providerDefault => {
				const providerState = this.oauthService.state.providers[providerDefault.vendor];
				const definedModels = VSCLONE_MODEL_DEFINITIONS_BY_PROVIDER[providerDefault.vendor];
				const visibleModels = providerState.isReady ? definedModels : [];
				const selectableModelCount = visibleModels.filter(model => {
					const identifier = `${providerDefault.vendor}/${model.modelId}`;
					return !this.storedSettingsState.ineligibility[identifier];
				}).length;

				return {
					vendor: providerDefault.vendor,
					displayName: providerDefault.displayName,
					status: providerState.isReady ? 'available' : 'requires_sign_in',
					modelCount: visibleModels.length,
					selectableModelCount,
					definedModelCount: definedModels.length,
				};
			})
			.sort(byProviderOrder);
	}

	private buildModels(providers: readonly IVSCloneSettingsProviderState[]): readonly IVSCloneSettingsModelState[] {
		const models: IVSCloneSettingsModelState[] = [];

		for (const provider of providers) {
			for (const definition of VSCLONE_MODEL_DEFINITIONS_BY_PROVIDER[provider.vendor]) {
				const identifier = `${provider.vendor}/${definition.modelId}`;
				const ineligibilityRecord = this.storedSettingsState.ineligibility[identifier];
				const capabilities = getVSCloneModelCapabilityMetadata(definition);
				const unavailableReason = provider.status !== 'available'
					? 'provider_requires_sign_in'
					: ineligibilityRecord
						? 'account_ineligible'
						: undefined;

				models.push({
					identifier,
					vendor: definition.vendor,
					modelId: definition.modelId,
					modelName: definition.modelName,
					reasoningEffortLevels: capabilities.reasoningEffortLevels ? [...capabilities.reasoningEffortLevels] : undefined,
					defaultReasoningEffort: capabilities.defaultReasoningEffort,
					supportsImages: capabilities.supportsImages,
					supportsFIM: capabilities.supportsFIM,
					supportedFeatures: [...capabilities.supportedFeatures],
					selectableFeatures: unavailableReason === undefined ? [...capabilities.supportedFeatures] : [],
					capabilities,
					isSelectable: unavailableReason === undefined,
					unavailableReason,
					ineligibilityReason: ineligibilityRecord?.reason,
				});
			}
		}

		return models;
	}

	private buildFeatureSelections(
		selectedByLocation: Readonly<Partial<Record<IVSCloneChatLocation, IVSCloneModelSelection>>>,
		models: readonly IVSCloneSettingsModelState[],
	): Partial<Record<IVSCloneChatLocation, VSCloneFeatureModelSelection>> {
		const featureSelections: Partial<Record<IVSCloneChatLocation, VSCloneFeatureModelSelection>> = {};
		const modelByIdentifier = new Map(models.map(model => [model.identifier, model]));

		for (const definition of VSCLONE_SETTINGS_FEATURE_DEFINITIONS) {
			const rawSelection = selectedByLocation[definition.location];
			const effectiveSelection = this.resolveLocationSelection(definition.location, definition.featureName, rawSelection, modelByIdentifier, models);
			if (effectiveSelection) {
				featureSelections[definition.location] = toFeatureSelection(effectiveSelection);
			}
		}

		return featureSelections;
	}

	private resolveLocationSelection(
		location: IVSCloneChatLocation,
		featureName: VSCloneSettingsFeatureName,
		rawSelection: IVSCloneModelSelection | undefined,
		modelByIdentifier: ReadonlyMap<string, IVSCloneSettingsModelState>,
		models: readonly IVSCloneSettingsModelState[],
	): IVSCloneModelSelection | undefined {
		if (rawSelection) {
			const model = modelByIdentifier.get(rawSelection.modelIdentifier);
			if (model && model.selectableFeatures.includes(featureName)) {
				return this.normalizeSelection(location, rawSelection, undefined, model);
			}
		}

		return this.buildFallbackSelection(location, featureName, models);
	}

	private normalizeSelection(
		location: IVSCloneChatLocation,
		selection: IVSCloneModelSelection,
		threadId: string | undefined,
		modelOverride?: IVSCloneSettingsModelState,
	): IVSCloneModelSelection {
		const model = modelOverride ?? this.state.models.find(candidate => candidate.identifier === selection.modelIdentifier);
		if (!model) {
			return {
				...selection,
				threadId,
				location,
			};
		}

		const sanitized = this.sanitizeReasoningFieldsForModel(model, location, {
			reasoningEffort: selection.reasoningEffort,
			reasoningEnabled: selection.reasoningEnabled,
			reasoningBudget: selection.reasoningBudget,
		});

		return {
			threadId,
			location,
			modelIdentifier: model.identifier,
			vendor: model.vendor,
			modelId: model.modelId,
			modelName: model.modelName,
			reasoningEffort: sanitized.reasoningEffort,
			reasoningEnabled: sanitized.reasoningEnabled,
			reasoningBudget: sanitized.reasoningBudget,
			selectedAt: selection.selectedAt,
		};
	}

	sanitizeReasoningFields(modelIdentifier: string, fields: IVSCloneReasoningFieldOverrides): IVSCloneReasoningFieldOverrides {
		const model = this.state.models.find(candidate => candidate.identifier === modelIdentifier);
		if (!model) {
			return { ...fields };
		}
		return this.sanitizeReasoningFieldsForModel(model, undefined, fields);
	}

	// Drop persisted reasoning fields whose capability is absent on the current model so a stale
	// `reasoningEnabled: false` cannot survive a capability change and flip a non-toggleable model
	// into "off". Mirrors Void's capability-shaped selection normalization.
	private sanitizeReasoningFieldsForModel(
		model: IVSCloneSettingsModelState,
		location: IVSCloneChatLocation | undefined,
		fields: IVSCloneReasoningFieldOverrides,
	): IVSCloneReasoningFieldOverrides {
		const capabilities = model.capabilities.reasoningCapabilities;
		const reasoningSlider = capabilities ? capabilities.reasoningSlider : undefined;
		const canTurnOffReasoning = capabilities ? capabilities.canTurnOffReasoning === true : false;
		const preservedReasoningEnabled = canTurnOffReasoning ? fields.reasoningEnabled : undefined;
		const preservedReasoningBudget = reasoningSlider?.type === 'budget_slider'
			? this.resolveReasoningBudgetForSlider(fields.reasoningBudget, reasoningSlider, canTurnOffReasoning)
			: undefined;
		const preservedReasoningEffort = reasoningSlider?.type === 'effort_slider'
			? (location ? this.resolveReasoningEffort(fields.reasoningEffort, model, location) : this.resolveReasoningEffortForModel(fields.reasoningEffort, model))
			: undefined;

		return {
			reasoningEffort: preservedReasoningEffort,
			reasoningEnabled: preservedReasoningEnabled,
			reasoningBudget: preservedReasoningBudget,
		};
	}

	private resolveReasoningEffortForModel(
		preferred: VSCloneReasoningEffortLevel | undefined,
		model: IVSCloneSettingsModelState,
	): VSCloneReasoningEffortLevel | undefined {
		// Pure capability-aware sanitization: pass through only if the preferred effort is still
		// listed on the model, otherwise drop it. Unlike `resolveReasoningEffort`, this never invents
		// a default so the caller can distinguish "not specified" from "explicit choice."
		if (preferred && model.reasoningEffortLevels?.includes(preferred)) {
			return preferred;
		}
		return undefined;
	}

	/**
	 * Capability-aware sanitization for a persisted `reasoningBudget`. Void never hot-swaps a model's
	 * budget range mid-session, so this defensive pass only fires in VSClone when capabilities drift
	 * between sessions. Preserve the UI's off-notch value (`min - stepSize`, see `ReasoningOptionSlider`
	 * at `vscloneUnifiedChatViewPane.ts:5041`) when the new slider still supports turning reasoning
	 * off so the stored "off" state round-trips; drop any other out-of-range value so the slider's
	 * default fires on load instead of treating a stale raw number as a live budget.
	 */
	private resolveReasoningBudgetForSlider(
		preferred: number | undefined,
		slider: { readonly type: 'budget_slider'; readonly min: number; readonly max: number; readonly default: number },
		canTurnOffReasoning: boolean,
	): number | undefined {
		if (preferred === undefined) {
			return undefined;
		}
		if (preferred >= slider.min && preferred <= slider.max) {
			return preferred;
		}
		if (canTurnOffReasoning) {
			const stepSize = Math.max(1, Math.round((slider.max - slider.min) / 8));
			const valueIfOff = slider.min - stepSize;
			if (preferred === valueIfOff) {
				return preferred;
			}
		}
		return undefined;
	}

	private resolveReasoningEffort(
		preferred: VSCloneReasoningEffortLevel | undefined,
		model: IVSCloneSettingsModelState,
		location: IVSCloneChatLocation,
	): VSCloneReasoningEffortLevel | undefined {
		if (preferred && model.reasoningEffortLevels?.includes(preferred)) {
			return preferred;
		}

		const featureName = toVSCloneFeatureName(location);
		if (featureName) {
			const fallbackCandidate = featureFallbackCandidates[featureName]?.find(candidate => candidate.modelIdentifier === model.identifier);
			if (fallbackCandidate?.reasoningEffort && model.reasoningEffortLevels?.includes(fallbackCandidate.reasoningEffort)) {
				return fallbackCandidate.reasoningEffort;
			}
		}

		return model.defaultReasoningEffort ?? model.reasoningEffortLevels?.[0];
	}

	private buildFallbackSelection(
		location: IVSCloneChatLocation,
		featureName: VSCloneSettingsFeatureName,
		models: readonly IVSCloneSettingsModelState[],
	): IVSCloneModelSelection | undefined {
		const fallbackModel = this.findFallbackModel(featureName, models);
		if (!fallbackModel) {
			return undefined;
		}

		return {
			location,
			modelIdentifier: fallbackModel.identifier,
			vendor: fallbackModel.vendor,
			modelId: fallbackModel.modelId,
			modelName: fallbackModel.modelName,
			reasoningEffort: this.resolveReasoningEffort(undefined, fallbackModel, location),
			// Derived defaults must stay stable across refreshes. Using a synthetic "now" timestamp
			// would make every refresh look like a real selection change to downstream listeners.
			selectedAt: 0,
		};
	}

	private findFallbackModel(
		featureName: VSCloneSettingsFeatureName,
		models: readonly IVSCloneSettingsModelState[],
	): IVSCloneSettingsModelState | undefined {
		const candidates = featureFallbackCandidates[featureName] ?? [];
		for (const candidate of candidates) {
			const model = models.find(current => current.identifier === candidate.modelIdentifier && current.selectableFeatures.includes(featureName));
			if (model) {
				return model;
			}
		}

		return models.find(model => model.selectableFeatures.includes(featureName));
	}

	private toFeatureSelectionMap(
		featureSelections: Readonly<Partial<Record<IVSCloneChatLocation, VSCloneFeatureModelSelection>>>,
	): Record<VSCloneSettingsFeatureName, VSCloneFeatureModelSelection | undefined> {
		const selectionsByFeature = createEmptyVSCloneModelSelectionOfFeature();
		for (const [location, selection] of Object.entries(featureSelections) as [IVSCloneChatLocation, VSCloneFeatureModelSelection | undefined][]) {
			if (!selection) {
				continue;
			}
			const featureName = toVSCloneFeatureName(location);
			if (!featureName) {
				continue;
			}
			selectionsByFeature[featureName] = cloneFeatureSelection(selection);
		}
		return selectionsByFeature;
	}

	private toFeatureDefaults(
		modelSelectionOfFeature: Readonly<Record<VSCloneSettingsFeatureName, VSCloneFeatureModelSelection | undefined>>,
	): Record<VSCloneSettingsFeatureName, IVSCloneSettingsFeatureState> {
		const featureDefaults = createEmptyVSCloneFeatureDefaults();
		for (const [featureName, selection] of Object.entries(modelSelectionOfFeature) as [VSCloneSettingsFeatureName, VSCloneFeatureModelSelection | undefined][]) {
			featureDefaults[featureName] = {
				featureName,
				location: toVSCloneFeatureLocation(featureName),
				selection: cloneFeatureSelection(selection),
			};
		}
		return featureDefaults;
	}

	private toThreadSelections(
		selectedByThread: Readonly<Record<string, IVSCloneThreadSelectionMap>>,
		modelByIdentifier: ReadonlyMap<string, IVSCloneSettingsModelState>,
	): Record<string, IVSCloneThreadSelectionMap> {
		return Object.fromEntries(
			Object.entries(selectedByThread)
				.filter(([threadId]) => !!normalizeVSCloneThreadId(threadId))
				.map(([threadId, selections]) => [threadId, Object.fromEntries(
					// Route every persisted thread-scoped selection through normalizeSelection so capability
					// changes on the underlying model drop stale reasoning fields at load time. Without this,
					// a persisted `reasoningEnabled: false` would survive a model flipping to
					// `canTurnOffReasoning: false` and incorrectly force reasoning off.
					Object.entries(selections).map(([location, selection]) => [
						location,
						selection
							? this.normalizeSelection(
								location as IVSCloneChatLocation,
								selection,
								threadId,
								modelByIdentifier.get(selection.modelIdentifier),
							)
							: undefined,
					]),
				) as IVSCloneThreadSelectionMap]),
		);
	}

	private toThreadSelectionSnapshots(threadSelections: Readonly<Record<string, IVSCloneThreadSelectionMap>>): Record<string, IVSCloneSettingsThreadSelectionSnapshotMap> {
		return Object.fromEntries(
			Object.entries(threadSelections).map(([threadId, selections]) => [threadId, Object.fromEntries(
				Object.values(selections)
					.filter((selection): selection is IVSCloneModelSelection => !!selection)
					.map(selection => {
						const featureName = toVSCloneFeatureName(selection.location);
						return featureName
							? [featureName, {
								threadId,
								featureName,
								selection: cloneModelSelection(selection),
							} satisfies IVSCloneSettingsThreadSelectionSnapshot]
							: undefined;
					})
					.filter((entry): entry is [VSCloneSettingsFeatureName, IVSCloneSettingsThreadSelectionSnapshot] => !!entry),
			) as IVSCloneSettingsThreadSelectionSnapshotMap]),
		);
	}

	private toRecentModels(
		selectionState: IVSCloneUnifiedChatSelectionState,
		modelByIdentifier: ReadonlyMap<string, IVSCloneSettingsModelState>,
	): readonly IVSCloneSettingsRecentModelState[] {
		const lastSelectedAtByIdentifier = new Map<string, number>();
		const allSelections = [
			...Object.values(selectionState.selectedByLocation),
			...Object.values(selectionState.selectedByThread).flatMap(selections => Object.values(selections)),
		];

		for (const selection of allSelections) {
			if (!selection) {
				continue;
			}
			const previousSelectedAt = lastSelectedAtByIdentifier.get(selection.modelIdentifier) ?? 0;
			if (selection.selectedAt > previousSelectedAt) {
				lastSelectedAtByIdentifier.set(selection.modelIdentifier, selection.selectedAt);
			}
		}

		return selectionState.recentModelIdentifiers.map(identifier => ({
			identifier,
			model: modelByIdentifier.get(identifier),
			lastSelectedAt: lastSelectedAtByIdentifier.get(identifier),
		}));
	}

	private collectIneligibilityRecords(): readonly IVSCloneModelIneligibilityRecord[] {
		return Object.entries(this.storedSettingsState.ineligibility)
			.filter(([modelIdentifier]) => VSCLONE_MODEL_IDENTIFIERS.includes(modelIdentifier))
			.map(([modelIdentifier, record]) => ({
				modelIdentifier,
				reason: record.reason,
				markedAt: record.markedAt,
			}))
			.sort((first, second) => second.markedAt - first.markedAt);
	}

	private toEligibilityRecords(
		providers: readonly IVSCloneSettingsProviderState[],
		ineligibilityRecords: readonly IVSCloneModelIneligibilityRecord[],
		modelByIdentifier: ReadonlyMap<string, IVSCloneSettingsModelState>,
	): readonly IVSCloneSettingsEligibilityRecord[] {
		const providerRecords = providers
			.filter(provider => provider.status === 'requires_sign_in')
			.map<IVSCloneSettingsEligibilityRecord>(provider => ({
				scope: 'provider',
				source: 'oauth_sign_in',
				vendor: provider.vendor,
				identifier: provider.vendor,
				displayName: provider.displayName,
				status: 'requires_sign_in',
			}));

		const modelRecords = ineligibilityRecords.map<IVSCloneSettingsEligibilityRecord>(record => {
			const model = modelByIdentifier.get(record.modelIdentifier);
			const definition = getVSCloneStaticModelDefinitionByIdentifier(record.modelIdentifier);
			return {
				scope: 'model',
				source: 'oauth_account',
				vendor: model?.vendor ?? definition?.vendor ?? 'openai',
				identifier: record.modelIdentifier,
				displayName: model?.modelName ?? definition?.modelName ?? record.modelIdentifier,
				status: 'account_ineligible',
				reason: record.reason,
				markedAt: record.markedAt,
				modelIdentifier: record.modelIdentifier,
				modelId: model?.modelId ?? definition?.modelId,
				modelName: model?.modelName ?? definition?.modelName,
			};
		});

		return [...providerRecords, ...modelRecords];
	}

	private toPersistedSelection(selection: IVSCloneModelSelection): IVSCloneModelSelection {
		return {
			...selection,
			threadId: undefined,
		};
	}

	private rememberRecentModel(current: readonly string[], modelIdentifier: string): readonly string[] {
		return [modelIdentifier, ...current.filter(identifier => identifier !== modelIdentifier)];
	}

	private emitSelectionChanges(previousState: IVSCloneSettingsState, nextState: IVSCloneSettingsState): void {
		for (const definition of VSCLONE_SETTINGS_FEATURE_DEFINITIONS) {
			// Feature defaults are location-scoped and intentionally synthetic, so restore events clone
			// them into full selection payloads with no thread binding instead of reusing the persisted object.
			const previousSelection = toLocationSelection(previousState.featureSelections[definition.location]);
			const currentSelection = toLocationSelection(nextState.featureSelections[definition.location]);
			if (selectionsEqual(previousSelection, currentSelection)) {
				continue;
			}
			this.fireSelectionChange({
				threadId: undefined,
				previous: previousSelection,
				current: currentSelection,
				reason: 'restore',
			});
		}

		const threadIds = new Set([
			...Object.keys(previousState.threadSelections),
			...Object.keys(nextState.threadSelections),
		]);
		for (const threadId of threadIds) {
			// Thread-bound selections are now location-scoped, so change events must compare each
			// location independently instead of treating the whole thread as one mutable slot.
			for (const location of ['chat', 'editorInline', 'notebook', 'terminal'] as const) {
				const previousSelection = previousState.threadSelections[threadId]?.[location];
				const currentSelection = nextState.threadSelections[threadId]?.[location];
				if (selectionsEqual(previousSelection, currentSelection)) {
					continue;
				}
				this.fireSelectionChange({
					threadId,
					previous: previousSelection ? cloneModelSelection(previousSelection) : undefined,
					current: currentSelection ? cloneModelSelection(currentSelection) : undefined,
					reason: currentSelection ? 'restore' : 'reset',
				});
			}
		}
	}

	private fireSelectionChange(event: IVSCloneModelSelectionChangeEvent): void {
		if (selectionsEqual(event.previous, event.current)) {
			return;
		}
		this._onDidChangeSelection.fire(event);
	}
}
