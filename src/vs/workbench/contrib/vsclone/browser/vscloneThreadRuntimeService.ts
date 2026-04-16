/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, raceTimeout } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn } from '../common/backend/vscloneChatHistoryService.js';
import { VSCloneThreadRuntimeStore } from '../common/backend/vscloneThreadRuntimeStore.js';
import type { IVSCloneApiConversationMessage } from '../common/vscloneChatApiAdapters.js';
import { formatToolResult } from '../common/vscloneToolDefinitions.js';
import {
	IVSCloneThreadRuntimeAssistantEditApplication,
	IVSCloneThreadRuntimeAssistantEditApplicationState,
	IVSCloneThreadRuntimeCatalogEntry,
	IVSCloneThreadRuntimeCatalogQuery,
	IVSCloneThreadRuntimeCheckpoint,
	IVSCloneThreadRuntimeMessage,
	IVSCloneThreadRuntimePausedApproval,
	IVSCloneThreadRuntimeRunContext,
	IVSCloneThreadRuntimeRunOptions,
	IVSCloneThreadRuntimeSnapshot,
	IVSCloneThreadRuntimeState,
	VSCloneThreadToolApprovalDecision,
} from '../common/vscloneThreadRuntimeTypes.js';
import type { VSCloneToolApprovalType } from '../common/vscloneToolRuntimeTypes.js';
import { IVSCloneAgentLoopHandle, IVSCloneAgentLoopOptions, IVSCloneAgentLoopService } from './vscloneAgentLoopService.js';
import {
	IVSCloneToolExecutionResult,
	IVSCloneToolExecutionService,
	IVSCloneToolRuntimeService,
} from './vscloneToolExecutionService.js';

export type { IVSCloneThreadRuntimeRunOptions } from '../common/vscloneThreadRuntimeTypes.js';

export const IVSCloneThreadRuntimeService = createDecorator<IVSCloneThreadRuntimeService>('vscloneThreadRuntimeService');
const defaultPersistedToolExecutionTimeoutMs = 90_000;

export interface IVSCloneThreadRuntimeHandle {
	readonly done: Promise<void>;
	cancel(): void;
}

export interface IVSCloneThreadRuntimeService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<IVSCloneThreadRuntimeState>;
	runThread(options: IVSCloneThreadRuntimeRunOptions): IVSCloneThreadRuntimeHandle;
	ensureHydratedFromHistory(threadId: string, turns: readonly IVSCloneChatHistoryTurn[]): IVSCloneThreadRuntimeState | undefined;
	ensureCatalogImportedFromHistory(thread: IVSCloneChatHistoryThread, turns?: readonly IVSCloneChatHistoryTurn[]): IVSCloneThreadRuntimeState;
	recordRejectedTurn(options: {
		threadId: string;
		turnId: string;
		promptText: string;
		mode: IVSCloneThreadRuntimeRunOptions['mode'];
		reason: string;
		imageAttachments?: IVSCloneThreadRuntimeRunOptions['imageAttachments'];
	}): void;
	cancelThread(threadId: string): void;
	approveLatestToolRequest(threadId: string): boolean;
	rejectLatestToolRequest(threadId: string, reason?: string): boolean;
	getThreads(query?: IVSCloneThreadRuntimeCatalogQuery): readonly IVSCloneThreadRuntimeCatalogEntry[];
	isDeletedThread(threadId: string): boolean;
	archiveThread(threadId: string, archived: boolean): boolean;
	deleteThread(threadId: string): boolean;
	clearAll(): void;
	getState(threadId: string): IVSCloneThreadRuntimeState | undefined;
	getAssistantEditApplicationState?(threadId: string, messageId: string): IVSCloneThreadRuntimeAssistantEditApplicationState | undefined;
	getAssistantEditApplicationStates?(threadId: string): readonly IVSCloneThreadRuntimeAssistantEditApplication[];
	setAssistantEditApplicationState?(threadId: string, messageId: string, state: IVSCloneThreadRuntimeAssistantEditApplicationState | undefined): void;
	rewindToCheckpoint(threadId: string, checkpointId: string): Promise<boolean>;
}

interface IPendingApproval {
	readonly deferred: DeferredPromise<VSCloneThreadToolApprovalDecision>;
	readonly requestedAt: number;
	readonly toolName: string;
	readonly params: Record<string, string>;
	readonly approvalType?: VSCloneToolApprovalType;
	status: 'pending' | 'approved' | 'rejected';
	snapshotPromise?: Promise<readonly IVSCloneThreadRuntimeSnapshot[]>;
}

interface IActiveThreadExecution {
	readonly handle: IVSCloneAgentLoopHandle;
	readonly pendingCheckpointByToolKey: Map<string, readonly IVSCloneThreadRuntimeSnapshot[]>;
	readonly runContext: IVSCloneThreadRuntimeRunContext;
	pendingApproval: IPendingApproval | undefined;
}

type IThreadRuntimeStore = Pick<VSCloneThreadRuntimeStore, 'loadAll' | 'loadDeletedThreadIds' | 'saveState' | 'deleteState' | 'markDeletedThread' | 'clearAll' | 'dispose'>;
type IThreadRuntimeStateDraft = Omit<IVSCloneThreadRuntimeState, 'catalog'> & { readonly catalog?: IVSCloneThreadRuntimeCatalogEntry };

/**
 * This service owns the live VSClone thread model: user/assistant/tool/checkpoint messages,
 * active branch state, and durable paused approvals. History can still exist for migration and
 * archive paths, but runtime state is the canonical conversation record.
 */
