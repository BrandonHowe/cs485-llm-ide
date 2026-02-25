/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatToolDefinitionsForPrompt, formatToolResult, VSCLONE_TOOL_DEFINITIONS } from '../../common/vscloneToolDefinitions.js';

suite('VSCloneToolDefinitions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('formats tool definitions for the system prompt', () => {
		const promptSection = formatToolDefinitionsForPrompt();
		assert.ok(promptSection.includes('## Available Tools'));
		assert.ok(promptSection.includes('<tool_call>'));
		for (const tool of VSCLONE_TOOL_DEFINITIONS) {
			assert.ok(promptSection.includes(`### ${tool.name}`));
		}
		assert.ok(promptSection.includes('attempt_completion'));
		assert.ok(promptSection.includes('Thinking:'));
	});

	test('formats tool results in xml wrapper', () => {
		const result = formatToolResult('read_file', {
			success: true,
			output: 'Contents of /workspace/src/app.ts',
		});

		assert.ok(result.startsWith('<tool_result'));
		assert.ok(result.includes('tool_name="read_file"'));
		assert.ok(result.includes('success="true"'));
		assert.ok(result.includes('Contents of /workspace/src/app.ts'));
		assert.ok(result.endsWith('</tool_result>'));
	});
});
