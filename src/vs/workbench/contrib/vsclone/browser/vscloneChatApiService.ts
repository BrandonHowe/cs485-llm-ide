/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../../base/common/async.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IVSCloneChatHistoryService } from '../common/backend/vscloneChatHistoryService.js';
import { IVSCloneOAuthService } from '../common/vscloneOAuthService.js';
import { IVSCloneApiSubmitOptions } from '../common/vscloneChatApiAdapters.js';
import { IVSCloneModelEligibilityService } from '../common/vscloneModelEligibilityService.js';
import { VSCloneModelVendor } from '../common/vscloneOAuthTypes.js';
import { IVSCloneEditApplicationService } from './vscloneEditApplicationService.js';
import {
	IVSCloneChatApiAbortedEvent,
	IVSCloneChatApiCompleteEvent,
	IVSCloneChatApiDeltaEvent,
	IVSCloneChatApiErrorEvent,
	VSCLONE_CHAT_API_CHANNEL_NAME,
	VSCLONE_CHAT_API_COMMAND_ABORT,
	VSCLONE_CHAT_API_COMMAND_SUBMIT,
	VSCLONE_CHAT_API_EVENT_ABORTED,
	VSCLONE_CHAT_API_EVENT_COMPLETE,
	VSCLONE_CHAT_API_EVENT_DELTA,
	VSCLONE_CHAT_API_EVENT_ERROR,
} from '../common/vscloneChatApiIpc.js';

export const IVSCloneChatApiService = createDecorator<IVSCloneChatApiService>('vscloneChatApiService');

export interface IVSCloneApiRequestHandle {
	readonly done: Promise<void>;
	cancel(): void;
}

export interface IVSCloneApiStreamObserver {
	readonly onDelta?: (text: string) => void;
	readonly onComplete?: () => void;
	readonly onError?: (message: string) => void;
	readonly onAborted?: () => void;
}

export interface IVSCloneChatApiService {
	readonly _serviceBrand: undefined;
	submitApiPrompt(options: IVSCloneApiSubmitOptions): IVSCloneApiRequestHandle;
	submitApiPromptForAgentLoop(options: IVSCloneApiSubmitOptions, observer: IVSCloneApiStreamObserver): IVSCloneApiRequestHandle;
}

interface IVSClonePendingApiRequest {
	readonly requestId: string;
	readonly options: IVSCloneApiSubmitOptions;
	readonly mode: 'history' | 'raw';
	readonly observer?: IVSCloneApiStreamObserver;
	readonly done: DeferredPromise<void>;
	cancelled: boolean;
}

export class VSCloneChatApiService extends Disposable implements IVSCloneChatApiService {
	declare readonly _serviceBrand: undefined;

	private readonly channel: IChannel;
	private readonly pendingRequests = new Map<string, IVSClonePendingApiRequest>();

	constructor(
		@IVSCloneOAuthService private readonly oauthService: IVSCloneOAuthService,
		@IVSCloneChatHistoryService private readonly historyService: IVSCloneChatHistoryService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@ILogService private readonly logService: ILogService,
		@IVSCloneEditApplicationService private readonly editApplicationService: IVSCloneEditApplicationService,
		@IVSCloneModelEligibilityService private readonly eligibilityService: IVSCloneModelEligibilityService,
	) {
		super();
		this.channel = mainProcessService.getChannel(VSCLONE_CHAT_API_CHANNEL_NAME);
		this.registerChannelListeners();
	}

	submitApiPrompt(options: IVSCloneApiSubmitOptions): IVSCloneApiRequestHandle {
		return this.submitApiPromptInternal(options, 'history');
	}

	submitApiPromptForAgentLoop(options: IVSCloneApiSubmitOptions, observer: IVSCloneApiStreamObserver): IVSCloneApiRequestHandle {
		return this.submitApiPromptInternal(options, 'raw', observer);
	}

	private submitApiPromptInternal(
		options: IVSCloneApiSubmitOptions,
		mode: 'history' | 'raw',
		observer?: IVSCloneApiStreamObserver,
	): IVSCloneApiRequestHandle {
		const requestId = generateUuid();
		const pending: IVSClonePendingApiRequest = {
			requestId,
			options,
			mode,
			observer,
			done: new DeferredPromise<void>(),
			cancelled: false,
		};
		this.pendingRequests.set(requestId, pending);

		if (mode === 'history') {
			this.historyService.applyTurnUpdate({
				threadId: options.threadId,
				turnId: options.turnId,
				sequence: options.sequence,
				sessionResource: options.sessionResource,
				phase: 'prompt',
				occurredAt: Date.now(),
				promptText: options.promptText,
				promptImages: options.imageAttachments,
				modelIdentifier: options.modelIdentifier,
				providerId: options.vendor,
			});
		}

		void this.submitToMainProcess(pending);

		return {
			done: pending.done.p,
			cancel: () => this.cancelRequest(requestId),
		};
	}

