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
import type { IVSCloneChatHistoryTurn } from '../../common/backend/vscloneChatHistoryService.js';
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

interface IComposerStateTarget {
	[key: string]: unknown;
	activeThreadId?: string;
	submittingPrompt: boolean;
	composerInput: HTMLTextAreaElement;
	composerSendButton: HTMLButtonElement;
	reasoningEffortSelect?: HTMLSelectElement;
	reasoningEffortContainer?: HTMLElement;
	updateComposerState: () => void;
	getBusyThreadId: () => string | undefined;
	getCurrentComposerModelSelection: (threadId: string | undefined) => unknown;
	refreshPlanModeControl: (composerBusy?: boolean) => void;
	getCurrentComposerMode: () => 'act' | 'plan';
}

interface IComposerPrimaryActionTarget {
	[key: string]: unknown;
	handleComposerPrimaryAction: () => Promise<void>;
	getBusyThreadId: () => string | undefined;
	sessionService: { cancelThread: (threadId: string) => void };
	updateComposerState: () => void;
	submitPrompt: () => Promise<void>;
}

interface IRenderToolAwareAssistantTarget {
	[key: string]: unknown;
	renderToolAwareAssistantText: (container: HTMLElement, text: string, streaming: boolean) => void;
}

interface IRenderAssistantMessageTarget {
	[key: string]: unknown;
	renderAssistantMessage: (turn: IVSCloneChatHistoryTurn) => HTMLElement;
}

