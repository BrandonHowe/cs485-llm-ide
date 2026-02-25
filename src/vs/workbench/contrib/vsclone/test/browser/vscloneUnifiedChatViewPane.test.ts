/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { VSCloneChatHistoryRail } from '../../browser/vscloneChatHistoryRail.js';
import type { IVSCloneChatSubmitOptions } from '../../browser/vscloneChatSessionService.js';
import { VSCloneUnifiedChatViewPane, toVSCloneHistoryQuery } from '../../browser/vscloneUnifiedChatViewPane.js';
import { formatToolResultWithDiff } from '../../common/vscloneToolResultDiff.js';

interface ITestPaneTarget {
	railVisible: boolean;
	railWidth: number;
	isCompactLayout: boolean;
	bodyWidth: number;
	rootContainer: HTMLElement;
	railContainer: HTMLElement;
	railResizeHandle: HTMLElement;
	threadsById: Map<string, unknown>;
	rail: {
		focusSearch?: () => void;
		getSelectedThread: () => string | undefined;
		setSelectedThread: (threadId: string | undefined) => void;
	};
	activeThreadId?: string;
	refreshConversation: () => void;
	focusInput: () => void;
	applyRailLayout: () => void;
}

interface IRenderConversationSurfaceTarget {
	[key: string]: unknown;
	renderConversationSurface: (parent: HTMLElement) => void;
}

interface ISubmitPromptTarget {
	[key: string]: unknown;
	submitPrompt: () => Promise<void>;
}

interface IRenderToolAwareAssistantTarget {
	[key: string]: unknown;
	renderToolAwareAssistantText: (container: HTMLElement, text: string, streaming: boolean) => void;
}