	private registerChannelListeners(): void {
		this._register(this.channel.listen<IVSCloneChatApiDeltaEvent>(VSCLONE_CHAT_API_EVENT_DELTA)(event => {
			this.handleDeltaEvent(event);
		}));
		this._register(this.channel.listen<IVSCloneChatApiCompleteEvent>(VSCLONE_CHAT_API_EVENT_COMPLETE)(event => {
			this.handleCompleteEvent(event);
		}));
		this._register(this.channel.listen<IVSCloneChatApiErrorEvent>(VSCLONE_CHAT_API_EVENT_ERROR)(event => {
			this.handleErrorEvent(event);
		}));
		this._register(this.channel.listen<IVSCloneChatApiAbortedEvent>(VSCLONE_CHAT_API_EVENT_ABORTED)(event => {
			this.handleAbortedEvent(event);
		}));
	}

	private async submitToMainProcess(pending: IVSClonePendingApiRequest): Promise<void> {
		const { requestId, options } = pending;

		try {
			const headers = await this.oauthService.getApiHeaders(options.vendor);
			if (!this.pendingRequests.has(requestId)) {
				return;
			}

			if (!headers) {
				throw new Error(`Not signed in to ${options.vendor}`);
			}

			this.logService.info(`[VSCloneChatApi] Dispatching ${options.vendor} request to main process (request: ${requestId})`);
			await this.channel.call<void>(VSCLONE_CHAT_API_COMMAND_SUBMIT, {
				requestId,
				options,
				headers,
			});
		} catch (error) {
			if (!this.pendingRequests.has(requestId)) {
				return;
			}

			const message = error instanceof Error ? error.message : String(error);
			this.logService.error(`[VSCloneChatApi] Failed to submit ${options.vendor} request:`, error);
			if (pending.mode === 'history') {
				this.applyErrorUpdate(pending, message);
			}
			pending.observer?.onError?.(message);
			this.finishRequest(requestId);
		}
	}

	private cancelRequest(requestId: string): void {
		const pending = this.pendingRequests.get(requestId);
		if (!pending) {
			return;
		}

		pending.cancelled = true;

		void this.channel.call<void>(VSCLONE_CHAT_API_COMMAND_ABORT, { requestId }).catch(error => {
			this.logService.warn('[VSCloneChatApi] Failed to abort request in main process', error);
		});

		if (pending.mode === 'history') {
			this.historyService.applyTurnUpdate({
				threadId: pending.options.threadId,
				turnId: pending.options.turnId,
				sequence: pending.options.sequence,
				sessionResource: pending.options.sessionResource,
				phase: 'cancel',
				occurredAt: Date.now(),
				promptText: pending.options.promptText,
				modelIdentifier: pending.options.modelIdentifier,
				providerId: pending.options.vendor,
			});
		} else {
			pending.observer?.onAborted?.();
		}
		this.finishRequest(requestId);
	}

	private handleDeltaEvent(event: IVSCloneChatApiDeltaEvent): void {
		const pending = this.pendingRequests.get(event.requestId);
		if (!pending || pending.cancelled || !event.text) {
			return;
		}

		pending.observer?.onDelta?.(event.text);
		if (pending.mode === 'history') {
			this.historyService.applyTurnUpdate({
				threadId: pending.options.threadId,
				turnId: pending.options.turnId,
				sequence: pending.options.sequence,
				sessionResource: pending.options.sessionResource,
				phase: 'stream',
				occurredAt: Date.now(),
				promptText: pending.options.promptText,
				modelIdentifier: pending.options.modelIdentifier,
				providerId: pending.options.vendor,
				responsePlainTextDelta: event.text,
				responseMarkdownDelta: event.text,
			});
		}
	}

