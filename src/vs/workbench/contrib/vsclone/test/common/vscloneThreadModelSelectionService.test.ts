/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSCloneModelCatalogService } from '../../common/vscloneModelCatalogService.js';
import { VSCloneMockProviderService } from '../../common/vscloneMockProviderService.js';
import { IVSCloneModelSelection, VSCloneThreadModelSelectionService } from '../../common/vscloneThreadModelSelectionService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';

suite('VSCloneThreadModelSelectionService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function createHarness() {
		const testDisposables = store.add(new DisposableStore());
		const storageService = testDisposables.add(new TestStorageService());
		const providerService = testDisposables.add(new VSCloneMockProviderService(storageService));
		const catalogService = testDisposables.add(new VSCloneModelCatalogService(providerService));
		const selectionService = testDisposables.add(new VSCloneThreadModelSelectionService(storageService, catalogService));

		await providerService.initialize();
		await catalogService.refreshCatalog();
		await selectionService.initialize();

		return { providerService, catalogService, selectionService };
	}

	function toSelection(modelIdentifier: string, vendor: string, modelId: string, modelName: string): IVSCloneModelSelection {
		return {
			threadId: 'thread-1',
			location: 'chat',
			modelIdentifier,
			vendor,
			modelId,
			modelName,
			selectedAt: Date.now(),
		};
	}

	test('set/get per-thread selection', async () => {
		const { catalogService, selectionService } = await createHarness();
		const model = catalogService.getSelectableModels()[0];
		assert.ok(model);

		await selectionService.setSelectionForThread('thread-1', toSelection(model.identifier, model.vendor, model.modelId, model.modelName));
		const current = selectionService.getCurrentSelectionForThread('thread-1', 'chat');
		assert.ok(current);
		assert.strictEqual(current?.modelIdentifier, model.identifier);
		assert.strictEqual(current?.vendor, model.vendor);
	});

	test('falls back to location selection for unknown thread', async () => {
		const { catalogService, selectionService } = await createHarness();
		const model = catalogService.getSelectableModels()[1];
		assert.ok(model);

		await selectionService.setSelectionForThread('', toSelection(model.identifier, model.vendor, model.modelId, model.modelName));
		const current = selectionService.getCurrentSelectionForThread('thread-does-not-exist', 'chat');
		assert.ok(current);
		assert.strictEqual(current?.modelIdentifier, model.identifier);
	});

	test('recent model identifiers dedupe and preserve recency', async () => {
		const { catalogService, selectionService } = await createHarness();
		const models = catalogService.getSelectableModels();
		assert.ok(models.length >= 3);

		await selectionService.setSelectionForThread('thread-1', toSelection(models[0].identifier, models[0].vendor, models[0].modelId, models[0].modelName));
		await selectionService.setSelectionForThread('thread-1', toSelection(models[1].identifier, models[1].vendor, models[1].modelId, models[1].modelName));
		await selectionService.setSelectionForThread('thread-1', toSelection(models[0].identifier, models[0].vendor, models[0].modelId, models[0].modelName));
		await selectionService.setSelectionForThread('thread-1', toSelection(models[2].identifier, models[2].vendor, models[2].modelId, models[2].modelName));

		assert.deepStrictEqual(selectionService.getRecentModelIdentifiers(3), [models[2].identifier, models[0].identifier, models[1].identifier]);
	});

	test('reconciles stale thread selection after catalog changes', async () => {
		const { providerService, catalogService, selectionService } = await createHarness();
		await providerService.setProviderEnabled('google', true);
		await providerService.setProviderConfigured('google', true);
		await catalogService.refreshCatalog();

		const googleModel = catalogService.getModels('google')[0];
		assert.ok(googleModel);
		await selectionService.setSelectionForThread('thread-1', toSelection(googleModel.identifier, googleModel.vendor, googleModel.modelId, googleModel.modelName));
		assert.strictEqual(selectionService.getCurrentSelectionForThread('thread-1', 'chat')?.modelIdentifier, googleModel.identifier);

		await providerService.setProviderConfigured('google', false);
		await catalogService.refreshCatalog();

		const next = selectionService.getCurrentSelectionForThread('thread-1', 'chat');
		assert.ok(next);
		assert.notStrictEqual(next?.modelIdentifier, googleModel.identifier);
	});

	test('reset clears explicit thread selection and falls back', async () => {
		const { catalogService, selectionService } = await createHarness();
		const model = catalogService.getSelectableModels()[0];
		assert.ok(model);

		await selectionService.setSelectionForThread('thread-1', toSelection(model.identifier, model.vendor, model.modelId, model.modelName));
		assert.strictEqual(selectionService.hasSelectionForThread('thread-1'), true);

		await selectionService.resetSelectionForThread('thread-1');
		assert.strictEqual(selectionService.hasSelectionForThread('thread-1'), false);
		assert.ok(selectionService.getCurrentSelectionForThread('thread-1', 'chat'));
	});
});
