/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IVSCloneLLMMessageAbortEvent,
	IVSCloneLLMMessageAbortRequest,
	IVSCloneLLMMessageChatRequest,
	IVSCloneLLMMessageErrorEvent,
	IVSCloneLLMMessageFinalEvent,
	IVSCloneLLMMessageObserver,
	IVSCloneLLMMessageRequest,
	IVSCloneLLMMessageRequestHandle,
	IVSCloneLLMMessageSubmitRequest,
	IVSCloneLLMMessageTextEvent,
	VSCLONE_LLM_MESSAGE_CHANNEL_NAME,
	VSCLONE_LLM_MESSAGE_COMMAND_ABORT,
	VSCLONE_LLM_MESSAGE_COMMAND_SUBMIT,
	VSCLONE_LLM_MESSAGE_EVENT_ON_ABORT,
	VSCLONE_LLM_MESSAGE_EVENT_ON_ERROR,
	VSCLONE_LLM_MESSAGE_EVENT_ON_FINAL_MESSAGE,
	VSCLONE_LLM_MESSAGE_EVENT_ON_TEXT,
} from './vscloneLLMMessageTypes.js';

export const IVSCloneLLMMessageService = createDecorator<IVSCloneLLMMessageService>('vscloneLLMMessageService');

export interface IVSCloneLLMMessageService {
	readonly _serviceBrand: undefined;
	sendRequest(request: IVSCloneLLMMessageRequest, observer?: IVSCloneLLMMessageObserver): IVSCloneLLMMessageRequestHandle;
	sendChatRequest(request: IVSCloneLLMMessageChatRequest, observer?: IVSCloneLLMMessageObserver): IVSCloneLLMMessageRequestHandle;
	abort(requestId: string): void;
}

interface IVSClonePendingLLMMessageRequest {
	readonly requestId: string;
	readonly request: IVSCloneLLMMessageRequest;
	readonly observer: IVSCloneLLMMessageObserver;
	readonly done: DeferredPromise<void>;
	cancelled: boolean;
}

/**
 * This service mirrors Void's request-id based transport pattern, but it deliberately does not
 * resolve OAuth state itself. Callers must pass auth material explicitly so chat, agent loops, and
 * future completion paths all stay honest about which renderer-owned credentials they used.
 */
export class VSCloneLLMMessageService extends Disposable implements IVSCloneLLMMessageService {
	declare readonly _serviceBrand: undefined;

	private readonly channel: IChannel;
	private readonly pendingRequests = new Map<string, IVSClonePendingLLMMessageRequest>();

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.channel = mainProcessService.getChannel(VSCLONE_LLM_MESSAGE_CHANNEL_NAME);
		this.registerChannelListeners();
	}

	sendRequest(request: IVSCloneLLMMessageRequest, observer: IVSCloneLLMMessageObserver = {}): IVSCloneLLMMessageRequestHandle {
		const requestId = generateUuid();
		const pending: IVSClonePendingLLMMessageRequest = {
			requestId,
			request,
			observer,
			done: new DeferredPromise<void>(),
			cancelled: false,
		};
		this.pendingRequests.set(requestId, pending);

		void this.submitToMainProcess(pending);

		return {
			requestId,
			done: pending.done.p,
			cancel: () => this.abort(requestId),
		};
	}

	sendChatRequest(request: IVSCloneLLMMessageChatRequest, observer: IVSCloneLLMMessageObserver = {}): IVSCloneLLMMessageRequestHandle {
		return this.sendRequest(request, observer);
	}

	abort(requestId: string): void {
		const pending = this.pendingRequests.get(requestId);
		if (!pending) {
			return;
		}

		pending.cancelled = true;
		pending.observer.onAbort?.();

		void this.channel.call<void>(
			VSCLONE_LLM_MESSAGE_COMMAND_ABORT,
			{ requestId } satisfies IVSCloneLLMMessageAbortRequest,
		).catch(error => {
			this.logService.debug('[VSCloneLLMMessageService] Failed to abort request in main process.', error);
		});

		this.finishRequest(requestId);
	}

	private registerChannelListeners(): void {
		this._register(this.channel.listen<IVSCloneLLMMessageTextEvent>(VSCLONE_LLM_MESSAGE_EVENT_ON_TEXT)(event => {
			const pending = this.pendingRequests.get(event.requestId);
			if (!pending || pending.cancelled) {
				return;
			}

			pending.observer.onText?.({
				text: event.text,
				fullText: event.fullText,
				fullReasoning: event.fullReasoning,
				toolCall: event.toolCall,
			});
		}));

		this._register(this.channel.listen<IVSCloneLLMMessageFinalEvent>(VSCLONE_LLM_MESSAGE_EVENT_ON_FINAL_MESSAGE)(event => {
			const pending = this.pendingRequests.get(event.requestId);
			if (!pending || pending.cancelled) {
				return;
			}

			pending.observer.onFinalMessage?.({
				fullText: event.fullText,
				fullReasoning: event.fullReasoning,
				toolCall: event.toolCall,
				anthropicReasoning: event.anthropicReasoning,
			});
			this.finishRequest(event.requestId);
		}));

		this._register(this.channel.listen<IVSCloneLLMMessageErrorEvent>(VSCLONE_LLM_MESSAGE_EVENT_ON_ERROR)(event => {
			const pending = this.pendingRequests.get(event.requestId);
			if (!pending || pending.cancelled) {
				return;
			}

			pending.observer.onError?.({
				message: event.message,
			});
			this.finishRequest(event.requestId);
		}));

		this._register(this.channel.listen<IVSCloneLLMMessageAbortEvent>(VSCLONE_LLM_MESSAGE_EVENT_ON_ABORT)(event => {
			const pending = this.pendingRequests.get(event.requestId);
			if (!pending || pending.cancelled) {
				return;
			}

			pending.observer.onAbort?.();
			this.finishRequest(event.requestId);
		}));
	}

	private async submitToMainProcess(pending: IVSClonePendingLLMMessageRequest): Promise<void> {
		try {
			await this.channel.call<void>(
				VSCLONE_LLM_MESSAGE_COMMAND_SUBMIT,
				{ requestId: pending.requestId, request: pending.request } satisfies IVSCloneLLMMessageSubmitRequest,
			);
		} catch (error) {
			if (!this.pendingRequests.has(pending.requestId)) {
				return;
			}

			const message = error instanceof Error ? error.message : String(error);
			this.logService.error(`[VSCloneLLMMessageService] Failed to submit ${describeRequestForLog(pending.request)} request.`, error);
			pending.observer.onError?.({ message });
			this.finishRequest(pending.requestId);
		}
	}

	private finishRequest(requestId: string): void {
		const pending = this.pendingRequests.get(requestId);
		if (!pending) {
			return;
		}

		this.pendingRequests.delete(requestId);
		pending.done.complete(undefined);
	}
}

function describeRequestForLog(request: IVSCloneLLMMessageRequest): string {
	switch (request.kind) {
		case 'chat':
			return `${request.prepared.vendor}/${request.prepared.modelId}`;
		case 'fim':
			return `${request.prepared.vendor}/${request.prepared.modelId}`;
	}
}
