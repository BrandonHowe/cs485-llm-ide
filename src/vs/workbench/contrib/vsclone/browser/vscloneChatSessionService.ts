/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { hash } from '../../../../base/common/hash.js';
import { URI } from '../../../../base/common/uri.js';
import { ChatSendResult, IChatService } from '../../chat/common/chatService/chatService.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
import { deriveThreadId } from '../common/vscloneChatHistoryModel.js';
import { IVSCloneChatHistoryService } from '../common/vscloneChatHistoryService.js';
import { VSCloneModelVendor } from '../common/vscloneMockProviderService.js';
import { IVSCloneOAuthService } from '../common/vscloneOAuthService.js';
import { VSCloneUseMockProviderTransportSetting, VSCloneUseVSCodeChatBackendSetting } from '../common/vscloneChatSettings.js';
import { IVSCloneModelSelection } from '../common/vscloneThreadModelSelectionService.js';
import { IVSClonePromptAssemblyService } from '../common/vsclonePromptAssemblyService.js';
import { IVSCloneAgentLoopHandle, IVSCloneAgentLoopService } from './vscloneAgentLoopService.js';
import { IVSCloneContextGatheringService } from './vscloneContextGatheringService.js';

export const IVSCloneChatSessionService = createDecorator<IVSCloneChatSessionService>('vscloneChatSessionService');

interface IVSCloneMockResponseState {
	threadId: string;
	turnId: string;
	sequence: number;
	sessionResource: string;
	promptText: string;
	modelIdentifier?: string;
	providerId?: string;
	chunks: readonly string[];
	nextChunkIndex: number;
	timerHandle: ReturnType<typeof setTimeout> | undefined;
}

export interface IVSCloneChatSubmitOptions {
	threadId?: string;
	sessionResource?: string;
	modelSelection?: IVSCloneModelSelection;
}

export interface IVSCloneChatSubmitResult {
	threadId: string;
	sessionResource: string;
	mocked: boolean;
}

export interface IVSCloneChatSessionService {
	readonly _serviceBrand: undefined;
	submitPrompt(promptText: string, options?: IVSCloneChatSubmitOptions): Promise<IVSCloneChatSubmitResult | undefined>;
	cancelThread(threadId: string): void;
}

function createMockSessionResource(seed: string): string {
	return `vsclone://mock/${encodeURIComponent(seed)}`;
}

function createMockSeed(promptText: string): string {
	const salt = Date.now().toString(36);
	return `vsclone-mock-${salt}-${Math.abs(hash(`${promptText}:${salt}`)).toString(36).slice(0, 5)}`;
}

function toAssistantReply(promptText: string): string {
	const trimmedPrompt = promptText.trim();
	if (!trimmedPrompt) {
		return localize('vsclone.syntheticReply.empty', 'I need a prompt before I can help.');
	}

	if (/\b(error|fail)\b/i.test(trimmedPrompt)) {
		return localize('vsclone.syntheticReply.errorHint', 'I can walk through that failure case. Share the exact error and the file path.');
	}

	return localize(
		'vsclone.syntheticReply.default',
		'Local VSClone response for: "{0}"\n\nThis custom pane is decoupled from the built-in VS Code chat widget and stores turns in VSClone history.',
		trimmedPrompt,
	);
}

function toResponseChunks(response: string): readonly string[] {
	const words = response.split(/(\s+)/).filter(chunk => chunk.length > 0);
	const chunks: string[] = [];
	let currentChunk = '';
	for (const word of words) {
		const projectedLength = currentChunk.length + word.length;
		if (projectedLength > 32 && currentChunk.length > 0) {
			chunks.push(currentChunk);
			currentChunk = word;
			continue;
		}
		currentChunk += word;
	}
	if (currentChunk.length > 0) {
		chunks.push(currentChunk);
	}
	return chunks.length > 0 ? chunks : [response];
}

function parseSessionResource(value: string | undefined): URI | undefined {
	if (!value) {
		return undefined;
	}

	try {
		return URI.parse(value);
	} catch {
		return undefined;
	}
}

export class VSCloneChatSessionService extends Disposable implements IVSCloneChatSessionService {
	declare readonly _serviceBrand: undefined;

	private readonly mockResponses = new Map<string, IVSCloneMockResponseState>();
	private readonly apiRequestHandles = new Map<string, IVSCloneAgentLoopHandle>();

