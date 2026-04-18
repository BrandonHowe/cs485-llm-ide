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
		const promptSection = formatToolDefinitionsForPrompt('act');
		assert.ok(promptSection.includes('## Available Tools'));
		assert.ok(promptSection.includes('native tool-calling interface'));
		for (const tool of VSCLONE_TOOL_DEFINITIONS) {
			assert.ok(promptSection.includes(`### ${tool.name}`));
		}
		assert.ok(promptSection.includes('attempt_completion'));
		assert.ok(promptSection.includes('Only call read_file for paths you directly observed'));
		assert.ok(promptSection.includes('The system prompt does not include a precomputed workspace tree'));
		assert.ok(promptSection.includes('If ls_dir returns no entries, treat the directory as empty'));
		assert.ok(promptSection.includes('Call one tool at a time and wait for its tool result before calling another tool.'));
		assert.ok(promptSection.includes('Do not hand-write XML or pseudo-tool syntax.'));
		assert.ok(promptSection.includes('Never invent tool results yourself.'));
		assert.ok(promptSection.includes('For attempt_completion, put the final user-facing summary in the `result` argument'));
	});

	test('filters mutating tools from the prompt in plan mode', () => {
		const promptSection = formatToolDefinitionsForPrompt('plan');
		assert.ok(promptSection.includes('read-only'));
		assert.ok(promptSection.includes('### read_file'));
		assert.ok(promptSection.includes('### attempt_completion'));
		assert.ok(!promptSection.includes('### edit_file'));
		assert.ok(!promptSection.includes('### create_file'));
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
