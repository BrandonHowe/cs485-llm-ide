/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getVSCloneIsReasoningEnabledState, getVSCloneModelCapabilityMetadata, getVSCloneProviderReasoningIOSettings, getVSCloneReservedOutputTokenSpaceForReasoning, getVSCloneSendableReasoningInfo, getVSCloneStaticModelDefinition, getVSCloneStaticModelDefinitionByIdentifier, isVSCloneReasoningEffortLevel, supportsVSCloneFeature, toVSCloneOpenAIReasoningEffort, VSCLONE_MODEL_IDENTIFIERS } from '../../common/vscloneModelCapabilities.js';

suite('VSCloneModelCapabilities', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

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
				'google/gemini-2.5-pro',
				'google/gemini-2.5-flash',
				'google/gemini-2.5-flash-lite',
				'google/gemini-3.1-pro-preview',
				'google/gemini-3-flash-preview',
				'google/gemini-3.1-flash-lite-preview',
			],
		);
	});

	test('looks up catalog definitions by provider tuple and identifier', () => {
		assert.strictEqual(getVSCloneStaticModelDefinition('openai', 'gpt-5.4')?.modelName, 'GPT-5.4');
		assert.strictEqual(getVSCloneStaticModelDefinitionByIdentifier('anthropic/claude-haiku-4-5-20251001')?.modelName, 'Haiku 4.5');
		assert.strictEqual(getVSCloneStaticModelDefinitionByIdentifier('unknown/gpt-5.4'), undefined);
		assert.strictEqual(getVSCloneStaticModelDefinitionByIdentifier('openai/unknown-model'), undefined);
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
		assert.strictEqual(supportsVSCloneFeature('google', 'gemini-2.5-flash-lite', 'Autocomplete'), true);
		assert.strictEqual(supportsVSCloneFeature('google', 'gemini-3.1-pro-preview', 'Autocomplete'), false);
	});

	test('keeps Gemini thinking preset-only instead of publishing a VSClone slider', () => {
		const gemini = getVSCloneStaticModelDefinitionByIdentifier('google/gemini-2.5-flash-lite');
		assert.ok(gemini);

		const geminiCapabilities = getVSCloneModelCapabilityMetadata(gemini!);
		// Gemini function-call replay needs provider-issued thought signatures when explicit
		// thinking is included, so the catalog must not synthesize `thinkingConfig` from stale
		// `reasoningBudget` or `reasoningEffort` selection fields.
		assert.strictEqual(geminiCapabilities.reasoningCapabilities, false);
		assert.strictEqual(getVSCloneSendableReasoningInfo('Chat', 'google', 'gemini-2.5-flash-lite', {
			reasoningEnabled: true,
			reasoningBudget: 8192,
			reasoningEffort: 'high',
		}), null);
	});

	test('resolves reasoning state and reserved output space for off-capable models', () => {
		// Chat defaults reasoning on for the Haiku-only OAuth path, but autocomplete/notebook callers
		// can still explicitly suppress send-path reasoning when users choose the off slot.
		assert.strictEqual(getVSCloneIsReasoningEnabledState('Chat', 'anthropic', 'claude-haiku-4-5-20251001', undefined), true);
		assert.strictEqual(getVSCloneIsReasoningEnabledState('Autocomplete', 'anthropic', 'claude-haiku-4-5-20251001', undefined), false);
		assert.strictEqual(getVSCloneIsReasoningEnabledState('Autocomplete', 'anthropic', 'claude-haiku-4-5-20251001', { reasoningEnabled: true }), true);
		assert.strictEqual(getVSCloneIsReasoningEnabledState('Chat', 'anthropic', 'claude-haiku-4-5-20251001', { reasoningEnabled: false }), false);
		assert.strictEqual(getVSCloneReservedOutputTokenSpaceForReasoning('anthropic', 'claude-haiku-4-5-20251001', { isReasoningEnabled: true }), 64_000);
		assert.strictEqual(getVSCloneReservedOutputTokenSpaceForReasoning('anthropic', 'claude-haiku-4-5-20251001', { isReasoningEnabled: false }), undefined);
		assert.strictEqual(getVSCloneReservedOutputTokenSpaceForReasoning('openai', 'gpt-5.4', { isReasoningEnabled: true }), undefined);
	});

	test('maps effort slider selections to provider-native request fragments', () => {
		const anthropicSettings = getVSCloneProviderReasoningIOSettings('anthropic');
		const openAISettings = getVSCloneProviderReasoningIOSettings('openai');
		const googleSettings = getVSCloneProviderReasoningIOSettings('google');

		// Anthropic is preset-driven in VSClone, but the wire API needs concrete budgets. Pin the
		// boundary values so future catalog edits do not accidentally exceed Haiku's 64k output cap.
		assert.deepStrictEqual(anthropicSettings.input?.includeInPayload?.({ type: 'effort_slider_value', isReasoningEnabled: true, reasoningEffort: 'low' }), { thinking: { type: 'enabled', budget_tokens: 1024 } });
		assert.deepStrictEqual(anthropicSettings.input?.includeInPayload?.({ type: 'effort_slider_value', isReasoningEnabled: true, reasoningEffort: 'max' }), { thinking: { type: 'enabled', budget_tokens: 7_999 } });
		assert.strictEqual(anthropicSettings.input?.includeInPayload?.({ type: 'effort_slider_value', isReasoningEnabled: true, reasoningEffort: 'none' }), null);
		assert.deepStrictEqual(anthropicSettings.input?.includeInPayload?.({ type: 'budget_slider_value', isReasoningEnabled: true, reasoningBudget: 1234 }), { thinking: { type: 'enabled', budget_tokens: 1234 } });

		assert.deepStrictEqual(openAISettings.input?.includeInPayload?.({ type: 'effort_slider_value', isReasoningEnabled: true, reasoningEffort: 'xhigh' }), { reasoning: { effort: 'high' } });
		assert.strictEqual(openAISettings.input?.includeInPayload?.({ type: 'budget_slider_value', isReasoningEnabled: true, reasoningBudget: 2048 }), null);
		assert.deepStrictEqual(googleSettings.input?.includeInPayload?.({ type: 'budget_slider_value', isReasoningEnabled: true, reasoningBudget: 2048 }), { thinkingConfig: { thinkingBudget: 2048 } });
		assert.strictEqual(googleSettings.input?.includeInPayload?.({ type: 'effort_slider_value', isReasoningEnabled: true, reasoningEffort: 'high' }), null);
	});

	test('normalizes effort labels and validates persisted effort values', () => {
		assert.strictEqual(isVSCloneReasoningEffortLevel('xhigh'), true);
		assert.strictEqual(isVSCloneReasoningEffortLevel('invalid'), false);
		assert.strictEqual(toVSCloneOpenAIReasoningEffort('max'), 'high');
		assert.strictEqual(toVSCloneOpenAIReasoningEffort('standard'), 'medium');
		assert.strictEqual(toVSCloneOpenAIReasoningEffort('lite'), 'low');
		assert.strictEqual(toVSCloneOpenAIReasoningEffort('none'), 'minimal');
	});

	test('returns sendable reasoning only for known slider-capable models', () => {
		assert.deepStrictEqual(getVSCloneSendableReasoningInfo('Chat', 'openai', 'gpt-5.4', undefined), {
			type: 'effort_slider_value',
			isReasoningEnabled: true,
			reasoningEffort: 'medium',
		});
		assert.deepStrictEqual(getVSCloneSendableReasoningInfo('Chat', 'openai', 'gpt-5.4', { reasoningEffort: 'xhigh' }), {
			type: 'effort_slider_value',
			isReasoningEnabled: true,
			reasoningEffort: 'xhigh',
		});
		assert.strictEqual(getVSCloneSendableReasoningInfo('Chat', 'anthropic', 'claude-haiku-4-5-20251001', { reasoningEffort: 'none' }), null);
		assert.strictEqual(getVSCloneSendableReasoningInfo('Chat', 'anthropic', 'claude-3-haiku-20240307', { reasoningEnabled: true }), null);
		assert.strictEqual(getVSCloneSendableReasoningInfo('Chat', 'openai', 'unknown-model', { reasoningEnabled: true, reasoningEffort: 'high' }), null);
	});
});
