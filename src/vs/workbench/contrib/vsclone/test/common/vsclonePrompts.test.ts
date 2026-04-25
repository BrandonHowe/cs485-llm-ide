/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IFileService, IFileStat } from '../../../../../platform/files/common/files.js';
import { assembleVSCloneSystemMessage, formatContextSelections, isVSCloneSensitiveFilePath, type IVSClonePromptContext } from '../../common/vsclonePrompts.js';

suite('VSClonePrompts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createBaseContext(overrides: Partial<IVSClonePromptContext> = {}): IVSClonePromptContext {
		return {
			activeFile: {
				uri: URI.file('/workspace/src/app.ts'),
				languageId: 'typescript',
				content: 'function greet() {\n\treturn "hi";\n}',
				selection: 'return "hi";',
				selectionRange: { startLine: 2, endLine: 2 },
			},
			...overrides,
		};
	}

	test('assembles system message sections with project context', () => {
		const message = assembleVSCloneSystemMessage(createBaseContext(), 'openai', 'act');
		assert.ok(message.includes('## System Information'));
		assert.ok(message.includes('- Vendor: openai'));
		assert.ok(message.includes('## Active File'));
		assert.ok(message.includes('File: file:///workspace/src/app.ts (typescript)'));
		assert.ok(message.includes('Summary: 3 line(s), 34 char(s).'));
		assert.ok(!message.includes('function greet() {'));
		assert.ok(message.includes('Selected Code:'));
		assert.ok(message.includes('Selection: lines 2-2 (12 char(s)).'));
		assert.ok(message.includes('return "hi";'));
		assert.ok(message.includes('## Available Tools'));
		assert.ok(message.includes('Use tools to inspect the workspace instead of asking the user to open, share, or paste files.'));
		assert.ok(message.includes('User turns may also include image attachments.'));
		assert.ok(message.includes('Do not claim that the current request was text-only'));
		assert.ok(!message.includes('## Open Files'));
		assert.ok(!message.includes('## Workspace Structure'));
		assert.ok(!message.includes('## Diagnostics'));
		assert.ok(message.includes('Use SEARCH/REPLACE edit blocks only when calling edit_file.'));
		assert.ok(message.includes('For edit_file, the `changes` argument must contain only exact SEARCH/REPLACE blocks; never send prose, explanations, or summaries in that field.'));
		assert.ok(message.includes('For edit_file, the `changes` argument must contain only one or more SEARCH/REPLACE blocks in this exact format:'));
		assert.ok(message.includes('<<<<<<< SEARCH'));
		assert.ok(message.includes('>>>>>>> REPLACE'));
	});

	test('keeps large active files summarized while preserving a capped selection preview', () => {
		const selected = 'SELECT_ME'.repeat(400);
		const largeContent = `${'p'.repeat(55_000)}${selected}${'s'.repeat(55_000)}`;
		const message = assembleVSCloneSystemMessage(createBaseContext({
			activeFile: {
				uri: URI.file('/workspace/src/large.ts'),
				languageId: 'typescript',
				content: largeContent,
				selection: selected,
				selectionRange: { startLine: 1, endLine: 1 },
			},
		}), 'anthropic', 'act');

		assert.ok(message.includes('Summary: 1 line(s), 113600 char(s).'));
		assert.ok(message.includes('Selected Code:'));
		assert.ok(message.includes('... [selection truncated]'));
		assert.ok(!message.includes('pppppppppppppppppppp'));
		assert.ok(message.length < 8_000);
	});

	test('omits file-body dumping when there is an active file without a selection', () => {
		const message = assembleVSCloneSystemMessage(createBaseContext({
			activeFile: {
				uri: URI.file('/workspace/src/huge.ts'),
				languageId: 'typescript',
				content: 'alpha\nbeta\ngamma',
				selection: undefined,
				selectionRange: { startLine: 2, endLine: 2 },
			},
		}), 'google', 'act');

		assert.ok(message.includes('## Available Tools'));
		assert.ok(message.includes('- Vendor: google'));
		assert.ok(message.includes('Summary: 3 line(s), 16 char(s).'));
		assert.ok(message.includes('Cursor: line 2.'));
		assert.ok(!message.includes('alpha\nbeta\ngamma'));
	});

	test('swaps to read-only instructions in plan mode', () => {
		const message = assembleVSCloneSystemMessage(createBaseContext(), 'openai', 'plan');
		assert.ok(message.includes('PLAN MODE'));
		assert.ok(message.includes('This turn is read-only.'));
		assert.ok(message.includes('finish with attempt_completion once you have a concrete plan.'));
		assert.ok(!message.includes('Use SEARCH/REPLACE edit blocks only when calling edit_file.'));
		assert.ok(!message.includes('### edit_file'));
	});

	test('omits sensitive file and code selection contents without reading protected files', async () => {
		const envUri = URI.file('/workspace/.env.local');
		const { fileService, readOperations } = createContextSelectionFileService(
			new Map([[envUri.fsPath, 'API_KEY=secret-value']]),
		);

		const serialized = await formatContextSelections([
			{ kind: 'file', uri: envUri, languageId: 'properties' },
			{ kind: 'codeSelection', uri: envUri, languageId: 'properties', startLine: 1, endLine: 1 },
		], fileService);

		assert.ok(serialized.includes(envUri.fsPath));
		assert.ok(serialized.includes('(protected sensitive file; contents not included)'));
		assert.ok(!serialized.includes('secret-value'));
		assert.deepStrictEqual(readOperations, []);
	});

	test('omits sensitive file contents when inlining folder selections', async () => {
		const folderUri = URI.file('/workspace');
		const sourceUri = URI.file('/workspace/src/app.ts');
		const envUri = URI.file('/workspace/.env.production');
		const { fileService, readOperations } = createContextSelectionFileService(
			new Map([
				[sourceUri.fsPath, 'export const answer = 42;'],
				[envUri.fsPath, 'DATABASE_URL=postgres://secret'],
			]),
			new Map([[folderUri.fsPath, [
				createTestFileStat(envUri),
				createTestFileStat(sourceUri),
			]]]),
		);

		const serialized = await formatContextSelections([
			{ kind: 'folder', uri: folderUri },
		], fileService);

		assert.ok(serialized.includes(`${folderUri.fsPath} folder structure:`));
		assert.ok(serialized.includes('.env.production'));
		assert.ok(serialized.includes('export const answer = 42;'));
		assert.ok(serialized.includes('(protected sensitive file; contents not included)'));
		assert.ok(!serialized.includes('postgres://secret'));
		assert.deepStrictEqual(readOperations, [sourceUri.fsPath]);
	});

	function createContextSelectionFileService(
		fileContents: ReadonlyMap<string, string>,
		folderChildren: ReadonlyMap<string, readonly IFileStat[]> = new Map<string, readonly IFileStat[]>(),
	): { readonly fileService: IFileService; readonly readOperations: string[] } {
		const readOperations: string[] = [];
		const fileService = {
			async readFile(resource: URI) {
				// The serializer must make the policy decision before readFile, otherwise selected
				// secrets can leak into the prompt even though normal tool reads are protected.
				assert.ok(!isVSCloneSensitiveFilePath(resource.fsPath), `Sensitive file was read: ${resource.fsPath}`);
				readOperations.push(resource.fsPath);
				return { value: VSBuffer.fromString(fileContents.get(resource.fsPath) ?? '') };
			},
			async resolve(resource: URI) {
				const children = folderChildren.get(resource.fsPath);
				if (children) {
					return createTestFolderStat(resource, children);
				}
				return createTestFileStat(resource);
			},
		} as unknown as IFileService;
		return { fileService, readOperations };
	}

	function createTestFileStat(resource: URI): IFileStat {
		return createTestStat(resource, false, undefined);
	}

	function createTestFolderStat(resource: URI, children: readonly IFileStat[]): IFileStat {
		return createTestStat(resource, true, [...children]);
	}

	function createTestStat(resource: URI, isDirectory: boolean, children: IFileStat[] | undefined): IFileStat {
		return {
			resource,
			name: resource.path.split('/').filter(Boolean).at(-1) ?? resource.path,
			isFile: !isDirectory,
			isDirectory,
			isSymbolicLink: false,
			children,
		} as IFileStat;
	}
});
