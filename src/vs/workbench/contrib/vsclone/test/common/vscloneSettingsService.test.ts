/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getVSCloneIsReasoningEnabledState, getVSCloneSendableReasoningInfo } from '../../common/vscloneModelCapabilities.js';
import { VSCloneSettingsService } from '../../common/vscloneSettingsService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { TestVSCloneOAuthService } from './vscloneTestOAuthService.js';
import { TestVSCloneUnifiedChatBackendService } from './vscloneTestUnifiedChatBackendService.js';

suite('VSCloneSettingsService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function createHarness() {
		const testDisposables = store.add(new DisposableStore());
		const storageService = testDisposables.add(new TestStorageService());
		const oauthService = new TestVSCloneOAuthService();
		const backendService = new TestVSCloneUnifiedChatBackendService();
		const settingsService = testDisposables.add(new VSCloneSettingsService(
			storageService,
			oauthService,
			backendService,
		));

		await settingsService.initialize();
		return { oauthService, settingsService };
	}

	test('projects provider enablement, feature defaults, thread snapshots, and recent models into one state object', async () => {
		const { settingsService } = await createHarness();
		const selectedModel = settingsService.getSelectableModels()[0];
		assert.ok(selectedModel);

		await settingsService.setSelectionForFeature('', {
			location: 'chat',
			modelIdentifier: selectedModel.identifier,
			vendor: selectedModel.vendor,
			modelId: selectedModel.modelId,
			modelName: selectedModel.modelName,
			selectedAt: Date.now(),
		});
		await settingsService.setSelectionForFeature('thread-1', {
			threadId: 'thread-1',
			location: 'chat',
			modelIdentifier: selectedModel.identifier,
			vendor: selectedModel.vendor,
			modelId: selectedModel.modelId,
			modelName: selectedModel.modelName,
			selectedAt: Date.now(),
		});

		const state = settingsService.getState();
		const threadChatSelection = state.threadSelections['thread-1']?.chat;
		const threadChatSnapshot = state.threadSelectionSnapshots['thread-1']?.Chat;
		assert.strictEqual(state.status, 'ready');
		assert.strictEqual(state.featureSelections.chat?.modelIdentifier, selectedModel.identifier);
		assert.strictEqual(state.modelSelectionOfFeature.Chat?.modelIdentifier, selectedModel.identifier);
		assert.strictEqual(state.featureDefaults.Chat.selection?.modelIdentifier, selectedModel.identifier);
		assert.strictEqual(threadChatSelection?.modelIdentifier, selectedModel.identifier);
		assert.strictEqual(threadChatSnapshot?.featureName, 'Chat');
		assert.ok(state.recentModelIdentifiers.includes(selectedModel.identifier));
		assert.strictEqual(state.recentModels[0]?.identifier, selectedModel.identifier);
		assert.strictEqual(state.recentModels[0]?.model?.identifier, selectedModel.identifier);
	});

	test('derives trimmed capability metadata and filters feature-specific model lists', async () => {
		const { settingsService } = await createHarness();
		const autocompleteModels = settingsService.getModelsForFeature('Autocomplete');
		const selectableAutocompleteModels = settingsService.getModelsForFeature('Autocomplete', { selectableOnly: true });
		const spark = settingsService.getModel('openai/gpt-5.3-codex-spark');
		const gpt54 = settingsService.getModel('openai/gpt-5.4');

		assert.ok(spark);
		assert.strictEqual(spark?.supportsFIM, true);
		assert.ok(spark?.supportedFeatures.includes('Autocomplete'));
		assert.ok(spark?.capabilities.supportedFeatures.includes('Autocomplete'));
		assert.ok(gpt54);
		assert.strictEqual(gpt54?.supportsFIM, false);
		assert.strictEqual(gpt54?.supportedFeatures.includes('Autocomplete'), false);
		assert.deepStrictEqual(
			autocompleteModels.map(model => model.identifier),
			[
				'openai/gpt-5.3-codex-spark',
				'openai/gpt-5-nano',
				'anthropic/claude-haiku-4-5-20251001',
				'google/gemini-2.5-flash-lite',
				'google/gemini-3.1-flash-lite-preview',
			],
		);
		assert.deepStrictEqual(
			selectableAutocompleteModels.map(model => model.identifier),
			[
				'openai/gpt-5.3-codex-spark',
				'openai/gpt-5-nano',
				'anthropic/claude-haiku-4-5-20251001',
			],
		);
	});

	test('uses Gemini 3 Flash as the default Google chat fallback', async () => {
		const { oauthService, settingsService } = await createHarness();
		oauthService.setReady('openai', false);
		oauthService.setReady('anthropic', false);
		oauthService.setReady('google', true);
		await settingsService.refreshState();

		const current = settingsService.getCurrentSelectionForFeature('', 'chat');
		// Chat fallback candidates keep OpenAI first globally, but when Google is the only selectable
		// provider the default should be Gemini 3 Flash so the reasoning dropdown uses `thinkingLevel`.
		assert.strictEqual(current?.modelIdentifier, 'google/gemini-3-flash-preview');
		assert.strictEqual(current?.reasoningEffort, 'high');
	});

	test('surfaces oauth-derived provider and model eligibility records', async () => {
		const { settingsService } = await createHarness();
		await settingsService.markModelIneligible('openai/gpt-5.3-codex-spark', 'upgrade required');

		const state = settingsService.getState();
		const spark = state.models.find(model => model.identifier === 'openai/gpt-5.3-codex-spark');
		const googleEligibility = state.eligibilityRecords.find(record => record.scope === 'provider' && record.vendor === 'google');
		const sparkEligibility = state.eligibilityRecords.find(record => record.scope === 'model' && record.modelIdentifier === 'openai/gpt-5.3-codex-spark');

		assert.ok(spark);
		assert.strictEqual(spark?.isSelectable, false);
		assert.strictEqual(spark?.unavailableReason, 'account_ineligible');
		assert.strictEqual(googleEligibility?.status, 'requires_sign_in');
		assert.strictEqual(googleEligibility?.source, 'oauth_sign_in');
		assert.strictEqual(sparkEligibility?.status, 'account_ineligible');
		assert.strictEqual(sparkEligibility?.reason, 'upgrade required');
		assert.strictEqual(sparkEligibility?.displayName, 'GPT-5.3-Codex-Spark');
		assert.deepStrictEqual(state.ineligibilityRecords, [{
			modelIdentifier: 'openai/gpt-5.3-codex-spark',
			reason: 'upgrade required',
			markedAt: state.ineligibilityRecords[0].markedAt,
		}]);
	});

	test('clears vendor ineligibility memory when the oauth identity signs out', async () => {
		const { oauthService, settingsService } = await createHarness();
		await settingsService.markModelIneligible('openai/gpt-5.3-codex-spark', 'upgrade required');
		assert.ok(settingsService.getIneligibilityRecord('openai/gpt-5.3-codex-spark'));

		oauthService.setReady('openai', false);
		await settingsService.refreshState();

		assert.strictEqual(settingsService.getIneligibilityRecord('openai/gpt-5.3-codex-spark'), undefined);
		assert.strictEqual(settingsService.getModel('openai/gpt-5.3-codex-spark')?.unavailableReason, 'provider_requires_sign_in');
	});

	test('preserves thread snapshots after provider availability changes', async () => {
		const { oauthService, settingsService } = await createHarness();
		oauthService.setReady('google', true);
		await settingsService.refreshState();

		const googleModel = settingsService.getModels('google')[0];
		assert.ok(googleModel);
		await settingsService.setSelectionForFeature('thread-1', {
			threadId: 'thread-1',
			location: 'chat',
			modelIdentifier: googleModel.identifier,
			vendor: googleModel.vendor,
			modelId: googleModel.modelId,
			modelName: googleModel.modelName,
			selectedAt: Date.now(),
		});

		oauthService.setReady('google', false);
		await settingsService.refreshState();

		const current = settingsService.getCurrentSelectionForFeature('thread-1', 'chat');
		const snapshot = settingsService.getThreadSelectionSnapshot('thread-1');
		assert.ok(current);
		assert.strictEqual(current?.modelIdentifier, googleModel.identifier);
		assert.strictEqual(snapshot?.selection.modelIdentifier, googleModel.identifier);
		assert.strictEqual(snapshot?.featureName, 'Chat');
		assert.strictEqual(settingsService.getModel(googleModel.identifier)?.isSelectable, false);
	});

	test('keeps separate thread-bound selections per location instead of overwriting the prior slot', async () => {
		const { settingsService } = await createHarness();
		const chatModel = settingsService.getSelectableModels()[0];
		const inlineModel = settingsService.getModelsForFeature('Autocomplete', { selectableOnly: true })[0];
		assert.ok(chatModel);
		assert.ok(inlineModel);

		await settingsService.setSelectionForFeature('thread-1', {
			threadId: 'thread-1',
			location: 'chat',
			modelIdentifier: chatModel.identifier,
			vendor: chatModel.vendor,
			modelId: chatModel.modelId,
			modelName: chatModel.modelName,
			selectedAt: Date.now(),
		});
		await settingsService.setSelectionForFeature('thread-1', {
			threadId: 'thread-1',
			location: 'editorInline',
			modelIdentifier: inlineModel.identifier,
			vendor: inlineModel.vendor,
			modelId: inlineModel.modelId,
			modelName: inlineModel.modelName,
			selectedAt: Date.now(),
		});

		const state = settingsService.getState();
		const threadSelections = state.threadSelections['thread-1'];
		const threadSnapshots = state.threadSelectionSnapshots['thread-1'];
		assert.strictEqual(threadSelections?.chat?.modelIdentifier, chatModel.identifier);
		assert.strictEqual(threadSelections?.editorInline?.modelIdentifier, inlineModel.identifier);
		assert.strictEqual(threadSnapshots?.Chat?.selection.modelIdentifier, chatModel.identifier);
		assert.strictEqual(threadSnapshots?.Autocomplete?.selection.modelIdentifier, inlineModel.identifier);
		assert.strictEqual(settingsService.getCurrentSelectionForFeature('thread-1', 'chat')?.modelIdentifier, chatModel.identifier);
		assert.strictEqual(settingsService.getCurrentSelectionForFeature('thread-1', 'editorInline')?.modelIdentifier, inlineModel.identifier);
	});

	test('sanitizeReasoningFields clears raw budgets for preset-slider models and preserves valid effort presets', async () => {
		// Haiku used to expose raw Anthropic thinking budgets. It now publishes an effort slider whose
		// preset labels map to provider budgets at send time, so stale stored `reasoningBudget` values
		// must be dropped while valid preset choices survive capability-shaped normalization.
		const { settingsService } = await createHarness();
		const presetSliderModelIdentifier = 'anthropic/claude-haiku-4-5-20251001';
		const effortSliderModelIdentifier = 'openai/gpt-5.4';

		const sanitized = {
			staleBudget: settingsService.sanitizeReasoningFields(presetSliderModelIdentifier, { reasoningBudget: 64_000 }),
			validPreset: settingsService.sanitizeReasoningFields(presetSliderModelIdentifier, { reasoningEffort: 'high', reasoningEnabled: true }),
			offPreset: settingsService.sanitizeReasoningFields(presetSliderModelIdentifier, { reasoningEffort: 'none', reasoningEnabled: false }),
			invalidPreset: settingsService.sanitizeReasoningFields(presetSliderModelIdentifier, { reasoningEffort: 'lite', reasoningEnabled: true }),
			effortSliderModel: settingsService.sanitizeReasoningFields(effortSliderModelIdentifier, { reasoningBudget: 2048 }),
		};

		assert.deepStrictEqual(sanitized, {
			staleBudget: { reasoningEffort: undefined, reasoningEnabled: undefined, reasoningBudget: undefined },
			validPreset: { reasoningEffort: 'high', reasoningEnabled: true, reasoningBudget: undefined },
			offPreset: { reasoningEffort: 'none', reasoningEnabled: false, reasoningBudget: undefined },
			invalidPreset: { reasoningEffort: undefined, reasoningEnabled: true, reasoningBudget: undefined },
			effortSliderModel: { reasoningEffort: undefined, reasoningEnabled: undefined, reasoningBudget: undefined },
		});
	});

	test('Haiku thinking presets route through capability helpers as on/off effort states', () => {
		// Pins the preset contract: the UI stores human-readable effort levels, while the provider
		// adapter maps those levels to Anthropic token budgets. The helpers under test are pure static
		// functions that read from the in-process capability catalog, so no settings-service harness is
		// needed.
		const haikuModelIdentifier = 'anthropic/claude-haiku-4-5-20251001';

		const offState = {
			enabled: getVSCloneIsReasoningEnabledState('Chat', 'anthropic', 'claude-haiku-4-5-20251001', {
				reasoningEnabled: false,
				reasoningEffort: 'none',
			}),
			sendable: getVSCloneSendableReasoningInfo('Chat', 'anthropic', 'claude-haiku-4-5-20251001', {
				reasoningEnabled: false,
				reasoningEffort: 'none',
			}),
		};
		const highState = {
			enabled: getVSCloneIsReasoningEnabledState('Chat', 'anthropic', 'claude-haiku-4-5-20251001', {
				reasoningEnabled: true,
				reasoningEffort: 'high',
			}),
			sendable: getVSCloneSendableReasoningInfo('Chat', 'anthropic', 'claude-haiku-4-5-20251001', {
				reasoningEnabled: true,
				reasoningEffort: 'high',
			}),
		};

		assert.deepStrictEqual({ offState, highState, haikuModelIdentifier }, {
			offState: {
				enabled: false,
				sendable: null,
			},
			highState: {
				enabled: true,
				sendable: { type: 'effort_slider_value', isReasoningEnabled: true, reasoningEffort: 'high' },
			},
			haikuModelIdentifier: 'anthropic/claude-haiku-4-5-20251001',
		});
	});
});