	constructor(
		@IChatService private readonly chatService: IChatService,
		@IVSCloneChatHistoryService private readonly historyService: IVSCloneChatHistoryService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IVSCloneOAuthService private readonly oauthService: IVSCloneOAuthService,
		@IVSCloneAgentLoopService private readonly agentLoopService: IVSCloneAgentLoopService,
		@IVSCloneContextGatheringService private readonly contextGatheringService: IVSCloneContextGatheringService,
		@IVSClonePromptAssemblyService private readonly promptAssemblyService: IVSClonePromptAssemblyService,
	) {
		super();
	}

	private get useVSCodeChatBackend(): boolean {
		return this.configurationService.getValue<boolean>(VSCloneUseVSCodeChatBackendSetting) ?? false;
	}

	private get useMockProviderTransport(): boolean {
		// Mock mode is the default development path so model/session UI can be exercised without real provider wiring.
		return this.configurationService.getValue<boolean>(VSCloneUseMockProviderTransportSetting) ?? true;
	}

	async submitPrompt(promptText: string, options: IVSCloneChatSubmitOptions = {}): Promise<IVSCloneChatSubmitResult | undefined> {
		const trimmedPrompt = promptText.trim();
		if (!trimmedPrompt) {
			return undefined;
		}

		if (this.useMockProviderTransport) {
			return this.submitMockPrompt(trimmedPrompt, options);
		}

		// 1. Try real API if vendor is signed in via OAuth
		if (!this.useVSCodeChatBackend) {
			const vendor = options.modelSelection?.vendor as VSCloneModelVendor | undefined;
			if (vendor) {
				// Ensure OAuth state is restored from secret storage before checking
				await this.oauthService.initialize();
				if (this.oauthService.isSignedIn(vendor)) {
					return this.submitApiPrompt(trimmedPrompt, options, vendor);
				}
			}
			return this.submitMockPrompt(trimmedPrompt, options);
		}

		if (!this.chatService.isEnabled(ChatAgentLocation.Chat)) {
			return this.submitMockPrompt(trimmedPrompt, options);
		}

		const preferredResource = parseSessionResource(options.sessionResource);
		let activeResource: URI | undefined;

		try {
			if (preferredResource) {
				const restored = await this.chatService.getOrRestoreSession(preferredResource);
				if (restored) {
					activeResource = restored.object.sessionResource;
					restored.dispose();
				}
			}

			if (!activeResource) {
				const started = this.chatService.startSession(ChatAgentLocation.Chat);
				activeResource = started.object.sessionResource;
				started.dispose();
			}

			const sessionResource = activeResource.toString();
			const canReuseThreadId = !!options.threadId && options.sessionResource === sessionResource;
			const threadId = canReuseThreadId ? options.threadId! : deriveThreadId(sessionResource);
			const sendResult = await this.chatService.sendRequest(activeResource, trimmedPrompt, { location: ChatAgentLocation.Chat });

			if (ChatSendResult.isRejected(sendResult)) {
				this.injectRejectedTurn({
					threadId,
					sessionResource,
					promptText: trimmedPrompt,
					reason: sendResult.reason,
					modelSelection: options.modelSelection,
				});
				return {
					threadId,
					sessionResource,
					mocked: false,
				};
			}

			if (ChatSendResult.isQueued(sendResult)) {
				void sendResult.deferred.then(result => {
					if (ChatSendResult.isRejected(result)) {
						this.injectRejectedTurn({
							threadId,
							sessionResource,
							promptText: trimmedPrompt,
							reason: result.reason,
							modelSelection: options.modelSelection,
						});
					}
				});
			}

			return {
				threadId,
				sessionResource,
				mocked: false,
			};
		} catch (error) {
			this.logService.warn('VSClone chat send failed, falling back to mock responder', error);
			return this.submitMockPrompt(trimmedPrompt, options);
		}
	}

	cancelThread(threadId: string): void {
		if (this.useVSCodeChatBackend && !this.useMockProviderTransport) {
			const thread = this.historyService.getThreads({ includeArchived: true }).find(candidate => candidate.threadId === threadId);
			const sessionResource = parseSessionResource(thread?.sessionResource);
			if (sessionResource) {
				this.chatService.cancelCurrentRequestForSession(sessionResource);
			}
		}

		// Cancel active API request handles for this thread
		for (const [turnId, handle] of [...this.apiRequestHandles]) {
			if (turnId.startsWith(threadId)) {
				handle.cancel();
				this.apiRequestHandles.delete(turnId);
			}
		}

		for (const [turnId, state] of [...this.mockResponses]) {
			if (state.threadId !== threadId) {
				continue;
			}
			if (state.timerHandle !== undefined) {
				clearTimeout(state.timerHandle);
			}
			this.mockResponses.delete(turnId);
		}
	}

