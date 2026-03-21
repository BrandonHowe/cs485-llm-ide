/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { postProcessCompletion } from '../../common/vscloneCompletionPostProcessor.js';

suite('VSCloneCompletionPostProcessor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('strips markdown wrappers before returning text', () => {
		const processed = postProcessCompletion('```ts\nconsole.log(value);\n```', 'console.', '', 'single-line');
		assert.strictEqual(processed, 'console.log(value);');
	});

	test('trims overlap with existing suffix text', () => {
		const processed = postProcessCompletion('value);', 'return ', ');', 'single-line');
		assert.strictEqual(processed, 'value');
	});

	test('enforces a single-line payload when requested', () => {
		const processed = postProcessCompletion('log();\nnextLine();', 'console.', '', 'single-line');
		assert.strictEqual(processed, 'log();');
	});

	test('truncates at unexpected closing brackets', () => {
		const processed = postProcessCompletion(')}', 'if (ready', '', 'single-line');
		assert.strictEqual(processed, ')');
	});

	test('truncates repeated lines to the first two copies', () => {
		const processed = postProcessCompletion('item,\nitem,\nitem,\nitem,\nnextItem,', '', '', 'multi-line');
		assert.strictEqual(processed, 'item,\nitem,');
	});

	test('decodes escaped multiline blocks into real newlines', () => {
		const processed = postProcessCompletion('\\n  if (n <= 1) {\\n    return n;\\n  }\\n\\n  return n;', '  ', '', 'multi-line');
		assert.strictEqual(processed, 'if (n <= 1) {\n    return n;\n  }\n\n  return n;');
	});

	test('decodes mixed escaped and real newlines in multiline blocks', () => {
		const processed = postProcessCompletion('\\n  }\\n  return fibonacci(n - 1) + fibonacci(n - 2);\\n\n', 'function fibonacci(n: number): number {\n  if (n <= 1) {\n    return n;\n  ', '', 'multi-line');
		assert.strictEqual(processed, '}\n  return fibonacci(n - 1) + fibonacci(n - 2);');
	});

	test('decodes escaped multiline blocks before single-line truncation', () => {
		const processed = postProcessCompletion('\\n  }\\n  return fibonacci(n - 1) + fibonacci(n - 2);\\n', 'function fibonacci(n: number): number {\n  if (n <= 1) {\n    return n;\n  ', '', 'single-line');
		assert.strictEqual(processed, '}');
	});

	test('rejects runaway completions with eight repeated lines', () => {
		const processed = postProcessCompletion('value\nvalue\nvalue\nvalue\nvalue\nvalue\nvalue\nvalue', '', '', 'multi-line');
		assert.strictEqual(processed, undefined);
	});

	test('truncates when completion starts repeating suffix lines', () => {
		const processed = postProcessCompletion('return value;\ncleanup();\nfinish();', '', 'before();\ncleanup();\nnext();', 'multi-line');
		assert.strictEqual(processed, 'return value;');
	});

	test('truncates at scope exit while preserving closing brackets', () => {
		const processed = postProcessCompletion('run();\n\t}\noutside();', 'function test() {\n\tif (ready) {\n\t\t', '', 'multi-line');
		assert.strictEqual(processed, 'run();\n\t}');
	});

	test('returns undefined when normalization yields empty text', () => {
		const processed = postProcessCompletion('```\n```', '', '', 'single-line');
		assert.strictEqual(processed, undefined);
	});
});
