/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IVSCloneLLMMessageAbortEvent,
	IVSCloneLLMMessageAbortRequest,
	IVSCloneLLMMessageErrorEvent,
	IVSCloneLLMMessageFinalEvent,
	IVSCloneLLMMessageSubmitRequest,
	IVSCloneLLMMessageTextEvent,
	VSCLONE_LLM_MESSAGE_COMMAND_ABORT,
	VSCLONE_LLM_MESSAGE_COMMAND_SUBMIT,
	VSCLONE_LLM_MESSAGE_EVENT_ON_ABORT,
	VSCLONE_LLM_MESSAGE_EVENT_ON_ERROR,
	VSCLONE_LLM_MESSAGE_EVENT_ON_FINAL_MESSAGE,
	VSCLONE_LLM_MESSAGE_EVENT_ON_TEXT,
} from '../common/vscloneLLMMessageTypes.js';
import { sendVSCloneLLMMessage } from './vscloneLLMMessageImpl.js';

/**
 * The main-process channel owns the actual network work so renderer cancellation can stop an
 * in-flight fetch immediately. That matches VSClone's existing chat/completion transport model and
 * keeps OAuth-derived headers out of the DOM-facing execution path once submitted.
 */
export class VSCloneLLMMessageChannel extends Disposable implements IServerChannel {

	private readonly onTextEmitter = this._register(new Emitter<IVSCloneLLMMessageTextEvent>());
	private readonly onFinalMessageEmitter = this._register(new Emitter<IVSCloneLLMMessageFinalEvent>());
	private readonly onErrorEmitter = this._register(new Emitter<IVSCloneLLMMessageErrorEvent>());
	private readonly onAbortEmitter = this._register(new Emitter<IVSCloneLLMMessageAbortEvent>());

	private readonly runningRequests = new Map<string, AbortController>();

	constructor(
		private readonly logService: ILogService,
	) {
		super();
	}

	listen<T>(_: string, event: string): Event<T> {
		switch (event) {
			case VSCLONE_LLM_MESSAGE_EVENT_ON_TEXT:
				return this.onTextEmitter.event as Event<T>;
			case VSCLONE_LLM_MESSAGE_EVENT_ON_FINAL_MESSAGE:
				return this.onFinalMessageEmitter.event as Event<T>;
			case VSCLONE_LLM_MESSAGE_EVENT_ON_ERROR:
				return this.onErrorEmitter.event as Event<T>;
			case VSCLONE_LLM_MESSAGE_EVENT_ON_ABORT:
				return this.onAbortEmitter.event as Event<T>;
			default:
				throw new Error(`Event not found: ${event}`);
		}
	}

	async call<T>(_: string, command: string, arg?: unknown, _cancellationToken: CancellationToken = CancellationToken.None): Promise<T> {
		switch (command) {
			case VSCLONE_LLM_MESSAGE_COMMAND_SUBMIT:
				this.submitRequest(arg as IVSCloneLLMMessageSubmitRequest);
				return undefined as T;
			case VSCLONE_LLM_MESSAGE_COMMAND_ABORT:
				this.abortRequest(arg as IVSCloneLLMMessageAbortRequest);
				return undefined as T;
			default:
				throw new Error(`Call not found: ${command}`);
		}
	}

	private submitRequest(submitRequest: IVSCloneLLMMessageSubmitRequest): void {
		const previousRequest = this.runningRequests.get(submitRequest.requestId);
		previousRequest?.abort();

		const abortController = new AbortController();
		this.runningRequests.set(submitRequest.requestId, abortController);

		void this.runRequest(submitRequest, abortController.signal).finally(() => {
			const active = this.runningRequests.get(submitRequest.requestId);
			if (active === abortController) {
				this.runningRequests.delete(submitRequest.requestId);
			}
		});
	}

	private abortRequest(request: IVSCloneLLMMessageAbortRequest): void {
		this.runningRequests.get(request.requestId)?.abort();
	}

	private async runRequest(submitRequest: IVSCloneLLMMessageSubmitRequest, signal: AbortSignal): Promise<void> {
		const { requestId, request } = submitRequest;

		try {
			await sendVSCloneLLMMessage(request, {
				onText: payload => {
					this.onTextEmitter.fire({ requestId, ...payload });
				},
				onFinalMessage: payload => {
					this.onFinalMessageEmitter.fire({ requestId, ...payload });
				},
				onError: payload => {
					this.onErrorEmitter.fire({ requestId, ...payload });
				},
				onAbort: () => {
					this.onAbortEmitter.fire({ requestId });
				},
			}, signal, this.logService);
		} catch (error) {
			if (signal.aborted) {
				this.onAbortEmitter.fire({ requestId });
				return;
			}

			const message = error instanceof Error ? error.message : String(error);
			this.logService.error('[VSCloneLLMMessageChannel] Request failed unexpectedly.', error);
			this.onErrorEmitter.fire({ requestId, message });
		}
	}
}
