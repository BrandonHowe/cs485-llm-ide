/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { getVendorAdapter } from '../common/vscloneChatApiAdapters.js';
import {
	IVSCloneChatApiAbortRequest,
	IVSCloneChatApiAbortedEvent,
	IVSCloneChatApiCompleteEvent,
	IVSCloneChatApiDeltaEvent,
	IVSCloneChatApiErrorEvent,
	IVSCloneChatApiSubmitRequest,
	VSCLONE_CHAT_API_COMMAND_ABORT,
	VSCLONE_CHAT_API_COMMAND_SUBMIT,
	VSCLONE_CHAT_API_EVENT_ABORTED,
	VSCLONE_CHAT_API_EVENT_COMPLETE,
	VSCLONE_CHAT_API_EVENT_DELTA,
	VSCLONE_CHAT_API_EVENT_ERROR,
} from '../common/vscloneChatApiIpc.js';

export class VSCloneChatApiChannel extends Disposable implements IServerChannel {

	private readonly onDeltaEmitter = this._register(new Emitter<IVSCloneChatApiDeltaEvent>());
	private readonly onCompleteEmitter = this._register(new Emitter<IVSCloneChatApiCompleteEvent>());
	private readonly onErrorEmitter = this._register(new Emitter<IVSCloneChatApiErrorEvent>());
	private readonly onAbortedEmitter = this._register(new Emitter<IVSCloneChatApiAbortedEvent>());

	// Each request gets its own AbortController so renderer-side cancel can stop an in-flight stream.
	private readonly runningRequests = new Map<string, AbortController>();

	constructor(
		private readonly logService: ILogService,
	) {
		super();
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- IServerChannel event payload type is selected by remote callers, so the implementation boundary stays any.
	listen(_: unknown, event: string): Event<any> {
		switch (event) {
			case VSCLONE_CHAT_API_EVENT_DELTA:
				return this.onDeltaEmitter.event;
			case VSCLONE_CHAT_API_EVENT_COMPLETE:
				return this.onCompleteEmitter.event;
			case VSCLONE_CHAT_API_EVENT_ERROR:
				return this.onErrorEmitter.event;
			case VSCLONE_CHAT_API_EVENT_ABORTED:
				return this.onAbortedEmitter.event;
			default:
				throw new Error(`Event not found: ${event}`);
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- IServerChannel call result is caller-defined generic output; this channel only returns completion acks.
	async call(_: unknown, command: string, arg?: unknown, _cancellationToken: CancellationToken = CancellationToken.None): Promise<any> {
		switch (command) {
			case VSCLONE_CHAT_API_COMMAND_SUBMIT:
				this.submitRequest(arg as IVSCloneChatApiSubmitRequest);
				return;
			case VSCLONE_CHAT_API_COMMAND_ABORT:
				this.abortRequest(arg as IVSCloneChatApiAbortRequest);
				return;
			default:
				throw new Error(`Call not found: ${command}`);
		}
	}

	private submitRequest(request: IVSCloneChatApiSubmitRequest): void {
		const previousRequest = this.runningRequests.get(request.requestId);
		previousRequest?.abort();

		const abortController = new AbortController();
		this.runningRequests.set(request.requestId, abortController);

		void this.streamRequest(request, abortController.signal).finally(() => {
			const active = this.runningRequests.get(request.requestId);
			if (active === abortController) {
				this.runningRequests.delete(request.requestId);
			}
		});
	}

	private abortRequest(request: IVSCloneChatApiAbortRequest): void {
		this.runningRequests.get(request.requestId)?.abort();
	}

	private async streamRequest(request: IVSCloneChatApiSubmitRequest, signal: AbortSignal): Promise<void> {
		const { requestId, options, headers } = request;
		const adapter = getVendorAdapter(options.vendor);
		const { url, body } = adapter.buildRequest(options);

		try {
			this.logService.info(`[VSCloneChatApiChannel] Streaming request to ${options.vendor}: ${url}`);

			const response = await fetch(url, {
				method: 'POST',
				headers: {
					...headers,
					'Content-Type': 'application/json',
					'Accept': 'text/event-stream',
				},
				body: JSON.stringify(body),
				signal,
			});

			if (!response.ok) {
				let errorBody = '';
				try {
					errorBody = await response.text();
				} catch {
					// Preserve the status-based error when body extraction fails.
				}
				throw new Error(`${options.vendor} API returned ${response.status}: ${errorBody || response.statusText}`);
			}

			if (!response.body) {
				throw new Error(`${options.vendor} API returned no response body`);
			}

			await this.consumeStream(response.body, request, signal);
		} catch (error) {
			if (signal.aborted) {
				this.onAbortedEmitter.fire({ requestId });
				return;
			}

			const message = error instanceof Error ? error.message : String(error);
			this.logService.error(`[VSCloneChatApiChannel] Stream error for ${options.vendor}:`, error);
			this.onErrorEmitter.fire({ requestId, message });
		}
	}

	private async consumeStream(body: ReadableStream<Uint8Array>, request: IVSCloneChatApiSubmitRequest, signal: AbortSignal): Promise<void> {
		const { requestId, options } = request;
		const adapter = getVendorAdapter(options.vendor);
		const reader = body.getReader();
		const decoder = new TextDecoder();

		let bufferedChunk = '';
		let currentEventType: string | undefined;
		let streamedAnyContent = false;

		try {
			while (true) {
				if (signal.aborted) {
					return;
				}

				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				bufferedChunk += decoder.decode(value, { stream: true });
				const lines = bufferedChunk.split('\n');
				bufferedChunk = lines.pop() ?? '';

				for (const rawLine of lines) {
					const line = rawLine.trimEnd();
					if (line === '') {
						currentEventType = undefined;
						continue;
					}

					if (line.startsWith('event:')) {
						currentEventType = line.slice(6).trim();
						continue;
					}

					const parsed = adapter.parseLine(line, currentEventType);
					if (!parsed) {
						continue;
					}

					switch (parsed.type) {
						case 'delta':
							if (parsed.text && parsed.text.length > 0) {
								streamedAnyContent = true;
								this.onDeltaEmitter.fire({ requestId, text: parsed.text });
							}
							break;
						case 'done':
							this.onCompleteEmitter.fire({ requestId });
							return;
						case 'error':
							throw new Error(parsed.message ?? 'Unknown API error');
					}
				}
			}

			// Some providers end the SSE stream without a terminal done event.
			if (streamedAnyContent) {
				this.onCompleteEmitter.fire({ requestId });
			}
		} finally {
			reader.releaseLock();
		}
	}
}
