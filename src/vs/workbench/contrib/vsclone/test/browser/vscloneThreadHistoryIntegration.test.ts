/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { VSCloneChatHistoryRail } from '../../browser/vscloneChatHistoryRail.js';
import { registerVSCloneChatHistoryActions, VSCloneChatHistoryCommandIds } from '../../browser/vscloneChatHistoryActions.js';
import { IVSCloneChatHistoryService as IVSCloneChatHistoryServiceId, VSCloneChatHistoryService, type IVSCloneChatHistoryService as IVSCloneChatHistoryServiceShape, type IVSCloneChatHistorySnapshot, type IVSCloneChatHistoryThread, type IVSCloneChatHistoryTurn, type VSCloneChatHistoryScope } from '../../common/backend/vscloneChatHistoryService.js';
import { VSCloneChatHistoryStore } from '../../common/backend/vscloneChatHistoryStore.js';
import { VSCloneUnifiedChatBackendService } from '../../common/backend/vscloneUnifiedChatBackendService.js';
import { VSCloneUnifiedChatViewPane } from '../../browser/vscloneUnifiedChatViewPane.js';

class TestLogService extends NullLogService {
	override info(..._args: unknown[]): void { /* no-op */ }
	override warn(..._args: unknown[]): void { /* no-op */ }
	override error(..._args: unknown[]): void { /* no-op */ }
}

class TestNotificationService {
	readonly warnings: string[] = [];
	readonly infos: string[] = [];
	readonly errors: string[] = [];

	warn(message: string): void {
		this.warnings.push(message);
	}

	info(message: string): void {
		this.infos.push(message);
	}

	error(message: string): void {
		this.errors.push(message);
	}
}

function createConfigurationService(values: Record<string, unknown | undefined> = {}) {
	return {
		getValue<T>(key: string): T | undefined {
			return values[key] as T | undefined;
		},
	};
}

class TestHistoryStore {
	readonly saveCalls: Array<{ scope: VSCloneChatHistoryScope; updatedAt: number }> = [];
	readonly clearCalls: VSCloneChatHistoryScope[] = [];
	private snapshot: IVSCloneChatHistorySnapshot;

	constructor(snapshot: IVSCloneChatHistorySnapshot) {
		this.snapshot = snapshot;
	}

	dispose(): void { /* no-op */ }

	async load(_scope: VSCloneChatHistoryScope): Promise<IVSCloneChatHistorySnapshot> {
		return this.snapshot;
	}

	async save(scope: VSCloneChatHistoryScope, snapshot: IVSCloneChatHistorySnapshot): Promise<void> {
		this.snapshot = snapshot;
		this.saveCalls.push({ scope, updatedAt: snapshot.updatedAt });
	}

	async clear(scope: VSCloneChatHistoryScope): Promise<void> {
		this.clearCalls.push(scope);
		this.snapshot = emptySnapshot();
	}
}

function emptySnapshot(): IVSCloneChatHistorySnapshot {
	return {
		updatedAt: Date.now(),
		threads: [],
		turnsByThreadId: {},
		modeByThread: {},
		selectedByThread: {},
		selectedByLocation: {},
		recentModelIdentifiers: [],
	};
}

function createTurn(threadId: string, sequence: number, promptText: string): IVSCloneChatHistoryTurn {
	return {
		turnId: `${threadId}-turn-${sequence}`,
		threadId,
		sequence,
		promptText,
		responseMarkdown: `Response ${sequence}`,
		responsePlainText: `Response ${sequence}`,
		startedAt: sequence,
		status: 'completed',
	};
}

function createThread(threadId: string, updatedAt: number, overrides: Partial<IVSCloneChatHistoryThread> = {}): IVSCloneChatHistoryThread {
	return {
		threadId,
		sessionResource: `vsclone://session/${threadId}`,
		title: `Thread ${threadId}`,
		createdAt: updatedAt - 10,
		updatedAt,
		status: 'active',
		archived: false,
		turnCount: 1,
		lastTurnPreview: `Preview ${threadId}`,
		...overrides,
	};
}

function createContextMenuCapture(): {
	service: IContextMenuService;
	getOptions: () => Parameters<IContextMenuService['showContextMenu']>[0] | undefined;
	hide: () => void;
} {
	let options: Parameters<IContextMenuService['showContextMenu']>[0] | undefined;
	return {
		service: {
			_serviceBrand: undefined,
			showContextMenu: (contextMenuOptions: Parameters<IContextMenuService['showContextMenu']>[0]) => {
				// The real context menu service disposes the previous menu when a new one opens, so
				// mirror that lifecycle here to avoid leaking the rail's per-open action store.
				options?.onHide?.(true);
				options = contextMenuOptions;
			},
			configure: () => undefined,
			closeContextView: () => options?.onHide?.(true),
			hideContextView: () => options?.onHide?.(true),
			layout: () => undefined,
			getContextViewElement: () => document.createElement('div'),
		} as unknown as IContextMenuService,
		getOptions: () => options,
		hide: () => options?.onHide?.(true),
	};
}

