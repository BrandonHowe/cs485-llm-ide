/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSCloneModelSwitcherWidget } from '../../browser/vscloneModelSwitcherWidget.js';
import { VSCloneSettingsService } from '../../common/vscloneSettingsService.js';
import { VSCloneThreadModelSelectionService } from '../../common/backend/vscloneThreadModelSelectionService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { TestVSCloneOAuthService } from '../common/vscloneTestOAuthService.js';
import { TestVSCloneUnifiedChatBackendService } from '../common/vscloneTestUnifiedChatBackendService.js';

suite('VSCloneModelSwitcherWidget', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function createHarness(threadId = 'thread-1') {
		const testDisposables = store.add(new DisposableStore());
		const storageService = testDisposables.add(new TestStorageService());
		const oauthService = new TestVSCloneOAuthService();
		const backendService = new TestVSCloneUnifiedChatBackendService();
		const settingsService = testDisposables.add(new VSCloneSettingsService(
			storageService,
			oauthService,
			backendService,
		));
		const selectionService = testDisposables.add(new VSCloneThreadModelSelectionService(settingsService));

		let manageProvidersCalls = 0;
		const bridge = {
			_serviceBrand: undefined,
			openManageProvidersPicker: async () => {
				manageProvidersCalls += 1;
			},
		};

		await settingsService.initialize();
		await selectionService.initialize();

		const context = { threadId, location: 'chat' as const };
		const widget = testDisposables.add(new VSCloneModelSwitcherWidget(
			settingsService,
			bridge,
			() => context,
		));

		const container = document.createElement('div');
		document.body.appendChild(container);
		testDisposables.add(toDisposable(() => container.remove()));
		widget.render(container);

		return { oauthService, selectionService, settingsService, widget, container, context, getManageProvidersCalls: () => manageProvidersCalls };
	}

	test('renders closed button and grouped providers when open', async () => {
		const { settingsService, widget, container } = await createHarness();
		const firstModel = settingsService.getSelectableModels()[0];
		assert.ok(firstModel);
		await settingsService.setSelectionForFeature('thread-1', {
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
		assert.ok(button.textContent?.includes(firstModel.modelName));
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
		const { settingsService, widget, container } = await createHarness();
		const anthropicModel = settingsService.getModels('anthropic')[0];
		assert.ok(anthropicModel);
		await settingsService.setSelectionForFeature('thread-1', {
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
		assert.ok(button.textContent?.includes(anthropicModel.modelName));
		const modelLabel = container.querySelector('.vsclone-model-switcher-button-model') as HTMLElement | null;
		assert.strictEqual(modelLabel?.getAttribute('title'), anthropicModel.modelName);
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

	test('hides signed-out providers and exposes pressed state for signed-in model rows', async () => {
		const { oauthService, settingsService, widget, container } = await createHarness();
		const selectedModel = settingsService.getSelectableModels()[0];
		assert.ok(selectedModel);
		await settingsService.setSelectionForFeature('thread-1', {
			threadId: 'thread-1',
			location: 'chat',
			modelIdentifier: selectedModel.identifier,
			vendor: selectedModel.vendor,
			modelId: selectedModel.modelId,
			modelName: selectedModel.modelName,
			selectedAt: Date.now(),
		});

		oauthService.setReady('google', false);
		await settingsService.refreshState();
		widget.open();

		const rows = Array.from(container.querySelectorAll('.vsclone-model-switcher-row')) as HTMLButtonElement[];
		assert.ok(rows.length > 0);
		for (const row of rows) {
			assert.notStrictEqual(row.getAttribute('aria-pressed'), null);
			assert.ok((row.getAttribute('aria-label') || '').includes('model'));
		}

		// Signed-out providers must not render any rows in the picker.
		assert.strictEqual(container.querySelector('.vsclone-model-switcher-row.locked'), null);
		assert.ok(!(container.textContent || '').toUpperCase().includes('GOOGLE'));

		const firstRowLabel = container.querySelector('.vsclone-model-switcher-row-label') as HTMLElement | null;
		assert.ok((firstRowLabel?.getAttribute('title') || '').length > 0);

		const refreshIcon = container.querySelector('.vsclone-model-switcher-refresh .codicon') as HTMLElement | null;
		assert.ok(refreshIcon);
		assert.strictEqual(refreshIcon?.getAttribute('aria-hidden'), 'true');
	});

	test('shows loading then error state', async () => {
		const { settingsService, widget, container } = await createHarness();

		const pendingRefresh = settingsService.refreshState();
		widget.open();
		assert.ok((container.textContent || '').includes('Loading models...'));
		await pendingRefresh;

		settingsService.setFailNextRefreshForTest();
		await settingsService.refreshState();
		widget.open();
		assert.ok((container.textContent || '').includes('Error loading models'));
		assert.ok((container.textContent || '').includes('Try again'));
	});

	test('shows empty state when no providers are signed in', async () => {
		const { oauthService, settingsService, widget, container } = await createHarness();

		oauthService.setReady('openai', false);
		oauthService.setReady('anthropic', false);
		oauthService.setReady('google', false);
		await settingsService.refreshState();
		widget.open();
		assert.ok((container.textContent || '').includes('No models available'));
		assert.ok((container.textContent || '').includes('Sign in to a provider to get started'));
	});

	test('selected rows use fill without a checkmark', async () => {
		const { settingsService, widget, container } = await createHarness();
		const firstModel = settingsService.getSelectableModels()[0];
		assert.ok(firstModel);
		await settingsService.setSelectionForFeature('thread-1', {
			threadId: 'thread-1',
			location: 'chat',
			modelIdentifier: firstModel.identifier,
			vendor: firstModel.vendor,
			modelId: firstModel.modelId,
			modelName: firstModel.modelName,
			selectedAt: Date.now(),
		});
		widget.open();

		const selectedRow = container.querySelector('.vsclone-model-switcher-row.selected');
		assert.ok(selectedRow);
		assert.strictEqual(selectedRow?.querySelector('.vsclone-model-switcher-row-check'), null);
		assert.strictEqual(selectedRow?.querySelector('.codicon-check'), null);
		assert.strictEqual((container.textContent || '').includes('Reset Selection'), false);
	});
});
