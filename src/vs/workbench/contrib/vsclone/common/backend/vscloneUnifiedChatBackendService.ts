/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Delayer } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import {
	VSCloneChatHistoryEnabledSetting,
	VSCloneChatHistoryMaxThreadsSetting,
	VSCloneChatHistoryMaxTurnsPerThreadSetting,
	VSCloneChatHistoryPersistScopeSetting,
	VSCloneChatHistoryRedactSecretsSetting,
	VSCloneChatHistoryRetentionDaysSetting,
} from '../vscloneChatHistorySettings.js';
import { VSCloneChatHistoryModel } from './vscloneChatHistoryModel.js';
import { VSCloneChatHistoryStore } from './vscloneChatHistoryStore.js';
import {
	type IVSCloneChatHistoryChangeEvent,
	type IVSCloneChatHistoryQuery,
	type IVSCloneChatHistoryThread,
	type IVSCloneChatHistoryTurn,
	type IVSCloneChatTurnUpdate,
	type VSCloneChatHistoryScope,
} from '../vscloneChatHistoryTypes.js';
import { reduceThreadTurns } from './vscloneChatHistoryStateMachine.js';
import type { IVSCloneUnifiedChatSelectionState } from '../vscloneModelSelectionTypes.js';
import type { IVSCloneUnifiedChatPlanModeState } from '../vsclonePlanModeTypes.js';

export const IVSCloneUnifiedChatBackendService = createDecorator<IVSCloneUnifiedChatBackendService>('vscloneUnifiedChatBackendService');

export interface IVSCloneUnifiedChatBackendService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<IVSCloneChatHistoryChangeEvent>;
	initialize(): Promise<void>;
	getThreads(query?: IVSCloneChatHistoryQuery): readonly IVSCloneChatHistoryThread[];
	getTurns(threadId: string): readonly IVSCloneChatHistoryTurn[];
	applyTurnUpdate(update: IVSCloneChatTurnUpdate): void;
	archiveThread(threadId: string, archived: boolean): Promise<void>;
	deleteThread(threadId: string): Promise<void>;
	clearAll(scope: VSCloneChatHistoryScope): Promise<void>;
	getSelectionState(): IVSCloneUnifiedChatSelectionState;
	replaceSelectionState(state: IVSCloneUnifiedChatSelectionState): Promise<void>;
	getPlanModeState(): IVSCloneUnifiedChatPlanModeState;
	replacePlanModeState(state: IVSCloneUnifiedChatPlanModeState): Promise<void>;
}

function normalizeScope(scope: string | undefined): VSCloneChatHistoryScope {
	return scope === 'profile' ? 'profile' : 'workspace';
}

function toError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}
	return new Error(String(error));
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

