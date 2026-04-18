/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { IVSCloneModelSelection, IVSCloneThreadSelectionMap, IVSCloneUnifiedChatSelectionState } from '../vscloneModelSelectionTypes.js';
import type { IVSCloneUnifiedChatPlanModeState } from '../vsclonePlanModeTypes.js';
import { VSCloneUnifiedChatStateStore } from './vscloneUnifiedChatStateStore.js';

export const IVSCloneUnifiedChatBackendService = createDecorator<IVSCloneUnifiedChatBackendService>('vscloneUnifiedChatBackendService');

/**
 * Fires when persisted selection or plan-mode state changes, gets initialized, or fails to persist.
 * Consumers treat `error` as "the backend state may be empty, surface an appropriate UX" and the
 * other reasons as "reload selection/plan caches from this service."
 */
export interface IVSCloneUnifiedChatBackendChangeEvent {
	readonly reason: 'initialize' | 'update' | 'clear' | 'error';
	readonly error?: Error;
}

export interface IVSCloneUnifiedChatBackendService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<IVSCloneUnifiedChatBackendChangeEvent>;
	initialize(): Promise<void>;
	deleteThread(threadId: string): Promise<void>;
	clearAll(): Promise<void>;
	getSelectionState(): IVSCloneUnifiedChatSelectionState;
	replaceSelectionState(state: IVSCloneUnifiedChatSelectionState): Promise<void>;
	getPlanModeState(): IVSCloneUnifiedChatPlanModeState;
	replacePlanModeState(state: IVSCloneUnifiedChatPlanModeState): Promise<void>;
}

function createEmptySelectionState(): IVSCloneUnifiedChatSelectionState {
	return {
		selectedByThread: {},
		selectedByLocation: {},
		recentModelIdentifiers: [],
	};
}

function createEmptyPlanModeState(): IVSCloneUnifiedChatPlanModeState {
	return {
		modeByThread: {},
	};
}

function isModelSelection(value: unknown): value is IVSCloneModelSelection {
	const record = typeof value === 'object' && value !== null ? value as Partial<IVSCloneModelSelection> : undefined;
	return !!record && typeof record.location === 'string' && typeof record.modelIdentifier === 'string';
}

function cloneThreadSelectionMap(value: unknown): IVSCloneThreadSelectionMap {
	if (isModelSelection(value)) {
		return {
			[value.location]: { ...value, threadId: undefined },
		};
	}

	const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
	return Object.fromEntries(
		Object.entries(record).map(([location, selection]) => [location, isModelSelection(selection) ? { ...selection, threadId: undefined } : undefined]),
	) as IVSCloneThreadSelectionMap;
}

function cloneSelectionState(state: IVSCloneUnifiedChatSelectionState): IVSCloneUnifiedChatSelectionState {
	return {
		selectedByThread: Object.fromEntries(
			Object.entries(state.selectedByThread).map(([threadId, selections]) => [threadId, cloneThreadSelectionMap(selections)]),
		),
		selectedByLocation: Object.fromEntries(Object.entries(state.selectedByLocation).map(([location, selection]) => [location, selection ? { ...selection, threadId: undefined } : undefined])),
		recentModelIdentifiers: [...state.recentModelIdentifiers],
	};
}

function clonePlanModeState(state: IVSCloneUnifiedChatPlanModeState): IVSCloneUnifiedChatPlanModeState {
	return {
		modeByThread: { ...state.modeByThread },
	};
}

/**
 * After the runtime-first rewrite, runtime state owns conversation persistence. This service only
 * persists the small selection and plan-mode maps layered on top of runtime state, since those
 * maps are durable UI preferences per thread that outlive any single runtime message.
 */
export class VSCloneUnifiedChatBackendService extends Disposable implements IVSCloneUnifiedChatBackendService {
	declare readonly _serviceBrand: undefined;

	private readonly store: VSCloneUnifiedChatStateStore;

	private readonly _onDidChange = this._register(new Emitter<IVSCloneUnifiedChatBackendChangeEvent>());
	readonly onDidChange = this._onDidChange.event;

	private selectionState = createEmptySelectionState();
	private planModeState = createEmptyPlanModeState();
	private initialized = false;
	private initializing: Promise<void> | undefined;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService _configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@INotificationService _notificationService: INotificationService,
	) {
		super();

		this.store = this._register(instantiationService.createInstance(VSCloneUnifiedChatStateStore));
	}

	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		if (this.initializing) {
			return this.initializing;
		}

		this.initializing = this.doInitialize().finally(() => {
			this.initializing = undefined;
		});

		return this.initializing;
	}

	async deleteThread(threadId: string): Promise<void> {
		await this.initialize();
		delete this.selectionState.selectedByThread[threadId];
		delete this.planModeState.modeByThread[threadId];
		this.persistNow();
	}

	async clearAll(): Promise<void> {
		await this.initialize();
		this.selectionState = createEmptySelectionState();
		this.planModeState = createEmptyPlanModeState();
		this.persistNow('clear');
	}

	getSelectionState(): IVSCloneUnifiedChatSelectionState {
		return cloneSelectionState(this.selectionState);
	}

	getPlanModeState(): IVSCloneUnifiedChatPlanModeState {
		return clonePlanModeState(this.planModeState);
	}

	async replaceSelectionState(state: IVSCloneUnifiedChatSelectionState): Promise<void> {
		await this.initialize();
		this.selectionState = cloneSelectionState(state);
		this.persistNow();
	}

	async replacePlanModeState(state: IVSCloneUnifiedChatPlanModeState): Promise<void> {
		await this.initialize();
		this.planModeState = clonePlanModeState(state);
		this.persistNow();
	}

	private async doInitialize(): Promise<void> {
		try {
			const snapshot = this.store.load();
			this.selectionState = cloneSelectionState(snapshot.selectionState);
			this.planModeState = clonePlanModeState(snapshot.planModeState);
			this.initialized = true;
			this._onDidChange.fire({ reason: 'initialize' });
		} catch (error) {
			// Selection and plan mode should degrade to an empty state rather than breaking chat init.
			this.selectionState = createEmptySelectionState();
			this.planModeState = createEmptyPlanModeState();
			this.initialized = true;
			this.logService.error('[VSCloneUnifiedChatBackendService] Failed to initialize unified chat state; using empty state.', error);
			this._onDidChange.fire({ reason: 'error', error: error instanceof Error ? error : new Error(String(error)) });
		}
	}

	private persistNow(reason: 'update' | 'clear' = 'update'): void {
		if (!this.initialized) {
			return;
		}

		try {
			this.store.save({
				selectionState: this.selectionState,
				planModeState: this.planModeState,
			});
			this._onDidChange.fire({ reason });
		} catch (error) {
			this.logService.error('[VSCloneUnifiedChatBackendService] Failed to persist unified chat state.', error);
			this._onDidChange.fire({ reason: 'error', error: error instanceof Error ? error : new Error(String(error)) });
		}
	}
}
