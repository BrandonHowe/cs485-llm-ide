/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IChannel, IServerChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { VSCloneLLMMessageService } from '../../common/vscloneLLMMessageService.js';
import { VSCloneLLMMessageChannel } from '../../electron-main/vscloneLLMMessageChannel.js';
import {
	type IVSCloneLLMMessageFinalPayload,
	type IVSCloneLLMMessageRequest,
	type IVSCloneLLMMessageTextPayload,
	VSCLONE_LLM_MESSAGE_COMMAND_ABORT,
	VSCLONE_LLM_MESSAGE_COMMAND_SUBMIT,
} from '../../common/vscloneLLMMessageTypes.js';
import { defaultOAuthProviderConfig } from '../../common/vscloneOAuthTypes.js';

function createClientChannel(serverChannel: IServerChannel<string>): IChannel {
	// The browser-facing service and the Electron-side channel use different IPC interfaces. This
	// adapter keeps the real command/event implementation intact while bypassing the full workbench
	// IPC stack that the unit harness does not stand up.
	return {
		call: <T>(command: string, arg?: unknown) => serverChannel.call<T>('', command, arg),
		listen: <T>(event: string) => serverChannel.listen<T>('', event),
	};
}

function createMainProcessService(channel: IChannel): IMainProcessService {
	return {
		_serviceBrand: undefined,
		getChannel: () => channel,
		registerChannel: () => undefined,
	};
}

function createFIMRequest(): IVSCloneLLMMessageRequest {
	return {
		kind: 'fim',
		auth: {
			vendor: 'openai',
			headers: {
				Authorization: 'Bearer test-openai-token',
			},
		},
		prepared: {
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelIdentifier: 'openai/gpt-5.3-codex',
			prompt: {
				prefix: 'const answer = ',
				suffix: ';',
				maxTokens: 64,
				temperature: 0,
				stopTokens: [],
				systemMessage: 'Complete the code.',
				promptText: 'Finish the line',
			},
		},
	};
}

function createSseStream(lines: readonly string[]): ReadableStream<Uint8Array> {
	// The FIM transport reads raw SSE lines from a `ReadableStream`. Building the response body this
	// way exercises the production chunk parser instead of short-circuiting it with a helper that
	// hands the service already-decoded events.
	return new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			for (const line of lines) {
				controller.enqueue(encoder.encode(line));
			}
			controller.close();
		},
	});
}

