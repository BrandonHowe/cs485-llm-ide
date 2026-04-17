/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { deriveThreadId } from '../common/backend/vscloneChatHistoryModel.js';
import { IVSCloneChatHistoryService } from '../common/backend/vscloneChatHistoryService.js';
import { IVSCloneModelSelection, IVSCloneThreadModelSelectionService } from '../common/backend/vscloneThreadModelSelectionService.js';
import { IVSClonePlanModeService } from '../common/vsclonePlanModeService.js';
import { type VSCloneChatMode } from '../common/vsclonePlanModeTypes.js';
import { IVSClonePromptAssemblyService } from '../common/vsclonePromptAssemblyService.js';
import type { IVSCloneApiConversationMessage } from '../common/vscloneChatApiAdapters.js';
import type { IVSCloneImageAttachment } from '../common/vscloneImageAttachmentTypes.js';
import { VSCloneModelVendor } from '../common/vscloneOAuthTypes.js';
import type { IVSCloneThreadRuntimeState } from '../common/vscloneThreadRuntimeTypes.js';
import { IVSCloneContextGatheringService } from './vscloneContextGatheringService.js';
import { IVSCloneThreadRuntimeHandle, IVSCloneThreadRuntimeService } from './vscloneThreadRuntimeService.js';

export const IVSCloneChatSessionService = createDecorator<IVSCloneChatSessionService>('vscloneChatSessionService');

export interface IVSCloneChatSubmitOptions {
	threadId?: string;
	sessionResource?: string;
	modelSelection?: IVSCloneModelSelection;
	imageAttachments?: readonly IVSCloneImageAttachment[];
}

export interface IVSCloneChatSubmitResult {
	threadId: string;
	sessionResource: string;
}

export interface IVSCloneChatSessionService {
	readonly _serviceBrand: undefined;
	submitPrompt(promptText: string, options?: IVSCloneChatSubmitOptions): Promise<IVSCloneChatSubmitResult | undefined>;
	cancelThread(threadId: string): void;
}

function createApiSessionResource(sessionId: string): string {
	return `vsclone://api/${encodeURIComponent(sessionId)}`;
}

export class VSCloneChatSessionService extends Disposable implements IVSCloneChatSessionService {
	declare readonly _serviceBrand: undefined;

	private readonly apiRequestHandles = new Map<string, IVSCloneThreadRuntimeHandle>();

	constructor(
		// History stays injected during the migration because neighboring services still compose with
		// the same constructor shape, but active submit/replay logic must not silently reread it.
		@IVSCloneChatHistoryService _historyService: IVSCloneChatHistoryService,
		@IVSCloneThreadModelSelectionService private readonly modelSelectionService: IVSCloneThreadModelSelectionService,
		@IVSClonePlanModeService private readonly planModeService: IVSClonePlanModeService,
		@ILogService private readonly logService: ILogService,
		@IVSCloneThreadRuntimeService private readonly threadRuntimeService: IVSCloneThreadRuntimeService,
		@IVSCloneContextGatheringService private readonly contextGatheringService: IVSCloneContextGatheringService,
		@IVSClonePromptAssemblyService private readonly promptAssemblyService: IVSClonePromptAssemblyService,
	) {
		super();
	}

	async submitPrompt(promptText: string, options: IVSCloneChatSubmitOptions = {}): Promise<IVSCloneChatSubmitResult | undefined> {
		const trimmedPrompt = promptText.trim();
		if (!trimmedPrompt) {
			return undefined;
		}

		await this.planModeService.initialize();
		// Mode is snapshotted once per submission so prompt assembly, tool execution, and transcript
		// rendering all agree even if the user flips the composer toggle while the turn is streaming.
		const mode = this.planModeService.getModeForThread(options.threadId);
		await this.modelSelectionService.initialize();
		const baseSelection = options.modelSelection ?? this.modelSelectionService.getCurrentSelectionForThread(options.threadId ?? '', 'chat');
		const apiVendor = this.getApiVendor(baseSelection);
		// VSClone now owns chat transport entirely, so every send must resolve to a concrete
		// provider/model pair instead of falling back to an implicit transport.
		if (!apiVendor || !baseSelection) {
			return this.rejectMissingApiSelection(trimmedPrompt, options, baseSelection, mode);
		}
		return this.submitApiPrompt(trimmedPrompt, options, apiVendor, baseSelection, mode);
	}

	cancelThread(threadId: string): void {
		// Handles are keyed as `${threadId}:api:${timestamp}`, so matching on the explicit delimiter
		// avoids cancelling similarly prefixed thread ids such as `thread-1` and `thread-10`.
		const threadHandlePrefix = `${threadId}:`;
		for (const [turnId, handle] of [...this.apiRequestHandles]) {
			if (turnId.startsWith(threadHandlePrefix)) {
				handle.cancel();
				this.apiRequestHandles.delete(turnId);
			}
		}
	}

	override dispose(): void {
		for (const handle of this.apiRequestHandles.values()) {
			handle.cancel();
		}
		this.apiRequestHandles.clear();
		super.dispose();
	}

