/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IVSCloneContextGatheringService } from './vscloneContextGatheringService.js';
import { IVSCloneThreadRuntimeService } from './vscloneThreadRuntimeService.js';
import { IVSCloneUnifiedChatBackendService } from '../common/backend/vscloneUnifiedChatBackendService.js';
import type { IVSCloneModelSelection } from '../common/vscloneModelSelectionTypes.js';
import type { IVSCloneChatTransportConversationMessage } from '../common/vscloneChatTransportTypes.js';
import type { IVSCloneContextSelection } from '../common/vscloneContextSelectionTypes.js';
import type { IVSCloneImageAttachment } from '../common/vscloneImageAttachmentTypes.js';
import { VSCloneModelVendor } from '../common/vscloneOAuthTypes.js';
import { type VSCloneChatMode } from '../common/vsclonePlanModeTypes.js';
import { IVSClonePlanModeService } from '../common/vsclonePlanModeService.js';
import { assembleVSCloneSystemMessage, buildVSCloneUserMessageContent } from '../common/vsclonePrompts.js';
import { IVSCloneSettingsService } from '../common/vscloneSettingsService.js';
import { deriveVSCloneThreadId } from '../common/vscloneThreadIds.js';
import { formatToolResult } from '../common/vscloneToolDefinitions.js';
import {
	type IVSCloneThreadRuntimeCatalogEntry,
	type IVSCloneThreadRuntimeCatalogQuery,
	type IVSCloneThreadRuntimeRunOptions,
	type IVSCloneThreadRuntimeState,
} from '../common/vscloneThreadRuntimeTypes.js';

export const IVSCloneChatThreadService = createDecorator<IVSCloneChatThreadService>('vscloneChatThreadService');

export interface IVSCloneChatThreadSubmitOptions {
	threadId?: string;
	sessionResource?: string;
	modelSelection?: IVSCloneModelSelection;
	imageAttachments?: readonly IVSCloneImageAttachment[];
	contextSelections?: readonly IVSCloneContextSelection[];
}

export interface IVSCloneChatThreadSubmitResult {
	threadId: string;
	sessionResource: string;
}

export interface IVSCloneChatThreadService {
	readonly _serviceBrand: undefined;
	sendMessage(promptText: string, options?: IVSCloneChatThreadSubmitOptions): Promise<IVSCloneChatThreadSubmitResult | undefined>;
	cancelThread(threadId: string): void;
	approveLatestToolRequest(threadId: string): boolean;
	rejectLatestToolRequest(threadId: string, reason?: string): boolean;
	getThreads(query?: IVSCloneThreadRuntimeCatalogQuery): readonly IVSCloneThreadRuntimeCatalogEntry[];
	isDeletedThread(threadId: string): boolean;
	archiveThread(threadId: string, archived: boolean): boolean;
	deleteThread(threadId: string): Promise<boolean>;
	clearAll(): Promise<void>;
	getState(threadId: string): IVSCloneThreadRuntimeState | undefined;
	rewindToCheckpoint(threadId: string, checkpointId: string): Promise<boolean>;
}

function createApiSessionResource(sessionId: string): string {
	return `vsclone://api/${encodeURIComponent(sessionId)}`;
}

function resolveThreadSubmissionIdentity(
	options: IVSCloneChatThreadSubmitOptions,
	runtimeState: IVSCloneThreadRuntimeState | undefined,
): IVSCloneChatThreadSubmitResult {
	const threadId = options.threadId;
	const sessionResource = options.sessionResource
		?? runtimeState?.catalog.sessionResource
		?? createApiSessionResource(threadId ?? generateUuid());

	// A restored pane can know the selected thread before its rail cache has repopulated the
	// session resource. In that case the selected thread is still the user's continuation target,
	// so keep it authoritative instead of deriving a brand-new thread from a fallback session URI.
	return {
		threadId: threadId ?? deriveVSCloneThreadId(sessionResource),
		sessionResource,
	};
}

/**
 * Phase 1.2 starts collapsing the session/runtime split by giving one service ownership of prompt
 * submission plus thread lifecycle actions. The old runtime still executes the loop underneath for
 * now, but callers no longer need to manually pair runtime deletion with sidecar-state cleanup.
 */
