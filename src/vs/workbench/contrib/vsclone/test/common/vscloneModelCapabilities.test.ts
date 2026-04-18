/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { getVSCloneModelCapabilityMetadata, getVSCloneStaticModelDefinitionByIdentifier, supportsVSCloneFeature, VSCLONE_MODEL_IDENTIFIERS } from '../../common/vscloneModelCapabilities.js';

suite('VSCloneModelCapabilities', () => {
	test('publishes a trimmed static model identifier list', () => {
		assert.deepStrictEqual(
			VSCLONE_MODEL_IDENTIFIERS,
			[
				'openai/gpt-5.4',
				'openai/gpt-5.3-codex-spark',
				'openai/gpt-5.3-codex',
				'openai/gpt-5.2-codex',
				'openai/gpt-5-nano',
				'anthropic/claude-haiku-4-5-20251001',
				'anthropic/claude-3-haiku-20240307',
				'google/gemini-3.1-pro-preview',
				'google/gemini-3-flash-preview',
				'google/gemini-3.1-flash-lite-preview',
			],
		);
	});

	test('marks only the current inline-completion policy models as autocomplete-capable', () => {
		const spark = getVSCloneStaticModelDefinitionByIdentifier('openai/gpt-5.3-codex-spark');
		const gpt54 = getVSCloneStaticModelDefinitionByIdentifier('openai/gpt-5.4');
		assert.ok(spark);
		assert.ok(gpt54);

		const sparkCapabilities = getVSCloneModelCapabilityMetadata(spark!);
		const gpt54Capabilities = getVSCloneModelCapabilityMetadata(gpt54!);
		assert.strictEqual(sparkCapabilities.supportsFIM, true);
		assert.ok(sparkCapabilities.supportedFeatures.includes('Autocomplete'));
		assert.strictEqual(gpt54Capabilities.supportsFIM, false);
		assert.strictEqual(gpt54Capabilities.supportedFeatures.includes('Autocomplete'), false);
		assert.strictEqual(supportsVSCloneFeature('google', 'gemini-3.1-flash-lite-preview', 'Autocomplete'), true);
		assert.strictEqual(supportsVSCloneFeature('google', 'gemini-3.1-pro-preview', 'Autocomplete'), false);
	});
});
