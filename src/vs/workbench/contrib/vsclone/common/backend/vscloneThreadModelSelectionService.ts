/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IVSCloneModelCatalogService, isVSCloneReasoningEffortLevel, type IVSCloneModelCatalogModelDescriptor, type VSCloneReasoningEffortLevel } from '../vscloneModelCatalogService.js';
import { IVSCloneUnifiedChatBackendService } from './vscloneUnifiedChatBackendService.js';
import {
	allVSCloneChatLocations,
	type IVSCloneChatLocation,
	type IVSCloneModelSelection,
	type IVSCloneModelSelectionChangeEvent,
	type IVSCloneUnifiedChatSelectionState,
	normalizeVSCloneThreadId,
} from '../vscloneModelSelectionTypes.js';

export const IVSCloneThreadModelSelectionService = createDecorator<IVSCloneThreadModelSelectionService>('vsCloneThreadModelSelectionService');

export type {
	IVSCloneChatLocation,
	IVSCloneModelSelection,
	IVSCloneModelSelectionChangeEvent,
};

const preferredEditorInlineFallbackIdentifier = 'openai/gpt-5.3-codex-spark';
const legacyEditorInlineFallbackIdentifier = 'openai/gpt-5.3-codex';
const preferredEditorInlineReasoningEffort: VSCloneReasoningEffortLevel = 'lite';

function cloneSelectionState(state: IVSCloneUnifiedChatSelectionState): IVSCloneUnifiedChatSelectionState {
	return {
		selectedByThread: Object.fromEntries(Object.entries(state.selectedByThread).map(([threadId, selection]) => [threadId, { ...selection, threadId: undefined }])),
		selectedByLocation: Object.fromEntries(Object.entries(state.selectedByLocation).map(([location, selection]) => [location, selection ? { ...selection, threadId: undefined } : undefined])),
		recentModelIdentifiers: [...state.recentModelIdentifiers],
	};
}

function isEqualSelection(left: IVSCloneModelSelection | undefined, right: IVSCloneModelSelection | undefined): boolean {
	if (!left || !right) {
		return left === right;
	}

	return left.location === right.location
		&& left.modelIdentifier === right.modelIdentifier
		&& left.vendor === right.vendor
		&& left.modelId === right.modelId
		&& left.modelName === right.modelName
		&& left.reasoningEffort === right.reasoningEffort
		&& left.selectedAt === right.selectedAt;
}

function touchRecentModelIdentifier(recentModelIdentifiers: readonly string[], identifier: string): string[] {
	return [
		identifier,
		...recentModelIdentifiers.filter(value => value !== identifier),
	].slice(0, 8);
}

export interface IVSCloneThreadModelSelectionService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSelection: Event<IVSCloneModelSelectionChangeEvent>;
	initialize(): Promise<void>;
	getCurrentSelectionForThread(threadId: string, location: IVSCloneChatLocation): IVSCloneModelSelection | undefined;
	setSelectionForThread(threadId: string, selection: IVSCloneModelSelection): Promise<void>;
	switchToNextModel(threadId: string, location: IVSCloneChatLocation): Promise<IVSCloneModelSelection | undefined>;
	resetSelectionForThread(threadId: string): Promise<void>;
	hasSelectionForThread(threadId: string): boolean;
	getRecentModelIdentifiers(limit?: number): readonly string[];
}

/**
 * This service now owns only selection policy and catalog reconciliation. Persistence lives in the
 * unified backend so send-path resolution and restore-path resolution always read the same state.
 */
