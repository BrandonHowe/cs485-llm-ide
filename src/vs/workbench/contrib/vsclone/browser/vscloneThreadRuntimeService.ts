/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, raceTimeout } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVSCloneUnifiedChatBackendService } from '../common/backend/vscloneUnifiedChatBackendService.js';
import type { IVSCloneChatTransportConversationMessage } from '../common/vscloneChatTransportTypes.js';
import { IVSCloneLLMMessageRequestHandle, type IVSCloneLLMMessageReasoningBlock, type IVSCloneLLMMessageToolCall } from '../common/vscloneLLMMessageTypes.js';
import { IVSCloneOAuthService } from '../common/vscloneOAuthService.js';
import { IVSCloneSettingsService } from '../common/vscloneSettingsService.js';
import { formatToolResult, type VSCloneToolApprovalType } from '../common/vscloneToolDefinitions.js';
import { resolveVSCloneWorkspacePath } from '../common/vscloneWorkspacePaths.js';
import {
	IVSCloneThreadRuntimeAssistantEditApplication,
	IVSCloneThreadRuntimeAssistantEditApplicationState,
	IVSCloneThreadRuntimeAssistantEditStatus,
	IVSCloneThreadRuntimeAssistantEditSuggestion,
	IVSCloneThreadRuntimeCatalogEntry,
	IVSCloneThreadRuntimeCatalogQuery,
	IVSCloneThreadRuntimeCheckpoint,
	IVSCloneThreadRuntimeConversationMessageMetadata,
	IVSCloneThreadRuntimeMessage,
	IVSCloneThreadRuntimeRunContext,
	IVSCloneThreadRuntimeRunOptions,
	IVSCloneThreadRuntimeSnapshot,
	IVSCloneThreadRuntimeState,
	type IVSCloneThreadRuntimeToolRequestMessage,
	VSCloneThreadRuntimeAssistantEditSuggestionApplyMode,
	VSCloneThreadToolApprovalDecision,
} from '../common/vscloneThreadRuntimeTypes.js';
import type { VSCloneChatMode } from '../common/vsclonePlanModeTypes.js';
import { IVSCloneConvertToLLMMessageService } from './vscloneConvertToLLMMessageService.js';
import { parseSearchReplaceBlocks } from './vscloneEditCodeService.js';
import { IVSCloneLLMMessageService } from './vscloneLLMMessageService.js';
import {
	IVSCloneToolExecutionResult,
	IVSCloneToolExecutionService,
	IVSCloneToolRuntimeService,
} from './vscloneToolExecutionService.js';

export type { IVSCloneThreadRuntimeRunOptions } from '../common/vscloneThreadRuntimeTypes.js';

export const IVSCloneThreadRuntimeService = createDecorator<IVSCloneThreadRuntimeService>('vscloneThreadRuntimeService');
const defaultPersistedToolExecutionTimeoutMs = 90_000;
const maxAgentIterations = 25;
const liveToolExecutionTimeoutMs = 90_000;
const runtimeStorageKey = 'vsclone.threadRuntime.v2';
// Workspace-scoped flag. Once enabled, edit_file/create_file approval prompts are auto-approved
// for the current workspace. Not synced across machines since the user grants trust per checkout.
const autoApproveEditsStorageKey = 'vsclone.autoApproveEdits.v1';

export interface IVSCloneThreadRuntimeHandle {
	readonly done: Promise<void>;
	cancel(): void;
}

export interface IVSCloneThreadRuntimeService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<IVSCloneThreadRuntimeState>;
	runThread(options: IVSCloneThreadRuntimeRunOptions): IVSCloneThreadRuntimeHandle;
	recordRejectedTurn(options: {
		threadId: string;
		turnId: string;
		sessionResource: string;
		promptText: string;
		mode: IVSCloneThreadRuntimeRunOptions['mode'];
		reason: string;
		imageAttachments?: IVSCloneThreadRuntimeRunOptions['imageAttachments'];
		contextSelections?: IVSCloneThreadRuntimeRunOptions['contextSelections'];
	}): void;
	cancelThread(threadId: string): void;
	approveLatestToolRequest(threadId: string): boolean;
	rejectLatestToolRequest(threadId: string, reason?: string): boolean;
	/**
	 * When enabled, approvals for `edits` tools (edit_file, create_file) are granted automatically
	 * for the active workspace. Terminal and MCP tool approvals are unaffected.
	 */
	isAutoApproveEdits(): boolean;
	setAutoApproveEdits(enabled: boolean): void;
	readonly onDidChangeAutoApproveEdits: Event<boolean>;
	getThreads(query?: IVSCloneThreadRuntimeCatalogQuery): readonly IVSCloneThreadRuntimeCatalogEntry[];
	isDeletedThread(threadId: string): boolean;
	archiveThread(threadId: string, archived: boolean): boolean;
	deleteThread(threadId: string): boolean;
	clearAll(): void;
	getState(threadId: string): IVSCloneThreadRuntimeState | undefined;
	getAssistantEditStatus?(threadId: string, messageId: string): IVSCloneThreadRuntimeAssistantEditStatus | undefined;
	getAssistantEditStatuses?(threadId: string): readonly IVSCloneThreadRuntimeAssistantEditStatus[];
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
	readonly done: Promise<void>;
	readonly cancel: () => void;
	readonly pendingCheckpointByToolKey: Map<string, readonly IVSCloneThreadRuntimeSnapshot[]>;
	readonly runContext: IVSCloneThreadRuntimeRunContext;
	pendingApproval: IPendingApproval | undefined;
	activeRequest: IVSCloneLLMMessageRequestHandle | undefined;
	activeToolTokenSource: CancellationTokenSource | undefined;
	cancelled: boolean;
	finished: boolean;
}

type IThreadRuntimeStateDraft = Omit<IVSCloneThreadRuntimeState, 'catalog'> & { readonly catalog?: IVSCloneThreadRuntimeCatalogEntry };

interface IVSClonePersistedThreadRuntimePayload {
	readonly schemaVersion: 2;
	readonly workspaceId: string;
	readonly updatedAt: number;
	readonly states: readonly IVSCloneThreadRuntimeState[];
	readonly deletedThreadIds: readonly string[];
}

interface ILoopIterationResult {
	readonly responseText: string;
	readonly responseTranscriptText: string;
	readonly toolCall?: IVSCloneLLMMessageToolCall;
	/**
	 * Streaming reasoning text captured from the provider. Mirrors Void's `fullReasoning` and is
	 * persisted onto the assistant turn so reload and branch operations see the same "Thinking..."
	 * content without rerunning the model.
	 */
	readonly reasoning?: string;
	/**
	 * Anthropic-specific signed thinking blocks. Round-tripped verbatim on subsequent turns so the
	 * provider can verify the server-issued signature. Null when the provider did not emit any.
	 */
	readonly anthropicReasoning?: readonly IVSCloneLLMMessageReasoningBlock[] | null;
	readonly errorMessage?: string;
	readonly aborted: boolean;
}

