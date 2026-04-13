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

interface IRenderUserMessageTarget {
	[key: string]: unknown;
	renderUserMessage: (turn: IVSCloneChatHistoryTurn) => HTMLElement;
	showImagePreviewOverlay: (dataUrl: string) => void;
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

// The constructor performs a lot of UI setup that would hide the small helper branches we want to
// exercise, so the tests use a prototype-only harness and inject only the members needed by each case.
function createPaneHarness(): VSCloneUnifiedChatViewPane {
	return Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
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

	test('helper transcript parsing decodes thinking traces and trims lone tool outputs', () => {
		const pane = createPaneHarness();
		const target = pane as unknown as IRenderToolAwareAssistantTarget & {
			markdownRendererService: ReturnType<typeof createPlainTextMarkdownRendererStub>;
			renderedMarkdownDisposables: { add: (value: { dispose(): void }) => void };
		};
		target.markdownRendererService = createPlainTextMarkdownRendererStub();
		target.renderedMarkdownDisposables = {
			add: () => undefined,
		};

		const thinkingContainer = document.createElement('div');
		const thinkingTranscript = [
			'<agent_trace type="thinking">Thinking about &lt;items&gt; &amp; tools</agent_trace>',
			'Final answer starts here',
		].join('\n');
		target.renderToolAwareAssistantText(thinkingContainer, thinkingTranscript, false);

		assert.strictEqual(
			thinkingContainer.querySelector('.vsclone-thinking-step')?.textContent,
			'Thinking about <items> & tools',
		);
		assert.ok(!thinkingContainer.textContent?.includes('&lt;items&gt;'));

		const toolContainer = document.createElement('div');
		const toolTranscript = [
			'<agent_trace type="tool" status="start">Search workspace</agent_trace>',
			'<tool_result tool_name="search" success="false">  trimmed output  </tool_result>',
		].join('\n');
		target.renderToolAwareAssistantText(toolContainer, toolTranscript, false);

		assert.strictEqual(
			toolContainer.querySelector('.vsclone-tool-card-output')?.textContent,
			'trimmed output',
		);
	});

	test('helper transcript normalization and thinking segmentation keep structural markers stable', () => {
		const pane = createPaneHarness() as unknown as {
			normalizeTranscriptComparisonText: (value: string) => string;
			extractPlainAssistantSegments: (text: string) => ReadonlyArray<{ kind: 'thinking' | 'text'; value: string }>;
			findNextPlainThinkingMarker: (text: string, fromOffset: number) => number;
			splitThinkingMessageAndTrailingText: (value: string) => { message: string; trailingText: string };
			shouldSuppressProvisionalCompletionSegment: (segment: string, segmentEndOffset: number, firstCompletionStartOffset: number | undefined, completionSummaries: readonly string[]) => boolean;
		};

		assert.strictEqual(
			pane.normalizeTranscriptComparisonText('  Hello\nWORLD  '),
			'hello world',
		);

		const transcript = 'labelThinking: ignore this. Thinking: plan step. Final answer starts here';
		assert.strictEqual(
			pane.findNextPlainThinkingMarker(transcript, 0),
			transcript.indexOf('Thinking: plan step.'),
		);
		assert.deepStrictEqual(pane.extractPlainAssistantSegments(transcript), [
			{ kind: 'text', value: 'labelThinking: ignore this.' },
			{ kind: 'thinking', value: 'plan step.' },
			{ kind: 'text', value: 'Final answer starts here' },
		]);
		assert.deepStrictEqual(
			pane.splitThinkingMessageAndTrailingText('Plan step. Final Answer starts here'),
			{ message: 'Plan step.', trailingText: 'Final Answer starts here' },
		);

		const completionSummary = 'I inspected the workspace and it appears empty, so here is a fresh small browser game idea and a concrete build plan.';
		const normalizedSummary = pane.normalizeTranscriptComparisonText(completionSummary);
		assert.strictEqual(
			pane.shouldSuppressProvisionalCompletionSegment(
				completionSummary,
				completionSummary.length,
				completionSummary.length + 10,
				[normalizedSummary],
			),
			true,
		);
		assert.strictEqual(
			pane.shouldSuppressProvisionalCompletionSegment(
				'Task complete',
				13,
				completionSummary.length + 10,
				['Task complete'],
			),
			false,
		);
		assert.strictEqual(
			pane.shouldSuppressProvisionalCompletionSegment(
				completionSummary,
				completionSummary.length,
				undefined,
				[completionSummary],
			),
			false,
		);
	});

	test('composer model selection and reasoning helpers resolve visible, stored, and default values', async () => {
		const pane = createPaneHarness() as unknown as {
			activeThreadId?: string;
			reasoningEffortContainer?: HTMLElement;
			reasoningEffortSelect?: HTMLSelectElement;
			modelSelectionService: {
				getCurrentSelectionForThread: (threadId: string, location: 'chat') => { threadId?: string; location: 'chat'; modelIdentifier: string; vendor: string; modelId: string; modelName: string; reasoningEffort?: string; selectedAt: number } | undefined;
				setSelectionForThread: (threadId: string, selection: unknown) => Promise<void>;
			};
			modelCatalogService: {
				getModel: (modelIdentifier: string) => { reasoningEffortLevels?: readonly string[]; defaultReasoningEffort?: string };
			};
			getCurrentComposerModelSelection: (threadId: string | undefined) => unknown;
			refreshReasoningEffortControl: () => void;
			updateReasoningEffortSelection: () => Promise<void>;
		};
		const selectedModel: {
			threadId: string;
			location: 'chat';
			modelIdentifier: string;
			vendor: string;
			modelId: string;
			modelName: string;
			reasoningEffort?: 'low' | 'high';
			selectedAt: number;
		} = {
			threadId: 'thread-1',
			location: 'chat' as const,
			modelIdentifier: 'openai/gpt-5.3-codex',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelName: 'GPT-5.3-Codex',
			reasoningEffort: 'low' as const,
			selectedAt: 1,
		};
		let persistedSelection: unknown;
		pane.activeThreadId = 'thread-1';
		pane.reasoningEffortContainer = document.createElement('div');
		pane.reasoningEffortContainer.classList.add('hidden');
		pane.reasoningEffortSelect = document.createElement('select');
		pane.reasoningEffortSelect.value = 'high';
		pane.modelSelectionService = {
			getCurrentSelectionForThread: () => selectedModel,
			setSelectionForThread: async (_threadId: string, selection: unknown) => {
				persistedSelection = selection;
			},
		};
		pane.modelCatalogService = {
			getModel: () => ({
				reasoningEffortLevels: ['low', 'high'],
				defaultReasoningEffort: 'high',
			}),
		};

		pane.refreshReasoningEffortControl();
		assert.deepStrictEqual(pane.getCurrentComposerModelSelection('thread-1'), {
			...selectedModel,
			threadId: 'thread-1',
			reasoningEffort: 'low',
		});

		pane.reasoningEffortSelect.value = 'high';
		assert.deepStrictEqual(pane.getCurrentComposerModelSelection('thread-1'), {
			...selectedModel,
			threadId: 'thread-1',
			reasoningEffort: 'high',
		});

		pane.reasoningEffortSelect.value = 'bogus';
		assert.deepStrictEqual(pane.getCurrentComposerModelSelection('thread-1'), {
			...selectedModel,
			threadId: 'thread-1',
			reasoningEffort: 'low',
		});

		(selectedModel as { reasoningEffort?: 'low' | 'high' | undefined }).reasoningEffort = undefined;
		pane.refreshReasoningEffortControl();
		assert.deepStrictEqual(pane.getCurrentComposerModelSelection('thread-1'), {
			...selectedModel,
			threadId: 'thread-1',
			reasoningEffort: 'high',
		});

		assert.strictEqual(pane.reasoningEffortContainer.classList.contains('hidden'), false);
		assert.deepStrictEqual(
			Array.from(pane.reasoningEffortSelect.options).map(option => [option.value, option.textContent]),
			[
				['low', 'Low'],
				['high', 'High'],
			],
		);
		assert.strictEqual(pane.reasoningEffortSelect.value, 'high');

		pane.reasoningEffortSelect.value = 'high';
		await pane.updateReasoningEffortSelection();
		assert.strictEqual((persistedSelection as { reasoningEffort?: string; location?: string; threadId?: string })?.reasoningEffort, 'high');
		assert.strictEqual((persistedSelection as { reasoningEffort?: string; location?: string; threadId?: string })?.location, 'chat');
		assert.strictEqual((persistedSelection as { reasoningEffort?: string; location?: string; threadId?: string })?.threadId, 'thread-1');
		assert.strictEqual((persistedSelection as { selectedAt?: number } | undefined)?.selectedAt !== undefined, true);

		persistedSelection = undefined;
		selectedModel.reasoningEffort = 'high';
		await pane.updateReasoningEffortSelection();
		assert.strictEqual(persistedSelection, undefined);

		pane.modelSelectionService.getCurrentSelectionForThread = () => undefined;
		pane.refreshReasoningEffortControl();
		assert.strictEqual(pane.reasoningEffortContainer.classList.contains('hidden'), true);
		assert.strictEqual(pane.reasoningEffortSelect.options.length, 0);
	});

	test('composer state and layout helpers respond to missing models and active threads', () => {
		const pane = createPaneHarness() as unknown as {
			activeThreadId?: string;
			historyReady: boolean;
			submittingPrompt: boolean;
			isCompactLayout: boolean;
			rootContainer: HTMLElement;
			composerInput: HTMLTextAreaElement;
			composerSendButton: HTMLButtonElement;
			reasoningEffortContainer: HTMLElement;
			reasoningEffortSelect: HTMLSelectElement;
			planModeContainer: HTMLElement;
			planModeSwitchButton: HTMLButtonElement;
			addContextMenuToggle: HTMLElement;
			getBusyThreadId: () => string | undefined;
			getCurrentComposerModelSelection: (threadId: string | undefined) => unknown;
			getCurrentComposerMode: () => 'act' | 'plan';
			updateComposerState: () => void;
			applyResponsiveLayout: (width: number) => void;
		};
		pane.activeThreadId = 'thread-1';
		pane.historyReady = true;
		pane.submittingPrompt = false;
		pane.rootContainer = document.createElement('div');
		pane.composerInput = document.createElement('textarea');
		pane.composerInput.value = 'ask';
		pane.composerSendButton = document.createElement('button');
		pane.reasoningEffortContainer = document.createElement('div');
		pane.reasoningEffortContainer.classList.add('hidden');
		pane.reasoningEffortSelect = document.createElement('select');
		pane.planModeContainer = document.createElement('div');
		pane.planModeSwitchButton = document.createElement('button');
		pane.addContextMenuToggle = document.createElement('span');
		pane.getBusyThreadId = () => undefined;
		pane.getCurrentComposerModelSelection = () => undefined;
		pane.getCurrentComposerMode = () => 'act';

		pane.updateComposerState();
		assert.strictEqual(pane.composerSendButton.disabled, true);
		assert.strictEqual(pane.composerInput.disabled, false);
		assert.strictEqual(
			pane.composerInput.placeholder,
			'Sign in to a provider and choose a model to start chatting...',
		);
		assert.strictEqual(pane.reasoningEffortSelect.disabled, true);
		assert.strictEqual(pane.planModeSwitchButton.getAttribute('aria-checked'), 'false');
		assert.strictEqual(pane.addContextMenuToggle.classList.contains('active'), false);

		pane.getCurrentComposerModelSelection = () => ({ modelIdentifier: 'openai/gpt-5.3-codex' });
		pane.reasoningEffortContainer.classList.remove('hidden');
		pane.getCurrentComposerMode = () => 'plan';
		pane.updateComposerState();
		assert.strictEqual(pane.composerSendButton.disabled, false);
		assert.strictEqual(pane.composerInput.disabled, false);
		assert.strictEqual(pane.composerSendButton.classList.contains('stop-mode'), false);
		assert.strictEqual(pane.composerSendButton.title, 'Send message');
		assert.strictEqual(pane.composerInput.placeholder, 'Type your prompt here...');
		assert.strictEqual(pane.reasoningEffortSelect.disabled, false);
		assert.strictEqual(pane.planModeSwitchButton.classList.contains('checked'), true);
		assert.strictEqual(pane.planModeSwitchButton.getAttribute('aria-checked'), 'true');
		assert.strictEqual(pane.addContextMenuToggle.classList.contains('active'), true);

		pane.applyResponsiveLayout(800);
		assert.strictEqual((pane as { isCompactLayout: boolean }).isCompactLayout, true);
		assert.strictEqual(pane.rootContainer.classList.contains('compact-layout'), true);
		pane.applyResponsiveLayout(1000);
		assert.strictEqual((pane as { isCompactLayout: boolean }).isCompactLayout, false);
		assert.strictEqual(pane.rootContainer.classList.contains('compact-layout'), false);
	});

	test('history helpers resolve busy state, cached threads, and thread switcher context', () => {
		const pane = createPaneHarness() as unknown as {
			activeThreadId?: string;
			historyService: {
				getTurns: (threadId: string) => Array<{ status: 'pending' | 'streaming' | 'completed' }>;
				getThreads: (query: { includeArchived: boolean }) => Array<{ threadId: string; archived: boolean }>;
				deleteThread: (threadId: string) => Promise<void>;
			};
			threadsById: Map<string, { threadId: string; archived: boolean }>;
			rail: {
				getSelectedThread: () => string | undefined;
				getFilterState: () => { query: string; tab: 'all' | 'active' | 'archived' };
				setRows: (rows: Array<{ threadId: string; selected: boolean }>) => void;
				setSelectedThread: (threadId: string | undefined) => void;
			};
			getBusyThreadId: () => string | undefined;
			resolveThreadById: (threadId: string) => { threadId: string; archived: boolean } | undefined;
			getModelSwitcherContext: () => { threadId: string; location: 'chat' };
			refreshRailRows: () => void;
			historyReady: boolean;
		};
		const cachedThread = { threadId: 'thread-1', archived: false };
		const archivedThread = { threadId: 'thread-archived', archived: true };
		let capturedQuery: { includeArchived: boolean } | undefined;
		let selectedThread: string | undefined;
		let capturedRows: Array<{ threadId: string; selected: boolean }> | undefined;

		pane.activeThreadId = 'thread-1';
		pane.historyService = {
			getTurns: (threadId: string) => threadId === 'thread-1'
				? [{ status: 'pending' }, { status: 'streaming' }]
				: [{ status: 'completed' }],
			getThreads: (query: { includeArchived: boolean }) => {
				capturedQuery = query;
				return [cachedThread, archivedThread];
			},
			deleteThread: async () => undefined,
		};
		pane.threadsById = new Map([['thread-1', cachedThread]]);
		pane.rail = {
			getSelectedThread: () => 'thread-rail',
			getFilterState: () => ({ query: 'bug', tab: 'all' }),
			setRows: (rows: Array<{ threadId: string; selected: boolean }>) => {
				capturedRows = rows;
			},
			setSelectedThread: (threadId: string | undefined) => {
				selectedThread = threadId;
			},
		};

		assert.strictEqual(pane.getBusyThreadId(), 'thread-1');
		pane.activeThreadId = 'thread-2';
		assert.strictEqual(pane.getBusyThreadId(), undefined);

		assert.strictEqual(pane.resolveThreadById('thread-1'), cachedThread);
		assert.strictEqual(pane.resolveThreadById('thread-archived'), archivedThread);
		assert.deepStrictEqual(pane.getModelSwitcherContext(), { threadId: 'thread-2', location: 'chat' });

		pane.historyReady = true;
		pane.activeThreadId = 'thread-1';
		pane.refreshRailRows();
		assert.deepStrictEqual(capturedQuery, { text: 'bug', tab: 'all', includeArchived: true });
		assert.strictEqual(pane.threadsById.get('thread-1'), cachedThread);
		assert.strictEqual(pane.threadsById.get('thread-archived'), archivedThread);
		assert.strictEqual(selectedThread, 'thread-1');
		assert.strictEqual(capturedRows?.[0].selected, true);
	});

	test('reloadHistory, render fallback, and composer reset branches update the pane state consistently', async () => {
		const pane = createPaneHarness() as unknown as {
			rootContainer: HTMLElement;
			railVisible: boolean;
			rail: {
				setLoading: () => void;
				setError: (message: string) => void;
				setSelectedThread: (threadId: string | undefined) => void;
			};
			historyReady: boolean;
			historyService: { initialize: () => Promise<void>; deleteThread?: (threadId: string) => Promise<void> };
			planModeService: { initialize: () => Promise<void> };
			reloadHistory: () => Promise<void>;
			refreshRailRows: () => void;
			refreshConversation: () => void;
			applyRailLayout: () => void;
			focusInput: () => void;
			renderConversationFallback: (parent: HTMLElement) => void;
			showComposerForNewChat: () => void;
			deleteThread: (threadId: string) => Promise<void>;
			refreshPlanModeControl: () => void;
			refreshModelControls: () => void;
			activeThreadId?: string;
			sessionService: { cancelThread: (threadId: string) => void };
		};
		let loadingCalls = 0;
		let errorMessage: string | undefined;
		let railSelection: string | undefined = 'thread-1';
		let refreshRailRowsCalls = 0;
		let refreshConversationCalls = 0;
		let applyRailLayoutCalls = 0;
		let focusInputCalls = 0;
		let refreshPlanModeControlCalls = 0;
		let refreshModelControlsCalls = 0;
		let cancelThreadId: string | undefined;
		let deletedThreadId: string | undefined;
		const root = document.createElement('div');

		pane.rootContainer = root;
		pane.railVisible = true;
		pane.rail = {
			setLoading: () => {
				loadingCalls += 1;
			},
			setError: (message: string) => {
				errorMessage = message;
			},
			setSelectedThread: (threadId: string | undefined) => {
				railSelection = threadId;
			},
		};
		pane.historyReady = false;
		pane.historyService = {
			initialize: async () => undefined,
		};
		pane.planModeService = {
			initialize: async () => undefined,
		};
		pane.refreshRailRows = () => {
			refreshRailRowsCalls += 1;
		};
		pane.refreshConversation = () => {
			refreshConversationCalls += 1;
		};
		pane.applyRailLayout = () => {
			applyRailLayoutCalls += 1;
		};
		pane.focusInput = () => {
			focusInputCalls += 1;
		};
		pane.refreshPlanModeControl = () => {
			refreshPlanModeControlCalls += 1;
		};
		pane.refreshModelControls = () => {
			refreshModelControlsCalls += 1;
		};
		pane.renderConversationFallback(root);
		assert.strictEqual(root.querySelector('.vsclone-thread-empty-state')?.textContent, 'Failed to render the chat UI. Reload the window and try again.');

		await pane.reloadHistory();
		assert.strictEqual(loadingCalls, 1);
		assert.strictEqual((pane as { historyReady: boolean }).historyReady, true);
		assert.strictEqual(refreshRailRowsCalls, 1);
		assert.strictEqual(refreshConversationCalls, 1);
		assert.strictEqual((pane as { railVisible: boolean }).railVisible, false);
		assert.strictEqual(applyRailLayoutCalls, 1);

		pane.historyService = {
			initialize: async () => {
				throw new Error('boom');
			},
		};
		await pane.reloadHistory();
		assert.strictEqual(errorMessage, 'Failed to load chat history. Please try again.');
		assert.strictEqual((pane as { historyReady: boolean }).historyReady, false);

		pane.activeThreadId = 'thread-1';
		refreshPlanModeControlCalls = 0;
		refreshModelControlsCalls = 0;
		refreshConversationCalls = 0;
		applyRailLayoutCalls = 0;
		focusInputCalls = 0;
		railSelection = 'thread-1';
		pane.railVisible = true;
		pane.sessionService = {
			cancelThread: (threadId: string) => {
				cancelThreadId = threadId;
			},
		};
		pane.historyService = {
			initialize: async () => undefined,
			deleteThread: async (threadId: string) => {
				deletedThreadId = threadId;
			},
		};
		(pane as unknown as { showComposerForNewChat: () => void }).showComposerForNewChat();
		assert.strictEqual((pane as { activeThreadId?: string }).activeThreadId, undefined);
		assert.strictEqual(railSelection, undefined);
		assert.strictEqual((pane as { railVisible: boolean }).railVisible, false);
		assert.strictEqual(refreshPlanModeControlCalls, 1);
		assert.strictEqual(refreshModelControlsCalls, 1);
		assert.strictEqual(refreshConversationCalls, 1);
		assert.strictEqual(applyRailLayoutCalls, 1);
		assert.strictEqual(focusInputCalls, 1);

		pane.activeThreadId = 'thread-1';
		pane.railVisible = true;
		refreshRailRowsCalls = 0;
		refreshPlanModeControlCalls = 0;
		refreshModelControlsCalls = 0;
		refreshConversationCalls = 0;
		applyRailLayoutCalls = 0;
		focusInputCalls = 0;
		railSelection = 'thread-1';
		pane.refreshRailRows = () => {
			refreshRailRowsCalls += 1;
		};
		await pane.deleteThread('thread-1');
		assert.strictEqual(cancelThreadId, 'thread-1');
		assert.strictEqual(deletedThreadId, 'thread-1');
		assert.strictEqual((pane as { activeThreadId?: string }).activeThreadId, undefined);
		assert.strictEqual(railSelection, undefined);
		assert.strictEqual((pane as { railVisible: boolean }).railVisible, false);
		assert.strictEqual(refreshRailRowsCalls, 1);
		assert.strictEqual(refreshPlanModeControlCalls, 1);
		assert.strictEqual(refreshModelControlsCalls, 2);
		assert.strictEqual(refreshConversationCalls, 2);
		assert.strictEqual(applyRailLayoutCalls, 1);
		assert.strictEqual(focusInputCalls, 1);
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
		const imageStrip = parent.querySelector('.vsclone-composer-image-strip') as HTMLElement;
		const composerInput = parent.querySelector('.vsclone-thread-composer-input') as HTMLTextAreaElement;
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
				// The image strip stays mounted even while empty so pasted/selected images can appear
				// without replacing composer nodes and breaking focus/measurement bookkeeping.
				composerChildren: {
					imageStrip: Array.from(composer.children).indexOf(imageStrip),
					input: Array.from(composer.children).indexOf(composerInput),
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
					imageStrip: 0,
					input: 1,
					toolbar: 2,
					hint: 3,
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
		target.pendingImages = [{ mimeType: 'image/png', base64Data: 'ZmFrZQ==', dataUrl: 'data:image/png;base64,ZmFrZQ==' }];
		target.rail = { setSelectedThread: () => undefined };
		target.threadsById = new Map();
		target.historyService = { getThreads: () => [] };
		target.updateComposerState = () => undefined;
		target.updateComposerMetrics = () => undefined;
		target.renderImageStrip = () => undefined;
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
			initialize: async () => undefined,
			getCurrentSelectionForThread: () => selectedModel,
			setSelectionForThread: async (threadId: string) => { boundThreadId = threadId; },
		};
		target.planModeService = {
			initialize: async () => undefined,
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
		assert.deepStrictEqual(capturedOptions?.imageAttachments, [{ mimeType: 'image/png', base64Data: 'ZmFrZQ==' }]);
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
		// The prototype-only harness bypasses constructor field initialization, so tests that
		// exercise the apply-button branch need to seed the per-turn state map explicitly.
		target.editApplyStateByTurnId = new Map();
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

	test('user turns render persisted prompt images', () => {
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as IRenderUserMessageTarget;
		let previewDataUrl: string | undefined;
		target.showImagePreviewOverlay = dataUrl => {
			previewDataUrl = dataUrl;
		};

		const rendered = target.renderUserMessage({
			turnId: 'turn-image',
			threadId: 'thread-image',
			sequence: 1,
			promptText: 'Describe this image',
			promptImages: [{ mimeType: 'image/png', base64Data: 'ZmFrZQ==' }],
			responseMarkdown: '',
			responsePlainText: '',
			startedAt: 1,
			status: 'pending',
		});

		const thumb = rendered.querySelector('.vsclone-thread-image-thumb') as HTMLButtonElement;
		const image = rendered.querySelector('.vsclone-thread-image-thumb-img') as HTMLImageElement;
		assert.ok(thumb);
		assert.strictEqual(image.src, 'data:image/png;base64,ZmFrZQ==');

		thumb.click();
		assert.strictEqual(previewDataUrl, 'data:image/png;base64,ZmFrZQ==');
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
