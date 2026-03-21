/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { VSCloneCompletionChannel } from '../../electron-main/vscloneCompletionChannel.js';
import { IVSCloneCompletionPromptEnvelope } from '../../common/vscloneCompletionTypes.js';
import {
	IVSCloneCompletionSubmitRequest,
	IVSCloneCompletionSubmitResponse,
	VSCLONE_COMPLETION_COMMAND_SUBMIT,
} from '../../common/backend/vscloneCompletionApiIpc.js';
import { IVSCloneModelSelection } from '../../common/vscloneModelSelectionTypes.js';

/**
 * The channel consumes raw SSE bytes, so the tests build streams by hand to verify that incomplete
 * line boundaries at EOF cannot drop the final completion text.
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

function createSubmitRequest(): IVSCloneCompletionSubmitRequest {
	const envelope: IVSCloneCompletionPromptEnvelope = {
		prefix: 'console.',
		suffix: '',
		languageId: 'typescript',
		filePath: '/workspace/src/app.ts',
		predictionType: 'single-line',
		maxTokens: 96,
		temperature: 0.01,
		stopTokens: ['\n'],
		systemMessage: 'system',
		promptText: 'prompt',
	};
	const selection: IVSCloneModelSelection = {
		location: 'editorInline',
		modelIdentifier: 'openai/gpt-5.3-codex',
		vendor: 'openai',
		modelId: 'gpt-5.3-codex',
		modelName: 'GPT-5.3-Codex',
		selectedAt: Date.now(),
	};

	return {
		requestId: 'request-1',
		headers: { Authorization: 'Bearer openai-token' },
		envelope,
		selection,
	};
}

suite('VSCloneCompletionChannel', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('flushes a trailing completion delta that ends at EOF', async () => {
		const testDisposables = store.add(new DisposableStore());
		const channel = testDisposables.add(new VSCloneCompletionChannel(new NullLogService()));
		const request = createSubmitRequest();

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(createStream([
			createOpenAIDeltaLine('log();'),
		]), { status: 200 });

		try {
			const response = await channel.call<IVSCloneCompletionSubmitResponse>('', VSCLONE_COMPLETION_COMMAND_SUBMIT, request);
			assert.strictEqual(response.rawText, 'log();');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('stops on a trailing done marker that arrives without a final newline', async () => {
		const testDisposables = store.add(new DisposableStore());
		const channel = testDisposables.add(new VSCloneCompletionChannel(new NullLogService()));
		const request = createSubmitRequest();

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(createStream([
			`${createOpenAIDeltaLine('log(')}\n`,
			`${createOpenAIDeltaLine('value);')}\n`,
			'data: [DONE]',
		]), { status: 200 });

		try {
			const response = await channel.call<IVSCloneCompletionSubmitResponse>('', VSCLONE_COMPLETION_COMMAND_SUBMIT, request);
			assert.strictEqual(response.rawText, 'log(value);');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
