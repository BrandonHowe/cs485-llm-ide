/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { findDiffs } from '../../browser/helpers/findDiffs.js';

suite('VSClone findDiffs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns a single edit for adjacent removed and added lines', () => {
		const diffs = findDiffs(
			[
				'function greet() {',
				'\treturn "hello";',
				'}',
			].join('\n'),
			[
				'function greet() {',
				'\treturn "hi";',
				'}',
			].join('\n'),
		);

		assert.deepStrictEqual(diffs, [{
			type: 'edit',
			originalCode: '\treturn "hello";',
			originalStartLine: 2,
			originalEndLine: 2,
			code: '\treturn "hi";',
			startLine: 2,
			endLine: 2,
		}]);
	});

	test('classifies pure insertions and deletions without widening neighboring ranges', () => {
		const diffs = findDiffs(
			[
				'const first = 1;',
				'const removed = true;',
				'const last = 3;',
			].join('\n'),
			[
				'const first = 1;',
				'const inserted = 2;',
				'const last = 3;',
				'const tail = 4;',
			].join('\n'),
		);

		assert.deepStrictEqual(diffs, [
			{
				type: 'edit',
				originalCode: 'const removed = true;',
				originalStartLine: 2,
				originalEndLine: 2,
				code: 'const inserted = 2;',
				startLine: 2,
				endLine: 2,
			},
			{
				type: 'insertion',
				originalStartLine: 4,
				code: 'const tail = 4;',
				startLine: 4,
				endLine: 4,
			},
		]);
	});

	test('normalizes a missing trailing newline into an insertion', () => {
		const diffs = findDiffs('export const value = 1;', 'export const value = 1;\n');

		assert.deepStrictEqual(diffs, [{
			type: 'insertion',
			originalStartLine: 2,
			code: '',
			startLine: 2,
			endLine: 2,
		}]);
	});

	test('reports pure deletion ranges at the next surviving new-file line', () => {
		const diffs = findDiffs(
			[
				'const first = 1;',
				'const removed = 2;',
				'const last = 3;',
			].join('\n'),
			[
				'const first = 1;',
				'const last = 3;',
			].join('\n'),
		);

		assert.deepStrictEqual(diffs, [{
			type: 'deletion',
			originalCode: 'const removed = 2;',
			originalStartLine: 2,
			originalEndLine: 2,
			startLine: 2,
		}]);
	});
});