	override dispose(): void {
		for (const handle of this.apiRequestHandles.values()) {
			handle.cancel();
		}
		this.apiRequestHandles.clear();

		for (const state of this.mockResponses.values()) {
			if (state.timerHandle !== undefined) {
				clearTimeout(state.timerHandle);
			}
		}
		this.mockResponses.clear();
		super.dispose();
	}

	private async submitApiPrompt(promptText: string, options: IVSCloneChatSubmitOptions, vendor: VSCloneModelVendor): Promise<IVSCloneChatSubmitResult> {
		const mockSeed = createMockSeed(promptText);
		const sessionResource = options.sessionResource ?? createMockSessionResource(mockSeed);
		const canReuseThreadId = !!options.threadId && options.sessionResource === sessionResource;
		const threadId = canReuseThreadId ? options.threadId! : deriveThreadId(sessionResource);
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

		const modelId = options.modelSelection?.modelId ?? '';
		const modelIdentifier = options.modelSelection?.modelIdentifier ?? '';
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
			reasoningEffort: options.modelSelection?.reasoningEffort,
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
			mocked: false,
		};
	}

	private submitMockPrompt(promptText: string, options: IVSCloneChatSubmitOptions): IVSCloneChatSubmitResult {
		const mockSeed = createMockSeed(promptText);
		const sessionResource = options.sessionResource ?? createMockSessionResource(mockSeed);
		const canReuseThreadId = !!options.threadId && options.sessionResource === sessionResource;
		const threadId = canReuseThreadId ? options.threadId! : deriveThreadId(sessionResource);
		const turnId = `${threadId}:mock:${Date.now()}`;
		const sequence = this.historyService.getTurns(threadId).length + 1;
		const occurredAt = Date.now();

		this.historyService.applyTurnUpdate({
			threadId,
			turnId,
			sequence,
			sessionResource,
			phase: 'prompt',
			occurredAt,
			promptText,
			modelIdentifier: options.modelSelection?.modelIdentifier,
			providerId: options.modelSelection?.vendor,
		});

		const reply = toAssistantReply(promptText);
		this.mockResponses.set(turnId, {
			threadId,
			turnId,
			sequence,
			sessionResource,
			promptText,
			modelIdentifier: options.modelSelection?.modelIdentifier,
			providerId: options.modelSelection?.vendor,
			chunks: toResponseChunks(reply),
			nextChunkIndex: 0,
			timerHandle: undefined,
		});
		this.scheduleMockTick(turnId, 130);

		return {
			threadId,
			sessionResource,
			mocked: true,
		};
	}

	private scheduleMockTick(turnId: string, delayMs: number): void {
		const state = this.mockResponses.get(turnId);
		if (!state) {
			return;
		}

		if (state.timerHandle !== undefined) {
			clearTimeout(state.timerHandle);
		}

		state.timerHandle = setTimeout(() => this.runMockTick(turnId), delayMs);
	}

	private runMockTick(turnId: string): void {
		const state = this.mockResponses.get(turnId);
		if (!state) {
			return;
		}

		if (state.nextChunkIndex >= state.chunks.length) {
			this.historyService.applyTurnUpdate({
				threadId: state.threadId,
				turnId: state.turnId,
				sequence: state.sequence,
				sessionResource: state.sessionResource,
				phase: 'complete',
				occurredAt: Date.now(),
				promptText: state.promptText,
				modelIdentifier: state.modelIdentifier,
				providerId: state.providerId,
			});
			this.mockResponses.delete(turnId);
			return;
		}

		const chunk = state.chunks[state.nextChunkIndex++];
		this.historyService.applyTurnUpdate({
			threadId: state.threadId,
			turnId: state.turnId,
			sequence: state.sequence,
			sessionResource: state.sessionResource,
			phase: 'stream',
			occurredAt: Date.now(),
			promptText: state.promptText,
			modelIdentifier: state.modelIdentifier,
			providerId: state.providerId,
			responsePlainTextDelta: chunk,
			responseMarkdownDelta: chunk,
		});

		this.scheduleMockTick(turnId, 55);
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
}
