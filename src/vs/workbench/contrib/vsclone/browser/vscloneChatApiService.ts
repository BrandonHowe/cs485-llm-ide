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
import { IVSCloneChatHistoryService } from '../common/vscloneChatHistoryService.js';
import { IVSCloneOAuthService } from '../common/vscloneOAuthService.js';
import { IVSCloneApiSubmitOptions } from '../common/vscloneChatApiAdapters.js';
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

export interface IVSCloneChatApiService {
	readonly _serviceBrand: undefined;
	submitApiPrompt(options: IVSCloneApiSubmitOptions): IVSCloneApiRequestHandle;
}

interface IVSClonePendingApiRequest {
	readonly requestId: string;
	readonly options: IVSCloneApiSubmitOptions;
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
	) {
		super();
		this.channel = mainProcessService.getChannel(VSCLONE_CHAT_API_CHANNEL_NAME);
		this.registerChannelListeners();
	}

	submitApiPrompt(options: IVSCloneApiSubmitOptions): IVSCloneApiRequestHandle {
		const requestId = generateUuid();
		const pending: IVSClonePendingApiRequest = {
			requestId,
			options,
			done: new DeferredPromise<void>(),
			cancelled: false,
		};
		this.pendingRequests.set(requestId, pending);

		this.historyService.applyTurnUpdate({
			threadId: options.threadId,
			turnId: options.turnId,
			sequence: options.sequence,
			sessionResource: options.sessionResource,
			phase: 'prompt',
			occurredAt: Date.now(),
			promptText: options.promptText,
			modelIdentifier: options.modelIdentifier,
			providerId: options.vendor,
		});

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
			this.applyErrorUpdate(pending, message);
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
		this.finishRequest(requestId);
	}

	private handleDeltaEvent(event: IVSCloneChatApiDeltaEvent): void {
		const pending = this.pendingRequests.get(event.requestId);
		if (!pending || pending.cancelled || !event.text) {
			return;
		}

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

	private handleCompleteEvent(event: IVSCloneChatApiCompleteEvent): void {
		const pending = this.pendingRequests.get(event.requestId);
		if (!pending || pending.cancelled) {
			return;
		}

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
		this.finishRequest(event.requestId);
	}

	private handleErrorEvent(event: IVSCloneChatApiErrorEvent): void {
		const pending = this.pendingRequests.get(event.requestId);
		if (!pending || pending.cancelled) {
			return;
		}

		this.applyErrorUpdate(pending, event.message);
		this.finishRequest(event.requestId);
	}

	private handleAbortedEvent(event: IVSCloneChatApiAbortedEvent): void {
		const pending = this.pendingRequests.get(event.requestId);
		if (!pending || pending.cancelled) {
			return;
		}

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
