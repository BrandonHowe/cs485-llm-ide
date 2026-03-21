/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatToolResultWithDiff, parseToolResultDiff } from '../../common/vscloneToolResultDiff.js';

suite('VSCloneToolResultDiff', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('formats and parses structured diff payloads', () => {
		const output = formatToolResultWithDiff(
			'Applied 1 edit.',
			['--- a/src/app.ts', '+++ b/src/app.ts', '@@ -12,1 +12,1 @@', '-const x = 1;', '+const x = 2;'].join('\n'),
		);

		const parsed = parseToolResultDiff(output);
		assert.ok(parsed);
		assert.strictEqual(parsed?.summary, 'Applied 1 edit.');
		assert.ok(parsed?.diff.includes('-const x = 1;'));
		assert.ok(parsed?.diff.includes('+const x = 2;'));
	});

	test('returns undefined when output has no diff markers', () => {
		assert.strictEqual(parseToolResultDiff('Created file /tmp/app.ts.'), undefined);
	});
});