suite('VSCloneLLMMessage renderer/main-process integration', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('streams FIM text and the final response across the renderer/main-process bridge', async () => {
		const testDisposables = store.add(new DisposableStore());
		const serverChannel = testDisposables.add(new VSCloneLLMMessageChannel(new NullLogService()));
		const clientChannel = createClientChannel(serverChannel);
		const service = testDisposables.add(new VSCloneLLMMessageService(
			createMainProcessService(clientChannel),
			new NullLogService(),
		));
		const originalFetch = globalThis.fetch;
		const requests: RequestInit[] = [];
		const textEvents: IVSCloneLLMMessageTextPayload[] = [];
		let finalPayload: IVSCloneLLMMessageFinalPayload | undefined;

		// The OpenAI FIM path uses plain `fetch`, which makes it the cleanest way to exercise the
		// real renderer↔main-process seam without having to stub provider SDK module imports.
		globalThis.fetch = async (input, init) => {
			requests.push(init ?? {});
			assert.strictEqual(String(input), defaultOAuthProviderConfig.openai.apiEndpoint);

			return {
				ok: true,
				status: 200,
				statusText: 'OK',
				body: createSseStream([
					'data: {"type":"response.output_text.delta","delta":"hel"}\n\n',
					'data: {"type":"response.output_text.delta","delta":"lo"}\n\n',
					'data: {"type":"response.completed"}\n\n',
				]),
				text: async () => '',
			} as Response;
		};

		try {
			const handle = service.sendRequest(createFIMRequest(), {
				onText: payload => textEvents.push(payload),
				onFinalMessage: payload => {
					finalPayload = payload;
				},
			});

			await handle.done;
		} finally {
			globalThis.fetch = originalFetch;
		}

		assert.strictEqual(requests.length, 1);
		assert.deepStrictEqual(requests[0].headers, {
			Authorization: 'Bearer test-openai-token',
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
		});
		assert.deepStrictEqual(textEvents.map(event => ({
			text: event.text,
			fullText: event.fullText,
		})), [
			{ text: 'hel', fullText: 'hel' },
			{ text: 'lo', fullText: 'hello' },
		]);
		assert.deepStrictEqual(finalPayload, {
			fullText: 'hello',
			fullReasoning: '',
			toolCall: undefined,
			anthropicReasoning: null,
			tokenUsage: undefined,
		});
	});

	test('propagates renderer cancellation to the main-process abort signal', async () => {
		const testDisposables = store.add(new DisposableStore());
		const serverChannel = testDisposables.add(new VSCloneLLMMessageChannel(new NullLogService()));
		const clientChannel = createClientChannel(serverChannel);
		const service = testDisposables.add(new VSCloneLLMMessageService(
			createMainProcessService(clientChannel),
			new NullLogService(),
		));
		const originalFetch = globalThis.fetch;
		let capturedSignal: AbortSignal | undefined;
		let backendAbortCount = 0;
		let observerAbortCount = 0;
		let finalMessageCount = 0;

		globalThis.fetch = async (_input, init) => {
			capturedSignal = init?.signal as AbortSignal | undefined;

			return {
				ok: true,
				status: 200,
				statusText: 'OK',
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						// The stream intentionally never produces data. Instead, the test waits for the
						// browser-side cancellation path to reach the backend `AbortSignal`, at which
						// point the reader errors exactly like a cancelled network stream would.
						capturedSignal?.addEventListener('abort', () => {
							backendAbortCount += 1;
							controller.error(new Error('aborted'));
						}, { once: true });
					},
				}),
				text: async () => '',
			} as Response;
		};

		try {
			const handle = service.sendRequest(createFIMRequest(), {
				onAbort: () => {
					observerAbortCount += 1;
				},
				onFinalMessage: () => {
					finalMessageCount += 1;
				},
			});

			// Yield once so the backend channel has time to issue the fetch and expose its signal.
			await timeout(0);
			handle.cancel();
			await timeout(0);
			await handle.done;
		} finally {
			globalThis.fetch = originalFetch;
		}

		assert.strictEqual(observerAbortCount, 1);
		assert.strictEqual(backendAbortCount, 1);
		assert.strictEqual(capturedSignal?.aborted, true);
		assert.strictEqual(finalMessageCount, 0);
	});

	test('settles pending renderer requests when the service is disposed', async () => {
		const testDisposables = store.add(new DisposableStore());
		const calls: { readonly command: string; readonly arg: unknown }[] = [];
		const channel: IChannel = {
			call: <T>(command: string, arg?: unknown) => {
				calls.push({ command, arg });
				if (command === VSCLONE_LLM_MESSAGE_COMMAND_ABORT) {
					return Promise.resolve(undefined as T);
				}

				// Keep the submit unresolved so the only way `done` can settle is through the
				// service disposal path under test.
				return new Promise<T>(() => undefined);
			},
			listen: <T>() => Event.None as Event<T>,
		};
		const service = testDisposables.add(new VSCloneLLMMessageService(
			createMainProcessService(channel),
			new NullLogService(),
		));
		let observerAbortCount = 0;

		const handle = service.sendRequest(createFIMRequest(), {
			onAbort: () => {
				observerAbortCount += 1;
			},
		});
		service.dispose();
		await handle.done;

		assert.deepStrictEqual({
			observerAbortCount,
			calls: calls.map(call => call.command),
			abortRequestId: (calls[1]?.arg as { readonly requestId?: string } | undefined)?.requestId,
			doneSettled: true,
		}, {
			observerAbortCount: 1,
			calls: [
				VSCLONE_LLM_MESSAGE_COMMAND_SUBMIT,
				VSCLONE_LLM_MESSAGE_COMMAND_ABORT,
			],
			abortRequestId: handle.requestId,
			doneSettled: true,
		});
	});

	test('aborts running main-process requests when the channel is disposed', async () => {
		const testDisposables = store.add(new DisposableStore());
		const serverChannel = testDisposables.add(new VSCloneLLMMessageChannel(new NullLogService()));
		const originalFetch = globalThis.fetch;
		let capturedSignal: AbortSignal | undefined;
		let backendAbortCount = 0;

		globalThis.fetch = async (_input, init) => {
			capturedSignal = init?.signal as AbortSignal | undefined;

			return {
				ok: true,
				status: 200,
				statusText: 'OK',
				body: new ReadableStream<Uint8Array>({
					start(controller) {
						// Channel disposal should abort the main-process controller even when no renderer
						// cancellation command is sent.
						capturedSignal?.addEventListener('abort', () => {
							backendAbortCount += 1;
							controller.error(new Error('disposed'));
						}, { once: true });
					},
				}),
				text: async () => '',
			} as Response;
		};

		try {
			await serverChannel.call('', VSCLONE_LLM_MESSAGE_COMMAND_SUBMIT, {
				requestId: 'dispose-test-request',
				request: createFIMRequest(),
			});

			// Let the async request runner enter `fetch` before disposing the channel.
			await timeout(0);
			serverChannel.dispose();
			await timeout(0);
		} finally {
			globalThis.fetch = originalFetch;
		}

		assert.deepStrictEqual({
			backendAbortCount,
			signalAborted: capturedSignal?.aborted,
		}, {
			backendAbortCount: 1,
			signalAborted: true,
		});
	});
});
