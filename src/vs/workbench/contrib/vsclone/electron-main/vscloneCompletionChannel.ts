/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { buildRequest, getEndpointMode, parseText } from '../common/backend/vscloneCompletionApiAdapters.js';
import {
	IVSCloneCompletionAbortRequest,
	IVSCloneCompletionSubmitRequest,
	IVSCloneCompletionSubmitResponse,
	VSCLONE_COMPLETION_COMMAND_ABORT,
	VSCLONE_COMPLETION_COMMAND_SUBMIT,
} from '../common/backend/vscloneCompletionApiIpc.js';

interface ICompletionStreamState {
	currentEventType: string | undefined;
}

interface ICompletionStreamResult {
	readonly rawText: string | undefined;
	readonly firstDeltaAfterMs?: number;
}

/**
 * Completion requests return a single text payload, but we still run them in the main process so
 * renderer-side cancellation can abort the underlying fetch immediately and avoid stale work.
 */
export class VSCloneCompletionChannel extends Disposable implements IServerChannel {

	private readonly runningRequests = new Map<string, AbortController>();

	constructor(
		private readonly logService: ILogService,
	) {
		super();
	}

	listen<T>(_: string, event: string): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_: string, command: string, arg?: unknown, cancellationToken: CancellationToken = CancellationToken.None): Promise<T> {
		switch (command) {
			case VSCLONE_COMPLETION_COMMAND_SUBMIT:
				return this.submitRequest(arg as IVSCloneCompletionSubmitRequest, cancellationToken) as T;
			case VSCLONE_COMPLETION_COMMAND_ABORT:
				this.abortRequest(arg as IVSCloneCompletionAbortRequest);
				return undefined as T;
			default:
				throw new Error(`Call not found: ${command}`);
		}
	}

	private async submitRequest(request: IVSCloneCompletionSubmitRequest, cancellationToken: CancellationToken): Promise<IVSCloneCompletionSubmitResponse> {
		const previousRequest = this.runningRequests.get(request.requestId);
		previousRequest?.abort();

		const abortController = new AbortController();
		this.runningRequests.set(request.requestId, abortController);
		const cancellationListener = cancellationToken.onCancellationRequested(() => {
			abortController.abort();
		});

		try {
			return await this.runRequest(request, abortController.signal);
		} finally {
			cancellationListener.dispose();
			const active = this.runningRequests.get(request.requestId);
			if (active === abortController) {
				this.runningRequests.delete(request.requestId);
			}
		}
	}

	private abortRequest(request: IVSCloneCompletionAbortRequest): void {
		this.runningRequests.get(request.requestId)?.abort();
	}

	private async runRequest(request: IVSCloneCompletionSubmitRequest, signal: AbortSignal): Promise<IVSCloneCompletionSubmitResponse> {
		const { selection } = request;
		const transportRequest = buildRequest(request.envelope, selection);
		const endpointMode = getEndpointMode(selection);
		const startedAt = Date.now();

		try {
			this.logService.info(
				`[VSCloneCompletionChannel] Dispatching ${selection.vendor} completion request for ${selection.modelId} `
				+ `(prefix=${request.envelope.prefix.length}, suffix=${request.envelope.suffix.length}, `
				+ `crossFileSnippets=${request.envelope.crossFileContext?.length ?? 0}, maxTokens=${request.envelope.maxTokens}, `
				+ `reasoning=${selection.reasoningEffort ?? 'default'}).`
			);

			const response = await fetch(transportRequest.url, {
				method: 'POST',
				headers: {
					...request.headers,
					'Content-Type': 'application/json',
					'Accept': endpointMode === 'sse' ? 'text/event-stream' : 'application/json',
				},
				body: JSON.stringify(transportRequest.body),
				signal,
			});
			const responseHeadersAfterMs = Date.now() - startedAt;
			this.logService.info(
				`[VSCloneCompletionChannel] Received ${selection.vendor} completion response headers for ${selection.modelId} `
				+ `in ${responseHeadersAfterMs}ms (status ${response.status}).`
			);

			if (!response.ok) {
				let errorBody = '';
				try {
					errorBody = await response.text();
				} catch {
					// Preserve the status-derived message when response extraction also fails.
				}
				throw new Error(`${selection.vendor} completion API returned ${response.status}: ${errorBody || response.statusText}`);
			}

			if (endpointMode !== 'sse') {
				throw new Error(`Unsupported completion endpoint mode: ${endpointMode}`);
			}

			if (!response.body) {
				throw new Error(`${selection.vendor} completion API returned no response body`);
			}

			const streamResult = await this.consumeSseText(response.body, selection.vendor, signal, startedAt);
			const elapsedMs = Date.now() - startedAt;
			if (streamResult.rawText) {
				this.logService.info(
					`[VSCloneCompletionChannel] Completed ${selection.vendor} completion request for ${selection.modelId} `
					+ `in ${elapsedMs}ms (${streamResult.rawText.length} chars, headers=${responseHeadersAfterMs}ms, `
					+ `firstDelta=${streamResult.firstDeltaAfterMs ?? 'n/a'}ms).`
				);
			} else {
				this.logService.info(
					`[VSCloneCompletionChannel] Completed ${selection.vendor} completion request for ${selection.modelId} `
					+ `in ${elapsedMs}ms with no text (headers=${responseHeadersAfterMs}ms, `
					+ `firstDelta=${streamResult.firstDeltaAfterMs ?? 'n/a'}ms).`
				);
			}

			return { rawText: streamResult.rawText };
		} catch (error) {
			if (signal.aborted) {
				this.logService.info(`[VSCloneCompletionChannel] Aborted ${selection.vendor} completion request for ${selection.modelId} after ${Date.now() - startedAt}ms.`);
				return { rawText: undefined };
			}

			this.logService.error(`[VSCloneCompletionChannel] Completion request failed for ${selection.vendor}.`, error);
			throw error;
		}
	}

	private async consumeSseText(
		body: ReadableStream<Uint8Array>,
		vendor: IVSCloneCompletionSubmitRequest['selection']['vendor'],
		signal: AbortSignal,
		startedAt: number,
	): Promise<ICompletionStreamResult> {
		const reader = body.getReader();
		const decoder = new TextDecoder();

		let bufferedChunk = '';
		let accumulatedText = '';
		let firstDeltaAfterMs: number | undefined;
		const state: ICompletionStreamState = {
			currentEventType: undefined,
		};

		try {
			while (true) {
				if (signal.aborted) {
					return { rawText: undefined, firstDeltaAfterMs };
				}

				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				bufferedChunk += decoder.decode(value, { stream: true });
				const processedChunk = this.processBufferedSseText(bufferedChunk, vendor, state, accumulatedText, false, firstDeltaAfterMs, startedAt);
				bufferedChunk = processedChunk.remainder;
				accumulatedText = processedChunk.accumulatedText;
				firstDeltaAfterMs = processedChunk.firstDeltaAfterMs;
				if (processedChunk.completed) {
					return { rawText: accumulatedText || undefined, firstDeltaAfterMs };
				}
			}

			// Providers occasionally terminate without a trailing newline, so we must flush the final
			// decoder tail or we risk dropping the last completion token.
			const processedTail = this.processBufferedSseText(bufferedChunk + decoder.decode(), vendor, state, accumulatedText, true, firstDeltaAfterMs, startedAt);
			return {
				rawText: processedTail.accumulatedText || undefined,
				firstDeltaAfterMs: processedTail.firstDeltaAfterMs,
			};
		} finally {
			reader.releaseLock();
		}
	}

	private processBufferedSseText(
		bufferedChunk: string,
		vendor: IVSCloneCompletionSubmitRequest['selection']['vendor'],
		state: ICompletionStreamState,
		accumulatedText: string,
		flushRemainder: boolean,
		firstDeltaAfterMs: number | undefined,
		startedAt: number,
	): { remainder: string; accumulatedText: string; completed: boolean; firstDeltaAfterMs: number | undefined } {
		const lines = bufferedChunk.split('\n');
		const remainder = flushRemainder ? '' : (lines.pop() ?? '');
		let nextAccumulatedText = accumulatedText;
		let nextFirstDeltaAfterMs = firstDeltaAfterMs;

		for (const rawLine of lines) {
			const parsedLine = this.processSseLine(rawLine, vendor, state);
			if (!parsedLine) {
				continue;
			}

			if (parsedLine.type === 'delta' && parsedLine.text) {
				nextFirstDeltaAfterMs ??= Date.now() - startedAt;
				nextAccumulatedText += parsedLine.text;
				continue;
			}
			if (parsedLine.type === 'done') {
				return {
					remainder,
					accumulatedText: nextAccumulatedText,
					completed: true,
					firstDeltaAfterMs: nextFirstDeltaAfterMs,
				};
			}

			throw new Error(parsedLine.message ?? 'Unknown completion API error');
		}

		return {
			remainder,
			accumulatedText: nextAccumulatedText,
			completed: false,
			firstDeltaAfterMs: nextFirstDeltaAfterMs,
		};
	}

	private processSseLine(
		rawLine: string,
		vendor: IVSCloneCompletionSubmitRequest['selection']['vendor'],
		state: ICompletionStreamState,
	) {
		const line = rawLine.trimEnd();
		if (line === '') {
			state.currentEventType = undefined;
			return undefined;
		}

		if (line.startsWith('event:')) {
			state.currentEventType = line.slice(6).trim();
			return undefined;
		}

		return parseText(vendor, line, state.currentEventType);
	}
}
