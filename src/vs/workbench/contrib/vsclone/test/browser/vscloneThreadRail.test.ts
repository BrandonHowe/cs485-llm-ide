/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { VSCloneThreadRail, type IVSCloneThreadRailFilterState } from '../../browser/vscloneThreadRail.js';
import type { IVSCloneThreadRailRow } from '../../browser/vscloneThreadRailTree.js';

interface IContextMenuCapture {
	service: IContextMenuService;
	getOptions: () => Parameters<IContextMenuService['showContextMenu']>[0] | undefined;
}

function createContextMenuCapture(): IContextMenuCapture {
	let options: Parameters<IContextMenuService['showContextMenu']>[0] | undefined;
	return {
		service: {
			_serviceBrand: undefined,
			showContextMenu: (contextMenuOptions: Parameters<IContextMenuService['showContextMenu']>[0]) => {
				options = contextMenuOptions;
			},
			configure: () => undefined,
			closeContextView: () => undefined,
			hideContextView: () => undefined,
			layout: () => undefined,
			getContextViewElement: () => document.createElement('div'),
		} as unknown as IContextMenuService,
		getOptions: () => options,
	};
}

function createRow(overrides: Partial<IVSCloneThreadRailRow> = {}): IVSCloneThreadRailRow {
	return {
		threadId: 'thread-1',
		title: 'Thread 1',
		preview: 'Preview 1',
		updatedLabel: 'just now',
		archived: false,
		turnCount: 1,
		status: 'active',
		selected: false,
		...overrides,
	};
}

function createHarness(store: Pick<DisposableStore, 'add'>) {
	const testDisposables = store.add(new DisposableStore());
	const contextMenu = createContextMenuCapture();
	const rail = testDisposables.add(new VSCloneThreadRail(contextMenu.service));
	const container = document.createElement('div');
	document.body.appendChild(container);
	rail.render(container);

	return { rail, container, contextMenu };
}

