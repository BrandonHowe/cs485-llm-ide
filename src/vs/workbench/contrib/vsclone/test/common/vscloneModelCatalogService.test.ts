/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSCloneModelCatalogService } from '../../common/vscloneModelCatalogService.js';
import { VSCloneMockProviderService } from '../../common/vscloneMockProviderService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';

suite('VSCloneModelCatalogService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('refresh success returns configured provider sections', async () => {
		const storageService = store.add(new TestStorageService());
		const providerService = store.add(new VSCloneMockProviderService(storageService));
		const catalogService = store.add(new VSCloneModelCatalogService(providerService));

		await providerService.initialize();
		await catalogService.refreshCatalog();

		const state = catalogService.getState();
		assert.strictEqual(state.status, 'ready');
		assert.deepStrictEqual(state.providers.map(provider => provider.vendor), ['openai', 'anthropic']);
		assert.ok(state.models.some(model => model.identifier === 'openai/gpt-5.3-codex'));
		assert.ok(state.models.some(model => model.identifier === 'anthropic/claude-3.5-sonnet'));
	});

	test('provider status projects requires_config when enabled but unconfigured', async () => {
		const storageService = store.add(new TestStorageService());
		const providerService = store.add(new VSCloneMockProviderService(storageService));
		const catalogService = store.add(new VSCloneModelCatalogService(providerService));

		await providerService.initialize();
		await providerService.setProviderEnabled('google', true);
		await providerService.setProviderConfigured('google', false);
		await catalogService.refreshCatalog();

		const state = catalogService.getState();
		const googleProvider = state.providers.find(provider => provider.vendor === 'google');
		assert.ok(googleProvider);
		assert.strictEqual(googleProvider?.status, 'requires_config');

		const googleModel = state.models.find(model => model.vendor === 'google');
		assert.ok(googleModel);
		assert.strictEqual(googleModel?.isSelectable, false);
		assert.strictEqual(googleModel?.unavailableReason, 'provider_requires_configuration');
	});

	test('error transition recovers on subsequent refresh', async () => {
		const storageService = store.add(new TestStorageService());
		const providerService = store.add(new VSCloneMockProviderService(storageService));
		const catalogService = store.add(new VSCloneModelCatalogService(providerService));

		await providerService.initialize();
		catalogService.setFailNextRefreshForTest();
		await catalogService.refreshCatalog();
		assert.strictEqual(catalogService.getState().status, 'error');

		await catalogService.refreshCatalog();
		assert.strictEqual(catalogService.getState().status, 'ready');
	});
});
