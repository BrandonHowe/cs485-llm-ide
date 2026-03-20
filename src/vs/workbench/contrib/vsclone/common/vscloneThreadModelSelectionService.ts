/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IVSCloneModelCatalogService, isVSCloneReasoningEffortLevel, type IVSCloneModelCatalogModelDescriptor, type VSCloneReasoningEffortLevel } from './vscloneModelCatalogService.js';
import { VSCloneModelVendor } from './vscloneOAuthTypes.js';

export const IVSCloneThreadModelSelectionService = createDecorator<IVSCloneThreadModelSelectionService>('vsCloneThreadModelSelectionService');

export type IVSCloneChatLocation = 'chat' | 'editorInline' | 'notebook' | 'terminal';

export interface IVSCloneModelSelection {
	threadId?: string;
	location: IVSCloneChatLocation;
	modelIdentifier: string;
	vendor: VSCloneModelVendor;
	modelId: string;
	modelName: string;
	reasoningEffort?: VSCloneReasoningEffortLevel;
	selectedAt: number;
}

export interface IVSCloneModelSelectionChangeEvent {
	threadId?: string;
	previous: IVSCloneModelSelection | undefined;
	current: IVSCloneModelSelection | undefined;
	reason: 'user' | 'restore' | 'fallback' | 'reset';
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

interface ISelectionStorage {
	version: 1;
	selectedByThread: Record<string, IVSCloneModelSelection>;
	selectedByLocation: Partial<Record<IVSCloneChatLocation, IVSCloneModelSelection>>;
	recentModelIdentifiers: string[];
}

const selectionStorageKey = 'vsclone.modelSwitcher.selection.v1';
const maxRecentModelIdentifiers = 8;

const allLocations: readonly IVSCloneChatLocation[] = ['chat', 'editorInline', 'notebook', 'terminal'];

function isVSCloneModelVendor(value: string): value is VSCloneModelVendor {
	switch (value) {
		case 'openai':
		case 'anthropic':
		case 'google':
			return true;
		default:
			return false;
	}
}

function normalizeThreadId(threadId: string): string | undefined {
	const normalized = threadId.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function parseStorage(raw: string | undefined): ISelectionStorage | undefined {
	if (!raw) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(raw) as Partial<ISelectionStorage>;
		if (!parsed || parsed.version !== 1) {
			return undefined;
		}

		return {
			version: 1,
			selectedByThread: typeof parsed.selectedByThread === 'object' && parsed.selectedByThread ? parsed.selectedByThread : {},
			selectedByLocation: typeof parsed.selectedByLocation === 'object' && parsed.selectedByLocation ? parsed.selectedByLocation : {},
			recentModelIdentifiers: Array.isArray(parsed.recentModelIdentifiers) ? parsed.recentModelIdentifiers.filter(value => typeof value === 'string') : [],
		};
	} catch {
		return undefined;
	}
}

function toStorageShape(
	selectedByThread: Map<string, IVSCloneModelSelection>,
	selectedByLocation: Map<IVSCloneChatLocation, IVSCloneModelSelection>,
	recentModelIdentifiers: readonly string[],
): ISelectionStorage {
	const threadSelections: Record<string, IVSCloneModelSelection> = {};
	for (const [threadId, selection] of selectedByThread) {
		threadSelections[threadId] = { ...selection, threadId: undefined };
	}

	const locationSelections: Partial<Record<IVSCloneChatLocation, IVSCloneModelSelection>> = {};
	for (const [location, selection] of selectedByLocation) {
		locationSelections[location] = { ...selection, threadId: undefined };
	}

	return {
		version: 1,
		selectedByThread: threadSelections,
		selectedByLocation: locationSelections,
		recentModelIdentifiers: [...recentModelIdentifiers],
	};
}

export class VSCloneThreadModelSelectionService extends Disposable implements IVSCloneThreadModelSelectionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSelection = this._register(new Emitter<IVSCloneModelSelectionChangeEvent>());
	readonly onDidChangeSelection = this._onDidChangeSelection.event;