export class VSCloneThreadModelSelectionService extends Disposable implements IVSCloneThreadModelSelectionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSelection = this._register(new Emitter<IVSCloneModelSelectionChangeEvent>());
	readonly onDidChangeSelection = this._onDidChangeSelection.event;

	private initialized = false;

	constructor(
		@IVSCloneUnifiedChatBackendService private readonly backendService: IVSCloneUnifiedChatBackendService,
		@IVSCloneModelCatalogService private readonly catalogService: IVSCloneModelCatalogService,
	) {
		super();

		this._register(this.catalogService.onDidChangeCatalog(() => {
			void this.reconcileSelections('fallback');
		}));
	}

	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		await this.backendService.initialize();
		this.initialized = true;
		await this.reconcileSelections('restore');
	}

	getCurrentSelectionForThread(threadId: string, location: IVSCloneChatLocation): IVSCloneModelSelection | undefined {
		const normalizedThreadId = normalizeVSCloneThreadId(threadId);
		const state = this.backendService.getSelectionState();
		const threadSelection = normalizedThreadId ? state.selectedByThread[normalizedThreadId] : undefined;
		if (threadSelection && this.isSelectableModelIdentifier(threadSelection.modelIdentifier)) {
			return this.toSelection(
				threadSelection.location,
				threadSelection.modelIdentifier,
				threadSelection.selectedAt,
				normalizedThreadId,
				threadSelection.reasoningEffort,
			);
		}

		const locationSelection = state.selectedByLocation[location];
		if (locationSelection && this.isSelectableModelIdentifier(locationSelection.modelIdentifier)) {
			return this.toSelection(
				locationSelection.location,
				locationSelection.modelIdentifier,
				locationSelection.selectedAt,
				normalizedThreadId,
				locationSelection.reasoningEffort,
			);
		}

		return this.getFallbackSelection(location, normalizedThreadId);
	}

	async setSelectionForThread(threadId: string, selection: IVSCloneModelSelection): Promise<void> {
		await this.initialize();

		const normalizedThreadId = normalizeVSCloneThreadId(threadId);
		const normalizedSelection = this.toSelection(selection.location, selection.modelIdentifier, Date.now(), normalizedThreadId, selection.reasoningEffort);
		if (!normalizedSelection) {
			return;
		}

		const currentState = cloneSelectionState(this.backendService.getSelectionState());
		const previous = normalizedThreadId ? currentState.selectedByThread[normalizedThreadId] : currentState.selectedByLocation[selection.location];
		if (normalizedThreadId) {
			currentState.selectedByThread[normalizedThreadId] = { ...normalizedSelection, threadId: undefined };
		}
		currentState.selectedByLocation[selection.location] = { ...normalizedSelection, threadId: undefined };
		currentState.recentModelIdentifiers = touchRecentModelIdentifier(currentState.recentModelIdentifiers, normalizedSelection.modelIdentifier);

		await this.backendService.replaceSelectionState(currentState);
		this._onDidChangeSelection.fire({
			threadId: normalizedThreadId,
			previous,
			current: normalizedSelection,
			reason: 'user',
		});
	}

	async switchToNextModel(threadId: string, location: IVSCloneChatLocation): Promise<IVSCloneModelSelection | undefined> {
		await this.initialize();

		const selectableModels = this.catalogService.getSelectableModels();
		if (selectableModels.length === 0) {
			return undefined;
		}

		const current = this.getCurrentSelectionForThread(threadId, location);
		const currentIndex = current ? selectableModels.findIndex(model => model.identifier === current.modelIdentifier) : -1;
		const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % selectableModels.length;
		const nextModel = selectableModels[nextIndex];
		const nextSelection = this.toSelection(location, nextModel.identifier, Date.now(), normalizeVSCloneThreadId(threadId));
		if (!nextSelection) {
			return undefined;
		}

		await this.setSelectionForThread(threadId, nextSelection);
		return nextSelection;
	}

	async resetSelectionForThread(threadId: string): Promise<void> {
		await this.initialize();

		const normalizedThreadId = normalizeVSCloneThreadId(threadId);
		if (!normalizedThreadId) {
			return;
		}

		const currentState = cloneSelectionState(this.backendService.getSelectionState());
		const previous = currentState.selectedByThread[normalizedThreadId];
		if (!previous) {
			return;
		}

		delete currentState.selectedByThread[normalizedThreadId];
		await this.backendService.replaceSelectionState(currentState);

		this._onDidChangeSelection.fire({
			threadId: normalizedThreadId,
			previous,
			current: this.getCurrentSelectionForThread(normalizedThreadId, previous.location),
			reason: 'reset',
		});
	}

	hasSelectionForThread(threadId: string): boolean {
		const normalizedThreadId = normalizeVSCloneThreadId(threadId);
		if (!normalizedThreadId) {
			return false;
		}

		return !!this.backendService.getSelectionState().selectedByThread[normalizedThreadId];
	}

	getRecentModelIdentifiers(limit = 3): readonly string[] {
		return this.backendService.getSelectionState().recentModelIdentifiers.slice(0, Math.max(0, limit));
	}

	private async reconcileSelections(reason: 'restore' | 'fallback'): Promise<void> {
		if (!this.initialized) {
			return;
		}

		const catalogState = this.catalogService.getState();
		if (catalogState.status !== 'ready') {
			return;
		}

		const currentState = cloneSelectionState(this.backendService.getSelectionState());
		const nextState = cloneSelectionState(currentState);
		let changed = false;
		const changedEvents: IVSCloneModelSelectionChangeEvent[] = [];

		nextState.recentModelIdentifiers = nextState.recentModelIdentifiers.filter(identifier => !!this.catalogService.getModel(identifier));

		for (const location of allVSCloneChatLocations) {
			const existing = nextState.selectedByLocation[location];
			if (existing && this.isSelectableModelIdentifier(existing.modelIdentifier) && !this.shouldReplaceLocationSelection(location, existing.modelIdentifier, existing.reasoningEffort)) {
				continue;
			}

			const fallback = this.getFallbackSelection(location);
			if (fallback) {
				nextState.selectedByLocation[location] = { ...fallback, threadId: undefined };
				if (!isEqualSelection(existing, fallback)) {
					changed = true;
					changedEvents.push({
						threadId: undefined,
						previous: existing,
						current: fallback,
						reason,
					});
				}
			} else if (existing) {
				delete nextState.selectedByLocation[location];
				changed = true;
				changedEvents.push({
					threadId: undefined,
					previous: existing,
					current: undefined,
					reason,
				});
			}
		}

		for (const [threadId, selection] of Object.entries(nextState.selectedByThread)) {
			if (this.isSelectableModelIdentifier(selection.modelIdentifier)) {
				continue;
			}

			const locationFallback = nextState.selectedByLocation[selection.location];
			if (!locationFallback) {
				delete nextState.selectedByThread[threadId];
				changed = true;
				changedEvents.push({
					threadId,
					previous: selection,
					current: undefined,
					reason,
				});
				continue;
			}

			const next = {
				...locationFallback,
				threadId,
				selectedAt: Date.now(),
			};
			nextState.selectedByThread[threadId] = { ...next, threadId: undefined };
			changed = true;
			changedEvents.push({
				threadId,
				previous: selection,
				current: next,
				reason,
			});
		}

		if (!changed) {
			return;
		}

		await this.backendService.replaceSelectionState(nextState);
		for (const event of changedEvents) {
			this._onDidChangeSelection.fire(event);
		}
	}

	private toSelection(
		location: IVSCloneChatLocation,
		modelIdentifier: string,
		selectedAt: number,
		threadId?: string,
		reasoningEffort?: VSCloneReasoningEffortLevel,
	): IVSCloneModelSelection | undefined {
		const model = this.catalogService.getModel(modelIdentifier);
		if (!model || !model.isSelectable) {
			return undefined;
		}

		return {
			threadId,
			location,
			modelIdentifier: model.identifier,
			vendor: model.vendor,
			modelId: model.modelId,
			modelName: model.modelName,
			reasoningEffort: this.normalizeReasoningEffort(model, reasoningEffort),
			selectedAt,
		};
	}

	private normalizeReasoningEffort(model: IVSCloneModelCatalogModelDescriptor, requested: VSCloneReasoningEffortLevel | undefined): VSCloneReasoningEffortLevel | undefined {
		if (!model.reasoningEffortLevels || model.reasoningEffortLevels.length === 0) {
			return undefined;
		}

		if (requested && isVSCloneReasoningEffortLevel(requested) && model.reasoningEffortLevels.includes(requested)) {
			return requested;
		}

		return model.defaultReasoningEffort ?? model.reasoningEffortLevels[0];
	}

	/**
	 * Inline completions optimize for time-to-first-token, so the Spark fallback stays on the
	 * lightest supported reasoning level even though the catalog default is tuned for chat quality.
	 */
	private getPreferredReasoningEffortForLocation(location: IVSCloneChatLocation, model: IVSCloneModelCatalogModelDescriptor): VSCloneReasoningEffortLevel | undefined {
		if (location === 'editorInline' && model.identifier === preferredEditorInlineFallbackIdentifier && model.reasoningEffortLevels?.includes(preferredEditorInlineReasoningEffort)) {
			return preferredEditorInlineReasoningEffort;
		}

		return model.defaultReasoningEffort ?? model.reasoningEffortLevels?.[0];
	}

	private isSelectableModelIdentifier(identifier: string): boolean {
		const model = this.catalogService.getModel(identifier);
		return !!model && model.isSelectable;
	}

	/**
	 * Inline completions are latency-sensitive enough that the lighter Spark model is a better
	 * default. This also migrates the previous editor-inline fallback so existing users pick up the
	 * faster path without needing a dedicated UI control for inline model selection.
	 */
	private shouldReplaceLocationSelection(location: IVSCloneChatLocation, modelIdentifier: string, reasoningEffort: VSCloneReasoningEffortLevel | undefined): boolean {
		if (location !== 'editorInline' || !this.isSelectableModelIdentifier(preferredEditorInlineFallbackIdentifier)) {
			return false;
		}

		if (modelIdentifier === legacyEditorInlineFallbackIdentifier) {
			return true;
		}

		if (modelIdentifier !== preferredEditorInlineFallbackIdentifier) {
			return false;
		}

		const preferredInlineModel = this.catalogService.getModel(preferredEditorInlineFallbackIdentifier);
		return !!preferredInlineModel && reasoningEffort !== this.getPreferredReasoningEffortForLocation(location, preferredInlineModel);
	}

	private getPreferredFallbackModel(location: IVSCloneChatLocation): IVSCloneModelCatalogModelDescriptor | undefined {
		if (location === 'editorInline') {
			const preferredInlineModel = this.catalogService.getModel(preferredEditorInlineFallbackIdentifier);
			if (preferredInlineModel?.isSelectable) {
				return preferredInlineModel;
			}
		}

		return this.catalogService.getSelectableModels()[0];
	}

	private getFallbackSelection(location: IVSCloneChatLocation, threadId?: string): IVSCloneModelSelection | undefined {
		const fallback = this.getPreferredFallbackModel(location);
		if (!fallback) {
			return undefined;
		}

		return {
			threadId,
			location,
			modelIdentifier: fallback.identifier,
			vendor: fallback.vendor,
			modelId: fallback.modelId,
			modelName: fallback.modelName,
			reasoningEffort: this.getPreferredReasoningEffortForLocation(location, fallback),
			selectedAt: Date.now(),
		};
	}
}

export class VSCloneNoopThreadModelSelectionService implements IVSCloneThreadModelSelectionService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeSelection = Event.None;

	async initialize(): Promise<void> {
		return;
	}

	getCurrentSelectionForThread(threadId: string, location: IVSCloneChatLocation): IVSCloneModelSelection | undefined {
		return undefined;
	}

	async setSelectionForThread(threadId: string, selection: IVSCloneModelSelection): Promise<void> {
		return;
	}

	async switchToNextModel(threadId: string, location: IVSCloneChatLocation): Promise<IVSCloneModelSelection | undefined> {
		return undefined;
	}

	async resetSelectionForThread(threadId: string): Promise<void> {
		return;
	}

	hasSelectionForThread(threadId: string): boolean {
		return false;
	}

	getRecentModelIdentifiers(limit = 3): readonly string[] {
		return [];
	}
}
