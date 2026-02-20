/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Delayer } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { VSCloneUnsupportedHistoryVersionError } from './vscloneChatHistoryMigrationService.js';
import { VSCloneChatHistoryModel } from './vscloneChatHistoryModel.js';
import { VSCloneChatHistoryStore } from './vscloneChatHistoryStore.js';
import { reduceThreadTurns } from './vscloneChatHistoryStateMachine.js';

export const VSCloneChatHistoryEnabledSetting = 'vsclone.chatHistory.enabled';
export const VSCloneChatHistoryMaxThreadsSetting = 'vsclone.chatHistory.maxThreads';
export const VSCloneChatHistoryMaxTurnsPerThreadSetting = 'vsclone.chatHistory.maxTurnsPerThread';
export const VSCloneChatHistoryRetentionDaysSetting = 'vsclone.chatHistory.retentionDays';
export const VSCloneChatHistoryRailWidthSetting = 'vsclone.chatHistory.railWidth';
export const VSCloneChatHistoryPersistScopeSetting = 'vsclone.chatHistory.persistScope';
export const VSCloneChatHistoryRedactSecretsSetting = 'vsclone.chatHistory.redactSecrets';

export const IVSCloneChatHistoryService = createDecorator<IVSCloneChatHistoryService>('vscloneChatHistoryService');

export type VSCloneChatHistoryScope = 'workspace' | 'profile';

export type VSCloneChatThreadStatus = 'active' | 'completed' | 'failed' | 'archived';
export type VSCloneChatTurnStatus = 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';

export interface IVSCloneChatHistoryThread {
	threadId: string;
	sessionResource: string;
	title: string;
	activeModelIdentifier?: string;
	createdAt: number;
	updatedAt: number;
	status: VSCloneChatThreadStatus;
	archived: boolean;
	turnCount: number;
	lastTurnPreview: string;
}

export interface IVSCloneChatHistoryTurn {
	turnId: string;
	threadId: string;
	sequence: number;
	modelIdentifier?: string;
	providerId?: string;
	promptText: string;
	responseMarkdown: string;
	responsePlainText: string;
	startedAt: number;
	completedAt?: number;
	status: VSCloneChatTurnStatus;
	errorCode?: string;
	lastEventAt?: number;
}

export interface IVSCloneChatHistorySnapshot {
	updatedAt: number;
	threads: readonly IVSCloneChatHistoryThread[];
	turnsByThreadId: Record<string, readonly IVSCloneChatHistoryTurn[]>;
}

export type VSCloneChatHistoryTab = 'all' | 'active' | 'archived';

export interface IVSCloneChatHistoryQuery {
	text?: string;
	tab?: VSCloneChatHistoryTab;
	includeArchived?: boolean;
	fromTimestamp?: number;
	toTimestamp?: number;
	limit?: number;
}

export type VSCloneChatTurnPhase = 'prompt' | 'stream' | 'complete' | 'error' | 'cancel';

export interface IVSCloneChatTurnUpdate {
	threadId: string;
	turnId: string;
	sequence: number;
	sessionResource: string;
	phase: VSCloneChatTurnPhase;
	occurredAt: number;
	promptText?: string;
	threadTitle?: string;
	modelIdentifier?: string;
	providerId?: string;
	responseMarkdownDelta?: string;
	responsePlainTextDelta?: string;
	responseMarkdownReplace?: string;
	responsePlainTextReplace?: string;
	errorCode?: string;
}

export interface IVSCloneChatHistoryChangeEvent {
	reason: 'initialize' | 'turnUpdate' | 'archive' | 'delete' | 'clear' | 'error';
	scope: VSCloneChatHistoryScope;
	threadIds: readonly string[];
	error?: Error;
}

export interface IVSCloneChatHistoryService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<IVSCloneChatHistoryChangeEvent>;
	initialize(): Promise<void>;
	getThreads(query?: IVSCloneChatHistoryQuery): readonly IVSCloneChatHistoryThread[];
	getTurns(threadId: string): readonly IVSCloneChatHistoryTurn[];
	applyTurnUpdate(update: IVSCloneChatTurnUpdate): void;
	archiveThread(threadId: string, archived: boolean): Promise<void>;
	deleteThread(threadId: string): Promise<void>;
	clearAll(scope: VSCloneChatHistoryScope): Promise<void>;
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

export class VSCloneChatHistoryService extends Disposable implements IVSCloneChatHistoryService {
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
			if (error instanceof VSCloneUnsupportedHistoryVersionError) {
				this.disabled = true;
				this.notificationService.warn(localize(
					'vsclone.history.unsupportedVersion',
					"VSClone chat history is temporarily disabled because the stored format is not supported."
				));
				this.logService.warn('VSClone chat history disabled due to unsupported schema version', error);
				this._onDidChange.fire({ reason: 'error', scope: this.persistScope, threadIds: [], error: err });
				return;
			}

			this.logService.error('Failed to initialize VSClone chat history', error);
			this._onDidChange.fire({ reason: 'error', scope: this.persistScope, threadIds: [], error: err });
			throw err;
		}
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
