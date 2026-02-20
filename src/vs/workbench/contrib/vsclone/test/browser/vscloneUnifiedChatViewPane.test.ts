/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { VSCloneChatHistoryRail } from '../../browser/vscloneChatHistoryRail.js';
import { VSCloneUnifiedChatViewPane, toVSCloneHistoryQuery } from '../../browser/vscloneUnifiedChatViewPane.js';

suite('VSCloneUnifiedChatViewPane', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('rail toggle and focus methods update layout state', () => {
		let focusRailCalled = false;
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as any;
		target.railVisible = true;
		target.railWidth = 320;
		target.isCompactLayout = false;
		target.bodyWidth = 1200;
		target.rootContainer = document.createElement('div');
		target.railContainer = document.createElement('div');
		target.railResizeHandle = document.createElement('div');
		target.titleElement = document.createElement('div');
		target.backButton = document.createElement('button');
		target.threadsById = new Map();
		target.rail = {
			focusSearch: () => { focusRailCalled = true; },
			getSelectedThread: () => undefined,
			setSelectedThread: () => { },
		};

		pane.toggleRail();
		assert.strictEqual(target.railVisible, false);
		assert.strictEqual((target.railContainer as HTMLElement).style.width, '0px');

		pane.focusRail();
		assert.strictEqual(focusRailCalled, true);
	});

	test('thread selection updates active thread and rail selection', async () => {
		let selectedThread: string | undefined;
		let focusInputCalled = false;

		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as any;
		target.railVisible = true;
		target.isCompactLayout = false;
		target.rootContainer = document.createElement('div');
		target.railContainer = document.createElement('div');
		target.railResizeHandle = document.createElement('div');
		target.titleElement = document.createElement('div');
		target.backButton = document.createElement('button');
		target.threadsById = new Map([
			['thread-1', {
				threadId: 'thread-1',
				sessionResource: 'vsclone://thread/thread-1',
				title: 'Thread 1',
				createdAt: 1,
				updatedAt: 2,
				status: 'active',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Preview',
			}],
		]);
		target.rail = {
			getSelectedThread: () => selectedThread,
			setSelectedThread: (threadId: string | undefined) => { selectedThread = threadId; },
		};
		target.refreshConversation = () => { };
		target.updateThreadHeader = () => { };
		target.focusInput = () => { focusInputCalled = true; };
		target.applyRailLayout = () => { };

		await pane.openSession('thread-1');

		assert.strictEqual(target.activeThreadId, 'thread-1');
		assert.strictEqual(selectedThread, 'thread-1');
		assert.strictEqual(focusInputCalled, true);
	});

	test('compact layout collapses rail when opening a thread', async () => {
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as any;
		target.railVisible = true;
		target.isCompactLayout = true;
		target.rootContainer = document.createElement('div');
		target.railContainer = document.createElement('div');
		target.railResizeHandle = document.createElement('div');
		target.titleElement = document.createElement('div');
		target.backButton = document.createElement('button');
		target.threadsById = new Map([
			['thread-1', {
				threadId: 'thread-1',
				sessionResource: 'vsclone://thread/thread-1',
				title: 'Thread 1',
				createdAt: 1,
				updatedAt: 2,
				status: 'active',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Preview',
			}],
		]);
		target.rail = {
			getSelectedThread: () => 'thread-1',
			setSelectedThread: () => { },
		};
		target.refreshConversation = () => { };
		target.updateThreadHeader = () => { };
		target.focusInput = () => { };
		target.applyRailLayout = () => { };

		await pane.openSession('thread-1');
		assert.strictEqual(target.railVisible, false);
	});

	test('rail delete confirmation modal can be opened and confirmed', () => {
		const contextMenuService: IContextMenuService = {
			_serviceBrand: undefined,
			showContextMenu: () => undefined,
			configure: () => undefined,
			closeContextView: () => undefined,
			hideContextView: () => undefined,
			layout: () => undefined,
			getContextViewElement: () => document.createElement('div'),
		} as unknown as IContextMenuService;

		const rail = store.add(new VSCloneChatHistoryRail(contextMenuService));
		const container = document.createElement('div');
		rail.render(container);

		let deletedThreadId: string | undefined;
		const disposable = rail.onDidRequestAction(event => {
			if (event.action === 'delete') {
				deletedThreadId = event.threadId;
			}
		});
		store.add(disposable);

		rail.confirmDeleteThread('thread-1', 'Thread 1');
		const overlay = container.querySelector('.vsclone-chat-history-delete-overlay') as HTMLElement;
		const confirm = container.querySelector('.vsclone-chat-history-delete-confirm') as HTMLButtonElement;
		assert.ok(overlay.classList.contains('visible'));
		confirm.click();
		assert.strictEqual(deletedThreadId, 'thread-1');
	});

	test('search/tab filter mapping updates query semantics', () => {
		assert.deepStrictEqual(toVSCloneHistoryQuery('', 'all'), { text: '', tab: 'all', includeArchived: true });
		assert.deepStrictEqual(toVSCloneHistoryQuery('abc', 'active'), { text: 'abc', tab: 'active', includeArchived: false });
		assert.deepStrictEqual(toVSCloneHistoryQuery('abc', 'archived'), { text: 'abc', tab: 'archived', includeArchived: false });
	});
});