	private async submitApiPrompt(
		promptText: string,
		options: IVSCloneChatSubmitOptions,
		vendor: VSCloneModelVendor,
		modelSelection: IVSCloneModelSelection,
		mode: VSCloneChatMode,
	): Promise<IVSCloneChatSubmitResult> {
		const sessionResource = options.sessionResource ?? createApiSessionResource(generateUuid());
		const canReuseThreadId = !!options.threadId && options.sessionResource === sessionResource;
		const threadId = canReuseThreadId ? options.threadId! : deriveThreadId(sessionResource);
		await this.planModeService.setModeForThread(threadId, mode);
		const resolvedSelection = await this.ensureThreadSelectionBinding(threadId, modelSelection);
		const turnId = `${threadId}:api:${Date.now()}`;
		// Active submits now continue strictly from the persisted runtime branch. If a thread has not
		// been explicitly imported into runtime yet, we start from an empty branch instead of hiding a
		// legacy history reconstruction behind this send path.
		// Sequence is derived from the runtime thread when possible so reloads and rewinds continue
		// from the active branch instead of from whichever legacy turns still happen to be persisted.
		const sequence = this.getNextSequenceForThread(threadId);

		const previousTurns = this.getPreviousTurnsForThread(threadId);

		const modelId = resolvedSelection?.modelId ?? '';
		const modelIdentifier = resolvedSelection?.modelIdentifier ?? '';
		let systemMessage: string | undefined;

		try {
			const context = await this.contextGatheringService.gatherContext();
			systemMessage = this.promptAssemblyService.assembleSystemMessage(context, vendor, mode);
		} catch (error) {
			// Prompt submission should not fail when context collection fails, so we degrade gracefully.
			this.logService.warn('[VSCloneChatSession] Failed to gather prompt context; continuing without enriched system prompt', error);
		}

		const handle = this.threadRuntimeService.runThread({
			threadId,
			turnId,
			sequence,
			sessionResource,
			promptText,
			mode,
			vendor,
			modelId,
			modelIdentifier,
			reasoningEffort: resolvedSelection?.reasoningEffort,
			previousTurns,
			systemMessage,
			imageAttachments: options.imageAttachments,
		});

		this.apiRequestHandles.set(turnId, handle);

		// Clean up handle when done
		void handle.done.finally(() => {
			this.apiRequestHandles.delete(turnId);
		});

		this.logService.info(`[VSCloneChatSession] Routed prompt to ${vendor} API (thread: ${threadId})`);

		return {
			threadId,
			sessionResource,
		};
	}

	/**
	 * The first time a thread is addressed we bind the resolved selection to that thread id. This
	 * keeps later restores and retries aligned with the model that actually sent the request.
	 */
	private async ensureThreadSelectionBinding(threadId: string, selection: IVSCloneModelSelection | undefined): Promise<IVSCloneModelSelection | undefined> {
		if (!selection) {
			return undefined;
		}

		if (!this.modelSelectionService.hasSelectionForThread(threadId)) {
			await this.modelSelectionService.setSelectionForThread(threadId, {
				...selection,
				threadId,
				location: 'chat',
				selectedAt: Date.now(),
			});
		}

		return this.modelSelectionService.getCurrentSelectionForThread(threadId, 'chat') ?? {
			...selection,
			threadId,
			location: 'chat',
			selectedAt: Date.now(),
		};
	}

	private async injectRejectedTurn(options: { threadId: string; sessionResource: string; promptText: string; reason: string; mode: VSCloneChatMode; modelSelection?: IVSCloneModelSelection; imageAttachments?: readonly IVSCloneImageAttachment[] }): Promise<void> {
		const turnId = `${options.threadId}:rejected:${Date.now()}`;
		await this.ensureThreadSelectionBinding(options.threadId, options.modelSelection);
		this.threadRuntimeService.recordRejectedTurn({
			threadId: options.threadId,
			turnId,
			promptText: options.promptText,
			mode: options.mode,
			reason: options.reason,
			imageAttachments: options.imageAttachments,
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
		options: IVSCloneChatSubmitOptions,
		modelSelection: IVSCloneModelSelection | undefined,
		mode: VSCloneChatMode,
	): Promise<IVSCloneChatSubmitResult> {
		const sessionResource = options.sessionResource ?? createApiSessionResource(generateUuid());
		const canReuseThreadId = !!options.threadId && options.sessionResource === sessionResource;
		const threadId = canReuseThreadId ? options.threadId! : deriveThreadId(sessionResource);
		await this.planModeService.setModeForThread(threadId, mode);
		await this.injectRejectedTurn({
			threadId,
			sessionResource,
			promptText,
			reason: 'Sign in to a provider and choose a model before sending messages through VSClone.',
			mode,
			modelSelection,
			imageAttachments: options.imageAttachments,
		});

		return {
			threadId,
			sessionResource,
		};
	}

	/**
	 * Active prompt replay only reads the runtime branch. Threads that still exist only in legacy
	 * history must be imported into runtime elsewhere before submission if they need prior context.
	 */
	private getPreviousTurnsForThread(threadId: string): IVSCloneApiConversationMessage[] {
		const runtimeState = this.threadRuntimeService.getState(threadId);
		if (runtimeState) {
			return this.toConversationMessagesFromRuntime(runtimeState);
		}

		return [];
	}

	private getNextSequenceForThread(threadId: string): number {
		const runtimeState = this.threadRuntimeService.getState(threadId);
		if (runtimeState) {
			// One user message is appended per submitted prompt, so counting them keeps the sequence
			// anchored to the active runtime branch even after rewind truncates future messages.
			return runtimeState.messages.filter(message => message.role === 'user').length + 1;
		}

		return 1;
	}

	private toConversationMessagesFromRuntime(state: IVSCloneThreadRuntimeState): IVSCloneApiConversationMessage[] {
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
				case 'checkpoint':
					break;
			}
		}
		return messages;
	}
}
