/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { VSCloneThreadRail } from '../../browser/vscloneThreadRail.js';
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
		updatedAt: 0,
		updatedLabel: 'just now',
		streamStateKind: undefined,
		selected: false,
		hasUnreadAgentMessage: false,
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

	test('render initializes the loading view with a skeleton', () => {
		const { container } = createHarness(store);
		try {
			assert.strictEqual((container.querySelector('.vsclone-thread-rail-list') as HTMLElement).classList.contains('hidden'), true);
			assert.strictEqual((container.querySelector('.vsclone-thread-rail-state') as HTMLElement).getAttribute('role'), 'status');
			assert.strictEqual(container.querySelectorAll('.vsclone-thread-rail-skeleton-row').length, 7);
		} finally {
			container.remove();
		}
	});

	test('rows render with title, timestamp, running spinner, and click selection', () => {
		const { rail, container } = createHarness(store);
		try {
			const selectedThreads: string[] = [];
			store.add(rail.onDidSelectThread(threadId => selectedThreads.push(threadId)));

			rail.setRows([
				createRow({ threadId: 'thread-1', title: 'Alpha', updatedLabel: '2m ago', streamStateKind: 'llm' }),
				createRow({ threadId: 'thread-2', title: 'Beta', updatedLabel: 'just now', streamStateKind: undefined }),
			]);

			const firstRow = container.querySelector('[data-thread-id="thread-1"]') as HTMLElement;
			const secondRow = container.querySelector('[data-thread-id="thread-2"]') as HTMLElement;
			assert.strictEqual(firstRow.getAttribute('aria-label'), 'Alpha. Updated 2m ago.');
			assert.strictEqual(secondRow.getAttribute('aria-label'), 'Beta. Updated just now.');
			assert.ok(firstRow.querySelector('.vsclone-thread-rail-row-spinner'));
			assert.strictEqual(secondRow.querySelector('.vsclone-thread-rail-row-spinner'), null);
			assert.strictEqual(firstRow.querySelector('.vsclone-thread-rail-row-title')?.textContent, 'Alpha');
			assert.strictEqual(secondRow.querySelector('.vsclone-thread-rail-row-timestamp')?.textContent, 'just now');

			rail.setSelectedThread('thread-2');
			assert.strictEqual(rail.getSelectedThread(), 'thread-2');
			assert.strictEqual(secondRow.getAttribute('aria-pressed'), 'true');
			assert.strictEqual(secondRow.classList.contains('selected'), true);
			assert.strictEqual(secondRow.classList.contains('unread-agent-message'), false);

			rail.setRows([createRow({ threadId: 'thread-1', title: 'Alpha', updatedLabel: '2m ago' })]);
			assert.strictEqual(rail.getSelectedThread(), undefined);
			assert.strictEqual((container.querySelector('[data-thread-id="thread-1"]') as HTMLElement).getAttribute('aria-pressed'), 'false');

			(container.querySelector('[data-thread-id="thread-1"]') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));

			assert.deepStrictEqual(selectedThreads, ['thread-1']);
			assert.strictEqual(rail.getSelectedThread(), 'thread-1');
			assert.strictEqual((container.querySelector('[data-thread-id="thread-1"]') as HTMLElement).classList.contains('selected'), true);
		} finally {
			container.remove();
		}
	});

	test('unread marker is independent from selected row background', () => {
		const { rail, container } = createHarness(store);
		try {
			rail.setRows([
				createRow({ threadId: 'thread-1', title: 'Alpha', hasUnreadAgentMessage: true }),
				createRow({ threadId: 'thread-2', title: 'Beta', selected: true }),
			]);

			const unreadRow = container.querySelector('[data-thread-id="thread-1"]') as HTMLElement;
			const selectedRow = container.querySelector('[data-thread-id="thread-2"]') as HTMLElement;

			assert.strictEqual(unreadRow.classList.contains('unread-agent-message'), true);
			assert.strictEqual(unreadRow.classList.contains('selected'), false);
			assert.strictEqual(selectedRow.classList.contains('selected'), true);
			assert.strictEqual(selectedRow.classList.contains('unread-agent-message'), false);
		} finally {
			container.remove();
		}
	});

	test('hover reveals a trash icon that flips to an inline two-step confirm before firing delete', async () => {
		const { rail, container } = createHarness(store);
		try {
			const observedActions: Array<{ action: string; threadId: string }> = [];
			store.add(rail.onDidRequestAction(event => observedActions.push({ ...event })));

			rail.setRows([createRow({ threadId: 'thread-1', title: 'Alpha', updatedLabel: '2m ago' })]);

			const row = () => container.querySelector('[data-thread-id="thread-1"]') as HTMLElement;
			row().dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

			const trash = row().querySelector('.vsclone-thread-rail-row-icon') as HTMLButtonElement;
			assert.ok(trash);
			trash.click();

			// First click swaps the trash icon for a cancel/confirm pair — no action fires yet.
			assert.deepStrictEqual(observedActions, []);
			const inlineButtons = row().querySelectorAll('.vsclone-thread-rail-row-icon');
			assert.strictEqual(inlineButtons.length, 2);
			(inlineButtons[1] as HTMLButtonElement).click();

			assert.deepStrictEqual(observedActions, [{ action: 'delete', threadId: 'thread-1' }]);
		} finally {
			container.remove();
		}
	});

	test('keyboard-driven delete flow: trash is always tabbable and Enter/Space on the row does not leak from nested buttons', async () => {
		const { rail, container } = createHarness(store);
		try {
			const observedActions: Array<{ action: string; threadId: string }> = [];
			const observedSelections: string[] = [];
			store.add(rail.onDidRequestAction(event => observedActions.push({ ...event })));
			store.add(rail.onDidSelectThread(threadId => observedSelections.push(threadId)));

			rail.setRows([createRow({ threadId: 'thread-1', title: 'Alpha', updatedLabel: '2m ago' })]);

			const row = container.querySelector('[data-thread-id="thread-1"]') as HTMLElement;
			const trash = row.querySelector('.vsclone-thread-rail-row-icon-delete') as HTMLButtonElement;
			// The trash button must be in the DOM (not gated on hover) so keyboard users can tab to it.
			assert.ok(trash);

			// Enter on a nested button must not bubble into the row's keydown as a row selection.
			trash.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
			trash.click();
			assert.strictEqual(row.classList.contains('pending-delete'), true);
			assert.deepStrictEqual(observedSelections, []);
			assert.deepStrictEqual(observedActions, []);

			const inlineButtons = row.querySelectorAll('.vsclone-thread-rail-row-icon');
			assert.strictEqual(inlineButtons.length, 2);
			const confirm = inlineButtons[1] as HTMLButtonElement;

			// Keypresses on the confirm button must not re-open the thread by bubbling.
			confirm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
			confirm.click();

			assert.deepStrictEqual(observedActions, [{ action: 'delete', threadId: 'thread-1' }]);
			assert.deepStrictEqual(observedSelections, []);
		} finally {
			container.remove();
		}
	});

	test('row context menus expose the full action set and the delete action opens the inline confirm', async () => {
		const { rail, container, contextMenu } = createHarness(store);
		try {
			const observedActions: Array<{ action: string; threadId: string }> = [];
			store.add(rail.onDidRequestAction(event => observedActions.push({ ...event })));

			rail.setRows([createRow({ threadId: 'thread-1', title: 'Alpha', updatedLabel: '2m ago' })]);

			const row = () => container.querySelector('[data-thread-id="thread-1"]') as HTMLElement;
			const contextMenuEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 13, clientY: 17 });
			row().dispatchEvent(contextMenuEvent);

			assert.strictEqual(contextMenuEvent.defaultPrevented, true);
			const options = contextMenu.getOptions();
			assert.ok(options);
			const actions = new Map(options!.getActions!().map(action => [action.id, action]));
			assert.deepStrictEqual([...actions.keys()], [
				'vsclone.threadRail.open',
				'vsclone.threadRail.copyPrompt',
				'vsclone.threadRail.copyResponse',
				'vsclone.threadRail.reusePrompt',
				'vsclone.threadRail.delete',
			]);

			await actions.get('vsclone.threadRail.open')!.run();
			await actions.get('vsclone.threadRail.copyPrompt')!.run();
			await actions.get('vsclone.threadRail.copyResponse')!.run();
			await actions.get('vsclone.threadRail.reusePrompt')!.run();
			await actions.get('vsclone.threadRail.delete')!.run();

			// Context-menu delete must surface the inline confirm even though the row is not
			// hovered — otherwise the affordance would be invisible from keyboard or right-click
			// flows. Confirm completes the delete.
			assert.strictEqual(row().classList.contains('pending-delete'), true);
			const inlineButtons = row().querySelectorAll('.vsclone-thread-rail-row-icon');
			assert.strictEqual(inlineButtons.length, 2);
			(inlineButtons[1] as HTMLButtonElement).click();

			options!.onHide?.(false);

			assert.deepStrictEqual(observedActions, [
				{ action: 'open', threadId: 'thread-1' },
				{ action: 'copyPrompt', threadId: 'thread-1' },
				{ action: 'copyResponse', threadId: 'thread-1' },
				{ action: 'reusePrompt', threadId: 'thread-1' },
				{ action: 'delete', threadId: 'thread-1' },
			]);
		} finally {
			container.remove();
		}
	});

	test('spinner appears for llm and tool stream states; awaiting_user shows the question icon; idle and no state show nothing', () => {
		const { rail, container } = createHarness(store);
		try {
			rail.setRows([
				createRow({ threadId: 'thread-llm', title: 'Llm', streamStateKind: 'llm' }),
				createRow({ threadId: 'thread-tool', title: 'Tool', streamStateKind: 'tool' }),
				createRow({ threadId: 'thread-awaiting', title: 'Awaiting', streamStateKind: 'awaiting_user' }),
				createRow({ threadId: 'thread-none', title: 'None', streamStateKind: undefined }),
			]);
			// Expand past the initial 3-row window so every thread is rendered.
			(container.querySelector('.vsclone-thread-rail-show-more') as HTMLButtonElement).click();

			const spinnerClassesByThread: Record<string, string | null> = {};
			for (const threadId of ['thread-llm', 'thread-tool', 'thread-awaiting', 'thread-none']) {
				const row = container.querySelector(`[data-thread-id="${threadId}"]`) as HTMLElement;
				const icon = row.querySelector('.vsclone-thread-rail-row-spinner') as HTMLElement | null;
				spinnerClassesByThread[threadId] = icon ? icon.className : null;
			}

			assert.deepStrictEqual(spinnerClassesByThread, {
				'thread-llm': 'vsclone-thread-rail-row-spinner codicon codicon-loading codicon-modifier-spin',
				'thread-tool': 'vsclone-thread-rail-row-spinner codicon codicon-loading codicon-modifier-spin',
				'thread-awaiting': 'vsclone-thread-rail-row-spinner codicon codicon-question',
				'thread-none': null,
			});
		} finally {
			container.remove();
		}
	});

	test('search input typing triggers the debounced onDidChangeSearchQuery and exposes the query via getSearchQuery', async () => {
		const { rail, container } = createHarness(store);
		try {
			const observed: string[] = [];
			store.add(rail.onDidChangeSearchQuery(query => observed.push(query)));
			const input = container.querySelector('.vsclone-thread-rail-search') as HTMLInputElement;

			input.value = '  alpha ';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			assert.strictEqual(rail.getSearchQuery(), 'alpha');
			await new Promise(resolve => setTimeout(resolve, 180));
			assert.deepStrictEqual(observed, ['alpha']);
		} finally {
			container.remove();
		}
	});

	test('new chat button fires onDidRequestNewChat', () => {
		const { rail, container } = createHarness(store);
		try {
			let requested = 0;
			store.add(rail.onDidRequestNewChat(() => { requested++; }));
			(container.querySelector('.vsclone-thread-rail-new-chat') as HTMLButtonElement).click();
			assert.strictEqual(requested, 1);
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
			assert.ok(stateContainer.querySelector('.vsclone-thread-rail-state-icon .codicon-comment-discussion'));
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

	test('Show N more expands and collapses the list', () => {
		const { rail, container } = createHarness(store);
		try {
			rail.setRows([
				createRow({ threadId: 'thread-1', title: 'Alpha' }),
				createRow({ threadId: 'thread-2', title: 'Beta' }),
				createRow({ threadId: 'thread-3', title: 'Gamma' }),
				createRow({ threadId: 'thread-4', title: 'Delta' }),
				createRow({ threadId: 'thread-5', title: 'Epsilon' }),
			]);

			const collapsedRows = container.querySelectorAll('[data-thread-id]');
			assert.strictEqual(collapsedRows.length, 3);
			const showMore = container.querySelector('.vsclone-thread-rail-show-more') as HTMLButtonElement;
			assert.strictEqual(showMore.textContent, 'Show 2 more...');

			showMore.click();

			const expandedRows = container.querySelectorAll('[data-thread-id]');
			assert.strictEqual(expandedRows.length, 5);
			assert.strictEqual((container.querySelector('.vsclone-thread-rail-show-more') as HTMLButtonElement).textContent, 'Show less');
		} finally {
			container.remove();
		}
	});
});