suite('VSCloneThreadRail', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('render initializes the loading view, header actions, and filter snapshot', () => {
		const { rail, container } = createHarness(store);
		try {
			assert.deepStrictEqual(rail.getFilterState(), { query: '', tab: 'all' });

			const searchInput = container.querySelector('.vsclone-thread-rail-search') as HTMLInputElement;
			const backButton = container.querySelector('.vsclone-thread-rail-back') as HTMLButtonElement;
			const newChatButton = container.querySelector('.vsclone-thread-rail-new-chat') as HTMLButtonElement;
			let closeRequested = false;
			let newChatRequested = false;

			store.add(rail.onDidRequestClose(() => {
				closeRequested = true;
			}));
			store.add(rail.onDidRequestNewChat(() => {
				newChatRequested = true;
			}));

			rail.focusSearch();
			assert.strictEqual(document.activeElement, searchInput);

			backButton.click();
			newChatButton.click();

			assert.strictEqual(closeRequested, true);
			assert.strictEqual(newChatRequested, true);
			assert.strictEqual((container.querySelector('.vsclone-thread-rail-list') as HTMLElement).classList.contains('hidden'), true);
			assert.strictEqual((container.querySelector('.vsclone-thread-rail-state') as HTMLElement).getAttribute('role'), 'status');
			assert.strictEqual(container.querySelectorAll('.vsclone-thread-rail-skeleton-row').length, 7);
		} finally {
			container.remove();
		}
	});

	test('filter state updates cancel pending searches and tab clicks emit the current query snapshot', async () => {
		const { rail, container } = createHarness(store);
		try {
			const observedStates: IVSCloneThreadRailFilterState[] = [];
			store.add(rail.onDidChangeFilterState(state => observedStates.push({ ...state })));

			const searchInput = container.querySelector('.vsclone-thread-rail-search') as HTMLInputElement;
			const activeTab = container.querySelector('[data-tab="active"]') as HTMLButtonElement;
			const archivedTab = container.querySelector('[data-tab="archived"]') as HTMLButtonElement;

			// The delayed search event is intentionally cancellable because this rail coalesces typing
			// to avoid thrashing the thread query on every keystroke.
			searchInput.value = '  alpha  ';
			searchInput.dispatchEvent(new Event('input', { bubbles: true }));
			rail.setFilterState({ query: 'beta', tab: 'active' });
			assert.deepStrictEqual(rail.getFilterState(), { query: 'beta', tab: 'active' });
			assert.strictEqual(searchInput.value, 'beta');
			assert.strictEqual(activeTab.getAttribute('aria-pressed'), 'true');
			await timeout(160);
			assert.deepStrictEqual(observedStates, []);

			searchInput.value = '  gamma  ';
			searchInput.dispatchEvent(new Event('input', { bubbles: true }));
			await timeout(160);
			assert.deepStrictEqual(observedStates, [{ query: 'gamma', tab: 'active' }]);

			activeTab.click();
			assert.deepStrictEqual(observedStates, [{ query: 'gamma', tab: 'active' }]);

			archivedTab.click();
			assert.deepStrictEqual(observedStates, [
				{ query: 'gamma', tab: 'active' },
				{ query: 'gamma', tab: 'archived' },
			]);
			assert.strictEqual(activeTab.getAttribute('aria-pressed'), 'false');
			assert.strictEqual(archivedTab.getAttribute('aria-pressed'), 'true');
		} finally {
			container.remove();
		}
	});

	test('rows render with selection state, accessibility labels, and click selection updates', () => {
		const { rail, container } = createHarness(store);
		try {
			const selectedThreads: string[] = [];
			store.add(rail.onDidSelectThread(threadId => selectedThreads.push(threadId)));

			rail.setRows([
				createRow({ threadId: 'thread-1', title: 'Alpha', preview: 'Preview A', updatedLabel: '2m ago', turnCount: 3, status: 'active' }),
				createRow({ threadId: 'thread-2', title: 'Beta', preview: 'Preview B', updatedLabel: 'just now', archived: true, turnCount: 5, status: 'completed' }),
			]);

			const firstRow = container.querySelector('[data-thread-id="thread-1"]') as HTMLButtonElement;
			const secondRow = container.querySelector('[data-thread-id="thread-2"]') as HTMLButtonElement;
			assert.strictEqual(firstRow.getAttribute('aria-label'), 'Alpha. 3 turns. Updated 2m ago.');
			assert.strictEqual(secondRow.getAttribute('aria-label'), 'Beta. 5 turns. Updated just now. Archived.');
			assert.strictEqual(secondRow.querySelector('.vsclone-thread-rail-row-archived')?.textContent, 'Archived');

			rail.setSelectedThread('thread-2');
			assert.strictEqual(rail.getSelectedThread(), 'thread-2');
			assert.strictEqual(secondRow.getAttribute('aria-pressed'), 'true');
			assert.strictEqual(secondRow.classList.contains('selected'), true);

			rail.setRows([createRow({ threadId: 'thread-1', title: 'Alpha', preview: 'Preview A', updatedLabel: '2m ago', turnCount: 3, status: 'active' })]);
			assert.strictEqual(rail.getSelectedThread(), undefined);
			assert.strictEqual((container.querySelector('[data-thread-id="thread-1"]') as HTMLButtonElement).getAttribute('aria-pressed'), 'false');

			const preview = container.querySelector('[data-thread-id="thread-1"] .vsclone-thread-rail-row-preview') as HTMLElement;
			preview.dispatchEvent(new MouseEvent('click', { bubbles: true }));

			assert.deepStrictEqual(selectedThreads, ['thread-1']);
			assert.strictEqual(rail.getSelectedThread(), 'thread-1');
			assert.strictEqual((container.querySelector('[data-thread-id="thread-1"]') as HTMLButtonElement).classList.contains('selected'), true);
		} finally {
			container.remove();
		}
	});

	test('row context menus emit action events and open the delete confirmation modal', async () => {
		const { rail, container, contextMenu } = createHarness(store);
		try {
			const observedActions: Array<{ action: string; threadId: string; archived?: boolean }> = [];
			store.add(rail.onDidRequestAction(event => observedActions.push({ ...event })));

			rail.setRows([
				createRow({
					threadId: 'thread-1',
					title: 'Alpha',
					preview: 'Preview A',
					updatedLabel: '2m ago',
					turnCount: 3,
					status: 'active',
					archived: false,
				}),
			]);

			const preview = container.querySelector('[data-thread-id="thread-1"] .vsclone-thread-rail-row-preview') as HTMLElement;
			const contextMenuEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 13, clientY: 17 });
			preview.dispatchEvent(contextMenuEvent);

			assert.strictEqual(contextMenuEvent.defaultPrevented, true);
			const options = contextMenu.getOptions();
			assert.ok(options);
			assert.ok(options?.getActions);

			const actions = new Map(options!.getActions!().map(action => [action.id, action]));
			const openAction = actions.get('vsclone.threadRail.open');
			const copyPromptAction = actions.get('vsclone.threadRail.copyPrompt');
			const copyResponseAction = actions.get('vsclone.threadRail.copyResponse');
			const reusePromptAction = actions.get('vsclone.threadRail.reusePrompt');
			const toggleArchiveAction = actions.get('vsclone.threadRail.toggleArchive');
			const deleteAction = actions.get('vsclone.threadRail.delete');
			assert.ok(openAction);
			assert.ok(copyPromptAction);
			assert.ok(copyResponseAction);
			assert.ok(reusePromptAction);
			assert.ok(toggleArchiveAction);
			assert.ok(deleteAction);
			await openAction!.run();
			await copyPromptAction!.run();
			await copyResponseAction!.run();
			await reusePromptAction!.run();
			await toggleArchiveAction!.run();
			await deleteAction!.run();
			options!.onHide?.(false);

			assert.deepStrictEqual(observedActions, [
				{ action: 'open', threadId: 'thread-1' },
				{ action: 'copyPrompt', threadId: 'thread-1' },
				{ action: 'copyResponse', threadId: 'thread-1' },
				{ action: 'reusePrompt', threadId: 'thread-1' },
				{ action: 'toggleArchive', threadId: 'thread-1', archived: true },
			]);
			const overlay = container.querySelector('.vsclone-thread-rail-delete-overlay') as HTMLElement;
			const cancel = container.querySelector('.vsclone-thread-rail-delete-cancel') as HTMLButtonElement;
			const description = container.querySelector('.vsclone-thread-rail-delete-description') as HTMLElement;
			assert.strictEqual(overlay.classList.contains('visible'), true);
			assert.strictEqual(overlay.getAttribute('aria-hidden'), 'false');
			assert.strictEqual(cancel, document.activeElement);
			assert.strictEqual(description.textContent?.includes('Alpha'), true);
		} finally {
			container.remove();
		}
	});

	test('loading, empty, and error states render the expected markup and retry wiring', () => {
		const { rail, container } = createHarness(store);
		try {
			let retryRequested = false;
			store.add(rail.onDidRequestRetry(() => {
				retryRequested = true;
			}));

			assert.strictEqual((container.querySelector('.vsclone-thread-rail-state') as HTMLElement).getAttribute('role'), 'status');
			assert.strictEqual(container.querySelectorAll('.vsclone-thread-rail-skeleton-row').length, 7);

			rail.setRows([]);
			const stateContainer = container.querySelector('.vsclone-thread-rail-state') as HTMLElement;
			assert.strictEqual(stateContainer.getAttribute('role'), 'status');
			assert.strictEqual(stateContainer.querySelector('.vsclone-thread-rail-state-icon')?.textContent, '[]');
			assert.strictEqual(stateContainer.querySelector('.vsclone-thread-rail-state-title')?.textContent, 'No threads yet');

			rail.setLoading();
			assert.strictEqual(container.querySelectorAll('.vsclone-thread-rail-skeleton-row').length, 7);

			rail.setError('Network down');
			assert.strictEqual(stateContainer.getAttribute('role'), 'alert');
			assert.strictEqual(stateContainer.querySelector('.vsclone-thread-rail-state-description')?.textContent, 'Network down');
			(stateContainer.querySelector('.vsclone-thread-rail-retry') as HTMLButtonElement).click();
			assert.strictEqual(retryRequested, true);
		} finally {
			container.remove();
		}
	});

	test('delete modal traps focus and closes through cancel, backdrop, and escape', () => {
		const { rail, container } = createHarness(store);
		const priorFocus = document.createElement('button');
		document.body.appendChild(priorFocus);
		priorFocus.focus();
		try {
			rail.setRows([createRow({ threadId: 'thread-1', title: 'Alpha', preview: 'Preview A', updatedLabel: '2m ago', turnCount: 3, status: 'active' })]);
			rail.confirmDeleteThread('thread-1', 'Alpha');

			const overlay = container.querySelector('.vsclone-thread-rail-delete-overlay') as HTMLElement;
			const modal = container.querySelector('.vsclone-thread-rail-delete-modal') as HTMLElement;
			const cancel = container.querySelector('.vsclone-thread-rail-delete-cancel') as HTMLButtonElement;
			const confirm = container.querySelector('.vsclone-thread-rail-delete-confirm') as HTMLButtonElement;

			assert.strictEqual(overlay.classList.contains('visible'), true);
			assert.strictEqual(overlay.getAttribute('aria-hidden'), 'false');
			assert.strictEqual(modal.getAttribute('role'), 'dialog');
			assert.strictEqual(modal.getAttribute('aria-modal'), 'true');
			assert.strictEqual(cancel, document.activeElement);
			assert.strictEqual(container.querySelector('.vsclone-thread-rail-delete-description')?.textContent?.includes('Alpha'), true);

			// The focus trap is attached to the dialog container, so keyboard simulation has to target
			// the modal itself rather than the backdrop to match how real bubbled key events arrive.
			confirm.focus();
			modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
			assert.strictEqual(document.activeElement, cancel);
			cancel.focus();
			modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
			assert.strictEqual(document.activeElement, confirm);

			cancel.click();
			assert.strictEqual(overlay.getAttribute('aria-hidden'), 'true');
			assert.strictEqual(overlay.classList.contains('visible'), false);
			assert.strictEqual(document.activeElement, priorFocus);

			rail.confirmDeleteThread('thread-1', 'Alpha');
			overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
			assert.strictEqual(overlay.getAttribute('aria-hidden'), 'true');
			assert.strictEqual(document.activeElement, priorFocus);

			rail.confirmDeleteThread('thread-1', 'Alpha');
			modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			assert.strictEqual(overlay.getAttribute('aria-hidden'), 'true');
			assert.strictEqual(overlay.classList.contains('visible'), false);
			assert.strictEqual(document.activeElement, priorFocus);
		} finally {
			priorFocus.remove();
			container.remove();
		}
	});
});