	private handleCompleteEvent(event: IVSCloneChatApiCompleteEvent): void {
		const pending = this.pendingRequests.get(event.requestId);
		if (!pending || pending.cancelled) {
			return;
		}

		if (pending.mode === 'history') {
			this.historyService.applyTurnUpdate({
				threadId: pending.options.threadId,
				turnId: pending.options.turnId,
				sequence: pending.options.sequence,
				sessionResource: pending.options.sessionResource,
				phase: 'complete',
				occurredAt: Date.now(),
				promptText: pending.options.promptText,
				modelIdentifier: pending.options.modelIdentifier,
				providerId: pending.options.vendor,
			});

			// We pre-parse edits here so completion logging can capture when the assistant produced
			// apply-ready changes, while the UI remains the authority for actually applying edits.
			const completedTurn = this.historyService.getTurns(pending.options.threadId).find(turn => turn.turnId === pending.options.turnId);
			const responseText = completedTurn ? (completedTurn.responsePlainText || completedTurn.responseMarkdown) : '';
			if (responseText && this.editApplicationService.hasSearchReplaceBlocks(responseText)) {
				this.logService.info(`[VSCloneChatApi] Detected SEARCH/REPLACE edits in turn ${pending.options.turnId}`);
			}
		}
		pending.observer?.onComplete?.();
		this.finishRequest(event.requestId);
	}

	private handleErrorEvent(event: IVSCloneChatApiErrorEvent): void {
		const pending = this.pendingRequests.get(event.requestId);
		if (!pending || pending.cancelled) {
			return;
		}

		this.recordEligibilityFailureIfAny(pending, event.message);

		if (pending.mode === 'history') {
			this.applyErrorUpdate(pending, event.message);
		}
		pending.observer?.onError?.(event.message);
		this.finishRequest(event.requestId);
	}

	/**
	 * Codex-on-ChatGPT (and similar account-gated backends) surface eligibility failures as opaque
	 * 400s rather than through a structured field. We sniff the error text for the known patterns
	 * and record the model as ineligible so the catalog can hide it on the next refresh instead of
	 * presenting a choice the user cannot actually make.
	 */
	private recordEligibilityFailureIfAny(pending: IVSClonePendingApiRequest, errorMessage: string): void {
		if (!errorMessage) {
			return;
		}

		const reason = detectEligibilityFailureReason(pending.options.vendor, errorMessage);
		if (!reason) {
			return;
		}

		this.logService.info(`[VSCloneChatApi] Marking ${pending.options.modelIdentifier} ineligible for this account: ${reason}`);
		this.eligibilityService.markIneligible(pending.options.modelIdentifier, reason);
	}

	private handleAbortedEvent(event: IVSCloneChatApiAbortedEvent): void {
		const pending = this.pendingRequests.get(event.requestId);
		if (!pending || pending.cancelled) {
			return;
		}

		if (pending.mode === 'history') {
			this.historyService.applyTurnUpdate({
				threadId: pending.options.threadId,
				turnId: pending.options.turnId,
				sequence: pending.options.sequence,
				sessionResource: pending.options.sessionResource,
				phase: 'cancel',
				occurredAt: Date.now(),
				promptText: pending.options.promptText,
				modelIdentifier: pending.options.modelIdentifier,
				providerId: pending.options.vendor,
			});
		}
		pending.observer?.onAborted?.();
		this.finishRequest(event.requestId);
	}

	private applyErrorUpdate(pending: IVSClonePendingApiRequest, message: string): void {
		const safeMessage = message || 'Unknown API error';
		this.historyService.applyTurnUpdate({
			threadId: pending.options.threadId,
			turnId: pending.options.turnId,
			sequence: pending.options.sequence,
			sessionResource: pending.options.sessionResource,
			phase: 'error',
			occurredAt: Date.now(),
			promptText: pending.options.promptText,
			errorCode: 'api_error',
			modelIdentifier: pending.options.modelIdentifier,
			providerId: pending.options.vendor,
			responsePlainTextReplace: safeMessage,
			responseMarkdownReplace: safeMessage,
		});
	}

	private finishRequest(requestId: string): void {
		const pending = this.pendingRequests.get(requestId);
		if (!pending) {
			return;
		}

		this.pendingRequests.delete(requestId);
		pending.done.complete();
	}

	override dispose(): void {
		for (const pending of this.pendingRequests.values()) {
			pending.done.complete();
		}
		this.pendingRequests.clear();
		super.dispose();
	}
}

/**
 * Known account-level eligibility failure patterns. OpenAI's Codex-on-ChatGPT backend returns a
 * 400 with a `detail` field whose text names the model that was rejected; matching that phrase is
 * the only reliable signal today, since there is no structured error code. Kept exported for the
 * unit tests in `vscloneChatApiService.test.ts` so the regex stays regression-guarded.
 */
export function detectEligibilityFailureReason(vendor: VSCloneModelVendor, errorMessage: string): string | undefined {
	if (vendor === 'openai') {
		// Example: `openai API returned 400: {"detail":"The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account."}`
		if (/is not supported when using Codex with a ChatGPT account/i.test(errorMessage)) {
			return 'Your ChatGPT account is not entitled to use this model with Codex.';
		}
	}
	return undefined;
}
