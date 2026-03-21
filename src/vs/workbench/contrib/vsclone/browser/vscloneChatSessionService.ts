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
import { IVSClonePromptAssemblyService } from '../common/vsclonePromptAssemblyService.js';
import { VSCloneModelVendor } from '../common/vscloneOAuthTypes.js';
import { IVSCloneAgentLoopHandle, IVSCloneAgentLoopService } from './vscloneAgentLoopService.js';
import { IVSCloneContextGatheringService } from './vscloneContextGatheringService.js';

export const IVSCloneChatSessionService = createDecorator<IVSCloneChatSessionService>('vscloneChatSessionService');

export interface IVSCloneChatSubmitOptions {
	threadId?: string;
	sessionResource?: string;
	modelSelection?: IVSCloneModelSelection;
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

	private readonly apiRequestHandles = new Map<string, IVSCloneAgentLoopHandle>();

	constructor(
		@IVSCloneChatHistoryService private readonly historyService: IVSCloneChatHistoryService,
		@IVSCloneThreadModelSelectionService private readonly modelSelectionService: IVSCloneThreadModelSelectionService,
		@ILogService private readonly logService: ILogService,
		@IVSCloneAgentLoopService private readonly agentLoopService: IVSCloneAgentLoopService,
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

		await this.modelSelectionService.initialize();
		const baseSelection = options.modelSelection ?? this.modelSelectionService.getCurrentSelectionForThread(options.threadId ?? '', 'chat');
		const apiVendor = this.getApiVendor(baseSelection);
		// VSClone now owns chat transport entirely, so every send must resolve to a concrete
		// provider/model pair instead of falling back to an implicit transport.
		if (!apiVendor || !baseSelection) {
			return this.rejectMissingApiSelection(trimmedPrompt, options, baseSelection);
		}
		return this.submitApiPrompt(trimmedPrompt, options, apiVendor, baseSelection);
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
	): Promise<IVSCloneChatSubmitResult> {
		const sessionResource = options.sessionResource ?? createApiSessionResource(generateUuid());
		const canReuseThreadId = !!options.threadId && options.sessionResource === sessionResource;
		const threadId = canReuseThreadId ? options.threadId! : deriveThreadId(sessionResource);
		const resolvedSelection = await this.ensureThreadSelectionBinding(threadId, modelSelection);
		const turnId = `${threadId}:api:${Date.now()}`;
		const sequence = this.historyService.getTurns(threadId).length + 1;

		// Gather previous turns for multi-turn conversation context
		const existingTurns = this.historyService.getTurns(threadId);
		const previousTurns: { role: 'user' | 'assistant'; content: string }[] = [];
		for (const turn of existingTurns) {
			if (turn.status === 'completed' || turn.status === 'streaming') {
				previousTurns.push({ role: 'user', content: turn.promptText });
				if (turn.responsePlainText) {
					previousTurns.push({ role: 'assistant', content: turn.responsePlainText });
				}
			}
		}

		const modelId = resolvedSelection?.modelId ?? '';
		const modelIdentifier = resolvedSelection?.modelIdentifier ?? '';
		let systemMessage: string | undefined;

		try {
			const context = await this.contextGatheringService.gatherContext();
			systemMessage = this.promptAssemblyService.assembleSystemMessage(context, vendor);
		} catch (error) {
			// Prompt submission should not fail when context collection fails, so we degrade gracefully.
			this.logService.warn('[VSCloneChatSession] Failed to gather prompt context; continuing without enriched system prompt', error);
		}

		const handle = this.agentLoopService.runAgentLoop({
			threadId,
			turnId,
			sequence,
			sessionResource,
			promptText,
			vendor,
			modelId,
			modelIdentifier,
			reasoningEffort: resolvedSelection?.reasoningEffort,
			previousTurns,
			systemMessage,
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

	private injectRejectedTurn(options: { threadId: string; sessionResource: string; promptText: string; reason: string; modelSelection?: IVSCloneModelSelection }): void {
		const turns = this.historyService.getTurns(options.threadId);
		const sequence = turns.length + 1;
		const turnId = `${options.threadId}:rejected:${Date.now()}`;
		const occurredAt = Date.now();

		this.historyService.applyTurnUpdate({
			threadId: options.threadId,
			turnId,
			sequence,
			sessionResource: options.sessionResource,
			phase: 'prompt',
			occurredAt,
			promptText: options.promptText,
			modelIdentifier: options.modelSelection?.modelIdentifier,
			providerId: options.modelSelection?.vendor,
		});

		this.historyService.applyTurnUpdate({
			threadId: options.threadId,
			turnId,
			sequence,
			sessionResource: options.sessionResource,
			phase: 'error',
			occurredAt: Date.now(),
			promptText: options.promptText,
			errorCode: 'request_rejected',
			modelIdentifier: options.modelSelection?.modelIdentifier,
			providerId: options.modelSelection?.vendor,
			responsePlainTextReplace: options.reason,
			responseMarkdownReplace: options.reason,
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

	private rejectMissingApiSelection(
		promptText: string,
		options: IVSCloneChatSubmitOptions,
		modelSelection: IVSCloneModelSelection | undefined,
	): IVSCloneChatSubmitResult {
		const sessionResource = options.sessionResource ?? createApiSessionResource(generateUuid());
		const canReuseThreadId = !!options.threadId && options.sessionResource === sessionResource;
		const threadId = canReuseThreadId ? options.threadId! : deriveThreadId(sessionResource);

		this.injectRejectedTurn({
			threadId,
			sessionResource,
			promptText,
			reason: 'Sign in to a provider and choose a model before sending messages through VSClone.',
			modelSelection,
		});

		return {
			threadId,
			sessionResource,
		};
	}
}
