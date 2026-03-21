/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IVSCloneCompletionRequest } from '../../common/vscloneCompletionTypes.js';
import { VSCloneCompletionPromptService } from '../../common/vscloneCompletionPromptService.js';
import { IVSCloneModelSelection } from '../../common/vscloneModelSelectionTypes.js';

suite('VSCloneCompletionPromptService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('builds a bounded completion envelope that preserves editor-inline context', () => {
		const service = new VSCloneCompletionPromptService();
		const request: IVSCloneCompletionRequest = {
			prefix: `before-${'p'.repeat(11_000)}   \n\t`,
			suffix: '',
			languageId: 'typescript',
			filePath: '/workspace/src/app.ts',
			predictionType: 'single-line',
			maxTokens: 128,
			crossFileContext: [{
				filePath: '/workspace/src/types.ts',
				languageId: 'typescript',
				content: 'export interface User {\n\tname: string;\n}\n',
			}],
		};
		const selection: IVSCloneModelSelection = {
			location: 'editorInline',
			modelIdentifier: 'openai/gpt-5.3-codex',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelName: 'GPT-5.3-Codex',
			selectedAt: Date.now(),
		};

		const envelope = service.buildPromptEnvelope(request, selection);

		assert.strictEqual(envelope.maxTokens, 96);
		assert.strictEqual(envelope.temperature, 0.01);
		assert.deepStrictEqual(envelope.stopTokens, ['\r\n', '\n']);
		assert.ok(envelope.prefix.length <= 10_000);
		assert.strictEqual(envelope.suffix, '\n');
		assert.ok(envelope.prefix === envelope.prefix.trimEnd());
		assert.ok(envelope.promptText.includes('Related files:'));
		assert.ok(envelope.promptText.includes('Current file:'));
		assert.ok(envelope.promptText.includes('<CURSOR>'));
		assert.ok(!envelope.promptText.includes('<PREFIX>'));
		assert.ok(!envelope.promptText.includes('<SUFFIX>'));
		assert.ok(!envelope.promptText.includes('Model:'));
		assert.ok(!envelope.promptText.includes('PredictionType:'));
		assert.ok(envelope.systemMessage.includes('Input: const x = Math.max(<CURSOR>);'));
		assert.ok(envelope.systemMessage.includes('Output: a, b'));
	});
});
