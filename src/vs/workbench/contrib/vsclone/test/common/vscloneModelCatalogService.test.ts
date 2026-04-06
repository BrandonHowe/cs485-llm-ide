/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSCloneModelCatalogService } from '../../common/vscloneModelCatalogService.js';
import { VSCloneModelEligibilityService } from '../../common/vscloneModelEligibilityService.js';
import { VSCloneProviderPreferencesService } from '../../common/vscloneProviderPreferencesService.js';
import { TestVSCloneOAuthService } from './vscloneTestOAuthService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';

suite('VSCloneModelCatalogService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function waitForCatalogToSettle(catalogService: VSCloneModelCatalogService): Promise<void> {
		for (let attempt = 0; attempt < 50; attempt++) {
			if (catalogService.getState().status !== 'loading') {
				return;
			}
			await new Promise<void>(resolve => setTimeout(resolve, 10));
		}
	}

	test('refresh success returns configured provider sections', async () => {
		const storageService = store.add(new TestStorageService());
		const providerPreferencesService = store.add(new VSCloneProviderPreferencesService(storageService));
		const oauthService = new TestVSCloneOAuthService();
		const eligibilityService = store.add(new VSCloneModelEligibilityService(storageService));
		const catalogService = store.add(new VSCloneModelCatalogService(providerPreferencesService, oauthService, eligibilityService));

		await providerPreferencesService.initialize();
		await catalogService.refreshCatalog();

		const state = catalogService.getState();
		assert.strictEqual(state.status, 'ready');
		// Google is enabled by default now so the picker and provider-management surfaces expose the
		// same first-run provider set without requiring a hidden preference toggle beforehand.
		assert.deepStrictEqual(state.providers.map(provider => provider.vendor), ['openai', 'anthropic', 'google']);
		const openAIModel = state.models.find(model => model.identifier === 'openai/gpt-5.3-codex');
		assert.ok(openAIModel);
		assert.deepStrictEqual(openAIModel?.reasoningEffortLevels, ['xhigh', 'high', 'medium', 'low']);
		assert.strictEqual(openAIModel?.defaultReasoningEffort, 'medium');
		const nanoModel = state.models.find(model => model.identifier === 'openai/gpt-5-nano');
		assert.ok(nanoModel);
		assert.deepStrictEqual(nanoModel?.reasoningEffortLevels, ['high', 'low', 'none']);
		assert.strictEqual(nanoModel?.defaultReasoningEffort, 'high');
		const anthropicModels = state.models.filter(model => model.vendor === 'anthropic');
		// The OAuth-backed Anthropic transport currently limits the picker to the Haiku models we
		// have verified against live `POST /v1/messages` sends, despite `/v1/models` listing more.
		assert.deepStrictEqual(
			anthropicModels.map(model => ({ id: model.modelId, name: model.modelName, reasoning: model.reasoningEffortLevels })),
			[
				{ id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', reasoning: undefined },
				{ id: 'claude-3-haiku-20240307', name: 'Haiku 3', reasoning: undefined },
			]
		);
		const googleModels = state.models.filter(model => model.vendor === 'google');
		assert.deepStrictEqual(
			googleModels.map(model => ({ id: model.modelId, name: model.modelName, reasoning: model.reasoningEffortLevels })),
			[
				{ id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', reasoning: ['high', 'medium', 'low', 'minimal'] },
				{ id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', reasoning: ['high', 'medium', 'low', 'minimal'] },
				{ id: 'gemini-3.1-flash-lite-preview', name: 'Gemini 3.1 Flash Lite', reasoning: ['high', 'medium', 'low', 'minimal'] },
			]
		);
		// Assert the picker exposes the verified Anthropic IDs so older Sonnet/Opus entries do not
		// silently reappear and route users back onto the broken OAuth path.
		assert.ok(state.models.some(model => model.identifier === 'openai/gpt-5.4'));
		assert.ok(state.models.some(model => model.identifier === 'anthropic/claude-haiku-4-5-20251001'));
		assert.ok(state.models.some(model => model.identifier === 'google/gemini-3.1-pro-preview'));
	});

	test('provider status projects requires_sign_in when enabled but signed out', async () => {
		const storageService = store.add(new TestStorageService());
		const providerPreferencesService = store.add(new VSCloneProviderPreferencesService(storageService));
		const oauthService = new TestVSCloneOAuthService();
		const eligibilityService = store.add(new VSCloneModelEligibilityService(storageService));
		const catalogService = store.add(new VSCloneModelCatalogService(providerPreferencesService, oauthService, eligibilityService));

		await providerPreferencesService.initialize();
		await providerPreferencesService.setProviderEnabled('google', true);
		oauthService.setReady('google', false);
		await catalogService.refreshCatalog();
		await waitForCatalogToSettle(catalogService);

		const state = catalogService.getState();
		const googleProvider = state.providers.find(provider => provider.vendor === 'google');
		assert.ok(googleProvider);
		assert.strictEqual(googleProvider?.status, 'requires_sign_in');

		const googleModel = state.models.find(model => model.vendor === 'google');
		assert.ok(googleModel);
		assert.strictEqual(googleModel?.isSelectable, false);
		assert.strictEqual(googleModel?.unavailableReason, 'provider_requires_sign_in');
	});

	test('error transition recovers on subsequent refresh', async () => {
		const storageService = store.add(new TestStorageService());
		const providerPreferencesService = store.add(new VSCloneProviderPreferencesService(storageService));
		const oauthService = new TestVSCloneOAuthService();
		const eligibilityService = store.add(new VSCloneModelEligibilityService(storageService));
		const catalogService = store.add(new VSCloneModelCatalogService(providerPreferencesService, oauthService, eligibilityService));

		await providerPreferencesService.initialize();
		catalogService.setFailNextRefreshForTest();
		await catalogService.refreshCatalog();
		assert.strictEqual(catalogService.getState().status, 'error');

		await catalogService.refreshCatalog();
		assert.strictEqual(catalogService.getState().status, 'ready');
	});

	test('marking a model ineligible hides it from the catalog and restores it on sign-out', async () => {
		const storageService = store.add(new TestStorageService());
		const providerPreferencesService = store.add(new VSCloneProviderPreferencesService(storageService));
		const oauthService = new TestVSCloneOAuthService();
		const eligibilityService = store.add(new VSCloneModelEligibilityService(storageService));
		const catalogService = store.add(new VSCloneModelCatalogService(providerPreferencesService, oauthService, eligibilityService));

		await providerPreferencesService.initialize();
		await eligibilityService.initialize();
		await catalogService.refreshCatalog();
		await waitForCatalogToSettle(catalogService);

		assert.ok(catalogService.getState().models.some(model => model.identifier === 'openai/gpt-5.3-codex-spark'));

		eligibilityService.markIneligible('openai/gpt-5.3-codex-spark', 'test');
		await waitForCatalogToSettle(catalogService);

		const afterHide = catalogService.getState();
		assert.ok(!afterHide.models.some(model => model.identifier === 'openai/gpt-5.3-codex-spark'));
		const openaiProvider = afterHide.providers.find(provider => provider.vendor === 'openai');
		assert.ok(openaiProvider);
		assert.strictEqual(openaiProvider?.modelCount, afterHide.models.filter(model => model.vendor === 'openai').length);

		// Simulate an OpenAI sign-out: the catalog should wipe cached ineligibility for that vendor
		// so a fresh identity can rediscover its own entitlements after signing back in.
		oauthService.setReady('openai', false);
		await waitForCatalogToSettle(catalogService);
		oauthService.setReady('openai', true);
		await waitForCatalogToSettle(catalogService);

		assert.ok(catalogService.getState().models.some(model => model.identifier === 'openai/gpt-5.3-codex-spark'));
	});
});