function createAccessor(services: Map<unknown, unknown>): { get<T>(id: unknown): T } {
	return {
		get<T>(id: unknown): T {
			if (!services.has(id)) {
				throw new Error(`Missing service for ${String(id)}`);
			}
			return services.get(id) as T;
		},
	};
}

function createRailActionMap(contextMenu: ReturnType<typeof createContextMenuCapture>): Map<string, { run: () => Promise<void> | void }> {
	const options = contextMenu.getOptions();
	assert.ok(options);
	assert.ok(options.getActions);
	return new Map(options.getActions!().map(action => [action.id, action]));
}

function createPaneHarness(rail: VSCloneChatHistoryRail, historyService: IVSCloneChatHistoryServiceShape) {
	const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
	const root = document.createElement('div');
	const railContainer = document.createElement('div');
	const composerInput = document.createElement('textarea');

	document.body.appendChild(root);
	document.body.appendChild(railContainer);
	root.appendChild(composerInput);

	(pane as unknown as {
		rootContainer: HTMLElement;
		railContainer: HTMLElement;
		railResizeHandle: HTMLElement;
		rail: VSCloneChatHistoryRail;
		historyService: IVSCloneChatHistoryServiceShape;
		sessionService: { cancelThread(threadId: string): void };
		planModeService: { initialize(): Promise<void> };
		historyReady: boolean;
		railVisible: boolean;
		activeThreadId?: string;
		threadsById: Map<string, IVSCloneChatHistoryThread>;
		composerInput: HTMLTextAreaElement;
		refreshConversation: () => void;
		refreshModelControls: () => void;
		refreshPlanModeControl: () => void;
		updateComposerState: () => void;
		scheduleScrollToBottom: () => void;
		applyRailLayout: () => void;
	}).rootContainer = root;
	(pane as unknown as { railContainer: HTMLElement }).railContainer = railContainer;
	(pane as unknown as { railResizeHandle: HTMLElement }).railResizeHandle = document.createElement('div');
	(pane as unknown as { rail: VSCloneChatHistoryRail }).rail = rail;
	(pane as unknown as { historyService: IVSCloneChatHistoryServiceShape }).historyService = historyService;
	(pane as unknown as { sessionService: { cancelThread(threadId: string): void } }).sessionService = {
		cancelThread: () => undefined,
	};
	(pane as unknown as { planModeService: { initialize(): Promise<void> } }).planModeService = {
		initialize: async () => undefined,
	};
	(pane as unknown as { historyReady: boolean }).historyReady = false;
	(pane as unknown as { railVisible: boolean }).railVisible = false;
	(pane as unknown as { activeThreadId?: string }).activeThreadId = undefined;
	(pane as unknown as { threadsById: Map<string, IVSCloneChatHistoryThread> }).threadsById = new Map();
	(pane as unknown as { composerInput: HTMLTextAreaElement }).composerInput = composerInput;
	(pane as unknown as { refreshConversation: () => void }).refreshConversation = () => undefined;
	(pane as unknown as { refreshModelControls: () => void }).refreshModelControls = () => undefined;
	(pane as unknown as { refreshPlanModeControl: () => void }).refreshPlanModeControl = () => undefined;
	(pane as unknown as { updateComposerState: () => void }).updateComposerState = () => undefined;
	(pane as unknown as { scheduleScrollToBottom: () => void }).scheduleScrollToBottom = () => undefined;
	(pane as unknown as { applyRailLayout: () => void }).applyRailLayout = () => undefined;

	return { pane, root, railContainer, composerInput };
}