function cloneSelectionState(state: IVSCloneUnifiedChatSelectionState): IVSCloneUnifiedChatSelectionState {
	return {
		selectedByThread: Object.fromEntries(Object.entries(state.selectedByThread).map(([threadId, selection]) => [threadId, { ...selection, threadId: undefined }])),
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
 * This service is the single owner of durable VSClone conversation state. History and model
 * selection facades both delegate here so the selected model used for execution cannot drift away
 * from the thread snapshot restored in the UI.
 */
export class VSCloneUnifiedChatBackendService extends Disposable implements IVSCloneUnifiedChatBackendService {
	declare readonly _serviceBrand: undefined;

	private readonly model = new VSCloneChatHistoryModel();
	private readonly store: VSCloneChatHistoryStore;
	private readonly persistDelayer = this._register(new Delayer<void>(300));

	private readonly _onDidChange = this._register(new Emitter<IVSCloneChatHistoryChangeEvent>());
	readonly onDidChange = this._onDidChange.event;

	private initialized = false;
	private disabled = false;
	private initializing: Promise<void> | undefined;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();

		this.store = this._register(instantiationService.createInstance(VSCloneChatHistoryStore));
	}

	private get enabled(): boolean {
		return this.configurationService.getValue<boolean>(VSCloneChatHistoryEnabledSetting) ?? true;
	}

	private get persistScope(): VSCloneChatHistoryScope {
		return normalizeScope(this.configurationService.getValue<string>(VSCloneChatHistoryPersistScopeSetting));
	}

	private get maxThreads(): number {
		return Math.max(1, this.configurationService.getValue<number>(VSCloneChatHistoryMaxThreadsSetting) ?? 200);
	}

	private get maxTurnsPerThread(): number {
		return Math.max(1, this.configurationService.getValue<number>(VSCloneChatHistoryMaxTurnsPerThreadSetting) ?? 100);
	}

	private get retentionDays(): number {
		return Math.max(1, this.configurationService.getValue<number>(VSCloneChatHistoryRetentionDaysSetting) ?? 30);
	}

	private get redactSecrets(): boolean {
		return this.configurationService.getValue<boolean>(VSCloneChatHistoryRedactSecretsSetting) ?? true;
	}

	async initialize(): Promise<void> {
		if (this.initialized || this.disabled || !this.enabled) {
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

	getThreads(query: IVSCloneChatHistoryQuery = {}): readonly IVSCloneChatHistoryThread[] {
		if (!this.initialized || this.disabled || !this.enabled) {
			return [];
		}

		const normalizedQuery: IVSCloneChatHistoryQuery = {
			...query,
			limit: Math.min(query.limit ?? this.maxThreads, this.maxThreads),
		};

		return this.model.getThreads(normalizedQuery);
	}

	getTurns(threadId: string): readonly IVSCloneChatHistoryTurn[] {
		if (!this.initialized || this.disabled || !this.enabled) {
			return [];
		}

		return this.model.getTurns(threadId);
	}

	applyTurnUpdate(update: IVSCloneChatTurnUpdate): void {
		if (!this.enabled || !this.initialized || this.disabled) {
			return;
		}

		const previous = this.model.getThreadState(update.threadId);
		const transition = reduceThreadTurns(previous.thread, previous.turns, update, {
			sessionResource: update.sessionResource,
			maxTurnsPerThread: this.maxTurnsPerThread,
		});

		this.model.setThreadState(transition.thread, transition.turns);

		const retention = this.model.applyRetention(this.maxThreads, this.retentionDays, Date.now());
		const changedThreadIds = [update.threadId, ...retention.deletedThreadIds.filter(id => id !== update.threadId)];

		this._onDidChange.fire({
			reason: 'turnUpdate',
			scope: this.persistScope,
			threadIds: changedThreadIds,
		});

		if (update.phase === 'stream') {
			this.schedulePersist();
		} else {
			void this.persistNow();
		}
	}

	async archiveThread(threadId: string, archived: boolean): Promise<void> {
		if (!this.enabled || !this.initialized || this.disabled) {
			return;
		}

		const thread = this.model.archiveThread(threadId, archived);
		if (!thread) {
			return;
		}

		this._onDidChange.fire({ reason: 'archive', scope: this.persistScope, threadIds: [threadId] });
		await this.persistNow();
	}

	async deleteThread(threadId: string): Promise<void> {
		if (!this.enabled || !this.initialized || this.disabled) {
			return;
		}

		const deleted = this.model.deleteThread(threadId);
		if (!deleted) {
			return;
		}

		this._onDidChange.fire({ reason: 'delete', scope: this.persistScope, threadIds: [threadId] });
		await this.persistNow();
	}

	async clearAll(scope: VSCloneChatHistoryScope): Promise<void> {
		const normalizedScope = normalizeScope(scope);

		if (normalizedScope === this.persistScope && this.initialized) {
			this.model.clear();
			this._onDidChange.fire({ reason: 'clear', scope: normalizedScope, threadIds: [] });
		}

		await this.store.clear(normalizedScope);
	}

	getSelectionState(): IVSCloneUnifiedChatSelectionState {
		if (!this.initialized || this.disabled || !this.enabled) {
			return createEmptySelectionState();
		}

		return cloneSelectionState(this.model.getSelectionState());
	}

	getPlanModeState(): IVSCloneUnifiedChatPlanModeState {
		if (!this.initialized || this.disabled || !this.enabled) {
			return createEmptyPlanModeState();
		}

		return clonePlanModeState(this.model.getPlanModeState());
	}

	async replaceSelectionState(state: IVSCloneUnifiedChatSelectionState): Promise<void> {
		if (!this.enabled || this.disabled) {
			return;
		}

		await this.initialize();
		if (!this.initialized || this.disabled) {
			return;
		}

		this.model.replaceSelectionState(cloneSelectionState(state));
		await this.persistNow();
	}

	async replacePlanModeState(state: IVSCloneUnifiedChatPlanModeState): Promise<void> {
		if (!this.enabled || this.disabled) {
			return;
		}

		await this.initialize();
		if (!this.initialized || this.disabled) {
			return;
		}

		this.model.replacePlanModeState(clonePlanModeState(state));
		await this.persistNow();
	}

	private async doInitialize(): Promise<void> {
		try {
			const snapshot = await this.store.load(this.persistScope);
			this.model.initialize(snapshot);

			const retention = this.model.applyRetention(this.maxThreads, this.retentionDays, Date.now());
			if (retention.deletedThreadIds.length > 0) {
				await this.persistNow();
			}

			this.initialized = true;
			this._onDidChange.fire({
				reason: 'initialize',
				scope: this.persistScope,
				threadIds: this.model.getThreads({ includeArchived: true }).map(thread => thread.threadId),
			});
		} catch (error) {
			const err = toError(error);
			this.logService.error('Failed to initialize VSClone chat history', error);
			this.notificationService.warn(localize(
				'vsclone.history.initializeFailed',
				'VSClone chat history could not be restored from storage.'
			));
			this._onDidChange.fire({ reason: 'error', scope: this.persistScope, threadIds: [], error: err });
			throw err;
		}
	}

	private schedulePersist(): void {
		void this.persistDelayer.trigger(() => this.persistNow());
	}

	private async persistNow(): Promise<void> {
		if (!this.enabled || !this.initialized || this.disabled) {
			return;
		}

		try {
			const snapshot = this.model.toSnapshot(Date.now());
			await this.store.save(this.persistScope, snapshot, {
				redactSecrets: this.redactSecrets,
			});
		} catch (error) {
			const err = toError(error);
			this.logService.error('Failed to persist VSClone chat history', error);
			this._onDidChange.fire({ reason: 'error', scope: this.persistScope, threadIds: [], error: err });
		}
	}
}
