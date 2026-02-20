/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSCloneModelSwitcherWidget } from '../../browser/vscloneModelSwitcherWidget.js';
import { VSCloneModelCatalogService } from '../../common/vscloneModelCatalogService.js';
import { VSCloneMockProviderService } from '../../common/vscloneMockProviderService.js';
import { VSCloneThreadModelSelectionService } from '../../common/vscloneThreadModelSelectionService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';

suite('VSCloneModelSwitcherWidget', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function createHarness(threadId = 'thread-1') {
		const testDisposables = store.add(new DisposableStore());
		const storageService = testDisposables.add(new TestStorageService());
		const providerService = testDisposables.add(new VSCloneMockProviderService(storageService));
		const catalogService = testDisposables.add(new VSCloneModelCatalogService(providerService));
		const selectionService = testDisposables.add(new VSCloneThreadModelSelectionService(storageService, catalogService));

		let manageProvidersCalls = 0;
		const bridge = {
			_serviceBrand: undefined,
			openManageProvidersPicker: async () => {
				manageProvidersCalls += 1;
			},
		};

		await providerService.initialize();
		await catalogService.refreshCatalog();
		await selectionService.initialize();

		const context = { threadId, location: 'chat' as const };
		const widget = testDisposables.add(new VSCloneModelSwitcherWidget(
			catalogService,
			selectionService,
			bridge,
			() => context,
		));

		const container = document.createElement('div');
		document.body.appendChild(container);
		testDisposables.add(toDisposable(() => container.remove()));
		widget.render(container);

		return { providerService, catalogService, selectionService, widget, container, context, getManageProvidersCalls: () => manageProvidersCalls };
	}

	test('renders closed button and grouped providers when open', async () => {
		const { catalogService, selectionService, widget, container } = await createHarness();
		const firstModel = catalogService.getSelectableModels()[0];
		assert.ok(firstModel);
		await selectionService.setSelectionForThread('thread-1', {
			threadId: 'thread-1',
			location: 'chat',
			modelIdentifier: firstModel.identifier,
			vendor: firstModel.vendor,
			modelId: firstModel.modelId,
			modelName: firstModel.modelName,
			selectedAt: Date.now(),
		});

		widget.refresh();
		const button = container.querySelector('.vsclone-model-switcher-button') as HTMLButtonElement;
		assert.ok(button.textContent?.includes('GPT-5.3-Codex'));

		widget.open();
		const menuText = (container.querySelector('.vsclone-model-switcher-menu-body') as HTMLElement).textContent || '';
		assert.ok(menuText.includes('OPENAI'));
		assert.ok(menuText.includes('ANTHROPIC'));
	});

	test('shows loading then error state', async () => {
		const { catalogService, widget, container } = await createHarness();

		const pendingRefresh = catalogService.refreshCatalog();
		widget.open();
		assert.ok((container.textContent || '').includes('Loading models...'));
		await pendingRefresh;

		catalogService.setFailNextRefreshForTest();
		await catalogService.refreshCatalog();
		widget.open();
		assert.ok((container.textContent || '').includes('Error loading models'));
		assert.ok((container.textContent || '').includes('Try again'));
	});

	test('shows empty and requires configuration states', async () => {
		const { providerService, catalogService, widget, container } = await createHarness();

		await providerService.setProviderEnabled('openai', false);
		await providerService.setProviderEnabled('anthropic', false);
		await providerService.setProviderEnabled('google', false);
		await catalogService.refreshCatalog();
		widget.open();
		assert.ok((container.textContent || '').includes('No models available'));

		await providerService.setProviderEnabled('google', true);
		await providerService.setProviderConfigured('google', false);
		await catalogService.refreshCatalog();
		widget.open();
		assert.ok((container.textContent || '').includes('Provider requires configuration'));
	});

	test('footer shows reset only for explicit thread selection', async () => {
		const withThread = await createHarness('thread-1');
		const withThreadModel = withThread.catalogService.getSelectableModels()[0];
		assert.ok(withThreadModel);
		await withThread.selectionService.setSelectionForThread('thread-1', {
			threadId: 'thread-1',
			location: 'chat',
			modelIdentifier: withThreadModel.identifier,
			vendor: withThreadModel.vendor,
			modelId: withThreadModel.modelId,
			modelName: withThreadModel.modelName,
			selectedAt: Date.now(),
		});
		withThread.widget.open();
		assert.ok((withThread.container.textContent || '').includes('Reset Selection'));

		const withoutThread = await createHarness('');
		withoutThread.widget.open();
		assert.ok(!(withoutThread.container.textContent || '').includes('Reset Selection'));
	});
});
