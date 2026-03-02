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

	test('returns undefined when normalization yields empty text', () => {
		const processed = postProcessCompletion('```\n```', '', '', 'single-line');
		assert.strictEqual(processed, undefined);
	});
});
