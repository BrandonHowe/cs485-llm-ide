/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	applyResolvedEditsInReverse,
	IVSCloneParsedEdit,
	parseSearchReplaceBlocks,
	resolveContentEdits,
	VSCloneEditApplicationService,
} from '../../browser/vscloneEditApplicationService.js';
import type { IVSCloneEditCodeService } from '../../browser/vscloneEditCodeServiceInterface.js';

suite('VSCloneEditApplicationService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function trackServiceLifetime<T extends object>(service: T): T {
		// The current subject under test is not disposable, but the suite still registers constructed
		// services with the standard leak harness so future disposable collaborators are covered.
		return store.add(Object.assign(service, { dispose: () => undefined }));
	}

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

	test('delegates start/apply/undo calls to the edit code service without flattening apply results', async () => {
		const calls: string[] = [];
		const fileChanges = [{
			uri: { toString: () => 'file:///workspace/src/app.ts' },
			displayPath: 'src/app.ts',
			addedLines: 1,
			removedLines: 1,
			action: 'modify' as const,
		}];
		const editCodeService = {
			hasSearchReplaceBlocks: () => true,
			parseSearchReplaceBlocks: () => [],
			startApplyingSearchReplaceBlocks: async (responseText: string) => {
				calls.push(`start:${responseText}`);
				return {
					attemptedEdits: 1,
					appliedEdits: 1,
					modifiedFiles: [fileChanges[0].uri],
					failures: [],
					fileChanges,
				};
			},
			applySearchReplaceBlocks: async (responseText: string) => {
				calls.push(`apply:${responseText}`);
				return {
					attemptedEdits: 1,
					appliedEdits: 1,
					modifiedFiles: [fileChanges[0].uri],
					failures: [],
					fileChanges,
				};
			},
			undoEditApply: async (changes: readonly typeof fileChanges) => {
				calls.push(`undo:${changes.length}`);
				return {
					revertedFiles: [fileChanges[0].uri],
					failures: [],
				};
			},
		} as unknown as IVSCloneEditCodeService;
		const service = trackServiceLifetime(new VSCloneEditApplicationService(editCodeService));

		const startResult = await service.startApplyingSearchReplaceBlocks('File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE');
		const applyResult = await service.applySearchReplaceBlocks('File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE');
		const undoResult = await service.undoEditApply(fileChanges);

		assert.deepStrictEqual(calls, [
			'start:File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
			'apply:File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
			'undo:1',
		]);
		assert.deepStrictEqual(startResult.fileChanges, fileChanges);
		assert.deepStrictEqual(applyResult.fileChanges, fileChanges);
		assert.deepStrictEqual(undoResult, {
			revertedFiles: [fileChanges[0].uri],
			failures: [],
		});
	});
});