suite('VSCloneThreadHistoryIntegration', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('restores threads, archives and deletes them through the rail, then exposes the clear-all composer reset gap', async () => {
		registerVSCloneChatHistoryActions();

		const testDisposables = store.add(new DisposableStore());
		const now = Date.now();
		const historySnapshot: IVSCloneChatHistorySnapshot = {
			updatedAt: now,
			threads: [
				createThread('thread-1', now - 1_000, { title: 'Alpha', turnCount: 2, lastTurnPreview: 'Alpha preview' }),
				createThread('thread-2', now - 2_000, { title: 'Beta', turnCount: 1, lastTurnPreview: 'Beta preview' }),
			],
			turnsByThreadId: {
				'thread-1': [createTurn('thread-1', 1, 'Alpha prompt'), createTurn('thread-1', 2, 'Alpha follow-up')],
				'thread-2': [createTurn('thread-2', 1, 'Beta prompt')],
			},
			modeByThread: {},
			selectedByThread: {},
			selectedByLocation: {},
			recentModelIdentifiers: [],
		};

		const instantiationService = testDisposables.add(new TestInstantiationService(new ServiceCollection()));
		const historyStore = new TestHistoryStore(historySnapshot);
		instantiationService.stubInstance(VSCloneChatHistoryStore, historyStore as unknown as VSCloneChatHistoryStore);

		const backend = testDisposables.add(new VSCloneUnifiedChatBackendService(
			instantiationService,
			createConfigurationService(),
			new TestLogService(),
			new TestNotificationService(),
		));
		const historyService = new VSCloneChatHistoryService(backend);
		const contextMenu = createContextMenuCapture();
		const rail = testDisposables.add(new VSCloneChatHistoryRail(contextMenu.service));
		const railHost = document.createElement('div');
		document.body.appendChild(railHost);
		rail.render(railHost);

		const { pane, root, composerInput } = createPaneHarness(rail, historyService);
		const castPane = pane as unknown as {
			reloadHistory: () => Promise<void>;
			refreshRailRows: () => void;
			refreshConversation: () => void;
			openSession: (threadId?: string) => Promise<void>;
			deleteThread: (threadId: string) => Promise<void>;
			focusRail: () => void;
			railVisible: boolean;
			activeThreadId?: string;
		};

		store.add(historyService.onDidChange(event => {
			if (event.reason !== 'turnUpdate') {
				castPane.refreshRailRows();
				castPane.refreshConversation();
			}
		}));

		store.add(rail.onDidRequestAction(async event => {
			switch (event.action) {
				case 'open':
					await castPane.openSession(event.threadId);
					break;
				case 'delete':
					await castPane.deleteThread(event.threadId);
					break;
				case 'toggleArchive':
					await historyService.archiveThread(event.threadId, !!event.archived);
					break;
				default:
					break;
			}
		}));

		try {
			await castPane.reloadHistory();
			assert.deepStrictEqual(backend.getThreads({ includeArchived: true }).map(thread => thread.threadId), ['thread-1', 'thread-2']);
			assert.strictEqual(railHost.querySelectorAll('.vsclone-chat-history-row').length, 2);

			await castPane.openSession('thread-1');
			assert.strictEqual(castPane.activeThreadId, 'thread-1');
			assert.strictEqual(rail.getSelectedThread(), 'thread-1');

			railHost.querySelector('[data-thread-id="thread-1"] .vsclone-chat-history-row-preview')?.dispatchEvent(
				new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 12, clientY: 18 }),
			);
			let actionMap = createRailActionMap(contextMenu);
			await actionMap.get('vsclone.chatHistory.toggleArchive')?.run();
			await timeout(0);
			assert.strictEqual(backend.getThreads({ includeArchived: true }).find(thread => thread.threadId === 'thread-1')?.archived, true);
			assert.strictEqual(railHost.querySelector('[data-thread-id="thread-1"] .vsclone-chat-history-row-archived')?.textContent, 'Archived');

			railHost.querySelector('[data-thread-id="thread-2"] .vsclone-chat-history-row-preview')?.dispatchEvent(
				new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 16, clientY: 20 }),
			);
			actionMap = createRailActionMap(contextMenu);
			await actionMap.get('vsclone.chatHistory.delete')?.run();
			const deleteCancel = railHost.querySelector('.vsclone-chat-history-delete-cancel') as HTMLButtonElement;
			const deleteConfirm = railHost.querySelector('.vsclone-chat-history-delete-confirm') as HTMLButtonElement;
			assert.ok(deleteCancel);
			assert.ok(deleteConfirm);
			deleteConfirm.click();
			await timeout(0);
			assert.deepStrictEqual(backend.getThreads({ includeArchived: true }).map(thread => thread.threadId), ['thread-1']);
			assert.strictEqual(railHost.querySelectorAll('.vsclone-chat-history-row').length, 1);

			// Clearing workspace history should return the user to a fresh composer, not leave the
			// history rail open on an empty backend snapshot.
			castPane.focusRail();
			assert.strictEqual(castPane.railVisible, true);
			assert.strictEqual(document.activeElement, railHost.querySelector('.vsclone-chat-history-search'));

			const clearCommand = CommandsRegistry.getCommand(VSCloneChatHistoryCommandIds.clearAllWorkspace);
			assert.ok(clearCommand);
			await clearCommand?.handler(createAccessor(new Map([[IVSCloneChatHistoryServiceId, historyService]])) as never);
			await timeout(0);

			assert.deepStrictEqual(backend.getThreads({ includeArchived: true }), []);
			assert.deepStrictEqual(historyStore.clearCalls, ['workspace']);
			assert.strictEqual(castPane.activeThreadId, undefined);
			assert.strictEqual(castPane.railVisible, false);
			assert.strictEqual(document.activeElement, composerInput);
		} finally {
			contextMenu.hide();
			root.remove();
			railHost.remove();
		}
	});
});
