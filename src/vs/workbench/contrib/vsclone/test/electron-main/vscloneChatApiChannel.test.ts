/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IVSCloneApiSubmitOptions } from '../../common/vscloneChatApiAdapters.js';
import {
	IVSCloneChatApiCompleteEvent,
	IVSCloneChatApiDeltaEvent,
	IVSCloneChatApiSubmitRequest,
	VSCLONE_CHAT_API_COMMAND_SUBMIT,
	VSCLONE_CHAT_API_EVENT_COMPLETE,
	VSCLONE_CHAT_API_EVENT_DELTA,
} from '../../common/vscloneChatApiIpc.js';
import { VSCloneChatApiChannel } from '../../electron-main/vscloneChatApiChannel.js';

function createSubmitRequest(overrides: Partial<IVSCloneApiSubmitOptions> = {}): IVSCloneChatApiSubmitRequest {
	return {
		requestId: 'request-1',
		headers: { Authorization: 'Bearer openai-token' },
		options: {
			threadId: 'thread-1',
			turnId: 'thread-1:turn-1',
			sequence: 1,
			sessionResource: 'vsclone://api/thread-1',
			promptText: 'Read styles.css',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelIdentifier: 'openai/gpt-5.3-codex',
			...overrides,
		},
	};
}

/**
 * The channel consumes SSE bytes directly, so tests build streams at the chunk level to verify
 * that transport chunk boundaries cannot truncate the final model delta.
 */
function createStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

function createOpenAIDeltaLine(text: string): string {
	return `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}`;
}

function waitForFirstEvent<T>(event: Event<T>, disposables: DisposableStore): Promise<T> {
	return new Promise<T>(resolve => {
		const listener = event(value => {
			listener.dispose();
			resolve(value);
		});
		disposables.add(listener);
	});
}

suite('VSCloneChatApiChannel', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('flushes a trailing delta line that ends at EOF', async () => {
		const testDisposables = store.add(new DisposableStore());
		const channel = testDisposables.add(new VSCloneChatApiChannel(new NullLogService()));
		const request = createSubmitRequest();
		const streamedDeltas: string[] = [];
		const completion = waitForFirstEvent(
			channel.listen<IVSCloneChatApiCompleteEvent>('', VSCLONE_CHAT_API_EVENT_COMPLETE),
			testDisposables,
		);

		testDisposables.add(channel.listen<IVSCloneChatApiDeltaEvent>('', VSCLONE_CHAT_API_EVENT_DELTA)(event => {
			streamedDeltas.push(event.text);
		}));

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(createStream([
			createOpenAIDeltaLine('<tool_call><tool_name>read_file</tool_name><path>styles.css</path></tool_call>'),
		]), { status: 200 });

		try {
			await channel.call('', VSCLONE_CHAT_API_COMMAND_SUBMIT, request);
			await completion;
		} finally {
			globalThis.fetch = originalFetch;
		}

		assert.deepStrictEqual(streamedDeltas, [
			'<tool_call><tool_name>read_file</tool_name><path>styles.css</path></tool_call>',
		]);
	});

	test('honors a trailing done marker that arrives without a final newline', async () => {
		const testDisposables = store.add(new DisposableStore());
		const channel = testDisposables.add(new VSCloneChatApiChannel(new NullLogService()));
		const request = createSubmitRequest();
		const streamedDeltas: string[] = [];
		let completionCount = 0;
		const completion = waitForFirstEvent(
			channel.listen<IVSCloneChatApiCompleteEvent>('', VSCLONE_CHAT_API_EVENT_COMPLETE),
			testDisposables,
		);

		testDisposables.add(channel.listen<IVSCloneChatApiCompleteEvent>('', VSCLONE_CHAT_API_EVENT_COMPLETE)(() => {
			completionCount += 1;
		}));
		testDisposables.add(channel.listen<IVSCloneChatApiDeltaEvent>('', VSCLONE_CHAT_API_EVENT_DELTA)(event => {
			streamedDeltas.push(event.text);
		}));

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(createStream([
			`${createOpenAIDeltaLine('Thinking: I will inspect styles.css first.')}\n`,
			'data: [DONE]',
		]), { status: 200 });

		try {
			await channel.call('', VSCLONE_CHAT_API_COMMAND_SUBMIT, request);
			await completion;
		} finally {
			globalThis.fetch = originalFetch;
		}

		assert.deepStrictEqual({ streamedDeltas, completionCount }, {
			streamedDeltas: ['Thinking: I will inspect styles.css first.'],
			completionCount: 1,
		});
	});
});
