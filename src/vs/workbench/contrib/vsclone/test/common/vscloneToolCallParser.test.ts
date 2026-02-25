/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseToolCalls } from '../../common/vscloneToolCallParser.js';

suite('VSCloneToolCallParser', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parses a single tool call', () => {
		const input = [
			'Need to read a file.',
			'<tool_call>',
			'<tool_name>read_file</tool_name>',
			'<path>/workspace/src/app.ts</path>',
			'</tool_call>',
		].join('\n');

		const parsed = parseToolCalls(input);
		assert.strictEqual(parsed.toolCalls.length, 1);
		assert.strictEqual(parsed.toolCalls[0].name, 'read_file');
		assert.strictEqual(parsed.toolCalls[0].params.path, '/workspace/src/app.ts');
		assert.strictEqual(parsed.textSegments.length, 2);
		assert.ok(parsed.textSegments[0].includes('Need to read a file.'));
	});

	test('parses multiple tool calls and keeps text segments in order', () => {
		const input = [
			'First action',
			'<tool_call><tool_name>list_directory</tool_name><path>/workspace</path></tool_call>',
			'Then search',
			'<tool_call><tool_name>search_files</tool_name><path>/workspace/src</path><pattern>TODO</pattern></tool_call>',
			'Finally answer',
		].join('\n');

		const parsed = parseToolCalls(input);
		assert.strictEqual(parsed.toolCalls.length, 2);
		assert.strictEqual(parsed.toolCalls[0].name, 'list_directory');
		assert.strictEqual(parsed.toolCalls[1].name, 'search_files');
		assert.strictEqual(parsed.textSegments.length, 3);
		assert.ok(parsed.textSegments[0].includes('First action'));
		assert.ok(parsed.textSegments[1].includes('Then search'));
		assert.ok(parsed.textSegments[2].includes('Finally answer'));
	});

	test('treats malformed or incomplete xml as plain text', () => {
		const malformed = '<tool_call><path>/workspace/src/app.ts</path></tool_call>';
		const incomplete = '<tool_call><tool_name>read_file</tool_name>';

		const malformedParsed = parseToolCalls(malformed);
		assert.strictEqual(malformedParsed.toolCalls.length, 0);
		assert.strictEqual(malformedParsed.textSegments.join(''), malformed);

		const incompleteParsed = parseToolCalls(incomplete);
		assert.strictEqual(incompleteParsed.toolCalls.length, 0);
		assert.strictEqual(incompleteParsed.textSegments.join(''), incomplete);
	});

	test('supports parameter bodies with angle brackets', () => {
		const input = [
			'<tool_call>',
			'<tool_name>create_file</tool_name>',
			'<path>/workspace/src/view.html</path>',
			'<content><div class="app">ok</div></content>',
			'</tool_call>',
		].join('\n');

		const parsed = parseToolCalls(input);
		assert.strictEqual(parsed.toolCalls.length, 1);
		assert.strictEqual(parsed.toolCalls[0].params.content, '<div class="app">ok</div>');
	});
});