	private readonly selectedByThread = new Map<string, IVSCloneModelSelection>();
	private readonly selectedByLocation = new Map<IVSCloneChatLocation, IVSCloneModelSelection>();
	private recentModelIdentifiers: string[] = [];
	private initialized = false;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IVSCloneModelCatalogService private readonly catalogService: IVSCloneModelCatalogService,
	) {
		super();

		this._register(this.catalogService.onDidChangeCatalog(() => {
			this.reconcileSelections('fallback');
		}));
	}

	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		const parsed = parseStorage(this.storageService.get(selectionStorageKey, StorageScope.PROFILE));
		if (parsed) {
			for (const [threadId, selection] of Object.entries(parsed.selectedByThread)) {
				const normalized = this.toSelectionFromStorage(selection);
				if (!normalized) {
					continue;
				}
				this.selectedByThread.set(threadId, normalized);
			}

			for (const location of allLocations) {
				const selection = parsed.selectedByLocation[location];
				const normalized = this.toSelectionFromStorage(selection);
				if (!normalized) {
					continue;
				}
				this.selectedByLocation.set(location, normalized);
			}

			this.recentModelIdentifiers = parsed.recentModelIdentifiers.slice(0, maxRecentModelIdentifiers);
		}

		this.initialized = true;
		this.reconcileSelections('restore');
	}

	getCurrentSelectionForThread(threadId: string, location: IVSCloneChatLocation): IVSCloneModelSelection | undefined {
		const normalizedThreadId = normalizeThreadId(threadId);
		const threadSelection = normalizedThreadId ? this.selectedByThread.get(normalizedThreadId) : undefined;
		if (threadSelection && this.isSelectableModelIdentifier(threadSelection.modelIdentifier)) {
			return this.toSelection(
				threadSelection.location,
				threadSelection.modelIdentifier,
				threadSelection.selectedAt,
				normalizedThreadId,
				threadSelection.reasoningEffort,
			);
		}

		const locationSelection = this.selectedByLocation.get(location);
		if (locationSelection && this.isSelectableModelIdentifier(locationSelection.modelIdentifier)) {
			return this.toSelection(
				locationSelection.location,
				locationSelection.modelIdentifier,
				locationSelection.selectedAt,
				normalizedThreadId,
				locationSelection.reasoningEffort,
			);
		}

		const fallback = this.getFallbackSelection(location, normalizedThreadId);
		if (!fallback) {
			return undefined;
		}
		return fallback;
	}

	async setSelectionForThread(threadId: string, selection: IVSCloneModelSelection): Promise<void> {
		await this.initialize();

		const normalizedThreadId = normalizeThreadId(threadId);
		const normalizedSelection = this.toSelection(selection.location, selection.modelIdentifier, Date.now(), normalizedThreadId, selection.reasoningEffort);
		if (!normalizedSelection) {
			return;
		}

		const previous = normalizedThreadId ? this.selectedByThread.get(normalizedThreadId) : this.selectedByLocation.get(selection.location);
		if (normalizedThreadId) {
			this.selectedByThread.set(normalizedThreadId, { ...normalizedSelection, threadId: undefined });
		}
		this.selectedByLocation.set(selection.location, { ...normalizedSelection, threadId: undefined });
		this.touchRecentModelIdentifier(normalizedSelection.modelIdentifier);
		this.store();

		this._onDidChangeSelection.fire({
			threadId: normalizedThreadId,
			previous,
			current: normalizedSelection,
			reason: 'user',
		});
	}

	hasSelectionForThread(threadId: string): boolean {
		const normalizedThreadId = normalizeThreadId(threadId);
		if (!normalizedThreadId) {
			return false;
		}
		return this.selectedByThread.has(normalizedThreadId);
	}

	getRecentModelIdentifiers(limit = 3): readonly string[] {
		return this.recentModelIdentifiers.slice(0, Math.max(0, limit));
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
		const nextSelection = this.toSelection(location, nextModel.identifier, Date.now(), normalizeThreadId(threadId));
		if (!nextSelection) {
			return undefined;
		}

		await this.setSelectionForThread(threadId, nextSelection);
		return nextSelection;
	}

	async resetSelectionForThread(threadId: string): Promise<void> {
		await this.initialize();

		const normalizedThreadId = normalizeThreadId(threadId);
		if (!normalizedThreadId) {
			return;
		}

		const previous = this.selectedByThread.get(normalizedThreadId);
		if (!previous) {
			return;
		}

		this.selectedByThread.delete(normalizedThreadId);
		this.store();

		this._onDidChangeSelection.fire({
			threadId: normalizedThreadId,
			previous,
			current: this.getCurrentSelectionForThread(normalizedThreadId, previous.location),
			reason: 'reset',
		});
	}

	private touchRecentModelIdentifier(identifier: string): void {
		this.recentModelIdentifiers = [
			identifier,
			...this.recentModelIdentifiers.filter(value => value !== identifier),
		].slice(0, maxRecentModelIdentifiers);
	}

	private toSelectionFromStorage(selection: unknown): IVSCloneModelSelection | undefined {
		if (!selection || typeof selection !== 'object') {
			return undefined;
		}

		const value = selection as IVSCloneModelSelection;
		if (!allLocations.includes(value.location) || typeof value.modelIdentifier !== 'string') {
			return undefined;
		}

		const [derivedVendor = '', derivedModelId = ''] = value.modelIdentifier.split('/');
		const parsedReasoningEffort = typeof value.reasoningEffort === 'string' && isVSCloneReasoningEffortLevel(value.reasoningEffort)
			? value.reasoningEffort
			: undefined;
		const model = this.catalogService.getModel(value.modelIdentifier);
		return {
			threadId: undefined,
			location: value.location,
			modelIdentifier: value.modelIdentifier,
			vendor: isVSCloneModelVendor(value.vendor) ? value.vendor : isVSCloneModelVendor(derivedVendor) ? derivedVendor : model?.vendor ?? 'openai',
			modelId: typeof value.modelId === 'string' && value.modelId.length > 0 ? value.modelId : derivedModelId,
			modelName: typeof value.modelName === 'string' && value.modelName.length > 0 ? value.modelName : derivedModelId,
			reasoningEffort: model ? this.normalizeReasoningEffort(model, parsedReasoningEffort) : parsedReasoningEffort,
			selectedAt: typeof value.selectedAt === 'number' ? value.selectedAt : Date.now(),
		};
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

		// Keep user intent when it matches the model contract, otherwise fall back to the model default.
		if (requested && model.reasoningEffortLevels.includes(requested)) {
			return requested;
		}

		return model.defaultReasoningEffort ?? model.reasoningEffortLevels[0];
	}

	private isSelectableModelIdentifier(identifier: string): boolean {
		const model = this.catalogService.getModel(identifier);
		return !!model && model.isSelectable;
	}

	private getFallbackSelection(location: IVSCloneChatLocation, threadId?: string): IVSCloneModelSelection | undefined {
		const fallback = this.catalogService.getSelectableModels()[0];
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
			reasoningEffort: fallback.defaultReasoningEffort ?? fallback.reasoningEffortLevels?.[0],
			selectedAt: Date.now(),
		};
	}

	private reconcileSelections(reason: 'restore' | 'fallback'): void {
		if (!this.initialized) {
			return;
		}
		const catalogState = this.catalogService.getState();
		if (catalogState.status !== 'ready') {
			return;
		}

		let changed = false;
		const changedEvents: IVSCloneModelSelectionChangeEvent[] = [];

		this.recentModelIdentifiers = this.recentModelIdentifiers.filter(identifier => !!this.catalogService.getModel(identifier));

		for (const location of allLocations) {
			const existing = this.selectedByLocation.get(location);
			if (existing && this.isSelectableModelIdentifier(existing.modelIdentifier)) {
				continue;
			}

			const fallback = this.getFallbackSelection(location);
			if (fallback) {
				this.selectedByLocation.set(location, { ...fallback, threadId: undefined });
				if (existing?.modelIdentifier !== fallback.modelIdentifier) {
					changed = true;
					changedEvents.push({
						threadId: undefined,
						previous: existing,
						current: fallback,
						reason,
					});
				}
			} else if (existing) {
				this.selectedByLocation.delete(location);
				changed = true;
				changedEvents.push({
					threadId: undefined,
					previous: existing,
					current: undefined,
					reason,
				});
			}
		}

		for (const [threadId, selection] of [...this.selectedByThread]) {
			if (this.isSelectableModelIdentifier(selection.modelIdentifier)) {
				continue;
			}

			const locationFallback = this.selectedByLocation.get(selection.location);
			if (!locationFallback) {
				this.selectedByThread.delete(threadId);
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
			this.selectedByThread.set(threadId, { ...next, threadId: undefined });
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

		this.store();
		for (const event of changedEvents) {
			this._onDidChangeSelection.fire(event);
		}
	}

	private store(): void {
		const serialized = JSON.stringify(toStorageShape(this.selectedByThread, this.selectedByLocation, this.recentModelIdentifiers));
		this.storageService.store(selectionStorageKey, serialized, StorageScope.PROFILE, StorageTarget.USER);
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