/**
 * This service owns the live VSClone thread model: user/assistant/tool/checkpoint messages,
 * active branch state, and durable paused approvals. Runtime state is the only canonical
 * conversation record; threads exist here or they do not exist at all.
 */
export class VSCloneThreadRuntimeService extends Disposable implements IVSCloneThreadRuntimeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<IVSCloneThreadRuntimeState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly _onDidChangeAutoApproveEdits = this._register(new Emitter<boolean>());
	readonly onDidChangeAutoApproveEdits = this._onDidChangeAutoApproveEdits.event;

	private readonly states = new Map<string, IVSCloneThreadRuntimeState>();
	private readonly deletedThreadIds = new Set<string>();
	private readonly activeExecutions = new Map<string, IActiveThreadExecution>();

	constructor(
		@IVSCloneOAuthService private readonly oauthService: IVSCloneOAuthService,
		@IVSCloneLLMMessageService private readonly llmMessageService: IVSCloneLLMMessageService,
		@IVSCloneConvertToLLMMessageService private readonly convertToLLMMessageService: IVSCloneConvertToLLMMessageService,
		@IVSCloneSettingsService private readonly settingsService: IVSCloneSettingsService,
		@IVSCloneToolRuntimeService private readonly toolRuntimeService: IVSCloneToolRuntimeService,
		@IVSCloneToolExecutionService private readonly toolExecutionService: IVSCloneToolExecutionService = {
			_serviceBrand: undefined,
			executeTool: async () => ({ success: false, output: 'Tool execution service is unavailable.' }),
		},
		@IVSCloneUnifiedChatBackendService private readonly unifiedChatBackendService: IVSCloneUnifiedChatBackendService,
		@IFileService private readonly fileService: IFileService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		private readonly persistedToolExecutionTimeoutMs: number = defaultPersistedToolExecutionTimeoutMs,
	) {
		super();
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
				contextSelections: options.contextSelections,
			})];
		const nextMessages = [...(baseState?.messages ?? []), ...promptMessage];
		this.setState(options.threadId, {
			threadId: options.threadId,
			catalog: {
				threadId: options.threadId,
				sessionResource: options.sessionResource,
				// Thread titles should remain anchored to the first submitted user prompt. Resumed tool
				// continuations and later follow-ups intentionally keep the existing title instead of
				// letting background loop traffic rename the conversation.
				title: baseState?.catalog.title ?? (this.truncateCatalogText(options.promptText, 120) || options.threadId),
				activeModelIdentifier: options.modelIdentifier,
				createdAt: baseState?.catalog.createdAt ?? Date.now(),
				updatedAt: Date.now(),
				status: 'active',
				archived: baseState?.catalog.archived ?? false,
				turnCount: baseState?.catalog.turnCount ?? 0,
				lastTurnPreview: baseState?.catalog.lastTurnPreview ?? '',
			},
			turnId: options.turnId,
			mode: options.mode,
			streamState: { kind: 'llm' },
			messages: nextMessages,
			assistantEditApplications: baseState?.assistantEditApplications ?? [],
			checkpoints: baseState?.checkpoints ?? [],
			currentCheckpointId: baseState?.currentCheckpointId,
			branchHeadMessageId: nextMessages.at(-1)?.id ?? baseState?.branchHeadMessageId,
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
			reasoningEnabled: options.reasoningEnabled,
			reasoningBudget: options.reasoningBudget,
			systemMessage: options.systemMessage,
			imageAttachments: options.imageAttachments,
			contextSelections: options.contextSelections,
		};
		const pendingCheckpointByToolKey = new Map<string, readonly IVSCloneThreadRuntimeSnapshot[]>();
		const done = new DeferredPromise<void>();
		const execution: IActiveThreadExecution = {
			done: done.p,
			cancel: () => {
				if (execution.cancelled || execution.finished) {
					return;
				}
				execution.cancelled = true;
				// The runtime owns both the streaming request and the currently running tool. Cancelling
				// both here keeps the single thread-level stop action aligned with the execution branch.
				execution.activeRequest?.cancel();
				execution.activeToolTokenSource?.cancel();
			},
			pendingCheckpointByToolKey,
			runContext,
			pendingApproval: undefined,
			activeRequest: undefined,
			activeToolTokenSource: undefined,
			cancelled: false,
			finished: false,
		};
		this.activeExecutions.set(options.threadId, execution);
		void this.runLoop(options, execution).catch(error => {
			const message = error instanceof Error ? error.message : String(error);
			this.applyLoopError(options.threadId, options.turnId, execution, message);
		}).finally(() => {
			execution.finished = true;
			done.complete();
			if (this.activeExecutions.get(options.threadId) === execution) {
				this.activeExecutions.delete(options.threadId);
			}
			this.finishThread(options.threadId, { kind: 'idle' });
		});

		return {
			done: execution.done,
			cancel: () => this.cancelThread(options.threadId),
		};
	}

	recordRejectedTurn(options: {
		threadId: string;
		turnId: string;
		sessionResource: string;
		promptText: string;
		mode: IVSCloneThreadRuntimeRunOptions['mode'];
		reason: string;
		imageAttachments?: IVSCloneThreadRuntimeRunOptions['imageAttachments'];
		contextSelections?: IVSCloneThreadRuntimeRunOptions['contextSelections'];
	}): void {
		const baseState = this.states.get(options.threadId);
		const userMessage = this.createMessage({
			role: 'user',
			mode: options.mode,
			createdAt: Date.now(),
			content: options.promptText,
			imageAttachments: options.imageAttachments,
			contextSelections: options.contextSelections,
		});
		const assistantMessage = this.createMessage({
			role: 'assistant',
			mode: options.mode,
			createdAt: Date.now(),
			content: options.reason,
		});
		this.setState(options.threadId, {
			threadId: options.threadId,
			catalog: {
				threadId: options.threadId,
				sessionResource: options.sessionResource,
				title: this.truncateCatalogText(options.promptText, 120) || options.threadId,
				activeModelIdentifier: baseState?.catalog.activeModelIdentifier,
				createdAt: baseState?.catalog.createdAt ?? Date.now(),
				updatedAt: Date.now(),
				status: 'failed',
				archived: baseState?.catalog.archived ?? false,
				turnCount: baseState?.catalog.turnCount ?? 0,
				lastTurnPreview: options.reason,
			},
			turnId: options.turnId,
			mode: options.mode,
			streamState: { kind: 'idle' },
			messages: [...(baseState?.messages ?? []), userMessage, assistantMessage],
			assistantEditApplications: baseState?.assistantEditApplications ?? [],
			checkpoints: baseState?.checkpoints ?? [],
			currentCheckpointId: baseState?.currentCheckpointId,
			branchHeadMessageId: assistantMessage.id,
			lastUpdatedAt: Date.now(),
		});
	}

	cancelThread(threadId: string): void {
		const execution = this.activeExecutions.get(threadId);
		if (!execution) {
			return;
		}

		execution.cancel();
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
			}));
			pendingApproval.deferred.complete({ kind: 'approved' });
			return true;
		}

		const pendingToolRequest = this.getAwaitingUserToolRequest(threadId);
		if (!pendingToolRequest) {
			return false;
		}

		this.appendMessage(threadId, {
			role: 'tool',
			createdAt: Date.now(),
			type: 'running_now',
			toolName: pendingToolRequest.toolName,
			approvalType: pendingToolRequest.approvalType,
			params: pendingToolRequest.params,
		});
		this.updateState(threadId, state => ({
			...state,
			streamState: { kind: 'tool', toolName: pendingToolRequest.toolName },
		}));
		void this.executePersistedApproval(threadId, pendingToolRequest);
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
			}));
			pendingApproval.deferred.complete({ kind: 'rejected', reason });
			return true;
		}

		const pendingToolRequest = this.getAwaitingUserToolRequest(threadId);
		if (!pendingToolRequest) {
			return false;
		}

		this.appendMessage(threadId, {
			role: 'tool',
			createdAt: Date.now(),
			type: 'rejected',
			toolName: pendingToolRequest.toolName,
			approvalType: pendingToolRequest.approvalType,
			params: pendingToolRequest.params,
			output: reason,
			success: false,
		});
		this.updateState(threadId, state => ({
			...state,
			streamState: { kind: 'idle' },
		}));
		// Reload-safe rejections should continue through the same follow-up loop the live runtime
		// uses. The rejected tool message is already persisted above, so resume from runtime state
		// instead of terminating the restored thread at the approval boundary.
		this.resumeThreadFromPersistedToolDecision(threadId, pendingToolRequest, 'rejection');
		return true;
	}

	isAutoApproveEdits(): boolean {
		return this.storageService.getBoolean(autoApproveEditsStorageKey, StorageScope.WORKSPACE, false);
	}

	setAutoApproveEdits(enabled: boolean): void {
		if (this.isAutoApproveEdits() === enabled) {
			return;
		}
		if (enabled) {
			this.storageService.store(autoApproveEditsStorageKey, true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} else {
			this.storageService.remove(autoApproveEditsStorageKey, StorageScope.WORKSPACE);
		}
		this._onDidChangeAutoApproveEdits.fire(enabled);
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
		this.storePersistedState();
		// Runtime state now defines thread existence, so it also owns clearing the small persisted
		// sidecar maps layered on top of threads. Doing that here prevents delete callers in the pane
		// and command actions from drifting and leaving stale model/plan entries behind.
		void this.unifiedChatBackendService.deleteThread(threadId).catch(error => {
			this.logService.error('[VSCloneThreadRuntime] Failed to delete unified chat sidecar state for thread.', error);
		});
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
		const removedStates = [...this.states.values()];
		for (const threadId of [...this.activeExecutions.keys()]) {
			this.cancelThread(threadId);
		}
		this.activeExecutions.clear();
		this.states.clear();
		this.deletedThreadIds.clear();
		this.storePersistedState();
		// Workspace-wide clears must drop the thread sidecars too or a later restore will resurrect
		// model selections and plan-mode state for threads that no longer exist in runtime storage.
		void this.unifiedChatBackendService.clearAll().catch(error => {
			this.logService.error('[VSCloneThreadRuntime] Failed to clear unified chat sidecar state.', error);
		});
		for (const state of removedStates) {
			this._onDidChangeState.fire({
				...state,
				lastUpdatedAt: Date.now(),
			});
		}
	}

	getState(threadId: string): IVSCloneThreadRuntimeState | undefined {
		return this.states.get(threadId);
	}

	getAssistantEditStatus(threadId: string, messageId: string): IVSCloneThreadRuntimeAssistantEditStatus | undefined {
		return this.getAssistantEditStatuses(threadId).find(status => status.messageId === messageId);
	}

	getAssistantEditStatuses(threadId: string): readonly IVSCloneThreadRuntimeAssistantEditStatus[] {
		const state = this.states.get(threadId);
		if (!state) {
			return [];
		}

		const applicationsByMessageId = new Map(
			(state.assistantEditApplications ?? []).map(application => [application.messageId, application.state] as const),
		);
		const statuses: IVSCloneThreadRuntimeAssistantEditStatus[] = [];
		for (const message of state.messages) {
			if (message.role !== 'assistant') {
				continue;
			}
			const suggestion = message.metadata?.editSuggestion;
			if (!suggestion) {
				continue;
			}
			statuses.push({
				messageId: message.id,
				suggestion,
				application: applicationsByMessageId.get(message.id),
			});
		}
		return statuses;
	}

	getAssistantEditApplicationState(threadId: string, messageId: string): IVSCloneThreadRuntimeAssistantEditApplicationState | undefined {
		return this.getAssistantEditStatus(threadId, messageId)?.application;
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

		const assistantMessageIndex = current.messages.findIndex(message =>
			message.role === 'assistant' && message.id === messageId,
		);
		const assistantMessage = assistantMessageIndex >= 0
			? current.messages[assistantMessageIndex] as Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>
			: undefined;
		if (!assistantMessage) {
			return;
		}

		const suggestion = this.getAssistantMessageEditSuggestion(assistantMessage);
		if (!suggestion) {
			// Apply state is only valid for assistant messages that runtime already marked as
			// applicable. Dropping writes here keeps the durable state aligned with the same runtime
			// availability signal the pane should render from.
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
			streamState: { kind: 'idle' },
			lastUpdatedAt: Date.now(),
		});
		return true;
	}

	private restorePersistedStates(): void {
		const persisted = this.readPersistedState();
		if (!persisted) {
			return;
		}

		for (const threadId of persisted.deletedThreadIds) {
			this.deletedThreadIds.add(threadId);
		}
		for (const state of persisted.states) {
			const normalized = this.normalizeRestoredState(state);
			this.states.set(normalized.threadId, normalized);
		}
	}

	/**
	 * Phase 1.3 intentionally collapses the old per-thread serializer/store pair into one runtime-
	 * owned workspace payload. Persisting one blob makes the thread owner the only place that knows
	 * how chat history is stored, and the version bump explicitly drops old thread data instead of
	 * carrying migration code forward.
	 */
	private readPersistedState(): IVSClonePersistedThreadRuntimePayload | undefined {
		const raw = this.storageService.get(runtimeStorageKey, StorageScope.WORKSPACE);
		if (!raw) {
			return undefined;
		}

		try {
			const currentWorkspaceId = this.workspaceContextService.getWorkspace().id;
			const parsed = JSON.parse(raw, (_key, value) => {
				if (value && typeof value === 'object' && value.$mid === 1) {
					return URI.revive(value);
				}
				return value;
			}) as Partial<IVSClonePersistedThreadRuntimePayload>;
			if (parsed.schemaVersion !== 2 || !Array.isArray(parsed.states) || !Array.isArray(parsed.deletedThreadIds)) {
				throw new Error('Malformed VSClone runtime storage payload.');
			}
			if (typeof parsed.workspaceId === 'string' && parsed.workspaceId.length > 0 && parsed.workspaceId !== currentWorkspaceId) {
				this.logService.warn('[VSCloneThreadRuntime] Dropping persisted runtime state from a different workspace.', {
					storedWorkspaceId: parsed.workspaceId,
					currentWorkspaceId,
				});
				this.storageService.remove(runtimeStorageKey, StorageScope.WORKSPACE);
				return undefined;
			}
			return {
				schemaVersion: 2,
				workspaceId: typeof parsed.workspaceId === 'string' ? parsed.workspaceId : currentWorkspaceId,
				updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
				states: parsed.states as readonly IVSCloneThreadRuntimeState[],
				deletedThreadIds: parsed.deletedThreadIds as readonly string[],
			};
		} catch (error) {
			this.logService.warn('[VSCloneThreadRuntime] Failed to read persisted runtime state; dropping stored threads.', error);
			this.storageService.remove(runtimeStorageKey, StorageScope.WORKSPACE);
			return undefined;
		}
	}

	private storePersistedState(): void {
		if (this.states.size === 0 && this.deletedThreadIds.size === 0) {
			this.storageService.remove(runtimeStorageKey, StorageScope.WORKSPACE);
			return;
		}

		const payload: IVSClonePersistedThreadRuntimePayload = {
			schemaVersion: 2,
			workspaceId: this.workspaceContextService.getWorkspace().id,
			updatedAt: Date.now(),
			states: [...this.states.values()],
			deletedThreadIds: [...this.deletedThreadIds.values()].sort((left, right) => left.localeCompare(right)),
		};
		this.storageService.store(
			runtimeStorageKey,
			JSON.stringify(payload),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
	}

	private async executePersistedApproval(threadId: string, pendingToolRequest: IVSCloneThreadRuntimeToolRequestMessage): Promise<void> {
		const pendingCheckpointByToolKey = new Map<string, readonly IVSCloneThreadRuntimeSnapshot[]>();
		pendingCheckpointByToolKey.set(
			this.getToolInvocationKey(pendingToolRequest.toolName, pendingToolRequest.params),
			pendingToolRequest.snapshots,
		);
		const toolTokenSource = new CancellationTokenSource();
		let cancelledByUser = false;
		this.activeExecutions.set(threadId, {
			done: Promise.resolve(),
			cancel: () => {
				cancelledByUser = true;
				toolTokenSource.cancel();
			},
			pendingCheckpointByToolKey,
			runContext: pendingToolRequest.run,
			pendingApproval: undefined,
			activeRequest: undefined,
			activeToolTokenSource: toolTokenSource,
			cancelled: false,
			finished: false,
		});

		let result: IVSCloneToolExecutionResult;
		try {
			result = await this.executePersistedToolWithSafety(
				pendingToolRequest.toolName,
				pendingToolRequest.params,
				pendingToolRequest.run.mode,
				toolTokenSource,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result = { success: false, output: message };
		}

		const toolResultMessage = this.recordToolResult(
			threadId,
			pendingToolRequest.toolName,
			pendingToolRequest.params,
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

		this.resumeThreadFromPersistedToolDecision(threadId, pendingToolRequest, 'approval');
	}

	/**
	 * Phase 1.2 moves the live execution loop into the runtime owner so the thread service/running
	 * state/checkpoint logic no longer round-trips through a separate agent-loop facade.
	 */
	private async runLoop(options: IVSCloneThreadRuntimeRunOptions, execution: IActiveThreadExecution): Promise<void> {
		this.logTrace('info', `Starting runtime loop for thread ${options.threadId} (turn ${options.turnId})`);
		const messages: IVSCloneChatTransportConversationMessage[] = [...(options.previousTurns ?? [])];
		if (options.promptText || (options.imageAttachments?.length ?? 0) > 0) {
			messages.push({
				role: 'user',
				content: options.promptText,
				imageAttachments: options.imageAttachments,
				contextSelections: options.contextSelections,
			});
		}
		let assistantResponseText = '';
		for (let iteration = 1; iteration <= maxAgentIterations; iteration++) {
			this.logTrace('debug', `Runtime iteration ${iteration} for thread ${options.threadId}`);
			if (execution.cancelled) {
				this.applyLoopCancel(options.threadId, options.turnId, execution);
				return;
			}

			const responsePrefix = assistantResponseText;
			const iterationResult = await this.runModelIteration(options, messages, execution);
			assistantResponseText = `${responsePrefix}${iterationResult.responseTranscriptText}`;
			if (iterationResult.errorMessage) {
				this.applyLoopError(options.threadId, options.turnId, execution, iterationResult.errorMessage);
				return;
			}
			if (execution.cancelled || iterationResult.aborted) {
				this.applyLoopCancel(options.threadId, options.turnId, execution);
				return;
			}

			const visibleAssistantText = normalizeAssistantTranscriptText(iterationResult.responseText);
			if (visibleAssistantText !== iterationResult.responseText) {
				assistantResponseText = this.replaceCurrentIterationTranscript(
					options.threadId,
					responsePrefix,
					visibleAssistantText,
				);
			}

			const toolCall = iterationResult.toolCall;
			if (!toolCall) {
				this.applyLoopComplete(options.threadId, options.turnId, execution);
				return;
			}

			if (execution.cancelled) {
				this.applyLoopCancel(options.threadId, options.turnId, execution);
				return;
			}

			this.ensureAssistantResponse(options.threadId, visibleAssistantText, options.mode);

			let approvalDecision: VSCloneThreadToolApprovalDecision;
			try {
				approvalDecision = await this.recordToolRequested(
					options.threadId,
					toolCall.name,
					toolCall.rawParams,
					execution.pendingCheckpointByToolKey,
					execution.runContext,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.applyLoopError(options.threadId, options.turnId, execution, `Tool approval failed for ${toolCall.name}: ${message}`);
				return;
			}
			if (execution.cancelled) {
				this.applyLoopCancel(options.threadId, options.turnId, execution);
				return;
			}

			this.logTrace('info', `[Tool Attempt] ${toolCall.name}`);
			let formattedToolResult: string;
			if (approvalDecision.kind === 'rejected') {
				// `rejectLatestToolRequest()` already records the terminal rejected tool message in the
				// durable runtime transcript. Re-recording a synthetic failed result here would create a
				// second terminal outcome (`rejected` plus `tool_error`) for the same invocation.
				const rejectedResult = {
					success: false,
					output: approvalDecision.reason ?? 'Tool request was rejected.',
				};
				formattedToolResult = formatToolResult(toolCall.name, rejectedResult);
				this.logTrace('warn', `[Tool Result] ${toolCall.name} rejected`);
			} else {
				const toolResult = await this.executeToolWithCancellation(toolCall.name, toolCall.rawParams, options.mode, execution);
				this.recordToolResult(
					options.threadId,
					toolCall.name,
					toolCall.rawParams,
					toolResult,
					execution.pendingCheckpointByToolKey,
				);
				formattedToolResult = formatToolResult(toolCall.name, toolResult);
				this.logTrace(toolResult.success ? 'info' : 'warn', `[Tool Result] ${toolCall.name} ${toolResult.success ? 'succeeded' : 'failed'}`);
			}

			if (execution.cancelled) {
				this.applyLoopCancel(options.threadId, options.turnId, execution);
				return;
			}

			messages.push({
				role: 'assistant',
				content: visibleAssistantText,
				// Mirror Void: carry the signed Anthropic thinking blocks onto the stored assistant
				// turn so the follow-up request replays them verbatim. Anthropic rejects multi-turn
				// requests that drop the server-issued signatures.
				anthropicReasoning: iterationResult.anthropicReasoning,
			});
			messages.push({
				role: 'tool',
				id: toolCall.id,
				name: toolCall.name,
				rawParams: toolCall.rawParams,
				content: formattedToolResult,
			});

			if (toolCall.name === 'attempt_completion') {
				this.applyLoopComplete(options.threadId, options.turnId, execution);
				return;
			}
		}

		this.applyLoopError(options.threadId, options.turnId, execution, `Agent loop exceeded the safety limit of ${maxAgentIterations} iterations.`);
	}

	private async executeToolWithCancellation(
		toolName: string,
		params: Record<string, string>,
		mode: VSCloneChatMode,
		execution: IActiveThreadExecution,
	): Promise<IVSCloneToolExecutionResult> {
		const tokenSource = new CancellationTokenSource();
		execution.activeToolTokenSource = tokenSource;
		try {
			const toolExecution = this.toolExecutionService.executeTool(toolName, params, mode, tokenSource.token);
			const result = await raceTimeout(toolExecution, liveToolExecutionTimeoutMs, () => {
				this.logTrace('warn', `Tool ${toolName} exceeded ${liveToolExecutionTimeoutMs}ms; cancelling and continuing.`);
				tokenSource.cancel();
			});
			if (result) {
				return result;
			}
			return {
				success: false,
				output: `Tool ${toolName} did not finish within ${Math.round(liveToolExecutionTimeoutMs / 1000)} seconds and was cancelled.`,
			};
		} finally {
			if (execution.activeToolTokenSource === tokenSource) {
				execution.activeToolTokenSource = undefined;
			}
			tokenSource.dispose();
		}
	}

	private async runModelIteration(
		options: IVSCloneThreadRuntimeRunOptions,
		messages: readonly IVSCloneChatTransportConversationMessage[],
		execution: IActiveThreadExecution,
	): Promise<ILoopIterationResult> {
		const currentTurn = messages.at(-1);
		if (!currentTurn) {
			return {
				responseText: '',
				responseTranscriptText: '',
				errorMessage: 'Agent loop requires at least one conversation message before each model call.',
				aborted: false,
			};
		}

		let responseText = '';
		let responseTranscriptText = '';
		let toolCall: IVSCloneLLMMessageToolCall | undefined;
		let reasoning = '';
		let anthropicReasoning: readonly IVSCloneLLMMessageReasoningBlock[] | null = null;
		let errorMessage: string | undefined;
		let aborted = false;

		try {
			const headers = await this.oauthService.getApiHeaders(options.vendor);
			if (execution.cancelled) {
				return {
					responseText,
					responseTranscriptText,
					toolCall,
					reasoning,
					anthropicReasoning,
					aborted: true,
				};
			}
			if (!headers) {
				return {
					responseText,
					responseTranscriptText,
					toolCall,
					reasoning,
					anthropicReasoning,
					errorMessage: `Not signed in to ${options.vendor}`,
					aborted: false,
				};
			}

			const request = this.llmMessageService.sendChatRequest({
				kind: 'chat',
				auth: {
					vendor: options.vendor,
					headers,
				},
				prepared: this.convertToLLMMessageService.prepareChatRequest({
					threadId: options.threadId,
					turnId: options.turnId,
					sequence: options.sequence,
					sessionResource: options.sessionResource,
					mode: options.mode,
					vendor: options.vendor,
					modelId: options.modelId,
					modelIdentifier: options.modelIdentifier,
					reasoningEffort: options.reasoningEffort,
					reasoningEnabled: options.reasoningEnabled,
					reasoningBudget: options.reasoningBudget,
					previousTurns: messages.slice(0, -1),
					currentTurn,
					systemMessage: options.systemMessage,
				}),
			}, {
				onText: payload => {
					// Reasoning deltas arrive alongside text deltas on the same stream; keep the latest
					// cumulative reasoning string so reload and the collapsible UI both see the stream-
					// time "Thinking..." content without reparsing provider transport chunks.
					if (payload.fullReasoning !== undefined) {
						reasoning = payload.fullReasoning;
						this.recordAssistantReasoning(options.threadId, reasoning);
					}
					if (!payload.text) {
						return;
					}

					responseText += payload.text;
					responseTranscriptText = this.appendAssistantDeltaToRuntime(options.threadId, responseTranscriptText, payload.text);
				},
				onError: payload => {
					errorMessage = payload.message;
					this.recordEligibilityFailureIfAny(options.vendor, options.modelIdentifier, payload.message);
				},
				onFinalMessage: payload => {
					// Final payloads are authoritative even when a provider buffers text until the end
					// or only returns a native tool call with no text deltas. Syncing the runtime-owned
					// assistant message here avoids silently dropping zero-text tool turns.
					responseText = payload.fullText;
					reasoning = payload.fullReasoning ?? reasoning;
					anthropicReasoning = payload.anthropicReasoning ?? null;
					responseTranscriptText = this.replaceCurrentIterationTranscript(
						options.threadId,
						'',
						payload.fullText,
					);
					this.applyAssistantReasoningFinal(options.threadId, reasoning, anthropicReasoning);
					toolCall = payload.toolCall;
				},
				onAbort: () => {
					aborted = true;
				},
			});

			execution.activeRequest = request;
			await request.done;
			if (execution.activeRequest === request) {
				execution.activeRequest = undefined;
			}
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		}

		return {
			responseText,
			responseTranscriptText,
			toolCall,
			reasoning,
			anthropicReasoning,
			errorMessage,
			aborted,
		};
	}

	private appendAssistantDeltaToRuntime(threadId: string, responseText: string, delta: string): string {
		if (!delta) {
			return responseText;
		}
		this.recordAssistantDelta(threadId, delta);
		return responseText + delta;
	}

	private replaceCurrentIterationTranscript(threadId: string, responsePrefix: string, sanitizedIterationText: string): string {
		const replacementText = `${responsePrefix}${sanitizedIterationText}`;
		this.replaceAssistantResponse(threadId, replacementText);
		return replacementText;
	}

	private applyLoopComplete(threadId: string, turnId: string, execution: IActiveThreadExecution): void {
		if (execution.finished) {
			return;
		}
		execution.finished = true;
		this.logTrace('info', `Runtime loop completed for thread ${threadId} (turn ${turnId})`);
	}

	private applyLoopError(threadId: string, turnId: string, execution: IActiveThreadExecution, message: string): void {
		if (execution.finished) {
			return;
		}
		execution.finished = true;
		this.logTrace('error', `Runtime loop failed for thread ${threadId} (turn ${turnId}): ${message}`);
		this.replaceAssistantResponse(threadId, message);
	}

	private applyLoopCancel(threadId: string, turnId: string, execution: IActiveThreadExecution): void {
		if (execution.finished) {
			return;
		}
		execution.finished = true;
		this.logTrace('info', `Runtime loop cancelled for thread ${threadId} (turn ${turnId})`);
	}

	private recordEligibilityFailureIfAny(vendor: IVSCloneThreadRuntimeRunOptions['vendor'], modelIdentifier: string, errorMessage: string): void {
		const reason = detectEligibilityFailureReason(vendor, errorMessage);
		if (!reason) {
			return;
		}

		this.logTrace('info', `Marking ${modelIdentifier} ineligible for this account: ${reason}`);
		void this.settingsService.markModelIneligible(modelIdentifier, reason);
	}

	private logTrace(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
		const formatted = `[VSCloneThreadRuntime] ${message}`;
		switch (level) {
			case 'debug':
				this.logService.debug(formatted);
				break;
			case 'info':
				this.logService.info(formatted);
				break;
			case 'warn':
				this.logService.warn(formatted);
				break;
			case 'error':
				this.logService.error(formatted);
				break;
		}
	}

	/**
	 * Reload-safe approvals still need the same timeout and explicit cancellation hook as the live
	 * runtime loop. Otherwise a hung tool after reload would strand the restored thread forever.
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
		const requestedAt = Date.now();
		const toolRequestMessage = this.appendMessage(threadId, {
			role: 'tool',
			createdAt: requestedAt,
			type: 'tool_request',
			toolName,
			approvalType,
			params,
			requestedAt,
			snapshots: [],
			run: runContext,
		}) as IVSCloneThreadRuntimeToolRequestMessage | undefined;

		// Workspace-scoped auto-approve: skip the interactive wait for edits so repeat approvals
		// don't block an agent that the user has already trusted for this project. Snapshot capture
		// still runs below via the standard approved-path fall-through so checkpoints remain intact.
		if (approvalType === 'edits' && this.isAutoApproveEdits() && toolRequestMessage) {
			this.updateToolRequestSnapshots(threadId, toolRequestMessage.id, []);
			void this.captureCheckpointSnapshots(toolName, params).then(snapshots => {
				if (snapshots.length > 0) {
					pendingCheckpointByToolKey.set(this.getToolInvocationKey(toolName, params), snapshots);
					this.updateToolRequestSnapshots(threadId, toolRequestMessage.id, snapshots);
				}
			}, error => {
				this.logService.warn('[VSCloneThreadRuntime] Failed to capture checkpoints for auto-approved %s: %s', toolName, error instanceof Error ? error.message : String(error));
			});
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

		if (approvalType && toolRequestMessage) {
			const execution = this.activeExecutions.get(threadId);
			if (execution) {
				const pendingApproval: IPendingApproval = {
					deferred: new DeferredPromise<VSCloneThreadToolApprovalDecision>(),
					requestedAt: toolRequestMessage.requestedAt,
					toolName,
					params,
					approvalType,
					status: 'pending',
				};
				execution.pendingApproval = pendingApproval;
				this.updateState(threadId, state => ({
					...state,
					streamState: { kind: 'awaiting_user', toolName, approvalType },
				}));
				const snapshotPromise = this.captureCheckpointSnapshots(toolName, params).then(snapshots => {
					if (snapshots.length > 0 && pendingApproval.status !== 'rejected') {
						pendingCheckpointByToolKey.set(this.getToolInvocationKey(toolName, params), snapshots);
					}
					if (pendingApproval.status === 'pending') {
						// Snapshot capture is asynchronous, so update the original request message in
						// place instead of reviving a parallel paused-approval state just to persist it.
						this.updateToolRequestSnapshots(threadId, toolRequestMessage.id, snapshots);
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
			updatedMessages[updatedMessages.length - 1] = this.normalizeRuntimeConversationMessage({
				...lastMessage,
				content: lastMessage.content + delta,
			}, current.mode);
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

	/**
	 * Streams the latest reasoning string onto the current assistant turn. Mirrors Void's behavior
	 * of attaching `reasoning` alongside `content` on the assistant chat message so reload and the
	 * collapsible UI see the same "Thinking..." text without reparsing transport events.
	 */
	private recordAssistantReasoning(threadId: string, reasoning: string): void {
		const current = this.states.get(threadId);
		if (!current) {
			return;
		}

		const lastMessage = current.messages.at(-1);
		if (lastMessage?.role === 'assistant') {
			if ((lastMessage.reasoning ?? '') === reasoning) {
				return;
			}
			const updatedMessages = [...current.messages];
			updatedMessages[updatedMessages.length - 1] = this.normalizeRuntimeConversationMessage({
				...lastMessage,
				reasoning,
			}, current.mode);
			this.setState(threadId, {
				...current,
				messages: updatedMessages,
				branchHeadMessageId: lastMessage.id,
				streamState: { kind: 'llm' },
				lastUpdatedAt: Date.now(),
			});
			return;
		}

		// No assistant message yet (e.g. the provider buffers text until the final event). Create an
		// empty-text assistant turn so the reasoning has somewhere to live until text arrives.
		const assistantMessage = this.createMessage({
			role: 'assistant',
			mode: current.mode ?? 'act',
			createdAt: Date.now(),
			content: '',
			reasoning,
		});
		this.setState(threadId, {
			...current,
			messages: [...current.messages, assistantMessage],
			branchHeadMessageId: assistantMessage.id,
			streamState: { kind: 'llm' },
			lastUpdatedAt: Date.now(),
		});
	}

	/**
	 * Apply the final reasoning snapshot: the cumulative `reasoning` text plus the verbatim
	 * Anthropic thinking blocks. The blocks must persist exactly as received so a later turn can
	 * replay them back into Anthropic with the server-issued signatures intact.
	 */
	private applyAssistantReasoningFinal(
		threadId: string,
		reasoning: string,
		anthropicReasoning: readonly IVSCloneLLMMessageReasoningBlock[] | null,
	): void {
		const current = this.states.get(threadId);
		if (!current) {
			return;
		}
		const lastMessage = current.messages.at(-1);
		if (lastMessage?.role !== 'assistant') {
			return;
		}
		const updatedMessages = [...current.messages];
		updatedMessages[updatedMessages.length - 1] = this.normalizeRuntimeConversationMessage({
			...lastMessage,
			reasoning,
			anthropicReasoning,
		}, current.mode);
		this.setState(threadId, {
			...current,
			messages: updatedMessages,
			branchHeadMessageId: lastMessage.id,
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
			updatedMessages[updatedMessages.length - 1] = this.normalizeRuntimeConversationMessage({
				...lastMessage,
				content: responseText,
			}, current.mode);
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

	private ensureAssistantResponse(
		threadId: string,
		responseText: string,
		mode: IVSCloneThreadRuntimeRunOptions['mode'],
	): void {
		const normalized = normalizeAssistantTranscriptText(responseText);
		if (normalized.length > 0) {
			this.replaceAssistantResponse(threadId, normalized);
			return;
		}

		const current = this.states.get(threadId);
		if (!current) {
			return;
		}
		const lastMessage = current.messages.at(-1);
		if (lastMessage?.role === 'assistant') {
			return;
		}

		const assistantMessage = this.createMessage({
			role: 'assistant',
			mode: mode ?? current.mode ?? 'act',
			createdAt: Date.now(),
			content: '',
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
		const runtimeMessage = this.createMessage(message as Omit<IVSCloneThreadRuntimeMessage, 'id'>);
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
			streamState,
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
		const previousMessagesById = new Map(previous?.messages.map(message => [message.id, message] as const) ?? []);
		const messages = nextState.messages.map(message => this.normalizeRuntimeConversationMessage(
			message,
			nextState.mode,
			previousMessagesById.get(message.id),
		));
		const assistantEditApplications = this.normalizeAssistantEditApplications(
			nextState.assistantEditApplications ?? [],
			messages,
			'keep',
		);
		const normalized: IVSCloneThreadRuntimeState = {
			...nextState,
			messages,
			catalog: this.normalizeCatalogEntry(threadId, {
				...nextState,
				messages,
			}, previous),
			assistantEditApplications,
			branchHeadMessageId: nextState.branchHeadMessageId ?? messages.at(-1)?.id,
		};
		this.states.set(threadId, normalized);
		this.deletedThreadIds.delete(threadId);
		this.storePersistedState();
		this._onDidChangeState.fire(normalized);
	}

	private createMessage(message: Omit<Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'user' }>, 'id'>): Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'user' }>;
	private createMessage(message: Omit<Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>, 'id'>): Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>;
	private createMessage(message: Omit<Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'tool' }>, 'id'>): Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'tool' }>;
	private createMessage(message: Omit<Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'checkpoint' }>, 'id'>): Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'checkpoint' }>;
	private createMessage(message: Omit<IVSCloneThreadRuntimeMessage, 'id'>): IVSCloneThreadRuntimeMessage;
	private createMessage(message: Omit<IVSCloneThreadRuntimeMessage, 'id'>): IVSCloneThreadRuntimeMessage {
		// Spreading an Omit<Union, 'id'> loses discriminant narrowing, so build each variant by role
		// and cast each branch back into its concrete union member.
		const id = generateUuid();
		// eslint-disable-next-line local/code-no-dangerous-type-assertions
		const withId = { id, ...message } as IVSCloneThreadRuntimeMessage;
		if (withId.role === 'assistant') {
			// Assistant messages pick up durable edit-apply metadata at creation time so the pane can
			// later trust runtime state directly instead of re-parsing transcript text.
			return this.normalizeRuntimeConversationMessage(withId, withId.mode);
		}
		return withId;
	}

	private updateToolRequestSnapshots(
		threadId: string,
		toolRequestMessageId: string,
		snapshots: readonly IVSCloneThreadRuntimeSnapshot[],
	): void {
		this.updateState(threadId, current => ({
			...current,
			messages: current.messages.map(message => {
				if (message.id !== toolRequestMessageId || message.role !== 'tool' || message.type !== 'tool_request') {
					return message;
				}
				return {
					...message,
					snapshots,
				};
			}),
		}));
	}

	private getAwaitingUserToolRequest(threadId: string): IVSCloneThreadRuntimeToolRequestMessage | undefined {
		const state = this.states.get(threadId);
		return state ? this.getAwaitingUserToolRequestFromState(state) : undefined;
	}

	private getAwaitingUserToolRequestFromState(
		state: Pick<IVSCloneThreadRuntimeState, 'messages' | 'streamState'>,
	): IVSCloneThreadRuntimeToolRequestMessage | undefined {
		if (state.streamState.kind !== 'awaiting_user') {
			return undefined;
		}

		for (let index = state.messages.length - 1; index >= 0; index--) {
			const message = state.messages[index];
			if (message.role === 'tool' && message.type === 'tool_request') {
				return message;
			}
		}
		return undefined;
	}

	private normalizeRestoredState(state: IVSCloneThreadRuntimeState): IVSCloneThreadRuntimeState {
		const messages = state.messages.map(message => this.normalizeRestoredConversationMessage(
			message,
			state.mode,
		));
		const messageIds = new Set(messages.map(message => message.id));
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
		const normalizedStateBase: Omit<IVSCloneThreadRuntimeState, 'catalog' | 'streamState'> = {
			threadId: state.threadId,
			turnId: state.turnId,
			mode: state.mode,
			messages,
			assistantEditApplications,
			checkpoints: state.checkpoints,
			currentCheckpointId,
			branchHeadMessageId,
			lastUpdatedAt: state.lastUpdatedAt,
		};
		const pendingToolRequest = this.getAwaitingUserToolRequestFromState({
			...normalizedStateBase,
			streamState: state.streamState,
		});
		const streamState = pendingToolRequest
			? {
				kind: 'awaiting_user' as const,
				toolName: pendingToolRequest.toolName,
				approvalType: pendingToolRequest.approvalType,
			}
			: { kind: 'idle' as const };
		return {
			...normalizedStateBase,
			streamState,
			catalog: this.normalizeCatalogEntry(state.threadId, {
				...normalizedStateBase,
				streamState,
			}),
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
			if (!this.getAssistantMessageEditSuggestion(message)) {
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

	private getAssistantMessageEditSuggestion(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }> | undefined,
	): IVSCloneThreadRuntimeAssistantEditSuggestion | undefined {
		return message?.metadata?.editSuggestion;
	}

	private hasPendingAssistantEditApplication(state: IVSCloneThreadRuntimeState): boolean {
		return (state.assistantEditApplications ?? []).some(application => application.state.phase === 'pending');
	}

	private hasPendingUserDecision(state: IVSCloneThreadRuntimeState): boolean {
		return state.streamState.kind === 'awaiting_user';
	}

	private normalizeRestoredConversationMessage(
		message: IVSCloneThreadRuntimeMessage,
		threadMode: IVSCloneThreadRuntimeState['mode'],
	): IVSCloneThreadRuntimeMessage {
		if (message.role === 'user') {
			return { ...message, mode: message.mode ?? threadMode ?? 'act' };
		}
		if (message.role === 'assistant') {
			const editSuggestion = this.getAssistantEditSuggestion(message, threadMode, undefined);
			const { metadata: _staleMetadata, ...rest } = message;
			return {
				...rest,
				mode: message.mode ?? threadMode ?? 'act',
				...(editSuggestion ? { metadata: { editSuggestion } } : {}),
			};
		}
		return message;
	}

	private normalizeRuntimeConversationMessage(
		message: IVSCloneThreadRuntimeMessage,
		threadMode: IVSCloneThreadRuntimeState['mode'],
		previousMessage?: IVSCloneThreadRuntimeMessage,
	): IVSCloneThreadRuntimeMessage {
		if (message.role === 'user') {
			return { ...message, mode: message.mode ?? threadMode ?? 'act' };
		}
		if (message.role !== 'assistant') {
			return message;
		}

		const editSuggestion = this.getAssistantEditSuggestion(message, threadMode, previousMessage);
		const { metadata: _staleMetadata, ...rest } = message;
		return {
			...rest,
			mode: message.mode ?? threadMode ?? 'act',
			...(editSuggestion ? { metadata: { editSuggestion } } : {}),
		};
	}

	/**
	 * Runtime owns the assistant-apply affordance. SEARCH/REPLACE eligibility is derived from
	 * assistant content once and stored in durable metadata so the pane can render/apply from the
	 * stored signal instead of re-parsing transcript text. If a prior message on the same branch
	 * already carried an explicit suggestion, preserve it so streaming/summary updates do not erase
	 * eligibility the runtime had already committed to.
	 */
	private getAssistantEditSuggestion(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>,
		threadMode: IVSCloneThreadRuntimeState['mode'],
		previousMessage: IVSCloneThreadRuntimeMessage | undefined,
	): IVSCloneThreadRuntimeAssistantEditSuggestion | undefined {
		const shouldPreserveExplicit = previousMessage?.role === 'assistant'
			&& previousMessage.id === message.id
			&& previousMessage.content === message.content
			&& (previousMessage.mode ?? threadMode ?? 'act') === (message.mode ?? threadMode ?? 'act')
			&& previousMessage.metadata?.editSuggestion !== undefined;
		if (shouldPreserveExplicit) {
			return message.metadata?.editSuggestion ?? previousMessage.metadata?.editSuggestion;
		}
		if (message.metadata?.editSuggestion) {
			return message.metadata.editSuggestion;
		}
		return this.toAssistantEditSuggestion(
			this.getAssistantEditSuggestionApplyMode(message.content, message.mode ?? threadMode ?? 'act'),
		);
	}

	private toAssistantEditSuggestion(
		applyMode: VSCloneThreadRuntimeAssistantEditSuggestionApplyMode | undefined,
	): IVSCloneThreadRuntimeConversationMessageMetadata['editSuggestion'] | undefined {
		return applyMode
			? {
				kind: 'search_replace',
				applyMode,
			}
			: undefined;
	}

	private getAssistantEditSuggestionApplyMode(
		content: string,
		mode: IVSCloneThreadRuntimeRunOptions['mode'],
	): VSCloneThreadRuntimeAssistantEditSuggestionApplyMode | undefined {
		if (mode === 'plan') {
			return undefined;
		}
		if (parseSearchReplaceBlocks(content).length === 0) {
			return undefined;
		}
		return 'auto';
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
		// Titles should be stable once a thread exists, but pre-catalog payloads still need a
		// deterministic fallback sourced from the first real conversation message rather than a
		// truthy/falsey precedence bug.
		// eslint-disable-next-line local/code-no-in-operator
		const lastToolOutput = lastMessage?.role === 'tool' && 'output' in lastMessage
			? lastMessage.output
			: undefined;
		const titleSource = fallbackCatalog?.title
			|| firstConversationMessage?.content
			|| threadId;
		const previewSource = latestConversationMessage?.content
			|| fallbackCatalog?.lastTurnPreview
			|| lastToolOutput
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
		};
	}

	private deriveCatalogStatus(
		state: Pick<IVSCloneThreadRuntimeState, 'messages' | 'streamState'>,
		archived: boolean,
		fallbackStatus: IVSCloneThreadRuntimeCatalogEntry['status'] | undefined,
	): IVSCloneThreadRuntimeCatalogEntry['status'] {
		if (archived) {
			return 'archived';
		}
		if (state.streamState.kind !== 'idle') {
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

	private toAgentLoopConversationMessagesFromRuntime(threadId: string, excludedToolResultMessageId?: string): IVSCloneChatTransportConversationMessage[] {
		const state = this.states.get(threadId);
		if (!state) {
			return [];
		}

		// The runtime is the canonical conversation record, so resumed approvals and follow-up sends
		// project directly from runtime state here instead of depending on a separate common helper.
		const messages: IVSCloneChatTransportConversationMessage[] = [];
		for (const message of state.messages) {
			switch (message.role) {
				case 'user': {
					const userMessage: IVSCloneChatTransportConversationMessage = {
						role: 'user',
						content: message.content,
						...(message.imageAttachments ? { imageAttachments: message.imageAttachments } : {}),
						...(message.contextSelections ? { contextSelections: message.contextSelections } : {}),
					};
					messages.push(userMessage);
					break;
				}
				case 'assistant':
					messages.push({
						role: 'assistant',
						content: message.content,
						...(message.anthropicReasoning ? { anthropicReasoning: message.anthropicReasoning } : {}),
					});
					break;
				case 'tool':
					if (message.id === excludedToolResultMessageId) {
						break;
					}
					if (message.type === 'success' || message.type === 'tool_error' || message.type === 'rejected') {
						messages.push({
							role: 'tool',
							id: message.id,
							name: message.toolName,
							rawParams: message.params,
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

	private resumeThreadFromPersistedToolDecision(
		threadId: string,
		pendingToolRequest: IVSCloneThreadRuntimeToolRequestMessage,
		decision: 'approval' | 'rejection',
	): void {
		// Persisted tool decisions must resume from the runtime transcript so reload-time approvals
		// and rejections produce the same assistant follow-up the live loop would have emitted.
		// Sanitize the persisted reasoning fields against the current model's capabilities before
		// replaying so a stale `reasoningEnabled: false` cannot survive a capability change. Mirrors
		// the capability-aware normalization applied to thread-bound selections on load. Does not
		// touch `anthropicReasoning`, which lives on the assistant message in `previousTurns`.
		const sanitizedReasoning = this.settingsService.sanitizeReasoningFields(pendingToolRequest.run.modelIdentifier, {
			reasoningEffort: pendingToolRequest.run.reasoningEffort,
			reasoningEnabled: pendingToolRequest.run.reasoningEnabled,
			reasoningBudget: pendingToolRequest.run.reasoningBudget,
		});
		const resumeHandle = this.runThread({
			...pendingToolRequest.run,
			reasoningEffort: sanitizedReasoning.reasoningEffort,
			reasoningEnabled: sanitizedReasoning.reasoningEnabled,
			reasoningBudget: sanitizedReasoning.reasoningBudget,
			threadId,
			promptText: '',
			previousTurns: this.toAgentLoopConversationMessagesFromRuntime(threadId),
			recordPromptMessage: false,
		});
		void resumeHandle.done.catch(error => {
			this.logService.error(`[VSCloneThreadRuntime] Failed to resume thread after persisted ${decision}.`, error);
		});
	}

	private resolveWorkspacePath(rawPath: string | undefined): URI | undefined {
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
		const resolved = resolveVSCloneWorkspacePath(workspaceFolders, rawPath);
		return resolved && this.workspaceContextService.isInsideWorkspace(resolved)
			? resolved
			: undefined;
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

function normalizeAssistantTranscriptText(value: string): string {
	return value
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

function detectEligibilityFailureReason(
	vendor: IVSCloneThreadRuntimeRunOptions['vendor'],
	errorMessage: string,
): string | undefined {
	if (vendor === 'openai' && /is not supported when using Codex with a ChatGPT account/i.test(errorMessage)) {
		return 'Your ChatGPT account is not entitled to use this model with Codex.';
	}
	return undefined;
}
