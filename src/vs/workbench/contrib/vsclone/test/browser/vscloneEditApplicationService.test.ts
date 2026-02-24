/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { applyResolvedEditsInReverse, IVSCloneParsedEdit, parseSearchReplaceBlocks, resolveContentEdits } from '../../browser/vscloneEditApplicationService.js';

suite('VSCloneEditApplicationService', () => {
	test('parses SEARCH/REPLACE blocks with file paths', () => {
		const response = [
			'File: src/foo.ts',
			'<<<<<<< SEARCH',
			'const x = 1;',
			'=======',
			'const x = 2;',
			'>>>>>>> REPLACE',
			'',
			'File: src/bar.ts',
			'<<<<<<< SEARCH',
			'',
			'=======',
			'export const created = true;',
			'>>>>>>> REPLACE',
		].join('\n');

		const parsed = parseSearchReplaceBlocks(response);
		assert.strictEqual(parsed.length, 2);
		assert.strictEqual(parsed[0].filePath, 'src/foo.ts');
		assert.strictEqual(parsed[0].searchText, 'const x = 1;');
		assert.strictEqual(parsed[0].replaceText, 'const x = 2;');
		assert.strictEqual(parsed[1].filePath, 'src/bar.ts');
		assert.strictEqual(parsed[1].searchText, '');
	});

	test('resolves exact matches and applies replacements', () => {
		const content = 'const x = 1;\nconst y = 2;';
		const edits: IVSCloneParsedEdit[] = [{
			filePath: 'src/foo.ts',
			searchText: 'const x = 1;',
			replaceText: 'const x = 100;',
			order: 0,
		}];

		const resolved = resolveContentEdits(content, edits);
		assert.strictEqual(resolved.failed.length, 0);
		assert.strictEqual(resolved.resolved.length, 1);
		const next = applyResolvedEditsInReverse(content, resolved.resolved);
		assert.strictEqual(next, 'const x = 100;\nconst y = 2;');
	});

	test('falls back to whitespace-insensitive matching', () => {
		const content = 'function run() {\n\tconst value = 1;\n}\n';
		const edits: IVSCloneParsedEdit[] = [{
			filePath: 'src/foo.ts',
			searchText: 'function run() {\n  const value = 1;\n}',
			replaceText: 'function run() {\n  const value = 2;\n}',
			order: 0,
		}];

		const resolved = resolveContentEdits(content, edits);
		assert.strictEqual(resolved.failed.length, 0);
		assert.strictEqual(resolved.resolved.length, 1);
		const next = applyResolvedEditsInReverse(content, resolved.resolved);
		assert.ok(next.includes('const value = 2;'));
	});

	test('applies multiple edits bottom-to-top to preserve original offsets', () => {
		const content = 'abc def ghi';
		const edits: IVSCloneParsedEdit[] = [
			{ filePath: 'src/foo.ts', searchText: 'abc', replaceText: 'abc123456', order: 0 },
			{ filePath: 'src/foo.ts', searchText: 'ghi', replaceText: 'XYZ', order: 1 },
		];

		const resolved = resolveContentEdits(content, edits);
		assert.strictEqual(resolved.failed.length, 0);
		const next = applyResolvedEditsInReverse(content, resolved.resolved);
		assert.strictEqual(next, 'abc123456 def XYZ');
	});
});
