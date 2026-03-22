/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { getVendorAdapter, type IVSCloneVendorAdapter } from '../common/vscloneChatApiAdapters.js';
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

interface IStreamConsumptionState {
	currentEventType: string | undefined;
	streamedAnyContent: boolean;
}

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

	// IServerChannel payload type is chosen by the caller; channel-side events are cast at the boundary.
	listen<T>(_: string, event: string): Event<T> {
		switch (event) {
			case VSCLONE_CHAT_API_EVENT_DELTA:
				return this.onDeltaEmitter.event as Event<T>;
			case VSCLONE_CHAT_API_EVENT_COMPLETE:
				return this.onCompleteEmitter.event as Event<T>;
			case VSCLONE_CHAT_API_EVENT_ERROR:
				return this.onErrorEmitter.event as Event<T>;
			case VSCLONE_CHAT_API_EVENT_ABORTED:
				return this.onAbortedEmitter.event as Event<T>;
			default:
				throw new Error(`Event not found: ${event}`);
		}
	}

	// This channel only returns completion acknowledgements, so generic return values resolve to `undefined`.
	async call<T>(_: string, command: string, arg?: unknown, _cancellationToken: CancellationToken = CancellationToken.None): Promise<T> {
		switch (command) {
			case VSCLONE_CHAT_API_COMMAND_SUBMIT:
				this.submitRequest(arg as IVSCloneChatApiSubmitRequest);
				return undefined as T;
			case VSCLONE_CHAT_API_COMMAND_ABORT:
				this.abortRequest(arg as IVSCloneChatApiAbortRequest);
				return undefined as T;
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
			// Preserve the generic header map shape after the object spread so debug logging can still
			// inspect provider-specific keys such as Authorization without fighting excess narrowing.
			const outgoingHeaders: Record<string, string> = {
				...headers,
				'Content-Type': 'application/json',
				'Accept': 'text/event-stream',
			};
			const jsonBody = JSON.stringify(body);
			this.logService.info(`[VSCloneChatApiChannel] Streaming request to ${options.vendor}: ${url} (body size: ${jsonBody.length} bytes)`);
			// Log full headers (mask token to first/last 4 chars)
			const debugHeaders = { ...outgoingHeaders };
			if (debugHeaders['Authorization']) {
				const token = debugHeaders['Authorization'].replace('Bearer ', '');
				debugHeaders['Authorization'] = `Bearer ${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
			}
			this.logService.info(`[VSCloneChatApiChannel] Headers: ${JSON.stringify(debugHeaders)}`);
			this.logService.info(`[VSCloneChatApiChannel] Body (first 800): ${jsonBody.substring(0, 800)}`);
			// Log image attachment presence so we can diagnose multimodal delivery failures.
			const imageCount = options.imageAttachments?.length ?? 0;
			const prevImageCount = options.previousTurns?.reduce((acc, t) => acc + (t.imageAttachments?.length ?? 0), 0) ?? 0;
			if (imageCount > 0 || prevImageCount > 0) {
				this.logService.info(`[VSCloneChatApiChannel] Image attachments: ${imageCount} on current turn, ${prevImageCount} on previous turns`);
				const inputArray = body.input as Array<{ content?: unknown }> | undefined;
				if (Array.isArray(inputArray)) {
					const multimodalTurns = inputArray.filter(m => Array.isArray(m.content));
					this.logService.info(`[VSCloneChatApiChannel] Multimodal turns in body.input: ${multimodalTurns.length}/${inputArray.length}`);
					for (const turn of multimodalTurns) {
						const parts = turn.content as Array<{ type?: string }>;
						const imageParts = parts.filter(p => p.type === 'input_image');
						this.logService.info(`[VSCloneChatApiChannel] Turn has ${parts.length} content parts (${imageParts.length} images)`);
					}
				}
			}
			// Emit a curl command for manual debugging (token unmasked so user can paste it in terminal)
			const curlHeaders = Object.entries(outgoingHeaders).map(([k, v]) => `-H '${k}: ${v}'`).join(' \\\n  ');
			const minimalBody = JSON.stringify({ model: body.model, messages: [{ role: 'user', content: 'test' }], max_tokens: 1024, stream: false });
			this.logService.info(`[VSCloneChatApiChannel] DEBUG curl (minimal):\ncurl -X POST '${url}' \\\n  ${curlHeaders} \\\n  -d '${minimalBody}'`);

			const response = await fetch(url, {
				method: 'POST',
				headers: outgoingHeaders,
				body: jsonBody,
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
		const state: IStreamConsumptionState = {
			currentEventType: undefined,
			streamedAnyContent: false,
		};

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
				const processedChunk = this.processBufferedSseText(bufferedChunk, requestId, adapter, state, false);
				bufferedChunk = processedChunk.remainder;
				if (processedChunk.completed) {
					return;
				}
			}

			// Providers do not always terminate the final SSE event with a newline, so we must
			// flush the decoder and parse any buffered tail to avoid truncating tool-call XML.
			const processedTail = this.processBufferedSseText(bufferedChunk + decoder.decode(), requestId, adapter, state, true);
			if (processedTail.completed) {
				return;
			}

			// Some providers end the SSE stream without a terminal done event.
			if (state.streamedAnyContent) {
				this.onCompleteEmitter.fire({ requestId });
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * SSE payloads may arrive split across arbitrary transport chunks, so we keep the last partial
	 * line buffered until it is complete or the stream ends and we intentionally flush the remainder.
	 */
	private processBufferedSseText(
		bufferedChunk: string,
		requestId: string,
		adapter: IVSCloneVendorAdapter,
		state: IStreamConsumptionState,
		flushRemainder: boolean,
	): { remainder: string; completed: boolean } {
		const lines = bufferedChunk.split('\n');
		const remainder = flushRemainder ? '' : (lines.pop() ?? '');

		for (const rawLine of lines) {
			if (this.processSseLine(rawLine, requestId, adapter, state)) {
				return { remainder, completed: true };
			}
		}

		return { remainder, completed: false };
	}

	/**
	 * Keeping line parsing in one place avoids subtle drift between normal chunk handling and the
	 * EOF flush path, which both need identical SSE semantics to preserve the stream transcript.
	 */
	private processSseLine(
		rawLine: string,
		requestId: string,
		adapter: IVSCloneVendorAdapter,
		state: IStreamConsumptionState,
	): boolean {
		const line = rawLine.trimEnd();
		if (line === '') {
			state.currentEventType = undefined;
			return false;
		}

		if (line.startsWith('event:')) {
			state.currentEventType = line.slice(6).trim();
			return false;
		}

		const parsed = adapter.parseLine(line, state.currentEventType);
		if (!parsed) {
			return false;
		}

		switch (parsed.type) {
			case 'delta':
				if (parsed.text && parsed.text.length > 0) {
					state.streamedAnyContent = true;
					this.onDeltaEmitter.fire({ requestId, text: parsed.text });
				}
				return false;
			case 'done':
				this.onCompleteEmitter.fire({ requestId });
				return true;
			case 'error':
				throw new Error(parsed.message ?? 'Unknown API error');
		}
	}
}