suite('VSCloneUnifiedChatViewPane', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('rail toggle and focus methods update layout state', () => {
		let focusRailCalled = false;
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as ITestPaneTarget;
		target.railVisible = true;
		target.railWidth = 320;
		target.isCompactLayout = false;
		target.bodyWidth = 1200;
		target.rootContainer = document.createElement('div');
		target.railContainer = document.createElement('div');
		target.railResizeHandle = document.createElement('div');
		target.threadsById = new Map();
		target.rail = {
			focusSearch: () => { focusRailCalled = true; },
			getSelectedThread: () => undefined,
			setSelectedThread: (_threadId: string | undefined) => { },
		};

		pane.toggleRail();
		assert.strictEqual(target.railVisible, false);
		assert.strictEqual(target.railContainer.style.width, '0px');

		pane.focusRail();
		assert.strictEqual(focusRailCalled, true);
	});

	test('thread selection updates active thread and rail selection', async () => {
		let selectedThread: string | undefined;
		let focusInputCalled = false;

		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as ITestPaneTarget;
		target.railVisible = true;
		target.isCompactLayout = false;
		target.rootContainer = document.createElement('div');
		target.railContainer = document.createElement('div');
		target.railResizeHandle = document.createElement('div');
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
		target.focusInput = () => { focusInputCalled = true; };
		target.applyRailLayout = () => { };

		await pane.openSession('thread-1');

		assert.strictEqual(target.activeThreadId, 'thread-1');
		assert.strictEqual(selectedThread, 'thread-1');
		assert.strictEqual(focusInputCalled, true);
	});

	test('compact layout collapses rail when opening a thread', async () => {
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as ITestPaneTarget;
		target.railVisible = true;
		target.isCompactLayout = true;
		target.rootContainer = document.createElement('div');
		target.railContainer = document.createElement('div');
		target.railResizeHandle = document.createElement('div');
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
			setSelectedThread: (_threadId: string | undefined) => { },
		};
		target.refreshConversation = () => { };
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

	test('composer surface includes model and reasoning controls when enabled', () => {
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as IRenderConversationSurfaceTarget;
		target._register = (value: unknown) => value;
		target.activeThreadId = undefined;
		target.submittingPrompt = false;
		target.composerFocusDisposable = { value: undefined };
		target.contextMenuService = {
			showContextMenu: () => undefined,
		};
		target.configurationService = {
			getValue: (key: string) => key === 'vsclone.modelSwitcher.enabled' ? true : undefined,
		};
		target.modelCatalogService = {
			onDidChangeCatalog: Event.None,
			getState: () => ({ status: 'ready', providers: [], models: [] }),
			refreshCatalog: async () => undefined,
			getProviders: () => [],
			getModels: () => [],
			getModel: () => undefined,
			getSelectableModels: () => [],
		};
		target.modelSelectionService = {
			onDidChangeSelection: Event.None,
			initialize: async () => undefined,
			getCurrentSelectionForThread: () => undefined,
			setSelectionForThread: async () => undefined,
			switchToNextModel: async () => undefined,
			resetSelectionForThread: async () => undefined,
			hasSelectionForThread: () => false,
			getRecentModelIdentifiers: () => [],
		};
		target.providerConfigurationBridge = {
			openManageProvidersPicker: async () => undefined,
		};

		const parent = document.createElement('div');
		target.renderConversationSurface(parent);
		assert.ok(parent.querySelector('.vsclone-thread-model-switcher'));
		assert.ok(parent.querySelector('.vsclone-thread-reasoning-level-select'));
	});

	test('submitPrompt passes selected model metadata to session service', async () => {
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as ISubmitPromptTarget;
		const selectedModel = {
			threadId: undefined,
			location: 'chat',
			modelIdentifier: 'openai/gpt-5.3-codex',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelName: 'GPT-5.3-Codex',
			reasoningEffort: 'high' as const,
			selectedAt: Date.now(),
		};

		let capturedOptions: IVSCloneChatSubmitOptions | undefined;
		let boundThreadId: string | undefined;
		target.activeThreadId = undefined;
		target.submittingPrompt = false;
		target.railVisible = false;
		const composerInput = document.createElement('textarea');
		composerInput.value = 'hello';
		target.composerInput = composerInput;
		target.composerSendButton = document.createElement('button');
		target.rail = { setSelectedThread: () => undefined };
		target.threadsById = new Map();
		target.historyService = { getThreads: () => [] };
		target.updateComposerState = () => undefined;
		target.updateComposerMetrics = () => undefined;
		target.refreshConversation = () => undefined;
		target.applyRailLayout = () => undefined;
		target.modelSwitcher = { refresh: () => undefined };
		target.modelCatalogService = {
			getModel: () => ({
				identifier: 'openai/gpt-5.3-codex',
				vendor: 'openai',
				modelId: 'gpt-5.3-codex',
				modelName: 'GPT-5.3-Codex',
				reasoningEffortLevels: ['low', 'medium', 'high'],
				defaultReasoningEffort: 'medium',
				isSelectable: true,
			}),
		};
		target.modelSelectionService = {
			getCurrentSelectionForThread: () => selectedModel,
			setSelectionForThread: async (threadId: string) => { boundThreadId = threadId; },
		};
		target.sessionService = {
			submitPrompt: async (_prompt: string, options: IVSCloneChatSubmitOptions) => {
				capturedOptions = options;
				return { threadId: 'thread-new', sessionResource: 'vsclone://mock/thread-new', mocked: true };
			},
		};

		await target.submitPrompt();

		assert.strictEqual(capturedOptions?.modelSelection?.modelIdentifier, 'openai/gpt-5.3-codex');
		assert.strictEqual(capturedOptions?.modelSelection?.reasoningEffort, 'high');
		assert.strictEqual(boundThreadId, 'thread-new');
	});

	test('thread selection refreshes model switcher context on openSession', async () => {
		let refreshCount = 0;
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as ITestPaneTarget & { modelSwitcher: { refresh: () => void } };
		target.railVisible = true;
		target.isCompactLayout = false;
		target.rootContainer = document.createElement('div');
		target.railContainer = document.createElement('div');
		target.railResizeHandle = document.createElement('div');
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
			setSelectedThread: () => undefined,
		};
		target.modelSwitcher = { refresh: () => { refreshCount += 1; } };
		target.refreshConversation = () => { };
		target.focusInput = () => { };
		target.applyRailLayout = () => { };

		await pane.openSession('thread-1');
		assert.strictEqual(refreshCount, 1);
	});

	test('tool-aware renderer shows inline diff card for mutating tool results', () => {
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as IRenderToolAwareAssistantTarget;
		const container = document.createElement('div');
		const formattedOutput = formatToolResultWithDiff(
			'Applied 1 edit(s) to /workspace/src/app.ts. Current diagnostics on file: 0.',
			[
				'--- a/src/app.ts',
				'+++ b/src/app.ts',
				'@@ change 1 @@',
				'-const x = 1;',
				'+const x = 2;',
			].join('\n'),
		);
		const assistantText = [
			'<agent_trace type="tool" status="start">Edited src/app.ts</agent_trace>',
			`<tool_result tool_name="edit_file" success="true">${formattedOutput}</tool_result>`,
			'<agent_trace type="tool_result" status="success">edit_file succeeded</agent_trace>',
		].join('\n');

		target.renderToolAwareAssistantText(container, assistantText, false);

		assert.ok(container.querySelector('.vsclone-tool-diff-card'));
		assert.ok(container.querySelector('.vsclone-tool-diff-line.added'));
		assert.ok(container.querySelector('.vsclone-tool-diff-line.removed'));
		assert.ok(container.textContent?.includes('Applied file edits'));
	});
});