export class VSCloneThreadRuntimeService extends Disposable implements IVSCloneThreadRuntimeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<IVSCloneThreadRuntimeState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly store: IThreadRuntimeStore;
	private readonly states = new Map<string, IVSCloneThreadRuntimeState>();
	private readonly deletedThreadIds = new Set<string>();
	private readonly activeExecutions = new Map<string, IActiveThreadExecution>();

	constructor(
		@IVSCloneAgentLoopService private readonly agentLoopService: IVSCloneAgentLoopService,
		@IVSCloneToolRuntimeService private readonly toolRuntimeService: IVSCloneToolRuntimeService,
		@IVSCloneToolExecutionService private readonly toolExecutionService: IVSCloneToolExecutionService = {
			_serviceBrand: undefined,
			executeTool: async () => ({ success: false, output: 'Tool execution service is unavailable.' }),
		},
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IInstantiationService instantiationService?: IInstantiationService,
		private readonly persistedToolExecutionTimeoutMs: number = defaultPersistedToolExecutionTimeoutMs,
	) {
		super();
		this.store = instantiationService
			? this._register(instantiationService.createInstance(VSCloneThreadRuntimeStore))
			: {
				loadAll: () => [],
				loadDeletedThreadIds: () => [],
				saveState: () => undefined,
				deleteState: () => undefined,
				markDeletedThread: () => undefined,
				clearAll: () => undefined,
				dispose: () => undefined,
			};
		this.restorePersistedStates();
	}

	runThread(options: IVSCloneThreadRuntimeRunOptions): IVSCloneThreadRuntimeHandle {
		const baseState = this.states.get(options.threadId);
		const promptMessage = options.recordPromptMessage === false
			? []
			: [this.createMessage({
				role: 'user',
				mode: options.mode,
				createdAt: Date.now(),
				content: options.promptText,
				imageAttachments: options.imageAttachments,
			})];
		const nextMessages = [...(baseState?.messages ?? []), ...promptMessage];
		this.setState(options.threadId, {
			threadId: options.threadId,
			catalog: {
				threadId: options.threadId,
				sessionResource: options.sessionResource,
				title: this.truncateCatalogText(options.promptText, 120) || options.threadId,
				activeModelIdentifier: options.modelIdentifier,
				createdAt: baseState?.catalog.createdAt ?? Date.now(),
				updatedAt: Date.now(),
				status: 'active',
				archived: baseState?.catalog.archived ?? false,
				turnCount: baseState?.catalog.turnCount ?? 0,
				lastTurnPreview: baseState?.catalog.lastTurnPreview ?? '',
				importedFromHistory: baseState?.catalog.importedFromHistory,
			},
			turnId: options.turnId,
			mode: options.mode,
			streamState: { kind: 'llm' },
			messages: nextMessages,
			assistantEditApplications: baseState?.assistantEditApplications ?? [],
			checkpoints: baseState?.checkpoints ?? [],
			currentCheckpointId: baseState?.currentCheckpointId,
			branchHeadMessageId: nextMessages.at(-1)?.id ?? baseState?.branchHeadMessageId,
			pausedApproval: undefined,
			isRunning: true,
			lastUpdatedAt: Date.now(),
		});

		const runContext: IVSCloneThreadRuntimeRunContext = {
			turnId: options.turnId,
			sequence: options.sequence,
			sessionResource: options.sessionResource,
			mode: options.mode,
			vendor: options.vendor,
			modelId: options.modelId,
			modelIdentifier: options.modelIdentifier,
			reasoningEffort: options.reasoningEffort,
			systemMessage: options.systemMessage,
			imageAttachments: options.imageAttachments,
		};
		const pendingCheckpointByToolKey = new Map<string, readonly IVSCloneThreadRuntimeSnapshot[]>();
		const loopOptions: IVSCloneAgentLoopOptions = {
			...options,
			observer: {
				onResponseDelta: delta => this.recordAssistantDelta(options.threadId, delta),
				onResponseReplace: responseText => this.replaceAssistantResponse(options.threadId, responseText),
				onToolRequested: (toolName, params) => this.recordToolRequested(options.threadId, toolName, params, pendingCheckpointByToolKey, runContext),
				onToolResult: (toolName, params, result) => {
					this.recordToolResult(options.threadId, toolName, params, result, pendingCheckpointByToolKey);
				},
				onComplete: () => this.finishThread(options.threadId, { kind: 'idle' }),
				onError: message => {
					this.replaceAssistantResponse(options.threadId, message || 'Unknown API error');
					this.finishThread(options.threadId, { kind: 'idle' });
				},
				onCancel: () => this.finishThread(options.threadId, { kind: 'idle' }),
			},
		};

		const handle = this.agentLoopService.runAgentLoop(loopOptions);
		this.activeExecutions.set(options.threadId, { handle, pendingCheckpointByToolKey, pendingApproval: undefined, runContext });
		void handle.done.finally(() => {
			this.activeExecutions.delete(options.threadId);
			this.finishThread(options.threadId, { kind: 'idle' });
		});

		return {
			done: handle.done,
			cancel: () => this.cancelThread(options.threadId),
		};
	}

	ensureHydratedFromHistory(threadId: string, turns: readonly IVSCloneChatHistoryTurn[]): IVSCloneThreadRuntimeState | undefined {
		const existing = this.states.get(threadId);
		if (existing) {
			return existing;
		}
		if (turns.length === 0) {
			return undefined;
		}

		const messages: IVSCloneThreadRuntimeMessage[] = [];
		for (const turn of turns) {
			messages.push(this.createMessage({
				role: 'user',
				mode: turn.executionMode ?? 'act',
				// Legacy transcript data can still seed runtime, but after hydration the runtime message
				// itself is the durable source of truth. Persisting the import marker per message avoids
				// having to consult history again after reload just to recover that provenance.
				metadata: { importedFromHistory: true },
				createdAt: turn.startedAt,
				content: turn.promptText,
				imageAttachments: turn.promptImages,
			}));
			const responseText = turn.responsePlainText || turn.responseMarkdown;
			if (responseText) {
				messages.push(this.createMessage({
					role: 'assistant',
					mode: turn.executionMode ?? 'act',
					metadata: { importedFromHistory: true },
					createdAt: turn.completedAt ?? turn.lastEventAt ?? turn.startedAt,
					content: responseText,
				}));
			}
		}

		const latestTurn = turns.at(-1);
		if (!latestTurn) {
			return undefined;
		}

		const hydratedState: IVSCloneThreadRuntimeState = {
			threadId,
			catalog: this.createCatalogFromHistoryTurns(threadId, turns, messages),
			turnId: latestTurn.turnId,
			// Older history payloads predate per-turn execution mode. Hydration falls back the thread
			// mode to `act` as well so restored runtime state never carries an undefined default mode
			// after importing those legacy turns.
			mode: latestTurn.executionMode ?? 'act',
			streamState: { kind: 'idle' },
			messages,
			assistantEditApplications: [],
			checkpoints: [],
			currentCheckpointId: undefined,
			branchHeadMessageId: messages.at(-1)?.id,
			pausedApproval: undefined,
			// Hydrating legacy turns is an import step, not a resumable execution handoff. The
			// runtime becomes authoritative after hydration, so old pending/streaming turns are
			// normalized to idle instead of pretending they can still continue.
			isRunning: false,
			lastUpdatedAt: latestTurn.lastEventAt ?? latestTurn.completedAt ?? latestTurn.startedAt,
		};
		this.setState(threadId, hydratedState);
		return hydratedState;
	}

	ensureCatalogImportedFromHistory(
		thread: IVSCloneChatHistoryThread,
		turns: readonly IVSCloneChatHistoryTurn[] = [],
	): IVSCloneThreadRuntimeState {
		const existing = this.states.get(thread.threadId);
		if (existing && !this.shouldUpgradeSyntheticHistoryCatalog(existing)) {
			return existing;
		}

		const hydrated = existing ?? (turns.length > 0
			? this.ensureHydratedFromHistory(thread.threadId, turns)
			: undefined);
		const baseState: IThreadRuntimeStateDraft = hydrated ?? {
			threadId: thread.threadId,
			turnId: undefined,
			mode: 'act',
			streamState: { kind: 'idle' },
			messages: [],
			assistantEditApplications: [],
			checkpoints: [],
			currentCheckpointId: undefined,
			branchHeadMessageId: undefined,
			pausedApproval: undefined,
			isRunning: false,
			lastUpdatedAt: thread.updatedAt,
		};
		this.setState(thread.threadId, {
			...baseState,
			// Turn-only hydration can create a provisional imported catalog before the rail knows the
			// full history-thread metadata. Upgrade exactly that synthetic shape once, then keep the
			// runtime catalog authoritative for later reads instead of replaying history over it.
			catalog: this.createCatalogFromHistoryThread(thread, baseState.messages),
			lastUpdatedAt: thread.updatedAt,
		});
		return this.states.get(thread.threadId)!;
	}

	recordRejectedTurn(options: {
		threadId: string;
		turnId: string;
		promptText: string;
		mode: IVSCloneThreadRuntimeRunOptions['mode'];
		reason: string;
		imageAttachments?: IVSCloneThreadRuntimeRunOptions['imageAttachments'];
	}): void {
		const baseState = this.states.get(options.threadId);
		const userMessage = this.createMessage({
			role: 'user',
			mode: options.mode,
			createdAt: Date.now(),
			content: options.promptText,
			imageAttachments: options.imageAttachments,
		});
		const assistantMessage = this.createMessage({
			role: 'assistant',
			mode: options.mode,
			createdAt: Date.now(),
			content: options.reason,
		});
		this.setState(options.threadId, {
			threadId: options.threadId,
			turnId: options.turnId,
			mode: options.mode,
			streamState: { kind: 'idle' },
			messages: [...(baseState?.messages ?? []), userMessage, assistantMessage],
			assistantEditApplications: baseState?.assistantEditApplications ?? [],
			checkpoints: baseState?.checkpoints ?? [],
			currentCheckpointId: baseState?.currentCheckpointId,
			branchHeadMessageId: assistantMessage.id,
			pausedApproval: undefined,
			isRunning: false,
			lastUpdatedAt: Date.now(),
		});
	}

	cancelThread(threadId: string): void {
		const execution = this.activeExecutions.get(threadId);
		if (!execution) {
			return;
		}

		execution.handle.cancel();
		if (execution.pendingApproval) {
			void this.rejectLatestToolRequest(threadId, 'Tool request was cancelled before execution.');
		}
	}

	approveLatestToolRequest(threadId: string): boolean {
		const execution = this.activeExecutions.get(threadId);
		const pendingApproval = execution?.pendingApproval;
		if (execution && pendingApproval) {
			execution.pendingApproval = undefined;
			pendingApproval.status = 'approved';
			this.appendMessage(threadId, {
				role: 'tool',
				createdAt: Date.now(),
				type: 'running_now',
				toolName: pendingApproval.toolName,
				approvalType: pendingApproval.approvalType,
				params: pendingApproval.params,
			});
			this.updateState(threadId, state => ({
				...state,
				streamState: { kind: 'tool', toolName: pendingApproval.toolName },
				pausedApproval: undefined,
			}));
			pendingApproval.deferred.complete({ kind: 'approved' });
			return true;
		}

		const pausedApproval = this.states.get(threadId)?.pausedApproval;
		if (!pausedApproval) {
			return false;
		}

		this.appendMessage(threadId, {
			role: 'tool',
			createdAt: Date.now(),
			type: 'running_now',
			toolName: pausedApproval.toolName,
			approvalType: pausedApproval.approvalType,
			params: pausedApproval.params,
		});
		this.updateState(threadId, state => ({
			...state,
			streamState: { kind: 'tool', toolName: pausedApproval.toolName },
			pausedApproval: undefined,
			isRunning: true,
		}));
		void this.executePersistedApproval(threadId, pausedApproval);
		return true;
	}

	rejectLatestToolRequest(threadId: string, reason = 'Tool request was rejected.'): boolean {
		const execution = this.activeExecutions.get(threadId);
		const pendingApproval = execution?.pendingApproval;
		if (execution && pendingApproval) {
			execution.pendingApproval = undefined;
			pendingApproval.status = 'rejected';
			this.appendMessage(threadId, {
				role: 'tool',
				createdAt: Date.now(),
				type: 'rejected',
				toolName: pendingApproval.toolName,
				approvalType: pendingApproval.approvalType,
				params: pendingApproval.params,
				output: reason,
				success: false,
			});
			execution.pendingCheckpointByToolKey.delete(this.getToolInvocationKey(pendingApproval.toolName, pendingApproval.params));
			this.updateState(threadId, state => ({
				...state,
				streamState: { kind: 'idle' },
				pausedApproval: undefined,
			}));
			pendingApproval.deferred.complete({ kind: 'rejected', reason });
			return true;
		}

		const pausedApproval = this.states.get(threadId)?.pausedApproval;
		if (!pausedApproval) {
			return false;
		}

		this.appendMessage(threadId, {
			role: 'tool',
			createdAt: Date.now(),
			type: 'rejected',
			toolName: pausedApproval.toolName,
			approvalType: pausedApproval.approvalType,
			params: pausedApproval.params,
			output: reason,
			success: false,
		});
		this.updateState(threadId, state => ({
			...state,
			streamState: { kind: 'idle' },
			pausedApproval: undefined,
			isRunning: false,
		}));
		return true;
	}

	getThreads(query?: IVSCloneThreadRuntimeCatalogQuery): readonly IVSCloneThreadRuntimeCatalogEntry[] {
		const normalizedText = query?.text?.trim().toLowerCase();
		const filtered = [...this.states.values()]
			.map(state => state.catalog)
			.filter(catalog => this.matchesCatalogQuery(catalog, query?.tab, query?.includeArchived === true, normalizedText))
			.sort((left, right) => right.updatedAt - left.updatedAt);
		if (!query?.limit || query.limit <= 0) {
			return filtered;
		}
		return filtered.slice(0, query.limit);
	}

	isDeletedThread(threadId: string): boolean {
		return this.deletedThreadIds.has(threadId);
	}

	archiveThread(threadId: string, archived: boolean): boolean {
		const state = this.states.get(threadId);
		if (!state || state.catalog.archived === archived) {
			return false;
		}

		this.setState(threadId, {
			...state,
			catalog: {
				...state.catalog,
				archived,
				status: archived ? 'archived' : this.deriveCatalogStatus(state, false, state.catalog.status),
			},
			lastUpdatedAt: Date.now(),
		});
		return true;
	}

	deleteThread(threadId: string): boolean {
		const state = this.states.get(threadId);
		if (!state) {
			return false;
		}

		this.cancelThread(threadId);
		this.activeExecutions.delete(threadId);
		this.states.delete(threadId);
		this.deletedThreadIds.add(threadId);
		this.store.markDeletedThread(threadId);
		this._onDidChangeState.fire({
			...state,
			catalog: {
				...state.catalog,
				updatedAt: Date.now(),
			},
		});
		return true;
	}

	clearAll(): void {
		for (const threadId of [...this.activeExecutions.keys()]) {
			this.cancelThread(threadId);
		}
		this.activeExecutions.clear();
		this.states.clear();
		this.deletedThreadIds.clear();
		this.store.clearAll();
	}

	getState(threadId: string): IVSCloneThreadRuntimeState | undefined {
		return this.states.get(threadId);
	}

	getAssistantEditApplicationState(threadId: string, messageId: string): IVSCloneThreadRuntimeAssistantEditApplicationState | undefined {
		return this.states.get(threadId)?.assistantEditApplications?.find(entry => entry.messageId === messageId)?.state;
	}

	getAssistantEditApplicationStates(threadId: string): readonly IVSCloneThreadRuntimeAssistantEditApplication[] {
		return this.states.get(threadId)?.assistantEditApplications ?? [];
	}

	/**
	 * Edit-apply durability is keyed by assistant message id so rewind and restore can prune stale
	 * entries using the same active-branch message list the rest of runtime already owns.
	 */
	setAssistantEditApplicationState(
		threadId: string,
		messageId: string,
		state: IVSCloneThreadRuntimeAssistantEditApplicationState | undefined,
	): void {
		const current = this.states.get(threadId);
		if (!current) {
			return;
		}

		const nextApplications = [...(current.assistantEditApplications ?? [])];
		const existingIndex = nextApplications.findIndex(entry => entry.messageId === messageId);
		if (state) {
			const nextEntry: IVSCloneThreadRuntimeAssistantEditApplication = { messageId, state };
			if (existingIndex >= 0) {
				nextApplications[existingIndex] = nextEntry;
			} else {
				nextApplications.push(nextEntry);
			}
		} else if (existingIndex >= 0) {
			nextApplications.splice(existingIndex, 1);
		}

		this.setState(threadId, {
			...current,
			assistantEditApplications: nextApplications,
			lastUpdatedAt: Date.now(),
		});
	}

	async rewindToCheckpoint(threadId: string, checkpointId: string): Promise<boolean> {
		if (this.activeExecutions.has(threadId)) {
			return false;
		}

		const state = this.states.get(threadId);
		if (!state) {
			return false;
		}
		if (this.hasPendingUserDecision(state)) {
			// Paused approvals survive reload as durable runtime state. Rewind cannot fork the branch
			// while the same branch is still explicitly waiting on a user decision.
			return false;
		}
		if (this.hasPendingAssistantEditApplication(state)) {
			// Assistant edit apply is now a runtime-owned workflow. Rewind must refuse to branch while
			// that workflow is still in-flight or the checkpoint restore would race the unresolved edit.
			return false;
		}
		const checkpoint = state.checkpoints.find(entry => entry.id === checkpointId);
		if (!checkpoint) {
			return false;
		}
		const checkpointMessageIndex = state.messages.findIndex(message => message.role === 'checkpoint' && message.checkpoint.id === checkpointId);
		const checkpointIndex = state.checkpoints.findIndex(entry => entry.id === checkpointId);
		if (checkpointMessageIndex < 0 || checkpointIndex < 0) {
			return false;
		}

		for (const snapshot of checkpoint.snapshots) {
			if (!snapshot.existed) {
				if (await this.fileService.exists(snapshot.uri)) {
					await this.fileService.del(snapshot.uri, { recursive: true });
				}
				continue;
			}

			if (snapshot.isDirectory) {
				if (await this.fileService.exists(snapshot.uri)) {
					await this.fileService.del(snapshot.uri, { recursive: true });
				}
				await this.fileService.createFolder(snapshot.uri);
				continue;
			}

			if (await this.fileService.exists(snapshot.uri)) {
				await this.fileService.del(snapshot.uri, { recursive: true });
			}
			await this.fileService.createFolder(dirnameUri(snapshot.uri));
			await this.fileService.writeFile(snapshot.uri, VSBuffer.fromString(snapshot.content ?? ''));
		}

		const truncatedMessages = state.messages.slice(0, checkpointMessageIndex + 1);
		this.setState(threadId, {
			...state,
			messages: truncatedMessages,
			assistantEditApplications: state.assistantEditApplications ?? [],
			checkpoints: state.checkpoints.slice(0, checkpointIndex + 1),
			currentCheckpointId: checkpointId,
			branchHeadMessageId: truncatedMessages.at(-1)?.id,
			pausedApproval: undefined,
			isRunning: false,
			streamState: { kind: 'idle' },
			lastUpdatedAt: Date.now(),
		});
		return true;
	}

	private restorePersistedStates(): void {
		for (const threadId of this.store.loadDeletedThreadIds()) {
			this.deletedThreadIds.add(threadId);
		}
		for (const persisted of this.store.loadAll()) {
			const normalized = this.normalizeRestoredState(persisted);
			this.states.set(normalized.threadId, normalized);
		}
	}

	private async executePersistedApproval(threadId: string, pausedApproval: IVSCloneThreadRuntimePausedApproval): Promise<void> {
		const pendingCheckpointByToolKey = new Map<string, readonly IVSCloneThreadRuntimeSnapshot[]>();
		pendingCheckpointByToolKey.set(this.getToolInvocationKey(pausedApproval.toolName, pausedApproval.params), pausedApproval.snapshots);
		const toolTokenSource = new CancellationTokenSource();
		let cancelledByUser = false;
		this.activeExecutions.set(threadId, {
			handle: {
				done: Promise.resolve(),
				cancel: () => {
					cancelledByUser = true;
					toolTokenSource.cancel();
				},
			},
			pendingCheckpointByToolKey,
			runContext: pausedApproval.run,
			pendingApproval: undefined,
		});

		let result: IVSCloneToolExecutionResult;
		try {
			result = await this.executePersistedToolWithSafety(
				pausedApproval.toolName,
				pausedApproval.params,
				pausedApproval.run.mode,
				toolTokenSource,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result = { success: false, output: message };
		}

		const toolResultMessage = this.recordToolResult(
			threadId,
			pausedApproval.toolName,
			pausedApproval.params,
			result,
			pendingCheckpointByToolKey,
		);
		this.activeExecutions.delete(threadId);

		if (!toolResultMessage) {
			this.finishThread(threadId, { kind: 'idle' });
			return;
		}
		if (cancelledByUser) {
			this.finishThread(threadId, { kind: 'idle' });
			return;
		}

		// Reload-safe approvals must continue from the persisted branch rather than stopping after
		// the approved tool finishes. Replaying the tool_result as the next user message restores the
		// same agent-loop shape the live runtime would have produced without a reload boundary.
		const resumeHandle = this.runThread({
			...pausedApproval.run,
			threadId,
			promptText: formatToolResult(pausedApproval.toolName, {
				success: result.success,
				output: result.output,
			}),
			previousTurns: this.toAgentLoopConversationMessagesFromRuntime(threadId, toolResultMessage.id),
			recordPromptMessage: false,
		});
		void resumeHandle.done.catch(error => {
			this.logService.error('[VSCloneThreadRuntime] Failed to resume thread after persisted approval.', error);
		});
	}

	/**
	 * Reload-safe approvals still need the same timeout and explicit cancellation hook as the live
	 * agent loop. Otherwise a hung tool after reload would strand the restored thread forever.
	 */
	private async executePersistedToolWithSafety(
		toolName: string,
		params: Record<string, string>,
		mode: IVSCloneThreadRuntimeRunContext['mode'],
		tokenSource: CancellationTokenSource,
	): Promise<IVSCloneToolExecutionResult> {
		try {
			const execution = this.toolExecutionService.executeTool(toolName, params, mode, tokenSource.token);
			const result = await raceTimeout(execution, this.persistedToolExecutionTimeoutMs, () => {
				this.logService.warn('[VSCloneThreadRuntime] Persisted tool %s exceeded %dms; cancelling resumed approval execution.', toolName, this.persistedToolExecutionTimeoutMs);
				tokenSource.cancel();
			});
			if (result) {
				return result;
			}

			return {
				success: false,
				output: `Tool ${toolName} did not finish within ${Math.round(this.persistedToolExecutionTimeoutMs / 1000)} seconds and was cancelled.`,
			};
		} finally {
			tokenSource.dispose();
		}
	}

	private async recordToolRequested(
		threadId: string,
		toolName: string,
		params: Record<string, string>,
		pendingCheckpointByToolKey: Map<string, readonly IVSCloneThreadRuntimeSnapshot[]>,
		runContext: IVSCloneThreadRuntimeRunContext,
	): Promise<VSCloneThreadToolApprovalDecision> {
		const approvalType = this.toolRuntimeService.getApprovalType(toolName);
		this.appendMessage(threadId, {
			role: 'tool',
			createdAt: Date.now(),
			type: 'tool_request',
			toolName,
			approvalType,
			params,
		});

		if (approvalType) {
			const execution = this.activeExecutions.get(threadId);
			if (execution) {
				const pendingApproval: IPendingApproval = {
					deferred: new DeferredPromise<VSCloneThreadToolApprovalDecision>(),
					requestedAt: Date.now(),
					toolName,
					params,
					approvalType,
					status: 'pending',
				};
				execution.pendingApproval = pendingApproval;
				this.updateState(threadId, state => ({
					...state,
					streamState: { kind: 'awaiting_user', toolName, approvalType },
					// Persist the approval immediately so reload can still resume the
					// branch while checkpoint capture is in flight. Snapshots are filled
					// in later if they arrive before the user approves or rejects.
					pausedApproval: {
						requestedAt: pendingApproval.requestedAt,
						toolName,
						params,
						approvalType,
						snapshots: [],
						run: runContext,
					},
				}));
				const snapshotPromise = this.captureCheckpointSnapshots(toolName, params).then(snapshots => {
					if (snapshots.length > 0 && pendingApproval.status !== 'rejected') {
						pendingCheckpointByToolKey.set(this.getToolInvocationKey(toolName, params), snapshots);
					}
					if (pendingApproval.status === 'pending') {
						this.updateState(threadId, state => ({
							...state,
							pausedApproval: {
								requestedAt: pendingApproval.requestedAt,
								toolName,
								params,
								approvalType,
								snapshots,
								run: runContext,
							},
						}));
					}
					return snapshots;
				}, error => {
					this.logService.warn('[VSCloneThreadRuntime] Failed to capture checkpoints for %s: %s', toolName, error instanceof Error ? error.message : String(error));
					return [];
				});
				pendingApproval.snapshotPromise = snapshotPromise;
				const approvalDecision = await pendingApproval.deferred.p;
				if (approvalDecision.kind === 'rejected') {
					return approvalDecision;
				}
				await snapshotPromise;
				return approvalDecision;
			}
		}

		this.appendMessage(threadId, {
			role: 'tool',
			createdAt: Date.now(),
			type: 'running_now',
			toolName,
			approvalType,
			params,
		});
		this.updateState(threadId, state => ({
			...state,
			streamState: { kind: 'tool', toolName },
		}));
		return { kind: 'approved' };
	}

	private recordToolResult(
		threadId: string,
		toolName: string,
		params: Record<string, string>,
		result: IVSCloneToolExecutionResult,
		pendingCheckpointByToolKey: Map<string, readonly IVSCloneThreadRuntimeSnapshot[]>,
	): Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'tool' }> | undefined {
		const approvalType = this.toolRuntimeService.getApprovalType(toolName);
		const toolMessage = this.appendMessage(threadId, {
			role: 'tool',
			createdAt: Date.now(),
			type: result.success ? 'success' : 'tool_error',
			toolName,
			approvalType,
			params,
			output: result.output,
			success: result.success,
		});
		if (!toolMessage) {
			return undefined;
		}

		const invocationKey = this.getToolInvocationKey(toolName, params);
		const snapshots = pendingCheckpointByToolKey.get(invocationKey);
		pendingCheckpointByToolKey.delete(invocationKey);
		if (result.success && snapshots && snapshots.length > 0) {
			const checkpoint: IVSCloneThreadRuntimeCheckpoint = {
				id: generateUuid(),
				createdAt: Date.now(),
				type: 'tool_edit',
				toolName,
				snapshots,
			};
			this.appendCheckpoint(threadId, checkpoint);
		}

		this.updateState(threadId, state => ({
			...state,
			streamState: { kind: 'llm' },
			pausedApproval: undefined,
		}));
		return toolMessage;
	}

	private async captureCheckpointSnapshots(toolName: string, params: Record<string, string>): Promise<readonly IVSCloneThreadRuntimeSnapshot[]> {
		const candidatePaths = this.getCheckpointCandidatePaths(toolName, params);
		if (candidatePaths.length === 0) {
			return [];
		}

		const snapshots: IVSCloneThreadRuntimeSnapshot[] = [];
		for (const rawPath of candidatePaths) {
			const resolved = this.resolveWorkspacePath(rawPath);
			if (!resolved) {
				continue;
			}

			const exists = await this.fileService.exists(resolved);
			if (!exists) {
				snapshots.push({ uri: resolved, existed: false, content: undefined, isDirectory: false });
				continue;
			}

			const stat = await this.fileService.resolve(resolved);
			if (stat.isDirectory) {
				snapshots.push({ uri: resolved, existed: true, content: undefined, isDirectory: true });
				continue;
			}

			const content = (await this.fileService.readFile(resolved)).value.toString();
			snapshots.push({ uri: resolved, existed: true, content, isDirectory: false });
		}

		return snapshots;
	}

	private getCheckpointCandidatePaths(toolName: string, params: Record<string, string>): readonly string[] {
		switch (toolName) {
			case 'edit_file':
			case 'create_file':
				return params.path ? [params.path] : [];
			default:
				return [];
		}
	}

	private recordAssistantDelta(threadId: string, delta: string): void {
		if (!delta) {
			return;
		}

		const current = this.states.get(threadId);
		if (!current) {
			return;
		}

		const lastMessage = current.messages.at(-1);
		if (lastMessage?.role === 'assistant') {
			const updatedMessages = [...current.messages];
			updatedMessages[updatedMessages.length - 1] = {
				...lastMessage,
				content: lastMessage.content + delta,
			};
			this.setState(threadId, {
				...current,
				messages: updatedMessages,
				branchHeadMessageId: lastMessage.id,
				streamState: { kind: 'llm' },
				lastUpdatedAt: Date.now(),
			});
			return;
		}

		const assistantMessage = this.createMessage({
			role: 'assistant',
			mode: current.mode ?? 'act',
			createdAt: Date.now(),
			content: delta,
		});
		this.setState(threadId, {
			...current,
			messages: [...current.messages, assistantMessage],
			branchHeadMessageId: assistantMessage.id,
			streamState: { kind: 'llm' },
			lastUpdatedAt: Date.now(),
		});
	}

	private replaceAssistantResponse(threadId: string, responseText: string): void {
		const current = this.states.get(threadId);
		if (!current) {
			return;
		}

		const lastMessage = current.messages.at(-1);
		if (lastMessage?.role === 'assistant') {
			const updatedMessages = [...current.messages];
			updatedMessages[updatedMessages.length - 1] = {
				...lastMessage,
				content: responseText,
			};
			this.setState(threadId, {
				...current,
				messages: updatedMessages,
				branchHeadMessageId: lastMessage.id,
				streamState: { kind: 'llm' },
				lastUpdatedAt: Date.now(),
			});
			return;
		}

		const assistantMessage = this.createMessage({
			role: 'assistant',
			mode: current.mode ?? 'act',
			createdAt: Date.now(),
			content: responseText,
		});
		this.setState(threadId, {
			...current,
			messages: [...current.messages, assistantMessage],
			branchHeadMessageId: assistantMessage.id,
			streamState: { kind: 'llm' },
			lastUpdatedAt: Date.now(),
		});
	}

	private appendCheckpoint(threadId: string, checkpoint: IVSCloneThreadRuntimeCheckpoint): void {
		const checkpointMessage = this.createMessage({
			role: 'checkpoint',
			createdAt: Date.now(),
			checkpoint,
		});
		this.updateState(threadId, current => ({
			...current,
			checkpoints: [...current.checkpoints, checkpoint],
			currentCheckpointId: checkpoint.id,
			messages: [...current.messages, checkpointMessage],
			branchHeadMessageId: checkpointMessage.id,
		}));
	}

	private appendMessage<T extends Omit<IVSCloneThreadRuntimeMessage, 'id'>>(threadId: string, message: T): Extract<IVSCloneThreadRuntimeMessage, { readonly role: T['role'] }> | undefined {
		if (!this.states.has(threadId)) {
			return undefined;
		}
		const runtimeMessage = this.createMessage(message);
		this.updateState(threadId, current => ({
			...current,
			messages: [...current.messages, runtimeMessage],
			branchHeadMessageId: runtimeMessage.id,
		}));
		return runtimeMessage as Extract<IVSCloneThreadRuntimeMessage, { readonly role: T['role'] }>;
	}

	private finishThread(threadId: string, streamState: IVSCloneThreadRuntimeState['streamState']): void {
		this.updateState(threadId, current => ({
			...current,
			isRunning: false,
			streamState,
			pausedApproval: current.pausedApproval,
		}));
	}

	private updateState(threadId: string, updater: (state: IVSCloneThreadRuntimeState) => IThreadRuntimeStateDraft): void {
		const current = this.states.get(threadId);
		if (!current) {
			return;
		}

		this.setState(threadId, {
			...updater(current),
			lastUpdatedAt: Date.now(),
		});
	}

	private setState(threadId: string, nextState: IThreadRuntimeStateDraft): void {
		const previous = this.states.get(threadId);
		const assistantEditApplications = this.normalizeAssistantEditApplications(
			nextState.assistantEditApplications ?? [],
			nextState.messages,
			'keep',
		);
		const normalized: IVSCloneThreadRuntimeState = {
			...nextState,
			catalog: this.normalizeCatalogEntry(threadId, nextState, previous),
			assistantEditApplications,
			branchHeadMessageId: nextState.branchHeadMessageId ?? nextState.messages.at(-1)?.id,
		};
		this.states.set(threadId, normalized);
		this.deletedThreadIds.delete(threadId);
		this.store.saveState(normalized);
		this._onDidChangeState.fire(normalized);
	}

	private createMessage(message: Omit<Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'user' }>, 'id'>): Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'user' }>;
	private createMessage(message: Omit<Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>, 'id'>): Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>;
	private createMessage(message: Omit<Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'tool' }>, 'id'>): Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'tool' }>;
	private createMessage(message: Omit<Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'checkpoint' }>, 'id'>): Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'checkpoint' }>;
	private createMessage(message: Omit<IVSCloneThreadRuntimeMessage, 'id'>): IVSCloneThreadRuntimeMessage {
		return { id: generateUuid(), ...message };
	}

	private normalizeRestoredState(state: IVSCloneThreadRuntimeState): IVSCloneThreadRuntimeState {
		const shouldBackfillImportedHistoryMetadata = this.shouldBackfillImportedHistoryMetadata(state.messages);
		const messages = state.messages.map(message => this.normalizeRestoredConversationMessage(
			message,
			state.mode,
			shouldBackfillImportedHistoryMetadata,
		));
		const messageIds = new Set(state.messages.map(message => message.id));
		const currentCheckpointId = state.currentCheckpointId && state.checkpoints.some(checkpoint => checkpoint.id === state.currentCheckpointId)
			? state.currentCheckpointId
			: state.checkpoints.at(-1)?.id;
		const branchHeadMessageId = state.branchHeadMessageId && messageIds.has(state.branchHeadMessageId)
			? state.branchHeadMessageId
			: messages.at(-1)?.id;
		const assistantEditApplications = this.normalizeAssistantEditApplications(
			state.assistantEditApplications ?? [],
			messages,
			'fail',
		);

		return state.pausedApproval
			? {
				...state,
				messages,
				currentCheckpointId,
				branchHeadMessageId,
				assistantEditApplications,
				streamState: {
					kind: 'awaiting_user',
					toolName: state.pausedApproval.toolName,
					approvalType: state.pausedApproval.approvalType,
				},
				catalog: this.normalizeCatalogEntry(state.threadId, {
					...state,
					messages,
					currentCheckpointId,
					branchHeadMessageId,
					assistantEditApplications,
					streamState: {
						kind: 'awaiting_user',
						toolName: state.pausedApproval.toolName,
						approvalType: state.pausedApproval.approvalType,
					},
					isRunning: false,
				}),
				isRunning: false,
			}
			: {
				...state,
				messages,
				currentCheckpointId,
				branchHeadMessageId,
				assistantEditApplications,
				streamState: { kind: 'idle' },
				catalog: this.normalizeCatalogEntry(state.threadId, {
					...state,
					messages,
					currentCheckpointId,
					branchHeadMessageId,
					assistantEditApplications,
					streamState: { kind: 'idle' },
					isRunning: false,
				}),
				isRunning: false,
			};
	}

	/**
	 * Runtime edit-apply state must follow the assistant message branch. Rewind and restore can
	 * therefore prune by message identity instead of trying to infer whether a pane-local entry
	 * is still relevant. Restore additionally converts stale `pending` entries to `failed`
	 * because there is no safe way to prove an interrupted apply completed before the reload.
	 */
	private normalizeAssistantEditApplications(
		applications: readonly IVSCloneThreadRuntimeAssistantEditApplication[],
		messages: readonly IVSCloneThreadRuntimeMessage[],
		pendingPolicy: 'keep' | 'fail',
	): readonly IVSCloneThreadRuntimeAssistantEditApplication[] {
		if (applications.length === 0) {
			return [];
		}

		const applicationsByMessageId = new Map<string, IVSCloneThreadRuntimeAssistantEditApplicationState>();
		for (const application of applications) {
			applicationsByMessageId.set(
				application.messageId,
				this.normalizeAssistantEditApplicationState(application.state, pendingPolicy),
			);
		}

		const normalized: IVSCloneThreadRuntimeAssistantEditApplication[] = [];
		for (const message of messages) {
			if (message.role !== 'assistant') {
				continue;
			}
			const state = applicationsByMessageId.get(message.id);
			if (!state) {
				continue;
			}
			normalized.push({
				messageId: message.id,
				state,
			});
		}
		return normalized;
	}

	private normalizeAssistantEditApplicationState(
		state: IVSCloneThreadRuntimeAssistantEditApplicationState,
		pendingPolicy: 'keep' | 'fail',
	): IVSCloneThreadRuntimeAssistantEditApplicationState {
		if (state.phase === 'pending' && pendingPolicy === 'fail') {
			return { phase: 'failed' };
		}
		return state;
	}

	private hasPendingAssistantEditApplication(state: IVSCloneThreadRuntimeState): boolean {
		return (state.assistantEditApplications ?? []).some(application => application.state.phase === 'pending');
	}

	private hasPendingUserDecision(state: IVSCloneThreadRuntimeState): boolean {
		return state.pausedApproval !== undefined || state.streamState.kind === 'awaiting_user';
	}

	private normalizeRestoredConversationMessage(
		message: IVSCloneThreadRuntimeMessage,
		threadMode: IVSCloneThreadRuntimeState['mode'],
		shouldBackfillImportedHistoryMetadata: boolean,
	): IVSCloneThreadRuntimeMessage {
		if (message.role === 'user' || message.role === 'assistant') {
			const metadata = (message.metadata?.importedFromHistory || shouldBackfillImportedHistoryMetadata)
				? { importedFromHistory: true }
				: undefined;
			return {
				...message,
				mode: message.mode ?? threadMode ?? 'act',
				// The import marker is durable runtime metadata. Older payloads may not have it, but
				// once present it should survive restore exactly so active runtime consumers do not
				// need pane-local bookkeeping to distinguish hydrated history from live messages.
				// Pre-metadata runtime payloads are treated as imported on restore as a deliberate
				// safety bias: it is better to require manual apply for an old live-looking thread
				// than to auto-apply edits from a historical thread that lost its provenance marker.
				...(metadata ? { metadata } : {}),
			};
		}
		return message;
	}

	private shouldBackfillImportedHistoryMetadata(
		messages: readonly IVSCloneThreadRuntimeMessage[],
	): boolean {
		// Older persisted runtime payloads had no conversation metadata at all. If none of the
		// conversation messages carry an explicit marker yet, restore backfills them as imported so
		// reopened legacy threads stay manual-only instead of suddenly becoming auto-apply eligible.
		let sawConversationMessage = false;
		for (const message of messages) {
			if (message.role !== 'user' && message.role !== 'assistant') {
				continue;
			}
			sawConversationMessage = true;
			if (message.metadata) {
				return false;
			}
		}
		return sawConversationMessage;
	}

	private normalizeCatalogEntry(
		threadId: string,
		state: IThreadRuntimeStateDraft,
		previous?: IVSCloneThreadRuntimeState,
	): IVSCloneThreadRuntimeCatalogEntry {
		const fallbackCatalog = state.catalog ?? previous?.catalog;
		const firstMessage = state.messages[0];
		const firstConversationMessage = state.messages.find((message): message is Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'user' | 'assistant' }> =>
			message.role === 'user' || message.role === 'assistant',
		);
		const lastMessage = state.messages.at(-1);
		const latestConversationMessage = [...state.messages].reverse().find((message): message is Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'user' | 'assistant' }> =>
			message.role === 'user' || message.role === 'assistant',
		);
		// Titles should be stable once a thread exists, but when older payloads or empty imports do
		// not have a catalog yet we still need a deterministic fallback sourced from the first real
		// conversation message rather than a truthy/falsey precedence bug.
		const titleSource = fallbackCatalog?.title
			|| firstConversationMessage?.content
			|| threadId;
		const previewSource = latestConversationMessage?.content
			|| fallbackCatalog?.lastTurnPreview
			|| (lastMessage?.role === 'tool' ? lastMessage.output : '')
			|| titleSource;
		const archived = state.catalog?.archived ?? previous?.catalog.archived ?? false;
		return {
			threadId,
			sessionResource: state.catalog?.sessionResource
				?? previous?.catalog.sessionResource,
			title: this.truncateCatalogText(titleSource, 120) || threadId,
			activeModelIdentifier: state.catalog?.activeModelIdentifier ?? previous?.catalog.activeModelIdentifier,
			createdAt: state.catalog?.createdAt
				?? previous?.catalog.createdAt
				?? firstMessage?.createdAt
				?? state.lastUpdatedAt,
			updatedAt: state.lastUpdatedAt,
			status: archived
				? 'archived'
				: this.deriveCatalogStatus(state, false, previous?.catalog.status ?? state.catalog?.status),
			archived,
			turnCount: this.getRuntimeTurnCount(state.messages, fallbackCatalog?.turnCount ?? 0),
			lastTurnPreview: this.truncateCatalogText(previewSource, 280),
			importedFromHistory: state.catalog?.importedFromHistory ?? previous?.catalog.importedFromHistory,
		};
	}

	private createCatalogFromHistoryThread(
		thread: IVSCloneChatHistoryThread,
		messages: readonly IVSCloneThreadRuntimeMessage[],
	): IVSCloneThreadRuntimeCatalogEntry {
		return {
			threadId: thread.threadId,
			sessionResource: thread.sessionResource,
			title: thread.title,
			activeModelIdentifier: thread.activeModelIdentifier,
			createdAt: thread.createdAt,
			updatedAt: thread.updatedAt,
			status: thread.archived ? 'archived' : thread.status,
			archived: thread.archived,
			turnCount: messages.filter(message => message.role === 'user').length || thread.turnCount,
			lastTurnPreview: this.truncateCatalogText(
				[...(messages.filter((message): message is Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' | 'user' }> =>
					message.role === 'assistant' || message.role === 'user',
				))].reverse()[0]?.content || thread.lastTurnPreview,
				280,
			),
			importedFromHistory: true,
		};
	}

	private createCatalogFromHistoryTurns(
		threadId: string,
		turns: readonly IVSCloneChatHistoryTurn[],
		messages: readonly IVSCloneThreadRuntimeMessage[],
	): IVSCloneThreadRuntimeCatalogEntry {
		const firstTurn = turns[0];
		const latestTurn = turns.at(-1);
		const status = latestTurn?.status === 'failed' || latestTurn?.status === 'cancelled'
			? 'failed'
			: 'completed';
		return {
			threadId,
			// Turn-only migration does not know the original session resource. Preserve that as unknown
			// so a later explicit history-thread import can upgrade the synthetic catalog safely.
			sessionResource: undefined,
			title: this.truncateCatalogText(firstTurn?.promptText, 120) || threadId,
			activeModelIdentifier: latestTurn?.modelIdentifier,
			createdAt: firstTurn?.startedAt ?? latestTurn?.startedAt ?? Date.now(),
			updatedAt: latestTurn?.lastEventAt ?? latestTurn?.completedAt ?? latestTurn?.startedAt ?? Date.now(),
			status,
			archived: false,
			turnCount: turns.length,
			lastTurnPreview: this.truncateCatalogText(
				[...(messages.filter((message): message is Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' | 'user' }> =>
					message.role === 'assistant' || message.role === 'user',
				))].reverse()[0]?.content || latestTurn?.responsePlainText || latestTurn?.promptText,
				280,
			),
			importedFromHistory: true,
		};
	}

	private shouldUpgradeSyntheticHistoryCatalog(state: IVSCloneThreadRuntimeState): boolean {
		// The only catalog that should be replaced from a history-thread import is the provisional
		// synthetic one that still lacks the real session resource. That covers both turn-only imports
		// and restored pre-catalog runtime payloads. Once runtime already knows a session resource,
		// later history reads are compatibility input only and must not overwrite runtime-owned
		// metadata.
		return !state.catalog.sessionResource;
	}

	private deriveCatalogStatus(
		state: Pick<IVSCloneThreadRuntimeState, 'messages' | 'streamState' | 'pausedApproval' | 'isRunning'>,
		archived: boolean,
		fallbackStatus: IVSCloneThreadRuntimeCatalogEntry['status'] | undefined,
	): IVSCloneThreadRuntimeCatalogEntry['status'] {
		if (archived) {
			return 'archived';
		}
		if (state.isRunning || state.pausedApproval || state.streamState.kind !== 'idle') {
			return 'active';
		}
		const latestToolMessage = [...state.messages].reverse().find((message): message is Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'tool' }> => message.role === 'tool');
		if (latestToolMessage?.type === 'tool_error' || latestToolMessage?.type === 'rejected') {
			return 'failed';
		}
		if (state.messages.length > 0) {
			return 'completed';
		}
		return fallbackStatus ?? 'active';
	}

	private getRuntimeTurnCount(messages: readonly IVSCloneThreadRuntimeMessage[], fallbackTurnCount: number): number {
		const turnCount = messages.filter(message => message.role === 'user').length;
		return turnCount > 0 ? turnCount : fallbackTurnCount;
	}

	private truncateCatalogText(value: string | undefined, maxLength: number): string {
		const normalized = value?.replace(/\s+/g, ' ').trim() ?? '';
		return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
	}

	private matchesCatalogQuery(
		catalog: IVSCloneThreadRuntimeCatalogEntry,
		tab: IVSCloneThreadRuntimeCatalogQuery['tab'] | undefined,
		includeArchived: boolean,
		normalizedText: string | undefined,
	): boolean {
		if (tab === 'archived') {
			if (!catalog.archived) {
				return false;
			}
		} else if (tab === 'active') {
			if (catalog.archived || catalog.status !== 'active') {
				return false;
			}
		} else if (!includeArchived && !tab && catalog.archived) {
			return false;
		}

		if (!normalizedText) {
			return true;
		}
		const haystack = `${catalog.title}\n${catalog.lastTurnPreview}`.toLowerCase();
		return haystack.includes(normalizedText);
	}

	private toAgentLoopConversationMessagesFromRuntime(threadId: string, excludedToolResultMessageId?: string): IVSCloneApiConversationMessage[] {
		const state = this.states.get(threadId);
		if (!state) {
			return [];
		}

		const messages: IVSCloneApiConversationMessage[] = [];
		for (const message of state.messages) {
			switch (message.role) {
				case 'user':
					messages.push(message.imageAttachments
						? {
							role: 'user',
							content: message.content,
							imageAttachments: message.imageAttachments,
						}
						: {
							role: 'user',
							content: message.content,
						});
					break;
				case 'assistant':
					messages.push({ role: 'assistant', content: message.content });
					break;
				case 'tool':
					// The agent loop feeds structured tool results back as the next user turn. Using
					// the same mapping here lets a restored approval resume from the active branch
					// without depending on any legacy transcript reconstruction.
					if (message.id !== excludedToolResultMessageId && (message.type === 'success' || message.type === 'tool_error' || message.type === 'rejected')) {
						messages.push({
							role: 'user',
							content: formatToolResult(message.toolName, {
								success: message.success === true,
								output: message.output ?? '',
							}),
						});
					}
					break;
				case 'checkpoint':
					break;
			}
		}
		return messages;
	}

	private resolveWorkspacePath(rawPath: string | undefined): URI | undefined {
		const normalizedPath = rawPath?.replace(/\\/g, '/').trim();
		if (!normalizedPath) {
			return undefined;
		}

		const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
		if (workspaceFolders.length === 0) {
			return undefined;
		}

		if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalizedPath)) {
			try {
				return URI.parse(normalizedPath);
			} catch {
				return undefined;
			}
		}

		if (normalizedPath.startsWith('/')) {
			return URI.file(normalizedPath);
		}

		return joinPath(workspaceFolders[0].uri, normalizedPath);
	}

	private getToolInvocationKey(toolName: string, params: Record<string, string>): string {
		return `${toolName}:${JSON.stringify(params)}`;
	}
}

function dirnameUri(resource: URI): URI {
	const lastSlash = resource.path.lastIndexOf('/');
	const nextPath = lastSlash <= 0 ? '/' : resource.path.slice(0, lastSlash);
	return resource.with({ path: nextPath });
}