export class VSCloneChatThreadService extends Disposable implements IVSCloneChatThreadService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IVSCloneSettingsService private readonly settingsService: IVSCloneSettingsService,
		@IVSClonePlanModeService private readonly planModeService: IVSClonePlanModeService,
		@ILogService private readonly logService: ILogService,
		@IVSCloneThreadRuntimeService private readonly threadRuntimeService: IVSCloneThreadRuntimeService,
		@IVSCloneContextGatheringService private readonly contextGatheringService: IVSCloneContextGatheringService,
		@IVSCloneUnifiedChatBackendService private readonly unifiedChatBackendService: IVSCloneUnifiedChatBackendService,
		@IFileService private readonly fileService: IFileService,
	) {
		super();
	}

	async sendMessage(promptText: string, options: IVSCloneChatThreadSubmitOptions = {}): Promise<IVSCloneChatThreadSubmitResult | undefined> {
		const trimmedPrompt = promptText.trim();
		if (!trimmedPrompt) {
			return undefined;
		}

		await this.planModeService.initialize();
		// Mode is snapshotted once per submission so prompt assembly, tool execution, and transcript
		// rendering all agree even if the user flips the composer toggle while the turn is streaming.
		const mode = this.planModeService.getModeForThread(options.threadId);
		await this.settingsService.initialize();
		const baseSelection = options.modelSelection ?? this.settingsService.getCurrentSelectionForFeature(options.threadId ?? '', 'chat');
		const apiVendor = this.getApiVendor(baseSelection);
		// VSClone now owns chat transport entirely, so every send must resolve to a concrete
		// provider/model pair instead of falling back to an implicit transport.
		if (!apiVendor || !baseSelection) {
			return this.rejectMissingApiSelection(trimmedPrompt, options, baseSelection, mode);
		}
		return this.submitApiPrompt(trimmedPrompt, options, apiVendor, baseSelection, mode);
	}

	cancelThread(threadId: string): void {
		this.threadRuntimeService.cancelThread(threadId);
	}

	approveLatestToolRequest(threadId: string): boolean {
		return this.threadRuntimeService.approveLatestToolRequest(threadId);
	}

	rejectLatestToolRequest(threadId: string, reason?: string): boolean {
		return this.threadRuntimeService.rejectLatestToolRequest(threadId, reason);
	}

	getThreads(query?: IVSCloneThreadRuntimeCatalogQuery): readonly IVSCloneThreadRuntimeCatalogEntry[] {
		return this.threadRuntimeService.getThreads(query);
	}

	isDeletedThread(threadId: string): boolean {
		return this.threadRuntimeService.isDeletedThread(threadId);
	}

	archiveThread(threadId: string, archived: boolean): boolean {
		return this.threadRuntimeService.archiveThread(threadId, archived);
	}

	async deleteThread(threadId: string): Promise<boolean> {
		this.threadRuntimeService.cancelThread(threadId);
		const deletedByRuntime = this.threadRuntimeService.deleteThread(threadId);
		if (!deletedByRuntime) {
			return false;
		}

		try {
			// Runtime state and unified sidecars now conceptually belong to one thread lifecycle. We
			// treat sidecar cleanup as best-effort so a persistence hiccup cannot resurrect a thread
			// the user already deleted from the visible runtime catalog.
			await this.unifiedChatBackendService.deleteThread(threadId);
		} catch (error) {
			this.logService.error('[VSCloneChatThreadService] Deleted runtime thread but failed to clear unified chat sidecars.', error);
		}
		return true;
	}

	async clearAll(): Promise<void> {
		this.threadRuntimeService.clearAll();
		try {
			// Clearing workspace chat history must also drop per-thread selection/plan sidecars or the
			// next restored chat can inherit stale thread-bound UI state from a conversation that no
			// longer exists.
			await this.unifiedChatBackendService.clearAll();
		} catch (error) {
			this.logService.error('[VSCloneChatThreadService] Cleared runtime threads but failed to clear unified chat sidecars.', error);
		}
	}

	getState(threadId: string): IVSCloneThreadRuntimeState | undefined {
		return this.threadRuntimeService.getState(threadId);
	}

	rewindToCheckpoint(threadId: string, checkpointId: string): Promise<boolean> {
		return this.threadRuntimeService.rewindToCheckpoint(threadId, checkpointId);
	}

	private async submitApiPrompt(
		promptText: string,
		options: IVSCloneChatThreadSubmitOptions,
		vendor: VSCloneModelVendor,
		modelSelection: IVSCloneModelSelection,
		mode: VSCloneChatMode,
	): Promise<IVSCloneChatThreadSubmitResult> {
		const { threadId, sessionResource } = resolveThreadSubmissionIdentity(
			options,
			options.threadId ? this.threadRuntimeService.getState(options.threadId) : undefined,
		);
		await this.planModeService.setModeForThread(threadId, mode);
		const resolvedSelection = await this.ensureThreadSelectionBinding(threadId, modelSelection);
		let systemMessage: string | undefined;

		try {
			const context = await this.contextGatheringService.gatherContext();
			systemMessage = assembleVSCloneSystemMessage(context, vendor, mode);
		} catch (error) {
			// Prompt submission should not fail when context collection fails, so we degrade gracefully.
			this.logService.warn('[VSCloneChatThreadService] Failed to gather prompt context; continuing without enriched system prompt', error);
		}

		// The LLM sees the user instructions followed by a serialized SELECTIONS block so @-mentions
		// and code selections travel as part of the turn itself. We keep the raw selections on the
		// runtime message too so the sidebar can re-render chips after reload. Previous turns already
		// stored their enriched content on send, so replay forwards `content` as-is.
		const enrichedPromptText = await buildVSCloneUserMessageContent(promptText, options.contextSelections, this.fileService);
		const previousTurns = this.getPreviousTurnsForThread(threadId);

		const runtimeOptions: IVSCloneThreadRuntimeRunOptions = {
			threadId,
			turnId: `${threadId}:api:${Date.now()}`,
			// Sequence and previous turns both come from the runtime thread so reloads and rewinds
			// continue from the active branch. A thread with no runtime state is simply new chat.
			sequence: this.getNextSequenceForThread(threadId),
			sessionResource,
			promptText: enrichedPromptText,
			mode,
			vendor,
			modelId: resolvedSelection?.modelId ?? '',
			modelIdentifier: resolvedSelection?.modelIdentifier ?? '',
			reasoningEffort: resolvedSelection?.reasoningEffort,
			reasoningEnabled: resolvedSelection?.reasoningEnabled,
			reasoningBudget: resolvedSelection?.reasoningBudget,
			previousTurns,
			systemMessage,
			imageAttachments: options.imageAttachments,
			contextSelections: options.contextSelections,
		};

		this.threadRuntimeService.runThread(runtimeOptions);
		this.logService.info(`[VSCloneChatThreadService] Routed prompt to ${vendor} API (thread: ${threadId})`);
		return { threadId, sessionResource };
	}

	/**
	 * The first time a thread is addressed we bind the resolved selection to that thread id. This
	 * keeps later restores and retries aligned with the model that actually sent the request.
	 */
	private async ensureThreadSelectionBinding(threadId: string, selection: IVSCloneModelSelection | undefined): Promise<IVSCloneModelSelection | undefined> {
		if (!selection) {
			return undefined;
		}

		const nextSelection: IVSCloneModelSelection = {
			...selection,
			threadId,
			location: 'chat',
			selectedAt: Date.now(),
		};
		const currentSelection = this.settingsService.getCurrentSelectionForFeature(threadId, 'chat');
		if (!currentSelection || !sameThreadBoundSelection(currentSelection, nextSelection)) {
			// The pane snapshots the visible picker state at send time so a quick model/reasoning
			// change takes effect immediately. Existing thread bindings therefore need to be updated
			// whenever that explicit submission selection differs from the persisted thread snapshot.
			await this.settingsService.setSelectionForFeature(threadId, nextSelection);
		}

		return this.settingsService.getCurrentSelectionForFeature(threadId, 'chat') ?? nextSelection;
	}

	private async injectRejectedTurn(options: { threadId: string; sessionResource: string; promptText: string; reason: string; mode: VSCloneChatMode; modelSelection?: IVSCloneModelSelection; imageAttachments?: readonly IVSCloneImageAttachment[]; contextSelections?: readonly IVSCloneContextSelection[] }): Promise<void> {
		const turnId = `${options.threadId}:rejected:${Date.now()}`;
		await this.ensureThreadSelectionBinding(options.threadId, options.modelSelection);
		this.threadRuntimeService.recordRejectedTurn({
			threadId: options.threadId,
			turnId,
			sessionResource: options.sessionResource,
			promptText: options.promptText,
			mode: options.mode,
			reason: options.reason,
			imageAttachments: options.imageAttachments,
			contextSelections: options.contextSelections,
		});
	}

	private getApiVendor(selection: IVSCloneModelSelection | undefined): VSCloneModelVendor | undefined {
		if (!selection) {
			return undefined;
		}

		switch (selection.vendor) {
			case 'openai':
			case 'anthropic':
			case 'google':
				return selection.vendor;
			default:
				return undefined;
		}
	}

	private async rejectMissingApiSelection(
		promptText: string,
		options: IVSCloneChatThreadSubmitOptions,
		modelSelection: IVSCloneModelSelection | undefined,
		mode: VSCloneChatMode,
	): Promise<IVSCloneChatThreadSubmitResult> {
		const { threadId, sessionResource } = resolveThreadSubmissionIdentity(
			options,
			options.threadId ? this.threadRuntimeService.getState(options.threadId) : undefined,
		);
		await this.planModeService.setModeForThread(threadId, mode);
		await this.injectRejectedTurn({
			threadId,
			sessionResource,
			promptText,
			reason: 'Sign in to a provider and choose a model before sending messages through VSClone.',
			mode,
			modelSelection,
			imageAttachments: options.imageAttachments,
			contextSelections: options.contextSelections,
		});

		return { threadId, sessionResource };
	}

	private getPreviousTurnsForThread(threadId: string): IVSCloneChatTransportConversationMessage[] {
		const runtimeState = this.threadRuntimeService.getState(threadId);
		if (!runtimeState) {
			return [];
		}

		// Phase 1.2 now keeps transcript replay with the thread owner instead of depending on a
		// standalone projection helper. That keeps the runtime->transport seam local to the services
		// that actually resume and submit turns.
		const messages: IVSCloneChatTransportConversationMessage[] = [];
		for (const message of runtimeState.messages) {
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
					// Preserve Anthropic signed reasoning blocks on user-turn follow-up sends so the
					// Anthropic convert seam can replay the original signatures. Mirrors the runtime
					// tool-loop path (`vscloneThreadRuntimeService.ts`) and Void's simple-message
					// conversion in `convertToLLMMessageService.ts`.
					messages.push({
						role: 'assistant',
						content: message.content,
						...(message.anthropicReasoning ? { anthropicReasoning: message.anthropicReasoning } : {}),
					});
					break;
				case 'tool':
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

	private getNextSequenceForThread(threadId: string): number {
		const runtimeState = this.threadRuntimeService.getState(threadId);
		if (!runtimeState) {
			return 1;
		}
		// One user message is appended per submitted prompt, so counting them keeps the sequence
		// anchored to the active runtime branch even after rewind truncates future messages.
		return runtimeState.messages.filter(message => message.role === 'user').length + 1;
	}
}

function sameThreadBoundSelection(left: IVSCloneModelSelection, right: IVSCloneModelSelection): boolean {
	return left.threadId === right.threadId
		&& left.location === right.location
		&& left.modelIdentifier === right.modelIdentifier
		&& left.vendor === right.vendor
		&& left.modelId === right.modelId
		&& left.modelName === right.modelName
		&& left.reasoningEffort === right.reasoningEffort
		&& left.reasoningEnabled === right.reasoningEnabled
		&& left.reasoningBudget === right.reasoningBudget;
}
