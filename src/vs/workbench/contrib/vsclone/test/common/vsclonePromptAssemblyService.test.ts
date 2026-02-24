/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { IVSClonePromptContext, VSClonePromptAssemblyService } from '../../common/vsclonePromptAssemblyService.js';

suite('VSClonePromptAssemblyService', () => {
	const service = new VSClonePromptAssemblyService();

	function createBaseContext(overrides: Partial<IVSClonePromptContext> = {}): IVSClonePromptContext {
		return {
			activeFile: {
				uri: URI.file('/workspace/src/app.ts'),
				languageId: 'typescript',
				content: 'function greet() {\n\treturn "hi";\n}',
				selection: 'return "hi";',
				selectionRange: { startLine: 2, endLine: 2 },
			},
			openFiles: [URI.file('/workspace/src/app.ts'), URI.file('/workspace/src/util.ts')],
			workspaceFolders: [{ name: 'workspace', uri: URI.file('/workspace') }],
			directoryTree: 'workspace/\n├── src/\n│   └── app.ts',
			diagnostics: [{
				uri: URI.file('/workspace/src/app.ts'),
				message: 'Unexpected any',
				severity: 'warning',
				line: 2,
			}],
			...overrides,
		};
	}

	test('assembles system message sections with project context', () => {
		const message = service.assembleSystemMessage(createBaseContext(), 'openai');
		assert.ok(message.includes('## System Information'));
		assert.ok(message.includes('- Vendor: openai'));
		assert.ok(message.includes('## Active File'));
		assert.ok(message.includes('File: file:///workspace/src/app.ts (typescript)'));
		assert.ok(message.includes('Selected Code:'));
		assert.ok(message.includes('Lines 2-2:'));
		assert.ok(message.includes('## Diagnostics'));
		assert.ok(message.includes('Unexpected any'));
		assert.ok(message.includes('<<<<<<< SEARCH'));
	});

	test('truncates oversized active file around selected text', () => {
		const selected = 'SELECT_ME';
		const largeContent = `${'p'.repeat(5500)}${selected}${'s'.repeat(5500)}`;
		const message = service.assembleSystemMessage(createBaseContext({
			activeFile: {
				uri: URI.file('/workspace/src/large.ts'),
				languageId: 'typescript',
				content: largeContent,
				selection: selected,
				selectionRange: { startLine: 1, endLine: 1 },
			},
		}), 'anthropic');

		assert.ok(message.includes(selected));
		assert.ok(message.includes('... [truncated'));
		assert.ok(message.length <= 80000);
	});

	test('enforces overall context budget for very large trees', () => {
		const hugeTree = 'x'.repeat(120000);
		const message = service.assembleSystemMessage(createBaseContext({ directoryTree: hugeTree }), 'google');
		assert.ok(message.length <= 80000);
		assert.ok(message.includes('[system context truncated to stay within budget]'));
		assert.ok(message.includes('- Vendor: google'));
	});
});
