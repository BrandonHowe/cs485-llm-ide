/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSCloneModelCatalogService } from '../../common/vscloneModelCatalogService.js';
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
		const catalogService = store.add(new VSCloneModelCatalogService(providerPreferencesService, oauthService));

		await providerPreferencesService.initialize();
		await catalogService.refreshCatalog();

		const state = catalogService.getState();
		assert.strictEqual(state.status, 'ready');
		assert.deepStrictEqual(state.providers.map(provider => provider.vendor), ['openai', 'anthropic']);
		const openAIModel = state.models.find(model => model.identifier === 'openai/gpt-5.3-codex');
		assert.ok(openAIModel);
		assert.deepStrictEqual(openAIModel?.reasoningEffortLevels, ['xhigh', 'high', 'medium', 'low']);
		assert.strictEqual(openAIModel?.defaultReasoningEffort, 'medium');
		assert.ok(state.models.some(model => model.identifier === 'anthropic/claude-opus-4.5'));
	});

	test('provider status projects requires_sign_in when enabled but signed out', async () => {
		const storageService = store.add(new TestStorageService());
		const providerPreferencesService = store.add(new VSCloneProviderPreferencesService(storageService));
		const oauthService = new TestVSCloneOAuthService();
		const catalogService = store.add(new VSCloneModelCatalogService(providerPreferencesService, oauthService));

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
		const catalogService = store.add(new VSCloneModelCatalogService(providerPreferencesService, oauthService));

		await providerPreferencesService.initialize();
		catalogService.setFailNextRefreshForTest();
		await catalogService.refreshCatalog();
		assert.strictEqual(catalogService.getState().status, 'error');

		await catalogService.refreshCatalog();
		assert.strictEqual(catalogService.getState().status, 'ready');
	});
});