function createPlainTextMarkdownRendererStub() {
	return {
		render: (markdown: { value?: string }, _options: unknown, outElement?: HTMLElement) => {
			const element = outElement ?? document.createElement('div');
			element.textContent = markdown.value ?? '';
			return {
				element,
				dispose: () => undefined,
			};
		},
	};
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
		const modal = container.querySelector('.vsclone-chat-history-delete-modal') as HTMLElement;
		const confirm = container.querySelector('.vsclone-chat-history-delete-confirm') as HTMLButtonElement;
		assert.ok(overlay.classList.contains('visible'));
		assert.strictEqual(overlay.getAttribute('aria-hidden'), 'false');
		assert.strictEqual(modal.getAttribute('role'), 'dialog');
		assert.strictEqual(modal.getAttribute('aria-modal'), 'true');
		confirm.click();
		assert.strictEqual(deletedThreadId, 'thread-1');
	});

	test('history rail delete modal traps keyboard focus and restores previous focus on escape', () => {
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
		document.body.appendChild(container);
		rail.render(container);

		const priorFocus = document.createElement('button');
		document.body.appendChild(priorFocus);
		priorFocus.focus();

		rail.confirmDeleteThread('thread-1', 'Thread 1');
		const overlay = container.querySelector('.vsclone-chat-history-delete-overlay') as HTMLElement;
		const cancel = container.querySelector('.vsclone-chat-history-delete-cancel') as HTMLButtonElement;
		const confirm = container.querySelector('.vsclone-chat-history-delete-confirm') as HTMLButtonElement;
		assert.strictEqual(document.activeElement, cancel);

		// Tab and Shift+Tab should wrap inside the two modal action buttons.
		confirm.focus();
		overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
		assert.strictEqual(document.activeElement, cancel);
		cancel.focus();
		overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
		assert.strictEqual(document.activeElement, confirm);

		overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		assert.strictEqual(overlay.getAttribute('aria-hidden'), 'true');
		assert.ok(!overlay.classList.contains('visible'));
		assert.strictEqual(document.activeElement, priorFocus);
		container.remove();
		priorFocus.remove();
	});

	test('history rail exposes state container roles and list accessibility labels', () => {
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

		const list = container.querySelector('.vsclone-chat-history-list') as HTMLElement;
		assert.strictEqual(list.getAttribute('role'), 'list');
		assert.strictEqual(list.getAttribute('aria-label'), 'Conversation threads');

		rail.setLoading();
		assert.strictEqual((container.querySelector('.vsclone-chat-history-state') as HTMLElement).getAttribute('role'), 'status');
		rail.setError('boom');
		assert.strictEqual((container.querySelector('.vsclone-chat-history-state') as HTMLElement).getAttribute('role'), 'alert');
		rail.setRows([{
			threadId: 'thread-1',
			title: 'Thread 1',
			preview: 'Preview',
			updatedLabel: 'just now',
			turnCount: 2,
			archived: false,
			status: 'active',
			selected: false,
		}]);
		assert.strictEqual((container.querySelector('.vsclone-chat-history-state') as HTMLElement).getAttribute('role'), null);
	});

	test('history rail rows render as keyboard-focusable buttons with selection state', () => {
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
		rail.setRows([{
			threadId: 'thread-1',
			title: 'Thread 1',
			preview: 'Preview',
			updatedLabel: 'just now',
			turnCount: 2,
			archived: false,
			status: 'active',
			selected: false,
		}]);

		const row = container.querySelector('.vsclone-chat-history-row') as HTMLButtonElement;
		assert.strictEqual(row.tagName, 'BUTTON');
		assert.strictEqual(row.getAttribute('aria-pressed'), 'false');

		rail.setSelectedThread('thread-1');
		assert.strictEqual(row.getAttribute('aria-pressed'), 'true');
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
		target.planModeService = {
			onDidChangeMode: Event.None,
			initialize: async () => undefined,
			getModeForThread: () => 'plan',
			setModeForThread: async () => undefined,
			isToolAllowed: () => true,
		};

		const parent = document.createElement('div');
		target.renderConversationSurface(parent);
		const composer = parent.querySelector('.vsclone-thread-composer') as HTMLElement;
		const toolbar = parent.querySelector('.vsclone-thread-composer-toolbar') as HTMLElement;
		const controls = parent.querySelector('.vsclone-thread-composer-controls') as HTMLElement;
		const addContextRoot = parent.querySelector('.vsclone-add-context-root') as HTMLElement;
		const addContextButton = parent.querySelector('.vsclone-add-context-button') as HTMLButtonElement;
		const addContextMenu = parent.querySelector('.vsclone-add-context-menu') as HTMLElement;
		const sendButton = parent.querySelector('.vsclone-thread-composer-send') as HTMLButtonElement;
		const hint = parent.querySelector('.vsclone-thread-composer-hint') as HTMLElement;
		assert.ok(parent.querySelector('.vsclone-thread-model-switcher'));
		assert.ok(parent.querySelector('.vsclone-thread-reasoning-level-select'));
		assert.ok(toolbar);
		assert.ok(addContextRoot);
		assert.ok(addContextMenu);
		assert.deepStrictEqual(
			{
				addContextHasPopup: addContextButton.getAttribute('aria-haspopup'),
				menuHidden: addContextMenu.classList.contains('hidden'),
				composerChildren: {
					toolbar: Array.from(composer.children).indexOf(toolbar),
					hint: Array.from(composer.children).indexOf(hint),
				},
				toolbarContainsAddContext: toolbar.contains(addContextRoot),
				toolbarContainsControls: toolbar.contains(controls),
				toolbarContainsSend: toolbar.contains(sendButton),
			},
			{
				addContextHasPopup: 'menu',
				menuHidden: true,
				composerChildren: {
					toolbar: 1,
					hint: 2,
				},
				toolbarContainsAddContext: true,
				toolbarContainsControls: true,
				toolbarContainsSend: true,
			},
		);
		assert.strictEqual((parent.querySelector('.vsclone-thread-action-button') as HTMLButtonElement).getAttribute('aria-label'), 'Show chat history');
		assert.strictEqual((parent.querySelector('.vsclone-thread-action-overflow') as HTMLButtonElement).textContent, '\u22ef');
		assert.strictEqual((parent.querySelector('.vsclone-thread-action-overflow') as HTMLButtonElement).getAttribute('aria-haspopup'), 'menu');
		assert.strictEqual((parent.querySelector('.vsclone-thread-messages') as HTMLElement).getAttribute('role'), 'log');
		assert.strictEqual((parent.querySelector('.vsclone-thread-messages') as HTMLElement).getAttribute('aria-live'), 'polite');
		assert.strictEqual((parent.querySelector('.vsclone-thread-messages') as HTMLElement).getAttribute('aria-relevant'), 'additions text');
		assert.strictEqual((parent.querySelector('.vsclone-thread-messages') as HTMLElement).getAttribute('aria-label'), 'Conversation messages');
		assert.strictEqual((parent.querySelector('.vsclone-thread-composer-input') as HTMLTextAreaElement).getAttribute('aria-label'), 'Chat message');
		assert.strictEqual((parent.querySelector('.vsclone-thread-composer-input') as HTMLTextAreaElement).getAttribute('aria-describedby'), hint.id);
		// Explicitly dispose synthesized registrations in this unit harness to satisfy leak checks.
		(target.modelSwitcher as { dispose?: () => void } | undefined)?.dispose?.();
		(target.composerFocusDisposable as { value?: { dispose?: () => void } }).value?.dispose?.();
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
				return { threadId: 'thread-new', sessionResource: 'vsclone://api/thread-new' };
			},
		};

		await target.submitPrompt();

		assert.strictEqual(capturedOptions?.modelSelection?.modelIdentifier, 'openai/gpt-5.3-codex');
		assert.strictEqual(capturedOptions?.modelSelection?.reasoningEffort, 'high');
		assert.strictEqual(boundThreadId, 'thread-new');
	});

	test('updateComposerState replaces send with stop while the active thread is streaming', () => {
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as IComposerStateTarget;
		const composerInput = document.createElement('textarea');
		const composerSendButton = document.createElement('button');
		let capturedPlanModeBusy: boolean | undefined;

		target.activeThreadId = 'thread-1';
		target.submittingPrompt = false;
		target.composerInput = composerInput;
		target.composerSendButton = composerSendButton;
		target.getBusyThreadId = () => 'thread-1';
		// The stop affordance must remain available even if the selected model disappears mid-stream.
		target.getCurrentComposerModelSelection = () => undefined;
		target.refreshPlanModeControl = composerBusy => {
			capturedPlanModeBusy = composerBusy;
		};
		target.getCurrentComposerMode = () => 'act';

		target.updateComposerState();

		assert.deepStrictEqual(
			{
				label: composerSendButton.textContent,
				disabled: composerSendButton.disabled,
				stopMode: composerSendButton.classList.contains('stop-mode'),
				ariaLabel: composerSendButton.getAttribute('aria-label'),
				title: composerSendButton.title,
				inputDisabled: composerInput.disabled,
				placeholder: composerInput.placeholder,
				planModeBusy: capturedPlanModeBusy,
			},
			{
				label: 'Stop',
				disabled: false,
				stopMode: true,
				ariaLabel: 'Stop response generation',
				title: 'Stop response generation',
				inputDisabled: true,
				placeholder: 'Waiting for response...',
				planModeBusy: true,
			},
		);
	});

	test('handleComposerPrimaryAction cancels the active thread instead of sending a new prompt', async () => {
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as IComposerPrimaryActionTarget;
		let cancelledThreadId: string | undefined;
		let updateComposerStateCalls = 0;
		let submitPromptCalls = 0;

		target.getBusyThreadId = () => 'thread-1';
		target.sessionService = {
			cancelThread: threadId => {
				cancelledThreadId = threadId;
			},
		};
		target.updateComposerState = () => {
			updateComposerStateCalls += 1;
		};
		target.submitPrompt = async () => {
			submitPromptCalls += 1;
		};

		await target.handleComposerPrimaryAction();

		assert.strictEqual(cancelledThreadId, 'thread-1');
		assert.strictEqual(updateComposerStateCalls, 1);
		assert.strictEqual(submitPromptCalls, 0);
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
				'@@ -12,1 +12,1 @@',
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
		assert.ok(container.textContent?.includes('TS src/app.ts'));
		assert.strictEqual((container.querySelector('.vsclone-tool-diff-title-line') as HTMLElement | null)?.textContent, 'Ln 12');
	});

	test('plan-mode assistant turns do not render apply changes buttons', () => {
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as IRenderAssistantMessageTarget;
		target.editApplicationService = {
			hasSearchReplaceBlocks: () => true,
		};

		const baseTurn: IVSCloneChatHistoryTurn = {
			turnId: 'turn-1',
			threadId: 'thread-1',
			sequence: 1,
			promptText: 'Prompt',
			responseMarkdown: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
			responsePlainText: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
			startedAt: 1,
			completedAt: 2,
			status: 'completed',
		};

		const planRendered = target.renderAssistantMessage({
			...baseTurn,
			executionMode: 'plan',
		});
		const actRendered = target.renderAssistantMessage({
			...baseTurn,
			turnId: 'turn-2',
			executionMode: 'act',
		});

		assert.strictEqual(planRendered.querySelector('.vsclone-thread-message-apply'), null);
		assert.ok(actRendered.querySelector('.vsclone-thread-message-apply'));
	});

	test('tool-aware renderer opens the file at the rendered diff line', () => {
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as IRenderToolAwareAssistantTarget & {
			editorService: { openEditor: (input: { resource: { toString(): string }; options?: { selection?: { startLineNumber: number; endLineNumber?: number } } }) => Promise<unknown> };
		};
		const container = document.createElement('div');
		const openEditorCalls: Array<{ resource: { toString(): string }; options?: { selection?: { startLineNumber: number; endLineNumber?: number } } }> = [];
		target.editorService = {
			openEditor: async (input) => {
				openEditorCalls.push(input);
				return undefined;
			},
		};

		const formattedOutput = formatToolResultWithDiff(
			'Applied 1 edit(s) to file:///workspace/src/styles.css. Current diagnostics on file: 0.',
			[
				'--- a/src/styles.css',
				'+++ b/src/styles.css',
				'@@ -42,2 +42,2 @@',
				'-font-family: ui-sans-serif;',
				'+font-family: "Comic Sans MS";',
			].join('\n'),
		);
		const assistantText = [
			'<agent_trace type="tool" status="start">Edited src/styles.css</agent_trace>',
			`<tool_result tool_name="edit_file" success="true">${formattedOutput}</tool_result>`,
			'<agent_trace type="tool_result" status="success">edit_file succeeded</agent_trace>',
		].join('\n');

		target.renderToolAwareAssistantText(container, assistantText, false);

		const fileLabel = container.querySelector('.vsclone-tool-diff-title-filename') as HTMLAnchorElement | null;
		assert.ok(fileLabel);
		fileLabel.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

		assert.strictEqual(openEditorCalls.length, 1);
		assert.strictEqual(openEditorCalls[0].resource.toString(), 'file:///workspace/src/styles.css');
		assert.strictEqual(openEditorCalls[0].options?.selection?.startLineNumber, 42);
	});

	test('tool-aware renderer shows a title range for multi-line diffs', () => {
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as IRenderToolAwareAssistantTarget & {
			editorService: { openEditor: (input: { resource: { toString(): string }; options?: { selection?: { startLineNumber: number; endLineNumber?: number } } }) => Promise<unknown> };
		};
		const container = document.createElement('div');
		const openEditorCalls: Array<{ resource: { toString(): string }; options?: { selection?: { startLineNumber: number; endLineNumber?: number } } }> = [];
		target.editorService = {
			openEditor: async (input) => {
				openEditorCalls.push(input);
				return undefined;
			},
		};

		const formattedOutput = formatToolResultWithDiff(
			'Applied 1 edit(s) to file:///workspace/src/styles.css. Current diagnostics on file: 0.',
			[
				'--- a/src/styles.css',
				'+++ b/src/styles.css',
				'@@ -20,9 +20,9 @@',
				'-old line 1',
				'-old line 2',
				'-old line 3',
				'-old line 4',
				'-old line 5',
				'-old line 6',
				'-old line 7',
				'-old line 8',
				'-old line 9',
				'+new line 1',
				'+new line 2',
				'+new line 3',
				'+new line 4',
				'+new line 5',
				'+new line 6',
				'+new line 7',
				'+new line 8',
				'+new line 9',
			].join('\n'),
		);
		const assistantText = [
			'<agent_trace type="tool" status="start">Edited src/styles.css</agent_trace>',
			`<tool_result tool_name="edit_file" success="true">${formattedOutput}</tool_result>`,
			'<agent_trace type="tool_result" status="success">edit_file succeeded</agent_trace>',
		].join('\n');

		target.renderToolAwareAssistantText(container, assistantText, false);

		const lineBadge = container.querySelector('.vsclone-tool-diff-title-line') as HTMLElement | null;
		assert.ok(lineBadge);
		assert.strictEqual(lineBadge.textContent, 'Ln 20-28');

		lineBadge.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

		assert.strictEqual(openEditorCalls.length, 1);
		assert.strictEqual(openEditorCalls[0].options?.selection?.startLineNumber, 20);
		assert.strictEqual(openEditorCalls[0].options?.selection?.endLineNumber, 28);
	});

	test('tool-aware renderer backfills line numbers for legacy change hunks', async () => {
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as IRenderToolAwareAssistantTarget & {
			editorService: { openEditor: (input: { resource: { toString(): string }; options?: { selection?: { startLineNumber: number; endLineNumber?: number } } }) => Promise<unknown> };
			modelService: { getModel: (resource: { toString(): string }) => { getValue(): string } | undefined };
			fileService: { readFile: () => Promise<{ value: { toString(): string } }> };
		};
		const container = document.createElement('div');
		const openEditorCalls: Array<{ resource: { toString(): string }; options?: { selection?: { startLineNumber: number; endLineNumber?: number } } }> = [];
		target.editorService = {
			openEditor: async (input) => {
				openEditorCalls.push(input);
				return undefined;
			},
		};
		target.modelService = {
			getModel: resource => resource.toString() === 'file:///workspace/src/styles.css'
				? {
					getValue: () => [
						'body {',
						'  margin: 0;',
						'  font-family: "Comic Sans MS", "Comic Sans", cursive;',
						'}',
					].join('\n'),
				}
				: undefined,
		};
		target.fileService = {
			readFile: async () => ({ value: { toString: () => '' } }),
		};

		const formattedOutput = formatToolResultWithDiff(
			'Applied 1 edit(s) to file:///workspace/src/styles.css. Current diagnostics on file: 0.',
			[
				'--- a/src/styles.css',
				'+++ b/src/styles.css',
				'@@ change 1 @@',
				'-font-family: ui-sans-serif, system-ui;',
				'+font-family: "Comic Sans MS", "Comic Sans", cursive;',
			].join('\n'),
		);
		const assistantText = [
			'<agent_trace type="tool" status="start">Edited src/styles.css</agent_trace>',
			`<tool_result tool_name="edit_file" success="true">${formattedOutput}</tool_result>`,
			'<agent_trace type="tool_result" status="success">edit_file succeeded</agent_trace>',
		].join('\n');

		target.renderToolAwareAssistantText(container, assistantText, false);
		await new Promise(resolve => setTimeout(resolve, 0));

		const lineBadge = container.querySelector('.vsclone-tool-diff-title-line') as HTMLElement | null;
		assert.ok(lineBadge);
		assert.strictEqual(lineBadge.textContent, 'Ln 3');

		const fileLabel = container.querySelector('.vsclone-tool-diff-title-filename') as HTMLAnchorElement | null;
		assert.ok(fileLabel);
		fileLabel.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

		assert.strictEqual(openEditorCalls.length, 1);
		assert.strictEqual(openEditorCalls[0].options?.selection?.startLineNumber, 3);
	});

	test('tool-aware renderer shows full markdown output for non-diff tool results', () => {
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as IRenderToolAwareAssistantTarget & {
			markdownRendererService: ReturnType<typeof createPlainTextMarkdownRendererStub>;
			renderedMarkdownDisposables: { add: (value: { dispose(): void }) => void };
		};
		const container = document.createElement('div');
		target.markdownRendererService = createPlainTextMarkdownRendererStub();
		target.renderedMarkdownDisposables = {
			add: () => undefined,
		};

		const assistantText = [
			'<agent_trace type="tool" status="start">Listed . (recursive)</agent_trace>',
			'<tool_result tool_name="list_directory" success="true">Directory listing for file:///workspace:\n(empty directory)</tool_result>',
			'<agent_trace type="tool_result" status="success">list_directory succeeded</agent_trace>',
		].join('\n');

		target.renderToolAwareAssistantText(container, assistantText, false);

		const output = container.querySelector('.vsclone-tool-card-output');
		assert.ok(output);
		assert.ok(output?.textContent?.includes('Directory listing for file:///workspace:'));
		assert.ok(output?.textContent?.includes('(empty directory)'));
	});

	test('tool-aware renderer uses the full attempt completion result instead of a trace excerpt', () => {
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as IRenderToolAwareAssistantTarget & {
			markdownRendererService: ReturnType<typeof createPlainTextMarkdownRendererStub>;
			renderedMarkdownDisposables: { add: (value: { dispose(): void }) => void };
		};
		const container = document.createElement('div');
		target.markdownRendererService = createPlainTextMarkdownRendererStub();
		target.renderedMarkdownDisposables = {
			add: () => undefined,
		};

		const fullSummary = [
			'# Result',
			'',
			'- first point',
			'- second point',
			'- third point',
			'',
			'`src/main.jsx` and `src/App.jsx` were inspected.',
		].join('\n');
		const assistantText = [
			'<agent_trace type="tool" status="start">Attempted completion</agent_trace>',
			`<tool_result tool_name="attempt_completion" success="true">${fullSummary}</tool_result>`,
			'<agent_trace type="tool_result" status="success">attempt_completion succeeded</agent_trace>',
		].join('\n');

		target.renderToolAwareAssistantText(container, assistantText, false);

		assert.ok(container.textContent?.includes('# Result'));
		assert.ok(container.textContent?.includes('second point'));
		assert.ok(container.textContent?.includes('src/main.jsx'));
		assert.strictEqual(container.querySelector('.vsclone-tool-card'), null);
	});

	test('tool-aware renderer suppresses duplicated pre-tool summaries when attempt completion repeats them', () => {
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as IRenderToolAwareAssistantTarget & {
			markdownRendererService: ReturnType<typeof createPlainTextMarkdownRendererStub>;
			renderedMarkdownDisposables: { add: (value: { dispose(): void }) => void };
		};
		const container = document.createElement('div');
		target.markdownRendererService = createPlainTextMarkdownRendererStub();
		target.renderedMarkdownDisposables = {
			add: () => undefined,
		};

		const provisionalSummary = [
			'I inspected the workspace and it appears empty, so here is a fresh small browser game idea and a concrete build plan.',
			'',
			'Game idea: "Pizza Panic"',
			'A fast, funny browser arcade game.',
		].join('\n');
		const assistantText = [
			provisionalSummary,
			'<tool_call><tool_name>list_directory</tool_name><path>.</path><recursive>true</recursive></tool_call>',
			'<agent_trace type="tool" status="start">Listed . (recursive)</agent_trace>',
			'<tool_result tool_name="list_directory" success="true">Directory listing for file:///workspace:\n(empty directory)</tool_result>',
			'<agent_trace type="tool_result" status="success">list_directory succeeded</agent_trace>',
			'<agent_trace type="tool" status="start">Attempted completion</agent_trace>',
			`<tool_result tool_name="attempt_completion" success="true">${provisionalSummary}</tool_result>`,
			'<agent_trace type="tool_result" status="success">attempt_completion succeeded</agent_trace>',
		].join('\n');

		target.renderToolAwareAssistantText(container, assistantText, false);

		const renderedSummaries = container.querySelectorAll('.vsclone-thread-message-text-segment');
		assert.strictEqual(renderedSummaries.length, 1);
		assert.ok(renderedSummaries[0].textContent?.includes('Pizza Panic'));
		assert.ok(container.querySelector('.vsclone-tool-card'));
	});

	test('tool-aware renderer recovers inline thinking markers and trailing prose before a tool call', () => {
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as IRenderToolAwareAssistantTarget & {
			markdownRendererService: ReturnType<typeof createPlainTextMarkdownRendererStub>;
			renderedMarkdownDisposables: { add: (value: { dispose(): void }) => void };
		};
		const container = document.createElement('div');
		target.markdownRendererService = createPlainTextMarkdownRendererStub();
		target.renderedMarkdownDisposables = {
			add: () => undefined,
		};

		const assistantText = [
			'Thinking: I’ll inspect the workspace to see whether there is any existing game scaffold or relevant code to build on.Thinking: I’ll summarize a concrete small browser game idea and implementation plan based on the workspace contents.Here’s a fun, small browser game idea:',
			'<tool_call><tool_name>list_directory</tool_name><path>.</path><recursive>true</recursive></tool_call>',
		].join('\n');

		target.renderToolAwareAssistantText(container, assistantText, false);

		const thinkingSteps = Array.from(container.querySelectorAll('.vsclone-thinking-step'));
		assert.strictEqual(thinkingSteps.length, 2);
		assert.ok(thinkingSteps[0].textContent?.includes('inspect the workspace'));
		assert.ok(thinkingSteps[1].textContent?.includes('implementation plan based on the workspace contents.'));
		assert.ok(!thinkingSteps[1].textContent?.includes('Here’s a fun, small browser game idea:'));

		const textSegment = container.querySelector('.vsclone-thread-message-text-segment');
		assert.ok(textSegment?.textContent?.includes('Here’s a fun, small browser game idea:'));
		assert.ok(container.querySelector('.vsclone-tool-card'));
	});
});
