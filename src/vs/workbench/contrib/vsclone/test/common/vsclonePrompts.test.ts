/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { assembleVSCloneSystemMessage, type IVSClonePromptContext } from '../../common/vsclonePrompts.js';

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
});
