/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { sanitizeAgentModelOutput } from '../../common/vscloneAgentTranscriptSanitizer.js';

suite('VSCloneAgentTranscriptSanitizer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('removes fabricated tool results and trailing prose after attempt completion', () => {
		const summary = [
			'I inspected the workspace and it appears empty.',
			'',
			'Game idea: Pizza Panic',
		].join('\n');
		const rawTranscript = [
			'Thinking: I’ll inspect the workspace first.',
			'<tool_call>',
			'<tool_name>list_directory</tool_name>',
			'<path>.</path>',
			'</tool_call>',
			'<tool_result>',
			'testgame/',
			'</tool_result>',
			'Thinking: I have enough context to summarize.',
			'<tool_call>',
			'<tool_name>attempt_completion</tool_name>',
			`<result>${summary}</result>`,
			'</tool_call>',
			summary,
		].join('\n');

		const sanitized = sanitizeAgentModelOutput(rawTranscript);

		assert.strictEqual(sanitized.removedFakeToolResults, true);
		assert.strictEqual(sanitized.truncatedAfterAttemptCompletion, true);
		assert.ok(!sanitized.sanitizedText.includes('<tool_result>\ntestgame/\n</tool_result>'));
		assert.ok(!sanitized.sanitizedText.endsWith(summary));
		assert.ok(sanitized.sanitizedText.includes('<tool_name>attempt_completion</tool_name>'));
		assert.ok(sanitized.sanitizedText.includes(`<result>${summary}</result>`));
	});

	test('preserves already-valid tool-call transcripts', () => {
		const rawTranscript = [
			'Thinking: I’ll inspect the workspace first.',
			'<tool_call>',
			'<tool_name>list_directory</tool_name>',
			'<path>.</path>',
			'</tool_call>',
		].join('\n');

		const sanitized = sanitizeAgentModelOutput(rawTranscript);

		assert.strictEqual(sanitized.removedFakeToolResults, false);
		assert.strictEqual(sanitized.truncatedAfterAttemptCompletion, false);
		assert.strictEqual(sanitized.sanitizedText, rawTranscript);
	});
});
