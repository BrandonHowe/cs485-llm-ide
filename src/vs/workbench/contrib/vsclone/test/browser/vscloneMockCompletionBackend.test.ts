/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IVSCloneCompletionRequest } from '../../common/vscloneCompletionTypes.js';
import { VSCloneMockCompletionBackend } from '../../browser/vscloneMockCompletionBackend.js';

interface IVSCloneMockCompletionBackendInternals {
	generateCompletion(request: IVSCloneCompletionRequest): string | undefined;
	completeBlockCharacters(prefix: string, currentIndentation: string, nestedIndentation: string): string | undefined;
	completeCommonPatterns(linePrefix: string, linePrefixTrimmedRight: string, currentIndentation: string, nestedIndentation: string): string | undefined;
	completeLineContinuation(prefix: string, linePrefix: string): string | undefined;
}

function createRequest(overrides: Partial<IVSCloneCompletionRequest> = {}): IVSCloneCompletionRequest {
	return {
		prefix: 'console.',
		suffix: '',
		languageId: 'typescript',
		filePath: '/workspace/src/app.ts',
		predictionType: 'single-line',
		maxTokens: 64,
		...overrides,
	};
}

suite('VSCloneMockCompletionBackend', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('complete waits for the transport delay before resolving generated text', async () => {
		const sandbox = sinon.createSandbox();
		try {
			const clock = sandbox.useFakeTimers();
			const backend = new VSCloneMockCompletionBackend();
			const request = createRequest({ prefix: 'console.' });
			const cts = new CancellationTokenSource();
			let settled = false;
			const resultPromise = backend.complete(request, cts.token).then(result => {
				settled = true;
				return result;
			});

			await clock.tickAsync(199);
			assert.strictEqual(settled, false);

			await clock.tickAsync(1);
			assert.strictEqual(await resultPromise, 'log();');
			assert.strictEqual(settled, true);
		} finally {
			sandbox.restore();
		}
	});

	test('complete returns undefined when the token is cancelled during the delay', async () => {
		const sandbox = sinon.createSandbox();
		try {
			const clock = sandbox.useFakeTimers();
			const backend = new VSCloneMockCompletionBackend();
			const cts = new CancellationTokenSource();
			const resultPromise = backend.complete(createRequest({ prefix: 'if (' }), cts.token);

			cts.cancel();
			await clock.tickAsync(200);

			assert.strictEqual(await resultPromise, undefined);
		} finally {
			sandbox.restore();
		}
	});

	test('generateCompletion falls back to multiline indentation when no more specific pattern matches', () => {
		const backend = new VSCloneMockCompletionBackend() as unknown as IVSCloneMockCompletionBackendInternals;

		assert.strictEqual(
			backend.generateCompletion(createRequest({
				prefix: 'function test() {\n    value',
				predictionType: 'multi-line',
			})),
			'\n        ',
		);
	});

	test('complete only considers the current line when matching keyword completions', async () => {
		const sandbox = sinon.createSandbox();
		try {
			const clock = sandbox.useFakeTimers();
			const backend = new VSCloneMockCompletionBackend();
			const resultPromise = backend.complete(createRequest({
				prefix: 'console.\nvalue',
			}), new CancellationTokenSource().token);

			await clock.tickAsync(200);

			assert.strictEqual(await resultPromise, undefined);
		} finally {
			sandbox.restore();
		}
	});

	test('generateCompletion preserves tab indentation when the surrounding block uses tabs', () => {
		const backend = new VSCloneMockCompletionBackend() as unknown as IVSCloneMockCompletionBackendInternals;

		assert.strictEqual(
			backend.generateCompletion(createRequest({
				prefix: 'function test() {\n\tvalue',
				predictionType: 'multi-line',
			})),
			'\n\t\t',
		);
	});

	test('completeBlockCharacters returns the expected delimiter completions', () => {
		const backend = new VSCloneMockCompletionBackend() as unknown as IVSCloneMockCompletionBackendInternals;

		assert.strictEqual(backend.completeBlockCharacters('if (ready) {', '  ', '    '), '\n    \n  }');
		assert.strictEqual(backend.completeBlockCharacters('fn(', '  ', '    '), ')');
		assert.strictEqual(backend.completeBlockCharacters('arr[', '  ', '    '), ']');
		assert.strictEqual(backend.completeBlockCharacters('case 1:', '  ', '    '), '\n    ');
		assert.strictEqual(backend.completeBlockCharacters('value', '  ', '    '), undefined);
	});

	test('completeCommonPatterns returns keyword-driven snippets and leaves unmatched input alone', () => {
		const backend = new VSCloneMockCompletionBackend() as unknown as IVSCloneMockCompletionBackendInternals;

		assert.strictEqual(backend.completeCommonPatterns('if (', 'if (', '', '  '), 'condition) {\n  \n}');
		assert.strictEqual(backend.completeCommonPatterns('for (', 'for (', '', '  '), 'let i = 0; i < arr.length; i++) {\n  \n}');
		assert.strictEqual(backend.completeCommonPatterns('function ', 'function', '', '  '), 'name(params) {\n  \n}');
		assert.strictEqual(backend.completeCommonPatterns('console.', 'console.', '', '  '), 'log();');
		// eslint-disable-next-line local/code-no-unexternalized-strings
		assert.strictEqual(backend.completeCommonPatterns('import ', 'import', '', '  '), "{ } from '';");
		assert.strictEqual(backend.completeCommonPatterns('return ', 'return', '', '  '), ';');
		assert.strictEqual(backend.completeCommonPatterns('value', 'value', '', '  '), undefined);
	});

	test('completeLineContinuation reuses the right-hand side of previous assignments and respects the lookback window', () => {
		const backend = new VSCloneMockCompletionBackend() as unknown as IVSCloneMockCompletionBackendInternals;

		assert.strictEqual(backend.completeLineContinuation('const answer = 42;\nvalue =', 'value ='), ' 42;');
		assert.strictEqual(backend.completeLineContinuation('console.log(1);\ncons', 'cons'), 'ole.log(1);');
		assert.strictEqual(backend.completeLineContinuation('console.log(1);\nfoo\nbar\nbaz\nqux\nquux\ncorge\ngrault\ngarply\nwaldo\nfred\ncons', 'cons'), undefined);
	});
});
