/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSCloneModelSwitcherWidget } from '../../browser/vscloneModelSwitcherWidget.js';
import { VSCloneModelCatalogService } from '../../common/vscloneModelCatalogService.js';
import { VSCloneProviderPreferencesService } from '../../common/vscloneProviderPreferencesService.js';
import { VSCloneThreadModelSelectionService } from '../../common/backend/vscloneThreadModelSelectionService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { TestVSCloneOAuthService } from '../common/vscloneTestOAuthService.js';
import { TestVSCloneUnifiedChatBackendService } from '../common/vscloneTestUnifiedChatBackendService.js';

suite('VSCloneModelSwitcherWidget', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function waitForCatalogToSettle(catalogService: VSCloneModelCatalogService): Promise<void> {
		for (let attempt = 0; attempt < 50; attempt++) {
			if (catalogService.getState().status !== 'loading') {
				return;
			}
			await new Promise<void>(resolve => setTimeout(resolve, 10));
		}
	}

	async function createHarness(threadId = 'thread-1') {
		const testDisposables = store.add(new DisposableStore());
		const storageService = testDisposables.add(new TestStorageService());
		const providerPreferencesService = testDisposables.add(new VSCloneProviderPreferencesService(storageService));
		const oauthService = new TestVSCloneOAuthService();
		const catalogService = testDisposables.add(new VSCloneModelCatalogService(providerPreferencesService, oauthService));
		const backendService = new TestVSCloneUnifiedChatBackendService();
		const selectionService = testDisposables.add(new VSCloneThreadModelSelectionService(backendService, catalogService));

		let manageProvidersCalls = 0;
		const bridge = {
			_serviceBrand: undefined,
			openManageProvidersPicker: async () => {
				manageProvidersCalls += 1;
			},
		};

		await providerPreferencesService.initialize();
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

		return { providerPreferencesService, oauthService, catalogService, selectionService, widget, container, context, getManageProvidersCalls: () => manageProvidersCalls };
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
		assert.strictEqual(button.getAttribute('aria-haspopup'), 'dialog');
		assert.strictEqual(button.getAttribute('aria-expanded'), 'false');

		widget.open();
		assert.strictEqual(button.getAttribute('aria-expanded'), 'true');
		const menu = container.querySelector('.vsclone-model-switcher-menu') as HTMLElement;
		assert.strictEqual(menu.getAttribute('role'), 'dialog');
		assert.strictEqual(menu.getAttribute('aria-labelledby'), button.id);
		const refreshButton = container.querySelector('.vsclone-model-switcher-refresh') as HTMLButtonElement;
		assert.strictEqual(refreshButton.getAttribute('aria-label'), 'Refresh models');
		const menuText = (container.querySelector('.vsclone-model-switcher-menu-body') as HTMLElement).textContent || '';
		assert.ok(menuText.includes('OPENAI'));
		assert.ok(menuText.includes('ANTHROPIC'));
	});

	test('shows the full Anthropic model label in the switcher button', async () => {
		const { catalogService, selectionService, widget, container } = await createHarness();
		const anthropicModel = catalogService.getModels('anthropic')[0];
		assert.ok(anthropicModel);
		await selectionService.setSelectionForThread('thread-1', {
			threadId: 'thread-1',
			location: 'chat',
			modelIdentifier: anthropicModel.identifier,
			vendor: anthropicModel.vendor,
			modelId: anthropicModel.modelId,
			modelName: anthropicModel.modelName,
			selectedAt: Date.now(),
		});

		widget.refresh();
		const button = container.querySelector('.vsclone-model-switcher-button') as HTMLButtonElement;
		assert.ok(button.textContent?.includes('Haiku 4.5'));
		assert.ok(button.textContent?.includes('anthropic'));
	});

	test('escape closes the menu and restores focus to the switcher button', async () => {
		const { widget, container } = await createHarness();
		widget.open();

		const button = container.querySelector('.vsclone-model-switcher-button') as HTMLButtonElement;
		const externalFocusable = document.createElement('button');
		container.appendChild(externalFocusable);
		externalFocusable.focus();

		// Escape should close and return focus to the trigger so keyboard users stay anchored.
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.strictEqual(document.activeElement, button);
		assert.strictEqual(button.getAttribute('aria-expanded'), 'false');
		assert.ok((container.querySelector('.vsclone-model-switcher-menu') as HTMLElement).classList.contains('hidden'));
	});

	test('model rows expose pressed state and locked-provider accessibility labels', async () => {
		const { providerPreferencesService, catalogService, oauthService, selectionService, widget, container } = await createHarness();
		const selectedModel = catalogService.getSelectableModels()[0];
		assert.ok(selectedModel);
		await selectionService.setSelectionForThread('thread-1', {
			threadId: 'thread-1',
			location: 'chat',
			modelIdentifier: selectedModel.identifier,
			vendor: selectedModel.vendor,
			modelId: selectedModel.modelId,
			modelName: selectedModel.modelName,
			selectedAt: Date.now(),
		});

		await providerPreferencesService.setProviderEnabled('google', true);
		oauthService.setReady('google', false);
		await catalogService.refreshCatalog();
		await waitForCatalogToSettle(catalogService);
		widget.open();

		const rows = Array.from(container.querySelectorAll('.vsclone-model-switcher-row')) as HTMLButtonElement[];
		assert.ok(rows.length > 0);
		for (const row of rows) {
			assert.notStrictEqual(row.getAttribute('aria-pressed'), null);
			assert.ok((row.getAttribute('aria-label') || '').includes('model'));
		}

		const lockedRow = container.querySelector('.vsclone-model-switcher-row.locked') as HTMLButtonElement | null;
		assert.ok(lockedRow);
		assert.ok((lockedRow?.getAttribute('aria-label') || '').includes('provider requires sign in'));

		// Icons created through createCodicon are decorative and must stay hidden to assistive tech.
		const refreshIcon = container.querySelector('.vsclone-model-switcher-refresh .codicon') as HTMLElement | null;
		assert.ok(refreshIcon);
		assert.strictEqual(refreshIcon?.getAttribute('aria-hidden'), 'true');
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

	test('shows empty and requires sign-in states', async () => {
		const { providerPreferencesService, catalogService, oauthService, widget, container } = await createHarness();

		await providerPreferencesService.setProviderEnabled('openai', false);
		await providerPreferencesService.setProviderEnabled('anthropic', false);
		await providerPreferencesService.setProviderEnabled('google', false);
		await catalogService.refreshCatalog();
		await waitForCatalogToSettle(catalogService);
		widget.open();
		assert.ok((container.textContent || '').includes('No models available'));

		await providerPreferencesService.setProviderEnabled('google', true);
		oauthService.setReady('google', false);
		await catalogService.refreshCatalog();
		await waitForCatalogToSettle(catalogService);
		widget.open();
		assert.ok((container.textContent || '').includes('Sign in to use this provider'));
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
