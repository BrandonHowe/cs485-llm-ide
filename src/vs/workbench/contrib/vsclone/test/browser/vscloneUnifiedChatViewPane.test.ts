/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
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

interface IRenderRuntimeAssistantMessageTarget {
	[key: string]: unknown;
	renderRuntimeAssistantMessage: (message: { id?: string; role: 'assistant'; createdAt: number; content: string; metadata?: { importedFromHistory?: boolean } }, threadId?: string) => HTMLElement;
	renderSearchReplaceAwareText: (container: HTMLElement, text: string, streaming: boolean) => void;
	appendMarkdownSegment: (container: HTMLElement, text: string, className: string) => void;
	looksLikePartialSearchReplaceBlock: (text: string) => boolean;
	threadRuntimeService?: {
		getState: (threadId: string) => unknown;
		getAssistantEditApplicationState?: (threadId: string, messageId: string) => unknown;
		setAssistantEditApplicationState?: (threadId: string, messageId: string, state: unknown) => void;
	};
}

interface IRenderUserMessageTarget {
	[key: string]: unknown;
	renderUserMessage: (turn: IVSCloneChatHistoryTurn) => HTMLElement;
	showImagePreviewOverlay: (dataUrl: string) => void;
}

interface IConversationActionTarget {
	[key: string]: unknown;
	activeThreadId?: string;
	composerInput: HTMLTextAreaElement;
	pendingImages: unknown[];
	clipboardService: { writeText: (text: string) => Promise<void> };
	threadRuntimeService: {
		getState: (threadId: string) => {
			threadId: string;
			streamState: { kind: 'idle' | 'llm' | 'tool' | 'awaiting_user' };
			messages: Array<{
				role: 'user' | 'assistant';
				content: string;
				imageAttachments?: Array<{ mimeType: string; base64Data: string }>;
			}>;
			checkpoints: Array<unknown>;
			isRunning: boolean;
			lastUpdatedAt: number;
		} | undefined;
		ensureHydratedFromHistory?: (threadId: string, turns: IVSCloneChatHistoryTurn[]) => {
			threadId: string;
			streamState: { kind: 'idle' | 'llm' | 'tool' | 'awaiting_user' };
			messages: Array<{
				role: 'user' | 'assistant';
				content: string;
				imageAttachments?: Array<{ mimeType: string; base64Data: string }>;
			}>;
			checkpoints: Array<unknown>;
			isRunning: boolean;
			lastUpdatedAt: number;
		} | undefined;
	};
	historyService: {
		getTurns: (threadId: string) => IVSCloneChatHistoryTurn[];
	};
	rail: {
		getSelectedThread: () => string | undefined;
	};
	toPendingImages: (attachments: Array<{ mimeType: string; base64Data: string }> | undefined) => unknown[];
	renderImageStrip: () => void;
	updateComposerMetrics: () => void;
	focusInput: () => void;
	copyPrompt: (threadId?: string) => Promise<void>;
	copyResponse: (threadId?: string) => Promise<void>;
	reusePrompt: (threadId?: string) => void;
}

interface IRefreshConversationTarget {
	[key: string]: unknown;
	activeThreadId?: string;
	conversationList: HTMLElement;
	conversationEmptyState: HTMLElement;
	historyService: {
		getTurns: (threadId: string) => IVSCloneChatHistoryTurn[];
	};
	threadRuntimeService: {
		getState: (threadId: string) => {
			threadId: string;
			streamState: { kind: 'idle' | 'llm' | 'tool' | 'awaiting_user'; toolName?: string; approvalType?: 'edits' | 'terminal' | 'MCP tools' };
			messages: Array<{
				role: 'user' | 'assistant' | 'tool' | 'checkpoint';
				type?: 'tool_request' | 'running_now' | 'success' | 'tool_error' | 'rejected';
				toolName?: string;
				approvalType?: 'edits' | 'terminal' | 'MCP tools';
				params?: Record<string, string>;
				output?: string;
				content?: string;
				imageAttachments?: Array<{ mimeType: string; base64Data: string }>;
				checkpoint?: { id: string; createdAt: number; type: 'tool_edit'; toolName: string; snapshots: Array<{ uri: { toString(): string }; existed: boolean; content: string | undefined }> };
			}>;
			assistantEditApplications?: Array<{ messageId: string; state: unknown }>;
			checkpoints: Array<unknown>;
			isRunning: boolean;
			lastUpdatedAt: number;
		} | undefined;
		ensureHydratedFromHistory?: (threadId: string, turns: IVSCloneChatHistoryTurn[]) => {
			threadId: string;
			streamState: { kind: 'idle' | 'llm' | 'tool' | 'awaiting_user'; toolName?: string; approvalType?: 'edits' | 'terminal' | 'MCP tools' };
			messages: Array<{
				role: 'user' | 'assistant' | 'tool' | 'checkpoint';
				content?: string;
				imageAttachments?: Array<{ mimeType: string; base64Data: string }>;
				type?: 'tool_request' | 'running_now' | 'success' | 'tool_error' | 'rejected';
				toolName?: string;
				approvalType?: 'edits' | 'terminal' | 'MCP tools';
				params?: Record<string, string>;
				output?: string;
				checkpoint?: { id: string; createdAt: number; type: 'tool_edit'; toolName: string; snapshots: Array<{ uri: { toString(): string }; existed: boolean; content: string | undefined }> };
			}>;
			assistantEditApplications?: Array<{ messageId: string; state: unknown }>;
			checkpoints: Array<unknown>;
			isRunning: boolean;
			lastUpdatedAt: number;
		} | undefined;
		approveLatestToolRequest?: (threadId: string) => boolean;
		rejectLatestToolRequest?: (threadId: string, reason: string) => boolean;
		rewindToCheckpoint?: (threadId: string, checkpointId: string) => Promise<boolean>;
		getAssistantEditApplicationState?: (threadId: string, messageId: string) => unknown;
		setAssistantEditApplicationState?: (threadId: string, messageId: string, state: unknown) => void;
	};
	renderedMarkdownDisposables: { clear: () => void; add: (value: unknown) => unknown };
	markdownRendererService: ReturnType<typeof createPlainTextMarkdownRendererStub>;
	updateComposerState: () => void;
	refreshModelControls: () => void;
	scheduleScrollToBottom: () => void;
	refreshConversation: () => void;
}

interface IHandleHistoryChangeTarget {
	[key: string]: unknown;
	historyReady: boolean;
	activeThreadId?: string;
	historyService: {
		getTurns: (threadId: string) => IVSCloneChatHistoryTurn[];
	};
	handleHistoryChange: (event: { reason: 'turnUpdate' | 'clear'; threadIds: readonly string[] }) => void;
	seedThreadCatalogFromHistory: (event?: { reason?: 'turnUpdate' | 'clear'; threadIds?: readonly string[] }) => void;
	refreshConversationScheduler: { schedule: (delay?: number) => void };
	refreshRailScheduler: { schedule: (delay?: number) => void };
	maybeAutoApplyCompletedTurns: () => void;
	ensureRuntimeThreadImportedFromHistory: (threadId: string | undefined) => unknown;
}

interface IRunAutoApplyTarget {
	[key: string]: unknown;
	runAutoApply: (target: { threadId: string; id: string; responseText: string }, responseText: string) => Promise<void>;
	editApplicationService: {
		startApplyingSearchReplaceBlocks: (responseText: string) => Promise<{
			attemptedEdits: number;
			appliedEdits: number;
			modifiedFiles: readonly unknown[];
			failures: readonly string[];
			fileChanges: readonly unknown[];
		}>;
		applySearchReplaceBlocks: (responseText: string) => Promise<unknown>;
	};
	notificationService: {
		info: (message: string) => void;
		warn: (message: string) => void;
		error: (message: string) => void;
	};
	setAssistantApplyState: (target: { threadId: string; id: string; responseText: string }, state: unknown) => void;
	refreshConversation: () => void;
}

interface IRenderRuntimeCheckpointTarget {
	[key: string]: unknown;
	renderRuntimeCheckpointMessage: (
		threadId: string,
		checkpoint: {
			id: string;
			createdAt: number;
			type: 'tool_edit';
			toolName: string;
			snapshots: Array<{ uri: { toString(): string }; existed: boolean; content: string | undefined }>;
		},
		threadIsRunning: boolean,
	) => HTMLElement;
	threadRuntimeService: {
		rewindToCheckpoint: (threadId: string, checkpointId: string) => Promise<boolean>;
		getState?: (threadId: string) => { isRunning: boolean } | undefined;
	};
	notificationService: {
		info: (message: string) => void;
		warn: (message: string) => void;
		error: (message: string) => void;
	};
	refreshConversation: () => void;
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
	const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane & {
		deletedLegacyThreadIds: Set<string>;
		pendingAssistantApplyMessageIds: Set<string>;
		importingRuntimeThreadIds: Set<string>;
		notificationService: { error: (message: string) => void };
		threadsById: Map<string, unknown>;
	};
	pane.deletedLegacyThreadIds = new Set();
	pane.pendingAssistantApplyMessageIds = new Set();
	pane.importingRuntimeThreadIds = new Set();
	pane.notificationService = { error: () => undefined };
	pane.threadsById = new Map();
	return pane;
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

	test('openSession keeps runtime-owned empty threads on the runtime-only read path', async () => {
		let selectedThread: string | undefined;
		let focusInputCalled = false;
		let getTurnsCalls = 0;
		let hydrateCalls = 0;

		const pane = createPaneHarness() as unknown as ITestPaneTarget & {
			refreshPlanModeControl: () => void;
			refreshModelControls: () => void;
			historyService: {
				getTurns: (threadId: string) => IVSCloneChatHistoryTurn[];
			};
			threadRuntimeService: {
				getState: (threadId: string) => unknown;
				ensureHydratedFromHistory: (threadId: string, turns: IVSCloneChatHistoryTurn[]) => unknown;
			};
		};
		pane.railVisible = true;
		pane.isCompactLayout = false;
		pane.rootContainer = document.createElement('div');
		pane.railContainer = document.createElement('div');
		pane.railResizeHandle = document.createElement('div');
		pane.threadsById = new Map([
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
		pane.rail = {
			getSelectedThread: () => selectedThread,
			setSelectedThread: (threadId: string | undefined) => { selectedThread = threadId; },
		};
		pane.historyService = {
			getTurns: () => {
				getTurnsCalls += 1;
				throw new Error('runtime-owned openSession should not read legacy turns');
			},
		};
		pane.threadRuntimeService = {
			getState: threadId => threadId === 'thread-1' ? {
				threadId,
				streamState: { kind: 'idle' },
				messages: [],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 2,
			} : undefined,
			ensureHydratedFromHistory: () => {
				hydrateCalls += 1;
				throw new Error('runtime-owned openSession should not trigger history hydration');
			},
		};
		pane.refreshConversation = () => undefined;
		pane.refreshPlanModeControl = () => undefined;
		pane.refreshModelControls = () => undefined;
		pane.focusInput = () => { focusInputCalled = true; };
		pane.applyRailLayout = () => undefined;

		await pane.openSession('thread-1');

		assert.strictEqual(pane.activeThreadId, 'thread-1');
		assert.strictEqual(selectedThread, 'thread-1');
		assert.strictEqual(focusInputCalled, true);
		assert.strictEqual(getTurnsCalls, 0);
		assert.strictEqual(hydrateCalls, 0);
	});

	test('openSession does not import runtime-owned threads when runtime state is missing', async () => {
		let selectedThread: string | undefined;
		let getTurnsCalls = 0;
		let hydrateCalls = 0;

		const pane = createPaneHarness() as unknown as ITestPaneTarget & {
			refreshPlanModeControl: () => void;
			refreshModelControls: () => void;
			historyService: {
				getTurns: (threadId: string) => IVSCloneChatHistoryTurn[];
			};
			threadRuntimeService: {
				getState: (threadId: string) => unknown;
				ensureHydratedFromHistory: (threadId: string, turns: IVSCloneChatHistoryTurn[]) => unknown;
			};
			threadsById: Map<string, {
				threadId: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'completed';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
				runtimeOwnedCatalog?: boolean;
			}>;
		};
		pane.railVisible = true;
		pane.isCompactLayout = false;
		pane.rootContainer = document.createElement('div');
		pane.railContainer = document.createElement('div');
		pane.railResizeHandle = document.createElement('div');
		pane.threadsById = new Map([
			['thread-runtime', {
				threadId: 'thread-runtime',
				title: 'Runtime thread',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 0,
				lastTurnPreview: '',
				runtimeOwnedCatalog: true,
			}],
		]);
		pane.rail = {
			getSelectedThread: () => selectedThread,
			setSelectedThread: (threadId: string | undefined) => { selectedThread = threadId; },
		};
		pane.historyService = {
			getTurns: () => {
				getTurnsCalls += 1;
				throw new Error('runtime-owned openSession should not reconstruct from legacy history when runtime state is missing');
			},
		};
		pane.threadRuntimeService = {
			getState: () => undefined,
			ensureHydratedFromHistory: () => {
				hydrateCalls += 1;
				throw new Error('runtime-owned openSession should not trigger legacy hydration when runtime state is missing');
			},
		};
		pane.refreshConversation = () => undefined;
		pane.refreshPlanModeControl = () => undefined;
		pane.refreshModelControls = () => undefined;
		pane.focusInput = () => undefined;
		pane.applyRailLayout = () => undefined;

		await pane.openSession('thread-runtime');

		assert.strictEqual(pane.activeThreadId, 'thread-runtime');
		assert.strictEqual(selectedThread, 'thread-runtime');
		assert.strictEqual(getTurnsCalls, 0);
		assert.strictEqual(hydrateCalls, 0);
	});

	test('openSession refuses to activate a legacy-only thread when explicit import cannot produce runtime state', async () => {
		let selectedThread: string | undefined = 'thread-runtime';
		let getTurnsCalls = 0;
		let refreshConversationCalls = 0;
		let showComposerCalls = 0;

		const pane = createPaneHarness() as unknown as ITestPaneTarget & {
			refreshPlanModeControl: () => void;
			refreshModelControls: () => void;
			showComposerForNewChat: () => void;
			historyService: {
				getTurns: (threadId: string) => IVSCloneChatHistoryTurn[];
			};
			threadRuntimeService: {
				getState: (threadId: string) => unknown;
				ensureHydratedFromHistory: (threadId: string, turns: IVSCloneChatHistoryTurn[]) => unknown;
			};
			threadsById: Map<string, {
				threadId: string;
				runtimeOwnedCatalog?: boolean;
			}>;
		};
		pane.activeThreadId = 'thread-runtime';
		pane.railVisible = true;
		pane.isCompactLayout = false;
		pane.rootContainer = document.createElement('div');
		pane.railContainer = document.createElement('div');
		pane.railResizeHandle = document.createElement('div');
		pane.threadsById = new Map([
			['thread-runtime', {
				threadId: 'thread-runtime',
				runtimeOwnedCatalog: true,
			}],
			['thread-legacy', {
				threadId: 'thread-legacy',
				runtimeOwnedCatalog: false,
			}],
		]);
		pane.rail = {
			getSelectedThread: () => selectedThread,
			setSelectedThread: (threadId: string | undefined) => { selectedThread = threadId; },
		};
		pane.historyService = {
			getTurns: (threadId: string) => {
				getTurnsCalls += 1;
				assert.strictEqual(threadId, 'thread-legacy');
				return [{
					turnId: 'thread-legacy:turn-1',
					threadId: 'thread-legacy',
					sequence: 1,
					promptText: 'Legacy prompt',
					responseMarkdown: 'Legacy response',
					responsePlainText: 'Legacy response',
					startedAt: 1,
					status: 'completed',
					lastEventAt: 1,
				} as IVSCloneChatHistoryTurn];
			},
		};
		pane.threadRuntimeService = {
			getState: threadId => threadId === 'thread-runtime' ? {
				threadId,
				streamState: { kind: 'idle' },
				messages: [],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 2,
			} : undefined,
			ensureHydratedFromHistory: () => undefined,
		};
		pane.refreshConversation = () => {
			refreshConversationCalls += 1;
		};
		pane.refreshPlanModeControl = () => undefined;
		pane.refreshModelControls = () => undefined;
		pane.showComposerForNewChat = () => {
			showComposerCalls += 1;
			pane.activeThreadId = undefined;
			pane.rail.setSelectedThread(undefined);
		};
		pane.focusInput = () => undefined;
		pane.applyRailLayout = () => undefined;

		await pane.openSession('thread-legacy');

		assert.strictEqual(getTurnsCalls, 1);
		assert.strictEqual(refreshConversationCalls, 0);
		assert.strictEqual(showComposerCalls, 0);
		assert.strictEqual(pane.activeThreadId, 'thread-runtime');
		assert.strictEqual(selectedThread, 'thread-runtime');
	});

	test('openSession restores the previous rail selection when a legacy-only import fails', async () => {
		let selectedThread: string | undefined = 'thread-runtime';

		const pane = createPaneHarness() as unknown as ITestPaneTarget & {
			refreshPlanModeControl: () => void;
			refreshModelControls: () => void;
			historyService: {
				getTurns: (threadId: string) => IVSCloneChatHistoryTurn[];
			};
			threadRuntimeService: {
				getState: (threadId: string) => unknown;
				ensureHydratedFromHistory: (threadId: string, turns: IVSCloneChatHistoryTurn[]) => unknown;
			};
			threadsById: Map<string, {
				threadId: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'completed';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
				runtimeOwnedCatalog?: boolean;
			}>;
		};
		pane.activeThreadId = 'thread-runtime';
		pane.railVisible = true;
		pane.isCompactLayout = false;
		pane.rootContainer = document.createElement('div');
		pane.railContainer = document.createElement('div');
		pane.railResizeHandle = document.createElement('div');
		pane.threadsById = new Map([
			['thread-runtime', {
				threadId: 'thread-runtime',
				title: 'Runtime thread',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Runtime response',
				runtimeOwnedCatalog: true,
			}],
			['thread-legacy', {
				threadId: 'thread-legacy',
				title: 'Legacy thread',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Legacy response',
				runtimeOwnedCatalog: false,
			}],
		]);
		pane.rail = {
			getSelectedThread: () => selectedThread,
			setSelectedThread: (threadId: string | undefined) => { selectedThread = threadId; },
		};
		pane.historyService = {
			getTurns: () => [{
				turnId: 'thread-legacy:turn-1',
				threadId: 'thread-legacy',
				sequence: 1,
				promptText: 'Legacy prompt',
				responseMarkdown: 'Legacy response',
				responsePlainText: 'Legacy response',
				startedAt: 1,
				status: 'completed',
				lastEventAt: 1,
			} as IVSCloneChatHistoryTurn],
		};
		pane.threadRuntimeService = {
			getState: threadId => threadId === 'thread-runtime' ? {
				threadId,
				catalog: {
					threadId,
					title: 'Runtime thread',
					createdAt: 1,
					updatedAt: 2,
					status: 'completed',
					archived: false,
					turnCount: 1,
					lastTurnPreview: 'Runtime response',
				},
				streamState: { kind: 'idle' },
				messages: [],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 2,
			} : undefined,
			ensureHydratedFromHistory: () => undefined,
		};
		pane.refreshConversation = () => undefined;
		pane.refreshPlanModeControl = () => undefined;
		pane.refreshModelControls = () => undefined;
		pane.focusInput = () => undefined;
		pane.applyRailLayout = () => undefined;

		await pane.openSession('thread-legacy');

		assert.strictEqual(pane.activeThreadId, 'thread-runtime');
		assert.strictEqual(selectedThread, 'thread-runtime');
	});

	test('openSession upgrades a stale legacy-owned cache row when runtime state already exists', async () => {
		let selectedThread: string | undefined;
		let getTurnsCalls = 0;
		let hydrateCalls = 0;

		const pane = createPaneHarness() as unknown as ITestPaneTarget & {
			refreshPlanModeControl: () => void;
			refreshModelControls: () => void;
			historyService: {
				getTurns: (threadId: string) => IVSCloneChatHistoryTurn[];
			};
			threadRuntimeService: {
				getState: (threadId: string) => unknown;
				ensureHydratedFromHistory: (threadId: string, turns: IVSCloneChatHistoryTurn[]) => unknown;
			};
			threadsById: Map<string, {
				threadId: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'completed';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
				runtimeOwnedCatalog?: boolean;
			}>;
		};
		pane.railVisible = true;
		pane.isCompactLayout = false;
		pane.rootContainer = document.createElement('div');
		pane.railContainer = document.createElement('div');
		pane.railResizeHandle = document.createElement('div');
		pane.threadsById = new Map([
			['thread-legacy', {
				threadId: 'thread-legacy',
				title: 'Legacy thread',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Legacy response',
				runtimeOwnedCatalog: false,
			}],
		]);
		pane.rail = {
			getSelectedThread: () => selectedThread,
			setSelectedThread: (threadId: string | undefined) => { selectedThread = threadId; },
		};
		pane.historyService = {
			getTurns: () => {
				getTurnsCalls += 1;
				throw new Error('stale legacy cache upgrade should not reread history when runtime state already exists');
			},
		};
		pane.threadRuntimeService = {
			getState: threadId => threadId === 'thread-legacy' ? {
				threadId,
				catalog: {
					threadId,
					title: 'Runtime thread',
					createdAt: 1,
					updatedAt: 3,
					status: 'completed',
					archived: false,
					turnCount: 1,
					lastTurnPreview: 'Runtime response',
				},
				streamState: { kind: 'idle' },
				messages: [
					{ id: 'msg-user', role: 'user', createdAt: 1, content: 'Runtime prompt' },
					{ id: 'msg-assistant', role: 'assistant', createdAt: 2, content: 'Runtime response' },
				],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 3,
			} : undefined,
			ensureHydratedFromHistory: () => {
				hydrateCalls += 1;
				throw new Error('stale legacy cache upgrade should not rehydrate when runtime state already exists');
			},
		};
		pane.refreshConversation = () => undefined;
		pane.refreshPlanModeControl = () => undefined;
		pane.refreshModelControls = () => undefined;
		pane.focusInput = () => undefined;
		pane.applyRailLayout = () => undefined;

		await pane.openSession('thread-legacy');

		assert.strictEqual(pane.activeThreadId, 'thread-legacy');
		assert.strictEqual(selectedThread, 'thread-legacy');
		assert.strictEqual(getTurnsCalls, 0);
		assert.strictEqual(hydrateCalls, 0);
		assert.strictEqual(pane.threadsById.get('thread-legacy')?.runtimeOwnedCatalog, true);
	});

	test('history change events for the active thread do not trigger hidden runtime imports', () => {
		const pane = createPaneHarness() as unknown as IHandleHistoryChangeTarget;
		const seededEvents: Array<'turnUpdate' | 'clear' | undefined> = [];
		const conversationRefreshes: Array<number | undefined> = [];
		const railRefreshes: Array<number | undefined> = [];
		let autoApplyCalls = 0;
		let importCalls = 0;
		let getTurnsCalls = 0;

		pane.historyReady = true;
		pane.activeThreadId = 'thread-1';
		pane.historyService = {
			getTurns: () => {
				getTurnsCalls += 1;
				throw new Error('background history events should not read legacy turns');
			},
		};
		pane.seedThreadCatalogFromHistory = event => {
			seededEvents.push(event?.reason);
		};
		pane.refreshConversationScheduler = {
			schedule: (delay?: number) => {
				conversationRefreshes.push(delay);
			},
		};
		pane.refreshRailScheduler = {
			schedule: (delay?: number) => {
				railRefreshes.push(delay);
			},
		};
		pane.maybeAutoApplyCompletedTurns = () => {
			autoApplyCalls += 1;
		};
		pane.ensureRuntimeThreadImportedFromHistory = () => {
			importCalls += 1;
			throw new Error('background history events should not cross the explicit runtime import boundary');
		};

		pane.handleHistoryChange({ reason: 'turnUpdate', threadIds: ['thread-1'] });
		pane.handleHistoryChange({ reason: 'clear', threadIds: ['thread-1'] });

		// Background history churn may refresh the merged catalog and schedule UI work, but explicit
		// open/reload boundaries remain the only places allowed to import legacy turns into runtime.
		assert.deepStrictEqual(seededEvents, ['turnUpdate', 'clear']);
		assert.deepStrictEqual(conversationRefreshes, [24, 0]);
		assert.deepStrictEqual(railRefreshes, [undefined, 0]);
		assert.strictEqual(autoApplyCalls, 1);
		assert.strictEqual(importCalls, 0);
		assert.strictEqual(getTurnsCalls, 0);
	});

	test('background history events for other threads stay out of the active runtime read path', () => {
		const pane = createPaneHarness() as unknown as IHandleHistoryChangeTarget;
		const seededEvents: Array<'turnUpdate' | 'clear' | undefined> = [];
		const conversationRefreshes: Array<number | undefined> = [];
		const railRefreshes: Array<number | undefined> = [];
		let autoApplyCalls = 0;
		let importCalls = 0;
		let getTurnsCalls = 0;

		pane.historyReady = true;
		pane.activeThreadId = 'thread-1';
		pane.historyService = {
			getTurns: () => {
				getTurnsCalls += 1;
				throw new Error('off-thread history events should not read legacy turns');
			},
		};
		pane.seedThreadCatalogFromHistory = event => {
			seededEvents.push(event?.reason);
		};
		pane.refreshConversationScheduler = {
			schedule: (delay?: number) => {
				conversationRefreshes.push(delay);
			},
		};
		pane.refreshRailScheduler = {
			schedule: (delay?: number) => {
				railRefreshes.push(delay);
			},
		};
		pane.maybeAutoApplyCompletedTurns = () => {
			autoApplyCalls += 1;
		};
		pane.ensureRuntimeThreadImportedFromHistory = () => {
			importCalls += 1;
			throw new Error('off-thread history events should not cross the explicit runtime import boundary');
		};

		pane.handleHistoryChange({ reason: 'turnUpdate', threadIds: ['thread-2'] });
		pane.handleHistoryChange({ reason: 'clear', threadIds: ['thread-2'] });

		// Unrelated history churn may still update the merged rail cache, but it must not kick the
		// active thread back through history or re-run active-thread auto-apply logic by mistake.
		assert.deepStrictEqual(seededEvents, ['turnUpdate', 'clear']);
		assert.deepStrictEqual(conversationRefreshes, [0]);
		assert.deepStrictEqual(railRefreshes, [undefined, 0]);
		assert.strictEqual(autoApplyCalls, 0);
		assert.strictEqual(importCalls, 0);
		assert.strictEqual(getTurnsCalls, 0);
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
		const modal = container.querySelector('.vsclone-chat-history-delete-modal') as HTMLElement;
		const cancel = container.querySelector('.vsclone-chat-history-delete-cancel') as HTMLButtonElement;
		const confirm = container.querySelector('.vsclone-chat-history-delete-confirm') as HTMLButtonElement;
		assert.strictEqual(document.activeElement, cancel);

		// Tab and Shift+Tab should wrap inside the two modal action buttons.
		confirm.focus();
		modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
		assert.strictEqual(document.activeElement, cancel);
		cancel.focus();
		modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
		assert.strictEqual(document.activeElement, confirm);

		modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
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

	test('rail helpers resolve busy state, runtime catalog rows, and thread switcher context', () => {
		const pane = createPaneHarness() as unknown as {
			activeThreadId?: string;
			historyService: {
				getTurns: (threadId: string) => Array<{ status: 'pending' | 'streaming' | 'completed' }>;
			};
			threadRuntimeService: {
				getState: (threadId: string) => {
					threadId: string;
					isRunning: boolean;
					streamState: { kind: 'idle' | 'tool'; toolName?: string };
					messages: [];
					checkpoints: [];
					lastUpdatedAt: number;
				} | undefined;
				getThreads?: (query?: { includeArchived?: boolean }) => Array<{
					threadId: string;
					sessionResource: string;
					title: string;
					createdAt: number;
					updatedAt: number;
					status: 'active' | 'completed' | 'failed' | 'archived';
					archived: boolean;
					turnCount: number;
					lastTurnPreview: string;
				}>;
			};
			threadsById: Map<string, { threadId: string; archived: boolean; sessionResource?: string; title?: string; createdAt?: number; updatedAt?: number; status?: 'active' | 'completed' | 'failed' | 'archived'; turnCount?: number; lastTurnPreview?: string; runtimeOwnedCatalog?: boolean }>;
			rail: {
				getSelectedThread: () => string | undefined;
				getFilterState: () => { query: string; tab: 'all' | 'active' | 'archived' };
				setRows: (rows: Array<{ threadId: string; selected: boolean }>) => void;
				setSelectedThread: (threadId: string | undefined) => void;
			};
			getBusyThreadId: () => string | undefined;
			resolveThreadById: (threadId: string) => { threadId: string; archived: boolean; sessionResource?: string } | undefined;
			getModelSwitcherContext: () => { threadId: string; location: 'chat' };
			refreshRailRows: () => void;
			historyReady: boolean;
		};
		const cachedThread = { threadId: 'thread-1', archived: false, sessionResource: 'vsclone://api/thread-1', title: 'Thread 1 bug', createdAt: 1, updatedAt: 10, status: 'active' as const, turnCount: 2, lastTurnPreview: 'Runtime preview' };
		const archivedThread = { threadId: 'thread-archived', archived: true, sessionResource: 'vsclone://api/thread-archived', title: 'Archived thread', createdAt: 1, updatedAt: 5, status: 'archived' as const, turnCount: 1, lastTurnPreview: 'Older preview' };
		let capturedQuery: { includeArchived: boolean } | undefined;
		let selectedThread: string | undefined;
		let capturedRows: Array<{ threadId: string; selected: boolean }> | undefined;

		pane.activeThreadId = 'thread-1';
		pane.historyService = {
			getTurns: (threadId: string) => threadId === 'thread-1'
				? [{ status: 'pending' }, { status: 'streaming' }]
				: [{ status: 'completed' }],
		};
		pane.threadRuntimeService = {
			getState: (threadId: string) => threadId === 'thread-1'
				? {
					threadId,
					isRunning: true,
					streamState: { kind: 'tool', toolName: 'edit_file' },
					messages: [],
					checkpoints: [],
					lastUpdatedAt: 1,
				}
				: undefined,
			getThreads: (query?: { includeArchived?: boolean }) => {
				capturedQuery = { includeArchived: !!query?.includeArchived };
				return [cachedThread, archivedThread];
			},
		};
		pane.threadsById = new Map([
			['thread-1', cachedThread],
			['thread-archived', archivedThread],
		]);
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
		assert.deepStrictEqual(capturedQuery, { includeArchived: true });
		assert.deepStrictEqual(pane.threadsById.get('thread-1'), {
			...cachedThread,
			activeModelIdentifier: undefined,
			importedFromHistory: undefined,
			runtimeOwnedCatalog: true,
		});
		assert.deepStrictEqual(pane.threadsById.get('thread-archived'), {
			...archivedThread,
			activeModelIdentifier: undefined,
			importedFromHistory: undefined,
			runtimeOwnedCatalog: true,
		});
		assert.strictEqual(selectedThread, 'thread-1');
		assert.strictEqual(capturedRows?.[0].selected, true);
	});

	test('runtime-backed copy and reuse actions prefer runtime messages over stale history turns', async () => {
		const pane = createPaneHarness() as unknown as IConversationActionTarget;
		const clipboardWrites: string[] = [];
		let renderImageStripCalls = 0;
		let updateComposerMetricsCalls = 0;
		let focusInputCalls = 0;
		const promptImages = [{ mimeType: 'image/png', base64Data: 'ZmFrZQ==' }];
		pane.activeThreadId = 'thread-runtime';
		pane.composerInput = document.createElement('textarea');
		pane.pendingImages = [];
		pane.clipboardService = {
			writeText: async (text: string) => {
				clipboardWrites.push(text);
			},
		};
		// Runtime owns the active branch here, so any legacy history read would be a regression back
		// to the hybrid transcript model we are trying to delete.
		pane.historyService = {
			getTurns: () => {
				throw new Error('legacy history should not be consulted when runtime messages are present');
			},
		};
		pane.threadRuntimeService = {
			getState: () => ({
				threadId: 'thread-runtime',
				streamState: { kind: 'idle' },
				messages: [
					{
						role: 'user',
						content: 'Runtime prompt',
						imageAttachments: promptImages,
					},
					{
						role: 'assistant',
						content: [
							'Visible response.',
							'<tool_result tool_name="edit_file" success="true">Hidden tool output.</tool_result>',
							'Still visible.',
						].join('\n'),
					},
				],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 1,
			}),
		};
		pane.rail = {
			getSelectedThread: () => undefined,
		};
		pane.toPendingImages = attachments => attachments?.map((attachment, index) => ({ ...attachment, dataUrl: `data:${attachment.mimeType};base64,${index}` })) ?? [];
		pane.renderImageStrip = () => { renderImageStripCalls += 1; };
		pane.updateComposerMetrics = () => { updateComposerMetricsCalls += 1; };
		pane.focusInput = () => { focusInputCalls += 1; };

		await pane.copyPrompt();
		await pane.copyResponse();
		pane.reusePrompt();

		assert.deepStrictEqual(clipboardWrites, ['Runtime prompt', 'Visible response.\n\nStill visible.']);
		assert.strictEqual(pane.composerInput.value, 'Runtime prompt');
		assert.strictEqual(pane.pendingImages.length, 1);
		assert.strictEqual(renderImageStripCalls, 1);
		assert.strictEqual(updateComposerMetricsCalls, 1);
		assert.strictEqual(focusInputCalls, 1);
	});

	test('runtime-backed copy and reuse actions do not import legacy turns when runtime state is missing', async () => {
		const pane = createPaneHarness() as unknown as IConversationActionTarget;
		const clipboardWrites: string[] = [];
		let renderImageStripCalls = 0;
		let updateComposerMetricsCalls = 0;
		let focusInputCalls = 0;
		pane.activeThreadId = 'thread-runtime';
		pane.composerInput = document.createElement('textarea');
		pane.pendingImages = [];
		pane.clipboardService = {
			writeText: async (text: string) => {
				clipboardWrites.push(text);
			},
		};
		pane.historyService = {
			getTurns: () => {
				assert.fail('copy/reuse should not consult legacy turns when runtime state is absent');
			},
		};
		pane.threadRuntimeService = {
			getState: () => undefined,
		};
		pane.rail = {
			getSelectedThread: () => undefined,
		};
		pane.toPendingImages = () => [];
		pane.renderImageStrip = () => { renderImageStripCalls += 1; };
		pane.updateComposerMetrics = () => { updateComposerMetricsCalls += 1; };
		pane.focusInput = () => { focusInputCalls += 1; };

		await pane.copyPrompt();
		await pane.copyResponse();
		pane.reusePrompt();

		assert.deepStrictEqual(clipboardWrites, []);
		assert.strictEqual(pane.composerInput.value, '');
		assert.deepStrictEqual(pane.pendingImages, []);
		assert.strictEqual(renderImageStripCalls, 0);
		assert.strictEqual(updateComposerMetricsCalls, 0);
		assert.strictEqual(focusInputCalls, 0);
	});

	test('explicit targeted-thread copy and reuse actions import a legacy-only thread once', async () => {
		const pane = createPaneHarness() as unknown as IConversationActionTarget & {
			threadsById: Map<string, { threadId: string; runtimeOwnedCatalog?: boolean }>;
		};
		const clipboardWrites: string[] = [];
		let renderImageStripCalls = 0;
		let updateComposerMetricsCalls = 0;
		let focusInputCalls = 0;
		let getTurnsCalls = 0;
		let importedRuntimeState: ReturnType<NonNullable<IConversationActionTarget['threadRuntimeService']['ensureHydratedFromHistory']>> | undefined;
		const promptImages = [{ mimeType: 'image/png', base64Data: 'bGVnYWN5' }];
		pane.threadsById = new Map([
			['thread-legacy', {
				threadId: 'thread-legacy',
				runtimeOwnedCatalog: false,
			}],
		]);
		pane.activeThreadId = 'thread-active';
		pane.composerInput = document.createElement('textarea');
		pane.pendingImages = [];
		pane.clipboardService = {
			writeText: async (text: string) => {
				clipboardWrites.push(text);
			},
		};
		pane.historyService = {
			getTurns: (threadId: string) => {
				getTurnsCalls += 1;
				assert.strictEqual(threadId, 'thread-legacy');
				return [{
					turnId: 'thread-legacy:turn-1',
					threadId: 'thread-legacy',
					sequence: 1,
					promptText: 'Legacy prompt',
					promptImages: promptImages,
					responseMarkdown: 'Legacy response',
					responsePlainText: 'Legacy response',
					startedAt: 1,
					status: 'completed',
					lastEventAt: 1,
				} as IVSCloneChatHistoryTurn];
			},
		};
		pane.threadRuntimeService = {
			getState: (threadId: string) => threadId === 'thread-legacy' ? importedRuntimeState : undefined,
			ensureHydratedFromHistory: (threadId, turns) => {
				assert.strictEqual(threadId, 'thread-legacy');
				assert.strictEqual(turns.length, 1);
				importedRuntimeState = {
					threadId,
					catalog: {
						threadId,
						title: 'Legacy thread',
						createdAt: 1,
						updatedAt: 1,
						status: 'completed',
						archived: false,
						turnCount: 1,
						lastTurnPreview: turns[0].responsePlainText || turns[0].responseMarkdown,
					},
					streamState: { kind: 'idle' },
					messages: [
						{
							role: 'user',
							content: turns[0].promptText,
							imageAttachments: turns[0].promptImages,
						},
						{
							role: 'assistant',
							content: turns[0].responsePlainText || turns[0].responseMarkdown,
						},
					],
					checkpoints: [],
					isRunning: false,
					lastUpdatedAt: 1,
				};
				return importedRuntimeState;
			},
		};
		pane.rail = {
			getSelectedThread: () => undefined,
		};
		pane.toPendingImages = attachments => attachments?.map((attachment, index) => ({ ...attachment, dataUrl: `data:${attachment.mimeType};base64,${index}` })) ?? [];
		pane.renderImageStrip = () => { renderImageStripCalls += 1; };
		pane.updateComposerMetrics = () => { updateComposerMetricsCalls += 1; };
		pane.focusInput = () => { focusInputCalls += 1; };
		(pane as unknown as { getImportingRuntimeThreadIds: () => Set<string> }).getImportingRuntimeThreadIds = () => new Set();

		await pane.copyPrompt('thread-legacy');
		await pane.copyResponse('thread-legacy');
		pane.reusePrompt('thread-legacy');

		assert.strictEqual(getTurnsCalls, 1);
		assert.strictEqual(pane.threadsById.get('thread-legacy')?.runtimeOwnedCatalog, true);
		assert.deepStrictEqual(clipboardWrites, ['Legacy prompt', 'Legacy response']);
		assert.strictEqual(pane.composerInput.value, 'Legacy prompt');
		assert.strictEqual(pane.pendingImages.length, 1);
		assert.strictEqual(renderImageStripCalls, 1);
		assert.strictEqual(updateComposerMetricsCalls, 1);
		assert.strictEqual(focusInputCalls, 1);
	});

	test('explicit targeted-thread copy and reuse actions do not import runtime-owned empty threads', async () => {
		const pane = createPaneHarness() as unknown as IConversationActionTarget & {
			threadsById: Map<string, { threadId: string; runtimeOwnedCatalog?: boolean }>;
		};
		const clipboardWrites: string[] = [];
		let getTurnsCalls = 0;
		let renderImageStripCalls = 0;
		let updateComposerMetricsCalls = 0;
		let focusInputCalls = 0;
		pane.threadsById = new Map([
			['thread-runtime', {
				threadId: 'thread-runtime',
				runtimeOwnedCatalog: true,
			}],
		]);
		pane.composerInput = document.createElement('textarea');
		pane.pendingImages = [];
		pane.clipboardService = {
			writeText: async (text: string) => {
				clipboardWrites.push(text);
			},
		};
		pane.historyService = {
			getTurns: () => {
				getTurnsCalls += 1;
				assert.fail('runtime-owned explicit actions should not fall back to legacy history');
			},
		};
		pane.threadRuntimeService = {
			getState: () => undefined,
			ensureHydratedFromHistory: () => {
				assert.fail('runtime-owned explicit actions should not trigger history hydration');
			},
		};
		pane.rail = {
			getSelectedThread: () => undefined,
		};
		pane.toPendingImages = () => [];
		pane.renderImageStrip = () => { renderImageStripCalls += 1; };
		pane.updateComposerMetrics = () => { updateComposerMetricsCalls += 1; };
		pane.focusInput = () => { focusInputCalls += 1; };

		await pane.copyPrompt('thread-runtime');
		await pane.copyResponse('thread-runtime');
		pane.reusePrompt('thread-runtime');

		assert.deepStrictEqual(clipboardWrites, []);
		assert.strictEqual(getTurnsCalls, 0);
		assert.strictEqual(renderImageStripCalls, 0);
		assert.strictEqual(updateComposerMetricsCalls, 0);
		assert.strictEqual(focusInputCalls, 0);
	});

	test('refreshConversation renders active runtime threads without reading legacy turns', () => {
		const pane = createPaneHarness() as unknown as IRefreshConversationTarget & {
			pendingAssistantApplyMessageIds: Set<string>;
		};
		pane.activeThreadId = 'thread-runtime';
		pane.pendingAssistantApplyMessageIds = new Set();
		pane.conversationList = document.createElement('div');
		pane.conversationEmptyState = document.createElement('div');
		pane.historyService = {
			getTurns: () => {
				throw new Error('legacy history should not be consulted for active runtime rendering');
			},
		};
		pane.threadRuntimeService = {
			getState: () => ({
				threadId: 'thread-runtime',
				streamState: { kind: 'awaiting_user', toolName: 'edit_file', approvalType: 'edits' },
				messages: [
					{
						role: 'user',
						content: 'runtime prompt',
						imageAttachments: [{ mimeType: 'image/png', base64Data: 'c3RhbGU=' }],
					},
					{
						role: 'assistant',
						content: 'runtime assistant response',
					},
					{
						role: 'tool',
						type: 'tool_request',
						toolName: 'edit_file',
						approvalType: 'edits',
						params: { path: 'src/runtime.ts' },
					},
					{
						role: 'checkpoint',
						checkpoint: {
							id: 'checkpoint-runtime',
							createdAt: 1,
							type: 'tool_edit',
							toolName: 'edit_file',
							snapshots: [],
						},
					},
				],
				checkpoints: [],
				isRunning: true,
				lastUpdatedAt: 1,
			}),
			approveLatestToolRequest: () => true,
			rejectLatestToolRequest: () => true,
			rewindToCheckpoint: async () => true,
		};
		pane.editApplicationService = {
			hasSearchReplaceBlocks: () => false,
		};
		pane.renderedMarkdownDisposables = {
			clear: () => undefined,
			add: value => value,
		};
		pane.markdownRendererService = createPlainTextMarkdownRendererStub();
		pane.updateComposerState = () => undefined;
		pane.refreshModelControls = () => undefined;
		pane.scheduleScrollToBottom = () => undefined;

		pane.refreshConversation();

		assert.ok(pane.conversationList.querySelector('.vsclone-thread-message.user.runtime'));
		assert.ok(pane.conversationList.querySelector('.vsclone-thread-message.assistant.runtime'));
		assert.ok(pane.conversationList.querySelector('.vsclone-thread-message.runtime-tool'));
		assert.ok(pane.conversationList.querySelector('.vsclone-runtime-checkpoint-card'));
		assert.strictEqual(pane.conversationEmptyState.classList.contains('hidden'), true);
	});

	test('runtime assistant apply state hydrates from public runtime assistant edit application state', () => {
		const pane = createPaneHarness() as unknown as {
			getAssistantApplyState: (target: { threadId: string; id: string; responseText: string }) => unknown;
			pendingAssistantApplyMessageIds: Set<string>;
			threadRuntimeService: {
				getState: (threadId: string) => {
					threadId: string;
					streamState: { kind: 'idle' };
					messages: Array<{ id: string; role: 'assistant'; createdAt: number; content: string }>;
					assistantEditApplications?: Array<{ messageId: string; state: unknown }>;
					checkpoints: Array<unknown>;
					isRunning: boolean;
					lastUpdatedAt: number;
				} | undefined;
				getAssistantEditApplicationState: (threadId: string, messageId: string) => unknown;
			};
		};
		pane.pendingAssistantApplyMessageIds = new Set();
		const runtimeState = {
			threadId: 'thread-1',
			streamState: { kind: 'idle' as const },
			messages: [
				{ id: 'assistant-applied', role: 'assistant' as const, createdAt: 1, content: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE' },
				{ id: 'assistant-undone', role: 'assistant' as const, createdAt: 3, content: 'File: src/feature.ts\n<<<<<<< SEARCH\n\n=======\ntext\n>>>>>>> REPLACE' },
			],
			assistantEditApplications: [
				{
					messageId: 'assistant-applied',
					state: {
						phase: 'applied',
						result: {
							attemptedEdits: 1,
							appliedEdits: 1,
							modifiedFiles: [URI.parse('file:///workspace/src/app.ts')],
							failures: [],
							fileChanges: [{
								uri: URI.parse('file:///workspace/src/app.ts'),
								displayPath: 'src/app.ts',
								addedLines: 2,
								removedLines: 1,
								action: 'modify',
								originalContent: 'before',
							}],
						},
					},
				},
				{
					messageId: 'assistant-undone',
					state: {
						phase: 'undone',
						result: {
							attemptedEdits: 1,
							appliedEdits: 1,
							modifiedFiles: [URI.parse('file:///workspace/src/feature.ts')],
							failures: [],
							fileChanges: [{
								uri: URI.parse('file:///workspace/src/feature.ts'),
								displayPath: 'src/feature.ts',
								addedLines: 3,
								removedLines: 0,
								action: 'create',
							}],
						},
					},
				},
			],
			checkpoints: [],
			isRunning: false,
			lastUpdatedAt: 4,
		};
		pane.threadRuntimeService = {
			getState: threadId => threadId === 'thread-1' ? runtimeState : undefined,
			getAssistantEditApplicationState: (threadId, messageId) => threadId === 'thread-1'
				? runtimeState.assistantEditApplications?.find(entry => entry.messageId === messageId)?.state
				: undefined,
		};

		const applied = pane.getAssistantApplyState({ threadId: 'thread-1', id: 'assistant-applied', responseText: '' }) as { phase: string; result: { fileChanges: Array<{ uri: URI; originalContent?: string }> } } | undefined;
		const undone = pane.getAssistantApplyState({ threadId: 'thread-1', id: 'assistant-undone', responseText: '' }) as { phase: string; result: { fileChanges: Array<{ uri: URI }> } } | undefined;

		assert.strictEqual(applied?.phase, 'applied');
		assert.strictEqual(applied?.result.fileChanges[0]?.uri.toString(), 'file:///workspace/src/app.ts');
		assert.strictEqual(applied?.result.fileChanges[0]?.originalContent, 'before');
		assert.strictEqual(undone?.phase, 'undone');
		assert.strictEqual(undone?.result.fileChanges[0]?.uri.toString(), 'file:///workspace/src/feature.ts');
	});

	test('refreshConversation renders apply summary from runtime assistant edit application state without creating a tool card', () => {
		const pane = createPaneHarness() as unknown as IRefreshConversationTarget & {
			pendingAssistantApplyMessageIds: Set<string>;
		};
		pane.activeThreadId = 'thread-apply-ui';
		pane.pendingAssistantApplyMessageIds = new Set();
		pane.conversationList = document.createElement('div');
		pane.conversationEmptyState = document.createElement('div');
		pane.historyService = {
			getTurns: () => [],
		};
		pane.threadRuntimeService = {
			getState: () => ({
				threadId: 'thread-apply-ui',
				streamState: { kind: 'idle' },
				messages: [
					{
						id: 'assistant-1',
						role: 'assistant',
						createdAt: 1,
						content: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
					},
				],
				assistantEditApplications: [{
					messageId: 'assistant-1',
					state: {
						phase: 'applied',
						result: {
							attemptedEdits: 1,
							appliedEdits: 1,
							modifiedFiles: [URI.parse('file:///workspace/src/app.ts')],
							failures: [],
							fileChanges: [{
								uri: URI.parse('file:///workspace/src/app.ts'),
								displayPath: 'src/app.ts',
								addedLines: 1,
								removedLines: 1,
								action: 'modify',
							}],
						},
					},
				}],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 1,
			}),
			getAssistantEditApplicationState: (_threadId, messageId) => messageId === 'assistant-1'
				? {
					phase: 'applied',
					result: {
						attemptedEdits: 1,
						appliedEdits: 1,
						modifiedFiles: [URI.parse('file:///workspace/src/app.ts')],
						failures: [],
						fileChanges: [{
							uri: URI.parse('file:///workspace/src/app.ts'),
							displayPath: 'src/app.ts',
							addedLines: 1,
							removedLines: 1,
							action: 'modify',
						}],
					},
				}
				: undefined,
			approveLatestToolRequest: () => true,
			rejectLatestToolRequest: () => true,
			rewindToCheckpoint: async () => true,
		};
		pane.editApplicationService = {
			hasSearchReplaceBlocks: () => true,
		};
		pane.renderedMarkdownDisposables = {
			clear: () => undefined,
			add: value => value,
		};
		pane.markdownRendererService = createPlainTextMarkdownRendererStub();
		pane.updateComposerState = () => undefined;
		pane.refreshModelControls = () => undefined;
		pane.scheduleScrollToBottom = () => undefined;

		pane.refreshConversation();

		assert.ok(pane.conversationList.querySelector('.vsclone-edit-apply-summary'));
		assert.strictEqual(pane.conversationList.querySelector('.runtime-tool'), null);
	});

	test('reloadHistory, render fallback, and composer reset branches update the pane state consistently', async () => {
		const pane = createPaneHarness() as unknown as {
			rootContainer: HTMLElement;
			railVisible: boolean;
			threadsById: Map<string, unknown>;
			rail: {
				setLoading: () => void;
				setError: (message: string) => void;
				setSelectedThread: (threadId: string | undefined) => void;
			};
			historyReady: boolean;
			historyService: { initialize: () => Promise<void>; getThreads: () => unknown[]; deleteThread?: (threadId: string) => Promise<void> };
			planModeService: { initialize: () => Promise<void> };
			threadRuntimeService: { getThreads?: () => unknown[]; deleteThread?: (threadId: string) => Promise<void> | boolean };
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
		pane.threadsById = new Map();
		pane.historyService = {
			initialize: async () => undefined,
			getThreads: () => [],
			deleteThread: async () => undefined,
		};
		pane.planModeService = {
			initialize: async () => undefined,
		};
		pane.threadRuntimeService = {};
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
			getThreads: () => [],
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
			getThreads: () => [],
			deleteThread: async () => undefined,
		};
		pane.threadRuntimeService = {
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
		(pane as unknown as {
			threadsById: Map<string, {
				threadId: string;
				sessionResource: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'active' | 'completed' | 'failed' | 'archived';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
			}>;
		}).threadsById = new Map([
			['thread-1', {
				threadId: 'thread-1',
				sessionResource: 'vsclone://api/thread-1',
				title: 'Thread 1',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'preview',
			}],
		]);
		refreshRailRowsCalls = 0;
		refreshPlanModeControlCalls = 0;
		refreshModelControlsCalls = 0;
		refreshConversationCalls = 0;
		applyRailLayoutCalls = 0;
		focusInputCalls = 0;
		railSelection = 'thread-1';
		let deletedHistoryThreadId: string | undefined;
		const historyThreads = [{
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
			title: 'Thread 1',
			createdAt: 1,
			updatedAt: 2,
			status: 'completed' as const,
			archived: false,
			turnCount: 1,
			lastTurnPreview: 'preview',
		}];
		pane.historyService = {
			initialize: async () => undefined,
			getThreads: () => historyThreads,
			deleteThread: async (threadId: string) => {
				deletedHistoryThreadId = threadId;
				const index = historyThreads.findIndex(thread => thread.threadId === threadId);
				if (index >= 0) {
					historyThreads.splice(index, 1);
				}
			},
		};
		pane.threadRuntimeService = {
			deleteThread: async (threadId: string) => {
				deletedThreadId = threadId;
				return true;
			},
		};
		pane.refreshRailRows = () => {
			refreshRailRowsCalls += 1;
		};
		await pane.deleteThread('thread-1');
		assert.strictEqual(cancelThreadId, 'thread-1');
		assert.strictEqual(deletedThreadId, 'thread-1');
		assert.strictEqual(deletedHistoryThreadId, 'thread-1');
		assert.strictEqual((pane as { activeThreadId?: string }).activeThreadId, undefined);
		assert.strictEqual(railSelection, undefined);
		assert.strictEqual((pane as { railVisible: boolean }).railVisible, false);
		assert.strictEqual(refreshRailRowsCalls, 1);
		assert.strictEqual(refreshPlanModeControlCalls, 1);
		assert.strictEqual(refreshModelControlsCalls, 2);
		assert.strictEqual(refreshConversationCalls, 2);
		assert.strictEqual(applyRailLayoutCalls, 1);
		assert.strictEqual(focusInputCalls, 1);
		(pane as unknown as {
			seedThreadCatalogFromHistory: (event?: { reason?: 'turnUpdate'; threadIds?: readonly string[] }) => void;
			threadsById: Map<string, unknown>;
		}).seedThreadCatalogFromHistory({ reason: 'turnUpdate', threadIds: ['thread-1'] });
		assert.ok(!(pane as unknown as { threadsById: Map<string, unknown> }).threadsById.has('thread-1'));
	});

	test('deleteThread refuses a rejected runtime delete and keeps the visible thread state intact', async () => {
		const pane = createPaneHarness() as unknown as {
			activeThreadId?: string;
			railVisible: boolean;
			threadsById: Map<string, {
				threadId: string;
				sessionResource: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'active' | 'completed' | 'failed' | 'archived';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
			}>;
			sessionService: {
				cancelThread: (threadId: string) => void;
			};
			historyService: {
				deleteThread: (threadId: string) => Promise<void>;
			};
			threadRuntimeService: {
				deleteThread: (threadId: string) => Promise<boolean> | boolean;
			};
			rail: {
				setSelectedThread: (threadId: string | undefined) => void;
			};
			notificationService: {
				error: (message: string) => void;
			};
			deleteThread: (threadId: string) => Promise<void>;
			refreshRailRows: () => void;
			refreshModelControls: () => void;
			refreshConversation: () => void;
			showComposerForNewChat: () => void;
		};
		const notifications: string[] = [];
		let canceledThreadId: string | undefined;
		let selectedThread: string | undefined = 'thread-1';
		let refreshRailRowsCalls = 0;
		let refreshModelControlsCalls = 0;
		let refreshConversationCalls = 0;
		let showComposerCalls = 0;
		let historyDeleteCalls = 0;
		pane.activeThreadId = 'thread-1';
		pane.railVisible = true;
		pane.threadsById = new Map([
			['thread-1', {
				threadId: 'thread-1',
				sessionResource: 'vsclone://api/thread-1',
				title: 'Thread 1',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'preview',
			}],
		]);
		pane.sessionService = {
			cancelThread: (threadId: string) => {
				canceledThreadId = threadId;
			},
		};
		pane.historyService = {
			deleteThread: async () => {
				historyDeleteCalls += 1;
			},
		};
		pane.threadRuntimeService = {
			deleteThread: async () => false,
		};
		pane.rail = {
			setSelectedThread: (threadId: string | undefined) => {
				selectedThread = threadId;
			},
		};
		pane.notificationService = {
			error: (message: string) => {
				notifications.push(message);
			},
		};
		pane.refreshRailRows = () => {
			refreshRailRowsCalls += 1;
		};
		pane.refreshModelControls = () => {
			refreshModelControlsCalls += 1;
		};
		pane.refreshConversation = () => {
			refreshConversationCalls += 1;
		};
		pane.showComposerForNewChat = () => {
			showComposerCalls += 1;
			pane.activeThreadId = undefined;
			pane.railVisible = false;
			pane.rail.setSelectedThread(undefined);
		};

		await pane.deleteThread('thread-1');

		assert.strictEqual(canceledThreadId, 'thread-1');
		assert.strictEqual(historyDeleteCalls, 0);
		assert.strictEqual(pane.activeThreadId, 'thread-1');
		assert.strictEqual(selectedThread, 'thread-1');
		assert.strictEqual(pane.railVisible, true);
		assert.ok(pane.threadsById.has('thread-1'));
		assert.strictEqual(refreshRailRowsCalls, 0);
		assert.strictEqual(refreshModelControlsCalls, 0);
		assert.strictEqual(refreshConversationCalls, 0);
		assert.strictEqual(showComposerCalls, 0);
		assert.deepStrictEqual(notifications, ['Failed to delete the chat. Please try again.']);
	});

	test('setThreadArchived uses runtime catalog archive and updates the cached rail rows', async () => {
		const pane = createPaneHarness() as unknown as {
			historyReady: boolean;
			activeThreadId?: string;
			threadsById: Map<string, {
				threadId: string;
				sessionResource: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'active' | 'completed' | 'failed' | 'archived';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
			}>;
			historyService: {
				archiveThread: (threadId: string, archived: boolean) => Promise<void>;
			};
			threadRuntimeService: {
				archiveThread?: (threadId: string, archived: boolean) => Promise<void> | boolean;
				getThreads?: () => unknown[];
			};
			rail: {
				getFilterState: () => { query: string; tab: 'all' | 'active' | 'archived' };
				setRows: (rows: Array<{ threadId: string; archived: boolean; status: string }>) => void;
				setSelectedThread: (threadId: string | undefined) => void;
			};
			notificationService: {
				error: (message: string) => void;
			};
			setThreadArchived: (threadId: string, archived: boolean) => Promise<void>;
			refreshRailRows: () => void;
		};
		const archiveCalls: Array<{ threadId: string; archived: boolean }> = [];
		let renderedRows: Array<{ threadId: string; archived: boolean; status: string }> = [];
		pane.historyReady = true;
		pane.threadsById = new Map([
			['thread-1', {
				threadId: 'thread-1',
				sessionResource: 'vsclone://api/thread-1',
				title: 'Thread 1',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'preview',
			}],
		]);
		pane.historyService = {
			archiveThread: async () => {
				throw new Error('history archive should not be used when runtime catalog archive exists');
			},
		};
		pane.threadRuntimeService = {
			archiveThread: async (threadId: string, archived: boolean) => {
				archiveCalls.push({ threadId, archived });
			},
		};
		pane.rail = {
			getFilterState: () => ({ query: '', tab: 'all' }),
			setRows: (rows: Array<{ threadId: string; archived: boolean; status: string }>) => {
				renderedRows = rows;
			},
			setSelectedThread: () => undefined,
		};
		pane.notificationService = {
			error: () => undefined,
		};

		await pane.setThreadArchived('thread-1', true);

		assert.deepStrictEqual(archiveCalls, [{ threadId: 'thread-1', archived: true }]);
		assert.strictEqual(pane.threadsById.get('thread-1')?.archived, true);
		assert.strictEqual(pane.threadsById.get('thread-1')?.status, 'archived');
		assert.strictEqual(renderedRows[0]?.threadId, 'thread-1');
	});

	test('setThreadArchived rolls back the optimistic cache when runtime persistence fails', async () => {
		const pane = createPaneHarness() as unknown as {
			historyReady: boolean;
			threadsById: Map<string, {
				threadId: string;
				sessionResource: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'active' | 'completed' | 'failed' | 'archived';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
			}>;
			historyService: {
				archiveThread: (threadId: string, archived: boolean) => Promise<void>;
			};
			threadRuntimeService: {
				archiveThread?: (threadId: string, archived: boolean) => Promise<void> | boolean;
				getThreads?: () => unknown[];
			};
			rail: {
				getFilterState: () => { query: string; tab: 'all' | 'active' | 'archived' };
				setRows: (rows: Array<{ threadId: string; archived: boolean; status: string }>) => void;
				setSelectedThread: (threadId: string | undefined) => void;
			};
			notificationService: {
				error: (message: string) => void;
			};
			setThreadArchived: (threadId: string, archived: boolean) => Promise<void>;
		};
		const notifications: string[] = [];
		let renderedRows: Array<{ threadId: string; archived: boolean; status: string }> = [];
		pane.historyReady = true;
		pane.threadsById = new Map([
			['thread-1', {
				threadId: 'thread-1',
				sessionResource: 'vsclone://api/thread-1',
				title: 'Thread 1',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'preview',
			}],
		]);
		pane.historyService = {
			archiveThread: async () => {
				throw new Error('history archive should not be used when runtime catalog archive exists');
			},
		};
		pane.threadRuntimeService = {
			archiveThread: async () => false,
			getThreads: () => [],
		};
		pane.rail = {
			getFilterState: () => ({ query: '', tab: 'all' }),
			setRows: (rows: Array<{ threadId: string; archived: boolean; status: string }>) => {
				renderedRows = rows;
			},
			setSelectedThread: () => undefined,
		};
		pane.notificationService = {
			error: (message: string) => { notifications.push(message); },
		};

		await pane.setThreadArchived('thread-1', true);

		assert.strictEqual(pane.threadsById.get('thread-1')?.archived, false);
		assert.strictEqual(pane.threadsById.get('thread-1')?.status, 'completed');
		assert.strictEqual(renderedRows[0]?.archived, false);
		assert.strictEqual(notifications.length, 1);
	});

	test('setThreadArchived falls back to legacy history for a legacy-only cached thread when runtime archive APIs exist', async () => {
		const pane = createPaneHarness() as unknown as {
			historyReady: boolean;
			threadsById: Map<string, {
				threadId: string;
				sessionResource: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'active' | 'completed' | 'failed' | 'archived';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
				runtimeOwnedCatalog?: boolean;
			}>;
			historyService: {
				archiveThread: (threadId: string, archived: boolean) => Promise<void>;
			};
			threadRuntimeService: {
				archiveThread?: (threadId: string, archived: boolean) => Promise<void> | boolean;
				getThreads?: () => unknown[];
			};
			rail: {
				getFilterState: () => { query: string; tab: 'all' | 'active' | 'archived' };
				setRows: (rows: Array<{ threadId: string; archived: boolean; status: string }>) => void;
				setSelectedThread: (threadId: string | undefined) => void;
			};
			notificationService: {
				error: (message: string) => void;
			};
			setThreadArchived: (threadId: string, archived: boolean) => Promise<void>;
		};
		const historyArchiveCalls: Array<{ threadId: string; archived: boolean }> = [];
		let runtimeArchiveCalls = 0;
		pane.historyReady = true;
		pane.threadsById = new Map([
			['thread-legacy', {
				threadId: 'thread-legacy',
				sessionResource: 'vsclone://api/thread-legacy',
				title: 'Legacy thread',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'preview',
				runtimeOwnedCatalog: false,
			}],
		]);
		pane.historyService = {
			archiveThread: async (threadId: string, archived: boolean) => {
				historyArchiveCalls.push({ threadId, archived });
			},
		};
		pane.threadRuntimeService = {
			archiveThread: async () => {
				runtimeArchiveCalls += 1;
				return false;
			},
		};
		pane.rail = {
			getFilterState: () => ({ query: '', tab: 'all' }),
			setRows: () => undefined,
			setSelectedThread: () => undefined,
		};
		pane.notificationService = {
			error: () => undefined,
		};

		await pane.setThreadArchived('thread-legacy', true);

		assert.strictEqual(runtimeArchiveCalls, 0);
		assert.deepStrictEqual(historyArchiveCalls, [{ threadId: 'thread-legacy', archived: true }]);
		assert.strictEqual(pane.threadsById.get('thread-legacy')?.archived, true);
	});

	test('setThreadArchived upgrades a stale legacy-owned cache row before using runtime archive', async () => {
		const pane = createPaneHarness() as unknown as {
			historyReady: boolean;
			threadsById: Map<string, {
				threadId: string;
				sessionResource?: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'active' | 'completed' | 'failed' | 'archived';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
				runtimeOwnedCatalog?: boolean;
			}>;
			historyService: {
				archiveThread: (threadId: string, archived: boolean) => Promise<void>;
			};
			threadRuntimeService: {
				getState: (threadId: string) => unknown;
				archiveThread?: (threadId: string, archived: boolean) => Promise<void> | boolean;
				getThreads?: () => unknown[];
			};
			rail: {
				getFilterState: () => { query: string; tab: 'all' | 'active' | 'archived' };
				setRows: (rows: Array<{ threadId: string; archived: boolean; status: string }>) => void;
				setSelectedThread: (threadId: string | undefined) => void;
			};
			notificationService: {
				error: (message: string) => void;
			};
			setThreadArchived: (threadId: string, archived: boolean) => Promise<void>;
		};
		const historyArchiveCalls: Array<{ threadId: string; archived: boolean }> = [];
		const runtimeArchiveCalls: Array<{ threadId: string; archived: boolean }> = [];
		let archivedInRuntime = false;
		pane.historyReady = true;
		pane.threadsById = new Map([
			['thread-runtime', {
				threadId: 'thread-runtime',
				title: 'Stale legacy row',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Legacy preview',
				runtimeOwnedCatalog: false,
			}],
		]);
		pane.historyService = {
			archiveThread: async (threadId: string, archived: boolean) => {
				historyArchiveCalls.push({ threadId, archived });
			},
		};
		pane.threadRuntimeService = {
			getState: (threadId: string) => threadId === 'thread-runtime' ? {
				threadId,
				catalog: {
					threadId,
					title: 'Runtime row',
					createdAt: 1,
					updatedAt: 3,
					status: 'completed',
					archived: false,
					turnCount: 1,
					lastTurnPreview: 'Runtime preview',
				},
				streamState: { kind: 'idle' },
				messages: [
					{ id: 'msg-user', role: 'user', createdAt: 1, content: 'Runtime prompt' },
					{ id: 'msg-assistant', role: 'assistant', createdAt: 2, content: 'Runtime response' },
				],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 3,
			} : undefined,
			archiveThread: async (threadId: string, archived: boolean) => {
				runtimeArchiveCalls.push({ threadId, archived });
				archivedInRuntime = archived;
			},
			getThreads: () => [{
				threadId: 'thread-runtime',
				title: 'Runtime row',
				createdAt: 1,
				updatedAt: 3,
				status: archivedInRuntime ? 'archived' : 'completed',
				archived: archivedInRuntime,
				turnCount: 1,
				lastTurnPreview: 'Runtime preview',
			}],
		};
		pane.rail = {
			getFilterState: () => ({ query: '', tab: 'all' }),
			setRows: () => undefined,
			setSelectedThread: () => undefined,
		};
		pane.notificationService = {
			error: () => undefined,
		};
		pane.refreshRailRows = pane.refreshRailRows.bind(pane);

		await pane.setThreadArchived('thread-runtime', true);

		assert.deepStrictEqual(runtimeArchiveCalls, [{ threadId: 'thread-runtime', archived: true }]);
		assert.deepStrictEqual(historyArchiveCalls, []);
		assert.strictEqual(pane.threadsById.get('thread-runtime')?.runtimeOwnedCatalog, true);
		assert.strictEqual(pane.threadsById.get('thread-runtime')?.archived, true);
	});

	test('deleteThread leaves the merged pane cache untouched when the runtime catalog rejects the delete', async () => {
		const pane = createPaneHarness() as unknown as {
			activeThreadId?: string;
			railVisible: boolean;
			threadsById: Map<string, {
				threadId: string;
				sessionResource: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'active' | 'completed' | 'failed' | 'archived';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
				runtimeOwnedCatalog?: boolean;
			}>;
			sessionService: { cancelThread: (threadId: string) => void };
			historyService: {
				deleteThread: (threadId: string) => Promise<void>;
			};
			threadRuntimeService: {
				deleteThread: (threadId: string) => Promise<boolean>;
				isDeletedThread?: (threadId: string) => boolean;
				getThreads: (query?: { includeArchived?: boolean }) => Array<unknown>;
			};
			notificationService: {
				error: (message: string) => void;
			};
			refreshRailRows: () => void;
			refreshModelControls: () => void;
			refreshConversation: () => void;
			deleteThread: (threadId: string) => Promise<void>;
		};
		const errors: string[] = [];
		let historyDeleteCalls = 0;
		pane.activeThreadId = 'thread-1';
		pane.railVisible = true;
		pane.threadsById = new Map([
			['thread-1', {
				threadId: 'thread-1',
				sessionResource: 'vsclone://api/thread-1',
				title: 'Thread 1',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'preview',
				runtimeOwnedCatalog: true,
			}],
		]);
		pane.sessionService = {
			cancelThread: () => undefined,
		};
		pane.historyService = {
			deleteThread: async () => {
				historyDeleteCalls += 1;
			},
		};
		pane.threadRuntimeService = {
			deleteThread: async () => false,
			getThreads: () => [],
		};
		pane.notificationService = {
			error: (message: string) => {
				errors.push(message);
			},
		};
		let refreshRailRowsCalls = 0;
		let refreshModelControlsCalls = 0;
		let refreshConversationCalls = 0;
		pane.refreshRailRows = () => { refreshRailRowsCalls += 1; };
		pane.refreshModelControls = () => { refreshModelControlsCalls += 1; };
		pane.refreshConversation = () => { refreshConversationCalls += 1; };

		await pane.deleteThread('thread-1');

		assert.strictEqual(pane.activeThreadId, 'thread-1');
		assert.strictEqual(pane.railVisible, true);
		assert.strictEqual(pane.threadsById.has('thread-1'), true);
		assert.strictEqual(historyDeleteCalls, 0);
		assert.strictEqual(errors.length, 1);
		assert.strictEqual(refreshRailRowsCalls, 0);
		assert.strictEqual(refreshModelControlsCalls, 0);
		assert.strictEqual(refreshConversationCalls, 0);
	});

	test('deleteThread mirrors a successful runtime delete into legacy history so refreshes do not resurrect the thread', async () => {
		const pane = createPaneHarness() as unknown as {
			historyReady: boolean;
			activeThreadId?: string;
			railVisible: boolean;
			threadsById: Map<string, {
				threadId: string;
				sessionResource: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'active' | 'completed' | 'failed' | 'archived';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
				runtimeOwnedCatalog?: boolean;
			}>;
			sessionService: { cancelThread: (threadId: string) => void };
			historyService: {
				getThreads: () => Array<{
					threadId: string;
					sessionResource: string;
					title: string;
					createdAt: number;
					updatedAt: number;
					status: 'active' | 'completed' | 'failed' | 'archived';
					archived: boolean;
					turnCount: number;
					lastTurnPreview: string;
				}>;
				deleteThread: (threadId: string) => Promise<void>;
			};
			threadRuntimeService: {
				deleteThread: (threadId: string) => Promise<boolean>;
				isDeletedThread?: (threadId: string) => boolean;
				getThreads: (query?: { includeArchived?: boolean }) => Array<unknown>;
			};
			rail: {
				getFilterState: () => { query: string; tab: 'all' | 'active' | 'archived' };
				setRows: (rows: Array<{ threadId: string; selected: boolean }>) => void;
				setSelectedThread: (threadId: string | undefined) => void;
			};
			notificationService: {
				error: (message: string) => void;
			};
			refreshRailRows: () => void;
			refreshModelControls: () => void;
			refreshConversation: () => void;
			deleteThread: (threadId: string) => Promise<void>;
		};
		let deletedFromHistory = false;
		let selectedThread: string | undefined = 'thread-1';
		let renderedRows: Array<{ threadId: string; selected: boolean }> = [];
		pane.historyReady = true;
		pane.activeThreadId = 'thread-1';
		pane.railVisible = true;
		pane.threadsById = new Map([
			['thread-1', {
				threadId: 'thread-1',
				sessionResource: 'vsclone://api/thread-1',
				title: 'Thread 1',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'preview',
				runtimeOwnedCatalog: true,
			}],
		]);
		pane.sessionService = {
			cancelThread: () => undefined,
		};
		pane.historyService = {
			getThreads: () => deletedFromHistory ? [] : [{
				threadId: 'thread-1',
				sessionResource: 'vsclone://api/thread-1',
				title: 'Thread 1',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'preview',
			}],
			deleteThread: async () => {
				deletedFromHistory = true;
			},
		};
		pane.threadRuntimeService = {
			deleteThread: async () => true,
			isDeletedThread: (threadId: string) => threadId === 'thread-1',
			getThreads: () => [],
		};
		pane.rail = {
			getFilterState: () => ({ query: '', tab: 'all' }),
			setRows: rows => { renderedRows = rows; },
			setSelectedThread: threadId => { selectedThread = threadId; },
		};
		pane.notificationService = {
			error: () => undefined,
		};
		pane.refreshRailRows = pane.refreshRailRows.bind(pane);
		pane.refreshModelControls = () => undefined;
		pane.refreshConversation = () => undefined;

		await pane.deleteThread('thread-1');
		pane.refreshRailRows();

		assert.strictEqual(deletedFromHistory, true);
		assert.strictEqual(pane.activeThreadId, undefined);
		assert.strictEqual(selectedThread, undefined);
		assert.strictEqual(renderedRows.some(row => row.threadId === 'thread-1'), false);
		assert.strictEqual(pane.threadsById.has('thread-1'), false);
	});

	test('deleteThread falls back to legacy history for a legacy-only cached thread even when runtime delete APIs exist', async () => {
		const pane = createPaneHarness() as unknown as {
			activeThreadId?: string;
			railVisible: boolean;
			threadsById: Map<string, {
				threadId: string;
				sessionResource: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'active' | 'completed' | 'failed' | 'archived';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
				runtimeOwnedCatalog?: boolean;
			}>;
			sessionService: { cancelThread: (threadId: string) => void };
			historyService: {
				deleteThread: (threadId: string) => Promise<void>;
			};
			threadRuntimeService: {
				deleteThread: (threadId: string) => Promise<boolean>;
			};
			refreshRailRows: () => void;
			refreshModelControls: () => void;
			refreshConversation: () => void;
			deleteThread: (threadId: string) => Promise<void>;
		};
		let runtimeDeleteCalls = 0;
		let historyDeleteThreadId: string | undefined;
		pane.activeThreadId = undefined;
		pane.railVisible = true;
		pane.threadsById = new Map([
			['thread-legacy', {
				threadId: 'thread-legacy',
				sessionResource: 'vsclone://api/thread-legacy',
				title: 'Legacy thread',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'preview',
				runtimeOwnedCatalog: false,
			}],
		]);
		pane.sessionService = {
			cancelThread: () => undefined,
		};
		pane.historyService = {
			deleteThread: async (threadId: string) => {
				historyDeleteThreadId = threadId;
			},
		};
		pane.threadRuntimeService = {
			deleteThread: async () => {
				runtimeDeleteCalls += 1;
				return false;
			},
		};
		pane.refreshRailRows = () => undefined;
		pane.refreshModelControls = () => undefined;
		pane.refreshConversation = () => undefined;

		await pane.deleteThread('thread-legacy');

		assert.strictEqual(runtimeDeleteCalls, 0);
		assert.strictEqual(historyDeleteThreadId, 'thread-legacy');
	});

	test('deleteThread upgrades a stale legacy-owned cache row before using runtime delete', async () => {
		const pane = createPaneHarness() as unknown as {
			activeThreadId?: string;
			railVisible: boolean;
			threadsById: Map<string, {
				threadId: string;
				sessionResource?: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'active' | 'completed' | 'failed' | 'archived';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
				runtimeOwnedCatalog?: boolean;
			}>;
			sessionService: { cancelThread: (threadId: string) => void };
			historyService: {
				deleteThread: (threadId: string) => Promise<void>;
			};
			threadRuntimeService: {
				getState: (threadId: string) => unknown;
				deleteThread: (threadId: string) => Promise<boolean>;
			};
			refreshRailRows: () => void;
			refreshModelControls: () => void;
			refreshConversation: () => void;
			deleteThread: (threadId: string) => Promise<void>;
		};
		const runtimeDeleteCalls: string[] = [];
		const historyDeleteCalls: string[] = [];
		pane.activeThreadId = undefined;
		pane.railVisible = true;
		pane.threadsById = new Map([
			['thread-runtime', {
				threadId: 'thread-runtime',
				title: 'Stale legacy row',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Legacy preview',
				runtimeOwnedCatalog: false,
			}],
		]);
		pane.sessionService = {
			cancelThread: () => undefined,
		};
		pane.historyService = {
			deleteThread: async (threadId: string) => {
				historyDeleteCalls.push(threadId);
			},
		};
		pane.threadRuntimeService = {
			getState: (threadId: string) => threadId === 'thread-runtime' ? {
				threadId,
				catalog: {
					threadId,
					title: 'Runtime row',
					createdAt: 1,
					updatedAt: 3,
					status: 'completed',
					archived: false,
					turnCount: 1,
					lastTurnPreview: 'Runtime preview',
				},
				streamState: { kind: 'idle' },
				messages: [
					{ id: 'msg-user', role: 'user', createdAt: 1, content: 'Runtime prompt' },
					{ id: 'msg-assistant', role: 'assistant', createdAt: 2, content: 'Runtime response' },
				],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 3,
			} : undefined,
			deleteThread: async (threadId: string) => {
				runtimeDeleteCalls.push(threadId);
				return true;
			},
		};
		pane.refreshRailRows = () => undefined;
		pane.refreshModelControls = () => undefined;
		pane.refreshConversation = () => undefined;

		await pane.deleteThread('thread-runtime');

		assert.deepStrictEqual(runtimeDeleteCalls, ['thread-runtime']);
		assert.deepStrictEqual(historyDeleteCalls, ['thread-runtime']);
		assert.strictEqual(pane.threadsById.has('thread-runtime'), false);
	});

	test('deleteThread keeps the thread hidden when runtime delete succeeds but legacy cleanup fails', async () => {
		const pane = createPaneHarness() as unknown as {
			historyReady: boolean;
			activeThreadId?: string;
			railVisible: boolean;
			threadsById: Map<string, {
				threadId: string;
				sessionResource: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'active' | 'completed' | 'failed' | 'archived';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
				runtimeOwnedCatalog?: boolean;
			}>;
			sessionService: { cancelThread: (threadId: string) => void };
			historyService: {
				getThreads: () => Array<{
					threadId: string;
					sessionResource: string;
					title: string;
					createdAt: number;
					updatedAt: number;
					status: 'active' | 'completed' | 'failed' | 'archived';
					archived: boolean;
					turnCount: number;
					lastTurnPreview: string;
				}>;
				deleteThread: (threadId: string) => Promise<void>;
			};
			threadRuntimeService: {
				deleteThread: (threadId: string) => Promise<boolean>;
				isDeletedThread?: (threadId: string) => boolean;
				getThreads: (query?: { includeArchived?: boolean }) => Array<unknown>;
			};
			rail: {
				getFilterState: () => { query: string; tab: 'all' | 'active' | 'archived' };
				setRows: (rows: Array<{ threadId: string; selected: boolean }>) => void;
				setSelectedThread: (threadId: string | undefined) => void;
			};
			notificationService: {
				error: (message: string) => void;
			};
			refreshRailRows: () => void;
			refreshModelControls: () => void;
			refreshConversation: () => void;
			deleteThread: (threadId: string) => Promise<void>;
			seedThreadCatalogFromHistory: (event?: { reason?: 'turnUpdate'; threadIds?: readonly string[] }) => void;
		};
		const errors: string[] = [];
		let selectedThread: string | undefined = 'thread-1';
		let renderedRows: Array<{ threadId: string; selected: boolean }> = [];
		pane.historyReady = true;
		pane.activeThreadId = 'thread-1';
		pane.railVisible = true;
		pane.threadsById = new Map([
			['thread-1', {
				threadId: 'thread-1',
				sessionResource: 'vsclone://api/thread-1',
				title: 'Thread 1',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'preview',
				runtimeOwnedCatalog: true,
			}],
		]);
		pane.sessionService = {
			cancelThread: () => undefined,
		};
		pane.historyService = {
			getThreads: () => [{
				threadId: 'thread-1',
				sessionResource: 'vsclone://api/thread-1',
				title: 'Thread 1',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'preview',
			}],
			deleteThread: async () => {
				throw new Error('legacy cleanup failed');
			},
		};
		pane.threadRuntimeService = {
			deleteThread: async () => true,
			isDeletedThread: (threadId: string) => threadId === 'thread-1',
			getThreads: () => [],
		};
		pane.rail = {
			getFilterState: () => ({ query: '', tab: 'all' }),
			setRows: rows => { renderedRows = rows; },
			setSelectedThread: threadId => { selectedThread = threadId; },
		};
		pane.notificationService = {
			error: (message: string) => { errors.push(message); },
		};
		pane.refreshRailRows = pane.refreshRailRows.bind(pane);
		pane.refreshModelControls = () => undefined;
		pane.refreshConversation = () => undefined;

		await pane.deleteThread('thread-1');
		pane.seedThreadCatalogFromHistory({ reason: 'turnUpdate', threadIds: ['thread-1'] });
		pane.refreshRailRows();

		assert.strictEqual(pane.activeThreadId, undefined);
		assert.strictEqual(selectedThread, undefined);
		assert.strictEqual(pane.threadsById.has('thread-1'), false);
		assert.strictEqual(renderedRows.some(row => row.threadId === 'thread-1'), false);
		assert.deepStrictEqual(errors, ['Deleted the chat, but failed to clean up legacy history. It may reappear after reload.']);
	});

	test('history seeding keeps runtime-owned rows while refreshing legacy-only cache entries', () => {
		const pane = createPaneHarness() as unknown as {
			threadsById: Map<string, {
				threadId: string;
				sessionResource: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'active' | 'completed' | 'failed' | 'archived';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
				runtimeOwnedCatalog?: boolean;
			}>;
			historyService: {
				getThreads: () => Array<{
					threadId: string;
					sessionResource: string;
					title: string;
					createdAt: number;
					updatedAt: number;
					status: 'active' | 'completed' | 'failed' | 'archived';
					archived: boolean;
					turnCount: number;
					lastTurnPreview: string;
				}>;
			};
			seedThreadCatalogFromHistory: (event?: { reason?: 'turnUpdate' | 'delete'; threadIds?: readonly string[] }) => void;
		};
		pane.threadsById = new Map([
			['thread-runtime', {
				threadId: 'thread-runtime',
				sessionResource: 'vsclone://runtime/thread-runtime',
				title: 'Runtime thread',
				createdAt: 1,
				updatedAt: 5,
				status: 'active',
				archived: false,
				turnCount: 2,
				lastTurnPreview: 'runtime preview',
				runtimeOwnedCatalog: true,
			}],
			['thread-legacy-stale', {
				threadId: 'thread-legacy-stale',
				sessionResource: 'vsclone://api/thread-legacy-stale',
				title: 'Stale legacy thread',
				createdAt: 1,
				updatedAt: 1,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'stale preview',
				runtimeOwnedCatalog: false,
			}],
		]);
		pane.historyService = {
			getThreads: () => [{
				threadId: 'thread-legacy-fresh',
				sessionResource: 'vsclone://api/thread-legacy-fresh',
				title: 'Fresh legacy thread',
				createdAt: 2,
				updatedAt: 6,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'fresh preview',
			}],
		};

		pane.seedThreadCatalogFromHistory({ reason: 'turnUpdate', threadIds: ['thread-legacy-fresh'] });

		assert.ok(pane.threadsById.has('thread-runtime'));
		assert.ok(pane.threadsById.has('thread-legacy-fresh'));
		assert.ok(!pane.threadsById.has('thread-legacy-stale'));
		assert.strictEqual(pane.threadsById.get('thread-runtime')?.runtimeOwnedCatalog, true);
	});

	test('refreshThreadCatalogFromRuntime preserves a real history session resource when runtime catalog metadata is incomplete', () => {
		const pane = createPaneHarness() as unknown as {
			threadsById: Map<string, {
				threadId: string;
				sessionResource?: string;
				activeModelIdentifier?: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'active' | 'completed' | 'failed' | 'archived';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
				importedFromHistory?: boolean;
				runtimeOwnedCatalog?: boolean;
			}>;
			threadRuntimeService: {
				getThreads: () => Array<{
					threadId: string;
					activeModelIdentifier?: string;
					title: string;
					createdAt: number;
					updatedAt: number;
					status: 'active' | 'completed' | 'failed' | 'archived';
					archived: boolean;
					turnCount: number;
					lastTurnPreview: string;
					importedFromHistory?: boolean;
				}>;
			};
			refreshThreadCatalogFromRuntime: () => void;
		};
		pane.threadsById = new Map([
			['thread-1', {
				threadId: 'thread-1',
				sessionResource: 'vsclone://api/thread-1',
				activeModelIdentifier: 'openai/gpt-5.3-codex',
				title: 'History title',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'History preview',
				importedFromHistory: true,
				runtimeOwnedCatalog: false,
			}],
		]);
		pane.threadRuntimeService = {
			getThreads: () => [{
				threadId: 'thread-1',
				title: 'Runtime title',
				createdAt: 1,
				updatedAt: 5,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Runtime preview',
			}],
		};

		pane.refreshThreadCatalogFromRuntime();

		assert.strictEqual(pane.threadsById.get('thread-1')?.sessionResource, 'vsclone://api/thread-1');
		assert.strictEqual(pane.threadsById.get('thread-1')?.activeModelIdentifier, 'openai/gpt-5.3-codex');
		assert.strictEqual(pane.threadsById.get('thread-1')?.importedFromHistory, true);
		assert.strictEqual(pane.threadsById.get('thread-1')?.runtimeOwnedCatalog, true);
	});

	test('refreshRailRows keeps legacy-only cached threads visible when runtime no longer lists them during migration', () => {
		const pane = createPaneHarness() as unknown as {
			historyReady: boolean;
			activeThreadId?: string;
			railVisible: boolean;
			threadsById: Map<string, {
				threadId: string;
				sessionResource: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'active' | 'completed' | 'failed' | 'archived';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
				runtimeOwnedCatalog?: boolean;
			}>;
			threadRuntimeService: {
				getThreads?: () => unknown[];
			};
			rail: {
				getFilterState: () => { query: string; tab: 'all' | 'active' | 'archived' };
				setRows: (rows: Array<{ threadId: string; selected: boolean }>) => void;
				setSelectedThread: (threadId: string | undefined) => void;
			};
			refreshRailRows: () => void;
			showComposerForNewChat: () => void;
		};
		let selectedThread: string | undefined = 'thread-1';
		let renderedRows: Array<{ threadId: string; selected: boolean }> = [];
		pane.historyReady = true;
		pane.activeThreadId = 'thread-1';
		pane.threadsById = new Map([
			['thread-1', {
				threadId: 'thread-1',
				sessionResource: 'vsclone://api/thread-1',
				title: 'Thread 1',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'preview',
				runtimeOwnedCatalog: false,
			}],
		]);
		pane.threadRuntimeService = {
			getThreads: () => [],
		};
		pane.rail = {
			getFilterState: () => ({ query: '', tab: 'all' }),
			setRows: (rows: Array<{ threadId: string; selected: boolean }>) => {
				renderedRows = rows;
			},
			setSelectedThread: (threadId: string | undefined) => {
				selectedThread = threadId;
			},
		};
		pane.showComposerForNewChat = () => {
			assert.fail('legacy-only cached threads should survive runtime refresh during migration');
		};

		pane.refreshRailRows();

		assert.strictEqual(pane.activeThreadId, 'thread-1');
		assert.strictEqual(selectedThread, 'thread-1');
		assert.deepStrictEqual(renderedRows.map(row => row.threadId), ['thread-1']);
	});

	test('syncThreadCatalogEntryFromRuntime preserves a real history session resource when runtime metadata is incomplete', () => {
		const pane = createPaneHarness() as unknown as {
			threadsById: Map<string, {
				threadId: string;
				sessionResource?: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'active' | 'completed' | 'failed' | 'archived';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
				runtimeOwnedCatalog?: boolean;
			}>;
			threadRuntimeService: {
				getState: (threadId: string) => unknown;
			};
			syncThreadCatalogEntryFromRuntime: (state: {
				threadId: string;
				catalog: {
					threadId: string;
					title: string;
					createdAt: number;
					updatedAt: number;
					status: 'active' | 'completed' | 'failed' | 'archived';
					archived: boolean;
					turnCount: number;
					lastTurnPreview: string;
				};
				streamState: { kind: 'idle' };
				messages: Array<{ role: 'user' | 'assistant'; content: string; createdAt: number }>;
				checkpoints: [];
				isRunning: boolean;
				lastUpdatedAt: number;
			}) => void;
		};
		const runtimeState = {
			threadId: 'thread-1',
			catalog: {
				threadId: 'thread-1',
				title: 'Runtime title',
				createdAt: 1,
				updatedAt: 5,
				status: 'completed' as const,
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Runtime preview',
			},
			streamState: { kind: 'idle' as const },
			messages: [
				{ role: 'user' as const, content: 'Prompt', createdAt: 1 },
				{ role: 'assistant' as const, content: 'Reply', createdAt: 2 },
			],
			checkpoints: [],
			isRunning: false,
			lastUpdatedAt: 5,
		};
		pane.threadsById = new Map([
			['thread-1', {
				threadId: 'thread-1',
				sessionResource: 'vsclone://api/thread-1',
				title: 'History title',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'History preview',
				runtimeOwnedCatalog: false,
			}],
		]);
		pane.threadRuntimeService = {
			getState: () => runtimeState,
		};

		pane.syncThreadCatalogEntryFromRuntime(runtimeState);

		assert.strictEqual(pane.threadsById.get('thread-1')?.sessionResource, 'vsclone://api/thread-1');
		assert.strictEqual(pane.threadsById.get('thread-1')?.runtimeOwnedCatalog, true);
	});

	test('refreshRailRows clears the active thread when it is absent from both runtime and cached history rows', () => {
		const pane = createPaneHarness() as unknown as {
			historyReady: boolean;
			activeThreadId?: string;
			railVisible: boolean;
			threadsById: Map<string, {
				threadId: string;
				sessionResource: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'active' | 'completed' | 'failed' | 'archived';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
				runtimeOwnedCatalog?: boolean;
			}>;
			threadRuntimeService: {
				getThreads?: () => unknown[];
			};
			rail: {
				getFilterState: () => { query: string; tab: 'all' | 'active' | 'archived' };
				setRows: (rows: Array<unknown>) => void;
				setSelectedThread: (threadId: string | undefined) => void;
			};
			refreshRailRows: () => void;
			showComposerForNewChat: () => void;
		};
		let selectedThread: string | undefined = 'thread-gone';
		let showComposerCalls = 0;
		pane.historyReady = true;
		pane.activeThreadId = 'thread-gone';
		pane.threadsById = new Map();
		pane.threadRuntimeService = {
			getThreads: () => [],
		};
		pane.rail = {
			getFilterState: () => ({ query: '', tab: 'all' }),
			setRows: () => undefined,
			setSelectedThread: (threadId: string | undefined) => {
				selectedThread = threadId;
			},
		};
		pane.showComposerForNewChat = () => {
			showComposerCalls += 1;
			pane.activeThreadId = undefined;
			pane.railVisible = false;
			pane.rail.setSelectedThread(undefined);
		};

		pane.refreshRailRows();

		assert.strictEqual(pane.activeThreadId, undefined);
		assert.strictEqual(selectedThread, undefined);
		assert.strictEqual(showComposerCalls, 1);
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

	test('submitPrompt is blocked while assistant apply is pending', async () => {
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as ISubmitPromptTarget & {
			hasPendingAssistantApply: (threadId: string) => boolean;
		};
		let submitCalls = 0;

		target.activeThreadId = 'thread-1';
		target.submittingPrompt = false;
		target.composerInput = document.createElement('textarea');
		target.composerInput.value = 'hello';
		target.composerSendButton = document.createElement('button');
		target.pendingImages = [];
		target.rail = { setSelectedThread: () => undefined };
		target.threadsById = new Map();
		target.historyService = { getThreads: () => [] };
		target.updateComposerState = () => undefined;
		target.updateComposerMetrics = () => undefined;
		target.renderImageStrip = () => undefined;
		target.refreshConversation = () => undefined;
		target.applyRailLayout = () => undefined;
		target.modelSwitcher = { refresh: () => undefined };
		target.planModeService = {
			initialize: async () => {
				throw new Error('plan mode init should not run when apply is pending');
			},
		};
		target.modelSelectionService = {
			initialize: async () => {
				throw new Error('model selection init should not run when apply is pending');
			},
			getCurrentSelectionForThread: () => ({
				threadId: 'thread-1',
				location: 'chat',
				modelIdentifier: 'openai/gpt-5.3-codex',
				vendor: 'openai',
				modelId: 'gpt-5.3-codex',
				modelName: 'GPT-5.3-Codex',
				selectedAt: Date.now(),
			}),
			setSelectionForThread: async () => undefined,
		};
		target.sessionService = {
			submitPrompt: async () => {
				submitCalls += 1;
				return { threadId: 'thread-1', sessionResource: 'vsclone://api/thread-1' };
			},
		};
		target.hasPendingAssistantApply = () => true;

		await target.submitPrompt();

		assert.strictEqual(submitCalls, 0);
		assert.strictEqual(target.submittingPrompt, false);
		assert.strictEqual(target.composerInput.value, 'hello');
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

	test('updateComposerState disables composer for pending assistant apply without showing stop mode', () => {
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		const target = pane as unknown as IComposerStateTarget & {
			hasPendingAssistantApply: (threadId: string) => boolean;
		};
		const composerInput = document.createElement('textarea');
		composerInput.value = 'hello';
		const composerSendButton = document.createElement('button');
		let capturedPlanModeBusy: boolean | undefined;

		target.activeThreadId = 'thread-1';
		target.submittingPrompt = false;
		target.composerInput = composerInput;
		target.composerSendButton = composerSendButton;
		target.getBusyThreadId = () => undefined;
		target.hasPendingAssistantApply = threadId => threadId === 'thread-1';
		target.getCurrentComposerModelSelection = () => ({
			threadId: 'thread-1',
			location: 'chat',
			modelIdentifier: 'openai/gpt-5.3-codex',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelName: 'GPT-5.3-Codex',
			selectedAt: Date.now(),
		});
		target.refreshPlanModeControl = composerBusy => {
			capturedPlanModeBusy = composerBusy;
		};
		target.getCurrentComposerMode = () => 'act';

		target.updateComposerState();

		assert.deepStrictEqual(
			{
				disabled: composerSendButton.disabled,
				stopMode: composerSendButton.classList.contains('stop-mode'),
				ariaLabel: composerSendButton.getAttribute('aria-label'),
				title: composerSendButton.title,
				inputDisabled: composerInput.disabled,
				placeholder: composerInput.placeholder,
				planModeBusy: capturedPlanModeBusy,
			},
			{
				disabled: true,
				stopMode: false,
				ariaLabel: 'Send message',
				title: 'Send message',
				inputDisabled: true,
				placeholder: 'Wait for edit application to finish...',
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
		target.getAssistantApplyState = (applyTarget: { id: string }) => applyTarget.id === 'turn-2'
			? { phase: 'failed' }
			: undefined;
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

	test('refreshConversation appends runtime workflow cards after persisted turns', () => {
		const pane = createPaneHarness() as unknown as IRefreshConversationTarget;
		let composerRefreshes = 0;
		let modelRefreshes = 0;
		let scrollRequests = 0;
		pane.activeThreadId = 'thread-1';
		pane.conversationList = document.createElement('div');
		pane.conversationEmptyState = document.createElement('div');
		pane.historyService = {
			getTurns: () => [],
		};
		pane.threadRuntimeService = {
			getState: () => ({
				threadId: 'thread-1',
				streamState: { kind: 'llm' },
				messages: [
					{
						role: 'tool',
						type: 'tool_request',
						toolName: 'edit_file',
						approvalType: 'edits',
						params: { path: 'src/app.ts' },
					},
					{
						role: 'tool',
						type: 'running_now',
						toolName: 'edit_file',
						approvalType: 'edits',
						params: { path: 'src/app.ts' },
					},
					{
						role: 'tool',
						type: 'success',
						toolName: 'edit_file',
						approvalType: 'edits',
						params: { path: 'src/app.ts' },
						output: 'Applied 1 edit.',
					},
					{
						role: 'checkpoint',
						checkpoint: {
							id: 'checkpoint-1',
							createdAt: 1,
							type: 'tool_edit',
							toolName: 'edit_file',
							snapshots: [{ uri: { toString: () => 'file:///workspace/src/app.ts' }, existed: true, content: 'before' }],
						},
					},
				],
				checkpoints: [],
				isRunning: true,
				lastUpdatedAt: 1,
			}),
			rewindToCheckpoint: async () => true,
		};
		pane.renderedMarkdownDisposables = {
			clear: () => undefined,
			add: value => value,
		};
		pane.markdownRendererService = createPlainTextMarkdownRendererStub();
		pane.updateComposerState = () => { composerRefreshes += 1; };
		pane.refreshModelControls = () => { modelRefreshes += 1; };
		pane.scheduleScrollToBottom = () => { scrollRequests += 1; };

		pane.refreshConversation();

		assert.strictEqual(pane.conversationEmptyState.classList.contains('hidden'), true);
		assert.ok(pane.conversationList.querySelector('.vsclone-runtime-status-badge'));
		assert.ok(pane.conversationList.querySelector('.vsclone-tool-card.status-success'));
		assert.ok(pane.conversationList.textContent?.includes('Completed edit_file (src/app.ts)'));
		assert.ok(pane.conversationList.querySelector('.vsclone-runtime-checkpoint-card'));
		assert.strictEqual(composerRefreshes, 1);
		assert.strictEqual(modelRefreshes, 1);
		assert.strictEqual(scrollRequests, 1);
	});

	test('openSession imports legacy turns into runtime without auto-applying imported assistant edits', async () => {
		const pane = createPaneHarness() as unknown as ITestPaneTarget & {
			editApplicationService: {
				hasSearchReplaceBlocks: (text: string) => boolean;
				startApplyingSearchReplaceBlocks: (text: string) => Promise<{
					attemptedEdits: number;
					appliedEdits: number;
					modifiedFiles: readonly unknown[];
					failures: readonly string[];
					fileChanges: readonly unknown[];
				}>;
			};
			notificationService: {
				info: (message: string) => void;
				warn: (message: string) => void;
				error: (message: string) => void;
			};
			threadRuntimeService: {
				getState: (threadId: string) => unknown;
				ensureHydratedFromHistory: (threadId: string, turns: IVSCloneChatHistoryTurn[]) => unknown;
				getAssistantEditApplicationState: (threadId: string, messageId: string) => unknown;
				setAssistantEditApplicationState: (threadId: string, messageId: string, state: unknown) => void;
			};
			historyService: {
				getTurns: (threadId: string) => IVSCloneChatHistoryTurn[];
			};
			pendingAssistantApplyMessageIds: Set<string>;
			refreshConversation: () => void;
			refreshPlanModeControl: () => void;
			refreshModelControls: () => void;
			applyRailLayout: () => void;
			focusInput: () => void;
			renderSearchReplaceAwareText: (container: HTMLElement, text: string, streaming: boolean) => void;
			appendMarkdownSegment: (container: HTMLElement, text: string, className: string) => void;
			looksLikePartialSearchReplaceBlock: (text: string) => boolean;
			renderRuntimeAssistantMessage: (message: { id: string; role: 'assistant'; createdAt: number; content: string }, threadId?: string) => HTMLElement;
			clipboardService: { writeText: (text: string) => Promise<void> };
			composerInput: HTMLTextAreaElement;
			pendingImages: Array<{ mimeType: string; base64Data: string; dataUrl: string }>;
			toPendingImages: (attachments: Array<{ mimeType: string; base64Data: string }> | undefined) => Array<{ mimeType: string; base64Data: string; dataUrl: string }>;
			renderImageStrip: () => void;
			updateComposerMetrics: () => void;
			copyPrompt: (threadId?: string) => Promise<void>;
			copyResponse: (threadId?: string) => Promise<void>;
			reusePrompt: (threadId?: string) => void;
		};
		const importedThreadIds: string[] = [];
		const applyCalls: string[] = [];
		const assistantApplyStates = new Map<string, unknown>();
		const clipboardWrites: string[] = [];
		let getTurnsCalls = 0;
		let selectedThread: string | undefined;
		pane.activeThreadId = undefined;
		pane.pendingAssistantApplyMessageIds = new Set();
		pane.railVisible = true;
		pane.rootContainer = document.createElement('div');
		pane.railContainer = document.createElement('div');
		pane.railResizeHandle = document.createElement('div');
		pane.threadsById = new Map([[
			'thread-import',
			{ threadId: 'thread-import', runtimeOwnedCatalog: false },
		]]);
		pane.rail = {
			getSelectedThread: () => selectedThread,
			setSelectedThread: (threadId: string | undefined) => { selectedThread = threadId; },
		};
		pane.historyService = {
			getTurns: () => {
				getTurnsCalls += 1;
				return [{
					turnId: 'thread-import:turn-1',
					threadId: 'thread-import',
					sequence: 1,
					promptText: 'Legacy prompt',
					responseMarkdown: 'Legacy response',
					responsePlainText: 'Legacy response',
					startedAt: 1,
					status: 'completed',
					lastEventAt: 1,
				} as IVSCloneChatHistoryTurn];
			},
		};
		let importedRuntimeState: {
			threadId: string;
			mode: 'plan';
			streamState: { kind: 'idle' };
			messages: Array<unknown>;
			assistantEditApplications?: Array<{ messageId: string; state: unknown }>;
			checkpoints: Array<unknown>;
			isRunning: boolean;
			lastUpdatedAt: number;
		} | undefined;
		pane.threadRuntimeService = {
			getState: () => importedRuntimeState,
			ensureHydratedFromHistory: (threadId, _turns) => {
				importedThreadIds.push(threadId);
				assistantApplyStates.clear();
				importedRuntimeState = {
					threadId,
					catalog: {
						threadId,
						title: 'Imported thread',
						createdAt: 1,
						updatedAt: 1,
						status: 'completed',
						archived: false,
						turnCount: 1,
						lastTurnPreview: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
						importedFromHistory: true,
					},
					mode: 'plan',
					streamState: { kind: 'idle' },
					messages: [
						{ id: 'msg-user', role: 'user', createdAt: 1, content: 'Imported prompt' },
						{
							id: 'msg-assistant',
							role: 'assistant',
							createdAt: 2,
							content: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
							mode: 'act',
							metadata: { importedFromHistory: true },
						},
					],
					checkpoints: [],
					isRunning: false,
					lastUpdatedAt: 1,
				};
				return importedRuntimeState;
			},
			getAssistantEditApplicationState: (_threadId, messageId) => assistantApplyStates.get(messageId),
			setAssistantEditApplicationState: (_threadId, messageId, state) => {
				assistantApplyStates.set(messageId, state);
				if (importedRuntimeState) {
					importedRuntimeState.assistantEditApplications = [...assistantApplyStates.entries()].map(([storedMessageId, storedState]) => ({
						messageId: storedMessageId,
						state: storedState,
					}));
				}
			},
		};
		pane.editApplicationService = {
			hasSearchReplaceBlocks: () => true,
			startApplyingSearchReplaceBlocks: async (text: string) => {
				applyCalls.push(text);
				return {
					attemptedEdits: 1,
					appliedEdits: 1,
					modifiedFiles: [],
					failures: [],
					fileChanges: [],
				};
			},
		};
		// The openSession auto-apply path always reports its result through notifications, so the
		// harness must provide those sinks or it will trip the error branch after a successful apply.
		pane.notificationService = {
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		};
		pane.refreshConversation = () => undefined;
		pane.refreshModelControls = () => undefined;
		pane.refreshPlanModeControl = () => undefined;
		pane.applyRailLayout = () => undefined;
		pane.focusInput = () => undefined;
		pane.clipboardService = {
			writeText: async (text: string) => {
				clipboardWrites.push(text);
			},
		};
		pane.composerInput = document.createElement('textarea');
		pane.pendingImages = [];
		pane.toPendingImages = attachments => attachments?.map((attachment, index) => ({
			...attachment,
			dataUrl: `data:${attachment.mimeType};base64,${index}`,
		})) ?? [];
		pane.renderImageStrip = () => undefined;
		pane.updateComposerMetrics = () => undefined;
		pane.renderSearchReplaceAwareText = (container: HTMLElement, text: string) => {
			container.textContent = text;
		};
		pane.appendMarkdownSegment = (container: HTMLElement, text: string) => {
			container.textContent = text;
		};
		pane.looksLikePartialSearchReplaceBlock = () => false;

		await pane.openSession('thread-import');
		await new Promise(resolve => setTimeout(resolve, 0));

		// History import should remain an explicit bridge into runtime ownership rather than a
		// fallback that later pane reads keep consulting behind the scenes.
		assert.deepStrictEqual(importedThreadIds, ['thread-import']);
		assert.strictEqual(getTurnsCalls, 1);
		assert.strictEqual(pane.threadsById.get('thread-import')?.runtimeOwnedCatalog, true);
		assert.strictEqual(selectedThread, 'thread-import');
		assert.deepStrictEqual(applyCalls, []);
		assert.strictEqual(assistantApplyStates.size, 0);
		await pane.copyPrompt('thread-import');
		await pane.copyResponse('thread-import');
		pane.reusePrompt('thread-import');
		assert.strictEqual(getTurnsCalls, 1);
		assert.deepStrictEqual(clipboardWrites, [
			'Imported prompt',
			'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
		]);
		assert.strictEqual(pane.composerInput.value, 'Imported prompt');
		const importedAssistantMessage = importedRuntimeState?.messages[1] as { id: string; role: 'assistant'; createdAt: number; content: string };
		const rendered = pane.renderRuntimeAssistantMessage(importedAssistantMessage, 'thread-import');
		const applyButton = rendered.querySelector('.vsclone-thread-message-apply') as HTMLButtonElement | null;
		assert.ok(applyButton);
		assert.strictEqual(applyButton.textContent, 'Apply Changes');
	});

	test('reloadHistory imports active legacy turns without auto-applying imported assistant edits', async () => {
		const pane = createPaneHarness() as unknown as {
			rootContainer: HTMLElement;
			railVisible: boolean;
			activeThreadId?: string;
			rail: {
				setLoading: () => void;
				setError: (message: string) => void;
			};
			historyReady: boolean;
			historyService: {
				initialize: () => Promise<void>;
				getThreads: (query?: { includeArchived?: boolean }) => Array<{
					threadId: string;
					sessionResource: string;
					title: string;
					createdAt: number;
					updatedAt: number;
					status: 'active' | 'completed' | 'failed' | 'archived';
					archived: boolean;
					turnCount: number;
					lastTurnPreview: string;
				}>;
				getTurns: (threadId: string) => IVSCloneChatHistoryTurn[];
			};
			planModeService: { initialize: () => Promise<void> };
			threadRuntimeService: {
				getState: (threadId: string) => unknown;
				ensureHydratedFromHistory: (threadId: string, turns: IVSCloneChatHistoryTurn[]) => unknown;
				getAssistantEditApplicationState: (threadId: string, messageId: string) => unknown;
			};
			editApplicationService: {
				hasSearchReplaceBlocks: (text: string) => boolean;
				startApplyingSearchReplaceBlocks: (text: string) => Promise<unknown>;
			};
			pendingAssistantApplyMessageIds: Set<string>;
			refreshRailRows: () => void;
			refreshConversation: () => void;
			applyRailLayout: () => void;
			renderSearchReplaceAwareText: (container: HTMLElement, text: string, streaming: boolean) => void;
			appendMarkdownSegment: (container: HTMLElement, text: string, className: string) => void;
			looksLikePartialSearchReplaceBlock: (text: string) => boolean;
			renderRuntimeAssistantMessage: (message: { id: string; role: 'assistant'; createdAt: number; content: string }, threadId?: string) => HTMLElement;
			reloadHistory: () => Promise<void>;
			clipboardService: { writeText: (text: string) => Promise<void> };
			composerInput: HTMLTextAreaElement;
			pendingImages: Array<{ mimeType: string; base64Data: string; dataUrl: string }>;
			toPendingImages: (attachments: Array<{ mimeType: string; base64Data: string }> | undefined) => Array<{ mimeType: string; base64Data: string; dataUrl: string }>;
			renderImageStrip: () => void;
			updateComposerMetrics: () => void;
			copyPrompt: (threadId?: string) => Promise<void>;
			copyResponse: (threadId?: string) => Promise<void>;
			reusePrompt: (threadId?: string) => void;
		};
		const applyCalls: string[] = [];
		const clipboardWrites: string[] = [];
		let getTurnsCalls = 0;
		let importedRuntimeState: {
			threadId: string;
			mode: 'act';
			streamState: { kind: 'idle' };
			messages: Array<unknown>;
			checkpoints: Array<unknown>;
			isRunning: boolean;
			lastUpdatedAt: number;
		} | undefined;
		pane.rootContainer = document.createElement('div');
		pane.railVisible = true;
		pane.activeThreadId = 'thread-reload';
		pane.historyReady = false;
		pane.pendingAssistantApplyMessageIds = new Set();
		pane.rail = {
			setLoading: () => undefined,
			setError: () => undefined,
		};
		pane.historyService = {
			initialize: async () => undefined,
			getThreads: () => [{
				threadId: 'thread-reload',
				sessionResource: 'vsclone://api/thread-reload',
				title: 'Reloaded thread',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Legacy response',
			}],
			getTurns: () => {
				getTurnsCalls += 1;
				return [{
					turnId: 'thread-reload:turn-1',
					threadId: 'thread-reload',
					sequence: 1,
					promptText: 'Legacy prompt',
					responseMarkdown: 'Legacy response',
					responsePlainText: 'Legacy response',
					startedAt: 1,
					status: 'completed',
					lastEventAt: 1,
				} as IVSCloneChatHistoryTurn];
			},
		};
		pane.planModeService = {
			initialize: async () => undefined,
		};
		pane.threadRuntimeService = {
			getState: () => importedRuntimeState,
			ensureHydratedFromHistory: (threadId) => {
				importedRuntimeState = {
					threadId,
					catalog: {
						threadId,
						title: 'Reloaded thread',
						createdAt: 1,
						updatedAt: 2,
						status: 'completed',
						archived: false,
						turnCount: 1,
						lastTurnPreview: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
						importedFromHistory: true,
					},
					mode: 'act',
					streamState: { kind: 'idle' },
					messages: [
						{ id: 'msg-user', role: 'user', createdAt: 1, content: 'Imported prompt' },
						{
							id: 'msg-assistant',
							role: 'assistant',
							createdAt: 2,
							content: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
							metadata: { importedFromHistory: true },
						},
					],
					checkpoints: [],
					isRunning: false,
					lastUpdatedAt: 2,
				};
				return importedRuntimeState;
			},
			getAssistantEditApplicationState: () => undefined,
		};
		pane.editApplicationService = {
			hasSearchReplaceBlocks: () => true,
			startApplyingSearchReplaceBlocks: async (text: string) => {
				applyCalls.push(text);
				return {};
			},
		};
		pane.refreshRailRows = () => undefined;
		pane.refreshConversation = () => undefined;
		pane.applyRailLayout = () => undefined;
		pane.clipboardService = {
			writeText: async (text: string) => {
				clipboardWrites.push(text);
			},
		};
		pane.composerInput = document.createElement('textarea');
		pane.pendingImages = [];
		pane.toPendingImages = attachments => attachments?.map((attachment, index) => ({
			...attachment,
			dataUrl: `data:${attachment.mimeType};base64,${index}`,
		})) ?? [];
		pane.renderImageStrip = () => undefined;
		pane.updateComposerMetrics = () => undefined;
		pane.renderSearchReplaceAwareText = (container: HTMLElement, text: string) => {
			container.textContent = text;
		};
		pane.appendMarkdownSegment = (container: HTMLElement, text: string) => {
			container.textContent = text;
		};
		pane.looksLikePartialSearchReplaceBlock = () => false;

		await pane.reloadHistory();

		assert.deepStrictEqual(applyCalls, []);
		assert.strictEqual(getTurnsCalls, 1);
		assert.strictEqual(pane.threadsById.get('thread-reload')?.runtimeOwnedCatalog, true);
		await pane.copyPrompt('thread-reload');
		await pane.copyResponse('thread-reload');
		pane.reusePrompt('thread-reload');
		assert.strictEqual(getTurnsCalls, 1);
		assert.deepStrictEqual(clipboardWrites, [
			'Imported prompt',
			'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
		]);
		assert.strictEqual(pane.composerInput.value, 'Imported prompt');
		const importedAssistantMessage = importedRuntimeState?.messages[1] as { id: string; role: 'assistant'; createdAt: number; content: string };
		const rendered = pane.renderRuntimeAssistantMessage(importedAssistantMessage, 'thread-reload');
		assert.ok(rendered.querySelector('.vsclone-thread-message-apply'));
	});

	test('reloadHistory does not import runtime-owned threads when runtime state is missing', async () => {
		const pane = createPaneHarness() as unknown as {
			rootContainer: HTMLElement;
			railVisible: boolean;
			activeThreadId?: string;
			historyReady: boolean;
			threadsById: Map<string, {
				threadId: string;
				sessionResource?: string;
				title: string;
				createdAt: number;
				updatedAt: number;
				status: 'active' | 'completed' | 'failed' | 'archived';
				archived: boolean;
				turnCount: number;
				lastTurnPreview: string;
				runtimeOwnedCatalog?: boolean;
			}>;
			rail: {
				setLoading: () => void;
				setError: (message: string) => void;
				setSelectedThread: (threadId: string | undefined) => void;
			};
			historyService: {
				initialize: () => Promise<void>;
				getThreads: () => Array<{
					threadId: string;
					sessionResource: string;
					title: string;
					createdAt: number;
					updatedAt: number;
					status: 'active' | 'completed' | 'failed' | 'archived';
					archived: boolean;
					turnCount: number;
					lastTurnPreview: string;
				}>;
				getTurns: (threadId: string) => IVSCloneChatHistoryTurn[];
			};
			planModeService: {
				initialize: () => Promise<void>;
			};
			threadRuntimeService: {
				getState: (threadId: string) => unknown;
				ensureHydratedFromHistory: (threadId: string, turns: IVSCloneChatHistoryTurn[]) => unknown;
				getThreads?: () => unknown[];
			};
			refreshRailRows: () => void;
			refreshConversation: () => void;
			applyRailLayout: () => void;
			focusInput: () => void;
			refreshPlanModeControl: () => void;
			refreshModelControls: () => void;
			reloadHistory: () => Promise<void>;
		};
		let getTurnsCalls = 0;
		let hydrateCalls = 0;
		let refreshConversationCalls = 0;

		pane.rootContainer = document.createElement('div');
		pane.railVisible = true;
		pane.activeThreadId = 'thread-runtime';
		pane.historyReady = false;
		pane.threadsById = new Map([
			['thread-runtime', {
				threadId: 'thread-runtime',
				title: 'Runtime thread',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 0,
				lastTurnPreview: '',
				runtimeOwnedCatalog: true,
			}],
		]);
		pane.rail = {
			setLoading: () => undefined,
			setError: () => undefined,
			setSelectedThread: () => undefined,
		};
		pane.historyService = {
			initialize: async () => undefined,
			getThreads: () => [],
			getTurns: () => {
				getTurnsCalls += 1;
				throw new Error('runtime-owned reload should not reread legacy turns when runtime state is missing');
			},
		};
		pane.planModeService = {
			initialize: async () => undefined,
		};
		pane.threadRuntimeService = {
			getState: () => undefined,
			ensureHydratedFromHistory: () => {
				hydrateCalls += 1;
				throw new Error('runtime-owned reload should not trigger legacy hydration when runtime state is missing');
			},
			getThreads: () => [],
		};
		pane.refreshRailRows = () => undefined;
		pane.refreshConversation = () => {
			refreshConversationCalls += 1;
		};
		pane.applyRailLayout = () => undefined;
		pane.focusInput = () => undefined;
		pane.refreshPlanModeControl = () => undefined;
		pane.refreshModelControls = () => undefined;

		await pane.reloadHistory();

		assert.strictEqual(getTurnsCalls, 0);
		assert.strictEqual(hydrateCalls, 0);
		assert.strictEqual(refreshConversationCalls, 1);
		assert.strictEqual(pane.activeThreadId, 'thread-runtime');
	});

	test('reloadHistory fails closed when the active legacy-only thread cannot be imported into runtime', async () => {
		const pane = createPaneHarness() as unknown as {
			rootContainer: HTMLElement;
			railVisible: boolean;
			activeThreadId?: string;
			historyReady: boolean;
			threadsById: Map<string, {
				threadId: string;
				runtimeOwnedCatalog?: boolean;
			}>;
			rail: {
				setLoading: () => void;
				setError: (message: string) => void;
				setSelectedThread: (threadId: string | undefined) => void;
			};
			historyService: {
				initialize: () => Promise<void>;
				getThreads: () => Array<{
					threadId: string;
					sessionResource: string;
					title: string;
					createdAt: number;
					updatedAt: number;
					status: 'active' | 'completed' | 'failed' | 'archived';
					archived: boolean;
					turnCount: number;
					lastTurnPreview: string;
				}>;
				getTurns: (threadId: string) => IVSCloneChatHistoryTurn[];
			};
			planModeService: {
				initialize: () => Promise<void>;
			};
			threadRuntimeService: {
				getState: (threadId: string) => unknown;
				ensureHydratedFromHistory: (threadId: string, turns: IVSCloneChatHistoryTurn[]) => unknown;
			};
			refreshRailRows: () => void;
			refreshConversation: () => void;
			applyRailLayout: () => void;
			focusInput: () => void;
			refreshPlanModeControl: () => void;
			refreshModelControls: () => void;
			showComposerForNewChat: () => void;
			reloadHistory: () => Promise<void>;
		};
		let selectedThread: string | undefined = 'thread-legacy';
		let getTurnsCalls = 0;
		let refreshConversationCalls = 0;
		let showComposerCalls = 0;

		pane.rootContainer = document.createElement('div');
		pane.railVisible = true;
		pane.activeThreadId = 'thread-legacy';
		pane.historyReady = false;
		pane.threadsById = new Map();
		pane.rail = {
			setLoading: () => undefined,
			setError: () => undefined,
			setSelectedThread: (threadId: string | undefined) => {
				selectedThread = threadId;
			},
		};
		pane.historyService = {
			initialize: async () => undefined,
			getThreads: () => [{
				threadId: 'thread-legacy',
				sessionResource: 'vsclone://api/thread-legacy',
				title: 'Legacy thread',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Legacy response',
			}],
			getTurns: (threadId: string) => {
				getTurnsCalls += 1;
				assert.strictEqual(threadId, 'thread-legacy');
				return [{
					turnId: 'thread-legacy:turn-1',
					threadId: 'thread-legacy',
					sequence: 1,
					promptText: 'Legacy prompt',
					responseMarkdown: 'Legacy response',
					responsePlainText: 'Legacy response',
					startedAt: 1,
					status: 'completed',
					lastEventAt: 1,
				} as IVSCloneChatHistoryTurn];
			},
		};
		pane.planModeService = {
			initialize: async () => undefined,
		};
		pane.threadRuntimeService = {
			getState: () => undefined,
			ensureHydratedFromHistory: () => undefined,
		};
		pane.refreshRailRows = () => undefined;
		pane.refreshConversation = () => {
			refreshConversationCalls += 1;
		};
		pane.applyRailLayout = () => undefined;
		pane.focusInput = () => undefined;
		pane.refreshPlanModeControl = () => undefined;
		pane.refreshModelControls = () => undefined;
		pane.showComposerForNewChat = () => {
			showComposerCalls += 1;
			pane.activeThreadId = undefined;
			pane.railVisible = false;
			pane.rail.setSelectedThread(undefined);
		};

		await pane.reloadHistory();

		assert.strictEqual(getTurnsCalls, 1);
		assert.strictEqual(showComposerCalls, 1);
		assert.strictEqual(refreshConversationCalls, 0);
		assert.strictEqual(pane.activeThreadId, undefined);
		assert.strictEqual(selectedThread, undefined);
		assert.strictEqual(pane.threadsById.get('thread-legacy')?.runtimeOwnedCatalog, false);
	});

	test('active runtime threads do not fall back to legacy history when runtime state is missing', () => {
		const pane = createPaneHarness() as unknown as IRefreshConversationTarget;
		let importCalls = 0;
		pane.activeThreadId = 'thread-runtime';
		pane.conversationList = document.createElement('div');
		pane.conversationEmptyState = document.createElement('div');
		pane.historyService = {
			getTurns: () => [{
				turnId: 'thread-runtime:history-turn',
				threadId: 'thread-runtime',
				sequence: 1,
				promptText: 'stale history prompt',
				promptImages: [{ mimeType: 'image/png', base64Data: 'c3RhbGU=' }],
				responseMarkdown: 'stale history response',
				responsePlainText: 'stale history response',
				startedAt: 1,
				completedAt: 2,
				status: 'completed',
				lastEventAt: 2,
			} as IVSCloneChatHistoryTurn],
		};
		pane.threadRuntimeService = {
			getState: () => undefined,
			// This case verifies that the pane no longer renders legacy turns inline when runtime is
			// absent and no migration import is available either.
			ensureHydratedFromHistory: () => {
				importCalls += 1;
				return undefined;
			},
		};
		pane.renderedMarkdownDisposables = {
			clear: () => undefined,
			add: value => value,
		};
		pane.markdownRendererService = createPlainTextMarkdownRendererStub();
		pane.updateComposerState = () => undefined;
		pane.refreshModelControls = () => undefined;
		pane.scheduleScrollToBottom = () => undefined;

		pane.refreshConversation();

		assert.strictEqual(importCalls, 0);
		assert.strictEqual(pane.conversationEmptyState.classList.contains('hidden'), false);
		assert.strictEqual(pane.conversationList.querySelector('.vsclone-thread-message'), null);
	});

	test('renderRuntimeAssistantMessage strips workflow XML and keeps user-facing prose', () => {
		const pane = createPaneHarness() as unknown as IRenderRuntimeAssistantMessageTarget;
		const markdownSegments: string[] = [];
		pane.renderSearchReplaceAwareText = (_container: HTMLElement, _text: string, _streaming: boolean) => {
			assert.fail('search/replace renderer should not be used for plain prose');
		};
		pane.appendMarkdownSegment = (container: HTMLElement, text: string, className: string) => {
			markdownSegments.push(text);
			const element = document.createElement('div');
			element.className = className;
			element.textContent = text;
			container.appendChild(element);
		};
		pane.looksLikePartialSearchReplaceBlock = () => false;

		const rendered = pane.renderRuntimeAssistantMessage({
			role: 'assistant',
			createdAt: 1,
			content: [
				'Here is the final answer.',
				'<agent_trace type="thinking">Inspecting workspace</agent_trace>',
				'<tool_call><tool_name>edit_file</tool_name></tool_call>',
				'<tool_result tool_name="edit_file" success="true">Applied edit.</tool_result>',
				'One more visible sentence.',
			].join('\n'),
		});

		assert.deepStrictEqual(markdownSegments, ['Here is the final answer.\n\n\n\nOne more visible sentence.']);
		assert.strictEqual(rendered.textContent?.includes('Inspecting workspace'), false);
		assert.strictEqual(rendered.textContent?.includes('Applied edit.'), false);
		assert.strictEqual(rendered.textContent?.includes('One more visible sentence.'), true);
	});

	test('renderRuntimeAssistantMessage keeps imported pending assistant apply state visible', () => {
		const pane = createPaneHarness() as unknown as IRenderRuntimeAssistantMessageTarget & {
			pendingAssistantApplyMessageIds: Set<string>;
			editApplicationService: {
				hasSearchReplaceBlocks: (text: string) => boolean;
			};
		};
		pane.pendingAssistantApplyMessageIds = new Set();
		pane.editApplicationService = {
			hasSearchReplaceBlocks: () => true,
		};
		pane.threadRuntimeService = {
			getState: () => ({
				threadId: 'thread-1',
				streamState: { kind: 'idle' },
				messages: [{
					id: 'assistant-pending',
					role: 'assistant',
					createdAt: 1,
					content: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
					metadata: { importedFromHistory: true },
				}],
				assistantEditApplications: [{
					messageId: 'assistant-pending',
					state: { phase: 'pending' },
				}],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 1,
			}),
			getAssistantEditApplicationState: () => ({ phase: 'pending' }),
		};
		pane.renderSearchReplaceAwareText = (container: HTMLElement, text: string) => {
			container.textContent = text;
		};
		pane.appendMarkdownSegment = (container: HTMLElement, text: string) => {
			container.textContent = text;
		};
		pane.looksLikePartialSearchReplaceBlock = () => false;

		const rendered = pane.renderRuntimeAssistantMessage({
			id: 'assistant-pending',
			role: 'assistant',
			createdAt: 1,
			content: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
			metadata: { importedFromHistory: true },
		}, 'thread-1');

		assert.strictEqual(rendered.querySelector('.vsclone-thread-message-apply')?.textContent, 'Applying changes...');
	});

	test('isThreadBusy trusts runtime state over stale history turns', () => {
		const pane = createPaneHarness() as unknown as IRefreshConversationTarget & {
			isThreadBusy: (threadId: string) => boolean;
		};
		pane.historyService = {
			getTurns: () => [{
				turnId: 'thread-1:turn-1',
				threadId: 'thread-1',
				sequence: 1,
				promptText: 'legacy',
				responseMarkdown: '',
				responsePlainText: '',
				startedAt: 1,
				status: 'streaming',
				lastEventAt: 1,
			} as IVSCloneChatHistoryTurn],
		};
		pane.threadRuntimeService = {
			getState: () => ({
				threadId: 'thread-1',
				streamState: { kind: 'idle' },
				messages: [],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 1,
			}),
		};

		assert.strictEqual(pane.isThreadBusy('thread-1'), false);
	});

	test('isThreadBusy does not fall back to legacy history when runtime is absent', () => {
		const pane = createPaneHarness() as unknown as IRefreshConversationTarget & {
			isThreadBusy: (threadId: string) => boolean;
		};
		pane.historyService = {
			getTurns: () => [{
				turnId: 'thread-1:turn-1',
				threadId: 'thread-1',
				sequence: 1,
				promptText: 'legacy',
				responseMarkdown: '',
				responsePlainText: '',
				startedAt: 1,
				status: 'streaming',
				lastEventAt: 1,
			} as IVSCloneChatHistoryTurn],
		};
		pane.threadRuntimeService = {
			getState: () => undefined,
		};

		assert.strictEqual(pane.isThreadBusy('thread-1'), false);
	});

	test('auto-apply waits for the runtime thread to become idle before starting edits', () => {
		const pane = createPaneHarness() as unknown as {
			maybeAutoApplyRuntimeAssistantMessages: (state: {
				threadId: string;
				streamState: { kind: 'llm' | 'idle' };
				messages: Array<{ id: string; role: 'assistant'; content: string }>;
				checkpoints: Array<unknown>;
				isRunning: boolean;
				lastUpdatedAt: number;
			}) => void;
			editApplicationService: {
				hasSearchReplaceBlocks: (text: string) => boolean;
				startApplyingSearchReplaceBlocks: (text: string) => Promise<unknown>;
			};
			threadRuntimeService: {
				getState: (threadId: string) => unknown;
				getAssistantEditApplicationState: (threadId: string, messageId: string) => unknown;
				setAssistantEditApplicationState: (threadId: string, messageId: string, state: unknown) => void;
			};
		};
		const startCalls: string[] = [];
		const persistedStates: unknown[] = [];
		const busyState = {
			threadId: 'thread-1',
			streamState: { kind: 'llm' as const },
			messages: [{
				id: 'assistant-busy',
				role: 'assistant' as const,
				content: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
			}],
			checkpoints: [],
			isRunning: true,
			lastUpdatedAt: 1,
		};
		pane.editApplicationService = {
			hasSearchReplaceBlocks: () => true,
			startApplyingSearchReplaceBlocks: async (text: string) => {
				startCalls.push(text);
				return {};
			},
		};
		pane.threadRuntimeService = {
			getState: () => busyState,
			getAssistantEditApplicationState: () => undefined,
			setAssistantEditApplicationState: (_threadId, _messageId, state) => {
				persistedStates.push(state);
			},
		};

		pane.maybeAutoApplyRuntimeAssistantMessages(busyState);

		assert.deepStrictEqual(startCalls, []);
		assert.deepStrictEqual(persistedStates, []);
	});

	test('manual apply persists pending in runtime before the engine bridge settles', async () => {
		const pane = createPaneHarness() as unknown as {
			pendingAssistantApplyMessageIds: Set<string>;
			applyAssistantEdits: (target: { threadId: string; id: string; responseText: string }, button: HTMLButtonElement) => Promise<void>;
			editApplicationService: {
				startApplyingSearchReplaceBlocks: (responseText: string) => Promise<{
					attemptedEdits: number;
					appliedEdits: number;
					modifiedFiles: readonly unknown[];
					failures: readonly string[];
					fileChanges: readonly unknown[];
				}>;
			};
			threadRuntimeService: {
				getState: (threadId: string) => unknown;
				setAssistantEditApplicationState: (threadId: string, messageId: string, state: unknown) => void;
			};
			notificationService: {
				info: (message: string) => void;
				warn: (message: string) => void;
				error: (message: string) => void;
			};
			refreshConversation: () => void;
		};
		const persistedPhases: string[] = [];
		let resolveApply: (() => void) | undefined;
		const applyStarted = new Promise<void>(resolve => {
			resolveApply = resolve;
		});
		pane.pendingAssistantApplyMessageIds = new Set();
		pane.editApplicationService = {
			startApplyingSearchReplaceBlocks: async () => {
				await applyStarted;
				return {
					attemptedEdits: 1,
					appliedEdits: 1,
					modifiedFiles: [],
					failures: [],
					fileChanges: [],
				};
			},
		};
		pane.threadRuntimeService = {
			getState: () => ({
				threadId: 'thread-1',
				streamState: { kind: 'idle' },
				messages: [],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 1,
			}),
			setAssistantEditApplicationState: (_threadId, _messageId, state) => {
				persistedPhases.push((state as { phase: string }).phase);
			},
		};
		pane.notificationService = {
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		};
		pane.refreshConversation = () => undefined;
		const button = document.createElement('button');

		const applyPromise = pane.applyAssistantEdits({
			threadId: 'thread-1',
			id: 'assistant-apply',
			responseText: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
		}, button);
		await Promise.resolve();

		assert.deepStrictEqual(persistedPhases, ['pending']);
		assert.strictEqual(pane.pendingAssistantApplyMessageIds.has('assistant-apply'), true);

		resolveApply?.();
		await applyPromise;

		assert.deepStrictEqual(persistedPhases, ['pending', 'applied']);
		assert.strictEqual(pane.pendingAssistantApplyMessageIds.has('assistant-apply'), false);
	});

	test('manual apply is disabled and refused while the runtime thread is busy', async () => {
		const pane = createPaneHarness() as unknown as IRenderRuntimeAssistantMessageTarget & {
			pendingAssistantApplyMessageIds: Set<string>;
			applyAssistantEdits: (target: { threadId: string; id: string; responseText: string }, button: HTMLButtonElement) => Promise<void>;
			editApplicationService: {
				hasSearchReplaceBlocks: () => boolean;
				startApplyingSearchReplaceBlocks: (responseText: string) => Promise<unknown>;
			};
			notificationService: {
				info: (message: string) => void;
				warn: (message: string) => void;
				error: (message: string) => void;
			};
			threadRuntimeService: {
				getState: (threadId: string) => unknown;
				getAssistantEditApplicationState: (threadId: string, messageId: string) => unknown;
				setAssistantEditApplicationState: (threadId: string, messageId: string, state: unknown) => void;
			};
			refreshConversation: () => void;
		};
		const calls: string[] = [];
		const warnings: string[] = [];
		pane.pendingAssistantApplyMessageIds = new Set();
		const busyState = {
			threadId: 'thread-1',
			streamState: { kind: 'llm' as const },
			messages: [{
				id: 'assistant-apply',
				role: 'assistant' as const,
				createdAt: 1,
				content: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
			}],
			assistantEditApplications: [{
				messageId: 'assistant-apply',
				state: { phase: 'failed' },
			}],
			checkpoints: [],
			isRunning: true,
			lastUpdatedAt: 1,
		};
		pane.editApplicationService = {
			hasSearchReplaceBlocks: () => true,
			startApplyingSearchReplaceBlocks: async (responseText: string) => {
				calls.push(responseText);
				return {};
			},
		};
		pane.notificationService = {
			info: () => undefined,
			warn: (message: string) => { warnings.push(message); },
			error: () => undefined,
		};
		pane.threadRuntimeService = {
			getState: () => busyState,
			getAssistantEditApplicationState: () => ({ phase: 'failed' }),
			setAssistantEditApplicationState: () => undefined,
		};
		pane.refreshConversation = () => undefined;
		pane.renderSearchReplaceAwareText = (container: HTMLElement, text: string) => {
			container.textContent = text;
		};
		pane.appendMarkdownSegment = (container: HTMLElement, text: string) => {
			container.textContent = text;
		};
		pane.looksLikePartialSearchReplaceBlock = () => false;

		const rendered = pane.renderRuntimeAssistantMessage(busyState.messages[0], 'thread-1');
		const applyButton = rendered.querySelector('.vsclone-thread-message-apply') as HTMLButtonElement | null;
		assert.ok(applyButton);
		assert.strictEqual(applyButton?.disabled, true);

		await pane.applyAssistantEdits({
			threadId: 'thread-1',
			id: 'assistant-apply',
			responseText: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
		}, document.createElement('button'));

		assert.deepStrictEqual(calls, []);
		assert.strictEqual(warnings.length, 1);
	});

	test('undo and redo are disabled and refused while the runtime thread is busy', async () => {
		const pane = createPaneHarness() as unknown as IRenderRuntimeAssistantMessageTarget & {
			undoAssistantEdits: (target: { threadId: string; id: string; responseText: string }, result: { fileChanges: Array<{ uri: URI; displayPath: string; addedLines: number; removedLines: number; action: 'modify' }> }, button: HTMLButtonElement) => Promise<void>;
			redoAssistantEdits: (target: { threadId: string; id: string; responseText: string }, button: HTMLButtonElement) => Promise<void>;
			editApplicationService: {
				hasSearchReplaceBlocks: () => boolean;
				undoEditApply: (fileChanges: readonly unknown[]) => Promise<unknown>;
				startApplyingSearchReplaceBlocks: (responseText: string) => Promise<unknown>;
			};
			notificationService: {
				info: (message: string) => void;
				warn: (message: string) => void;
				error: (message: string) => void;
			};
			threadRuntimeService: {
				getState: (threadId: string) => unknown;
				getAssistantEditApplicationState: (threadId: string, messageId: string) => unknown;
				setAssistantEditApplicationState: (threadId: string, messageId: string, state: unknown) => void;
			};
			refreshConversation: () => void;
		};
		const warnings: string[] = [];
		let undoCalls = 0;
		let redoCalls = 0;
		const appliedResult = {
			fileChanges: [{ uri: URI.parse('file:///workspace/src/app.ts'), displayPath: 'src/app.ts', addedLines: 1, removedLines: 1, action: 'modify' as const }],
		};
		const busyAppliedState = {
			threadId: 'thread-1',
			streamState: { kind: 'tool' as const },
			messages: [{
				id: 'assistant-applied',
				role: 'assistant' as const,
				createdAt: 1,
				content: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
			}],
			assistantEditApplications: [{
				messageId: 'assistant-applied',
				state: {
					phase: 'applied',
					result: {
						attemptedEdits: 1,
						appliedEdits: 1,
						modifiedFiles: [],
						failures: [],
						fileChanges: appliedResult.fileChanges,
					},
				},
			}, {
				messageId: 'assistant-redo',
				state: {
					phase: 'undone',
					result: {
						attemptedEdits: 1,
						appliedEdits: 1,
						modifiedFiles: [],
						failures: [],
						fileChanges: appliedResult.fileChanges,
					},
				},
			}],
			checkpoints: [],
			isRunning: true,
			lastUpdatedAt: 1,
		};
		pane.editApplicationService = {
			hasSearchReplaceBlocks: () => true,
			undoEditApply: async () => {
				undoCalls += 1;
				return {};
			},
			startApplyingSearchReplaceBlocks: async () => {
				redoCalls += 1;
				return {};
			},
		};
		pane.notificationService = {
			info: () => undefined,
			warn: (message: string) => { warnings.push(message); },
			error: () => undefined,
		};
		pane.threadRuntimeService = {
			getState: () => busyAppliedState,
			getAssistantEditApplicationState: (_threadId, messageId) => busyAppliedState.assistantEditApplications.find(entry => entry.messageId === messageId)?.state,
			setAssistantEditApplicationState: () => undefined,
		};
		pane.refreshConversation = () => undefined;
		pane.renderSearchReplaceAwareText = (container: HTMLElement, text: string) => {
			container.textContent = text;
		};
		pane.appendMarkdownSegment = (container: HTMLElement, text: string) => {
			container.textContent = text;
		};
		pane.looksLikePartialSearchReplaceBlock = () => false;

		const undoRendered = pane.renderRuntimeAssistantMessage(busyAppliedState.messages[0], 'thread-1');
		const undoButton = Array.from(undoRendered.querySelectorAll('button')).find(button => button.textContent === 'Undo') as HTMLButtonElement | undefined;
		assert.ok(undoButton);
		assert.strictEqual(undoButton?.disabled, true);

		await pane.undoAssistantEdits({
			threadId: 'thread-1',
			id: 'assistant-applied',
			responseText: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
		}, { fileChanges: appliedResult.fileChanges }, document.createElement('button'));

		busyAppliedState.messages = [{
			id: 'assistant-redo',
			role: 'assistant' as const,
			createdAt: 1,
			content: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
		}];
		const redoRendered = pane.renderRuntimeAssistantMessage(busyAppliedState.messages[0], 'thread-1');
		const redoButton = Array.from(redoRendered.querySelectorAll('button')).find(button => button.textContent === 'Redo') as HTMLButtonElement | undefined;
		assert.ok(redoButton);
		assert.strictEqual(redoButton?.disabled, true);

		await pane.redoAssistantEdits({
			threadId: 'thread-1',
			id: 'assistant-redo',
			responseText: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
		}, document.createElement('button'));

		assert.strictEqual(undoCalls, 0);
		assert.strictEqual(redoCalls, 0);
		assert.strictEqual(warnings.length, 2);
	});

	test('runAutoApply uses the engine-native start-applying path for assistant edits', async () => {
		const pane = createPaneHarness() as unknown as IRunAutoApplyTarget;
		const calls: string[] = [];
		let recordedState: unknown;
		let refreshCalls = 0;
		pane.editApplicationService = {
			startApplyingSearchReplaceBlocks: async (responseText: string) => {
				calls.push(`start:${responseText}`);
				return {
					attemptedEdits: 1,
					appliedEdits: 1,
					modifiedFiles: [],
					failures: [],
					fileChanges: [],
				};
			},
			applySearchReplaceBlocks: async () => {
				calls.push('legacy');
				throw new Error('legacy apply path should not be used');
			},
		};
		pane.notificationService = {
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		};
		pane.setAssistantApplyState = (_target: { threadId: string; id: string; responseText: string }, state: unknown) => {
			recordedState = state;
		};
		pane.refreshConversation = () => {
			refreshCalls += 1;
		};

		await pane.runAutoApply(
			{ threadId: 'thread-1', id: 'assistant-1', responseText: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE' },
			'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
		);

		assert.deepStrictEqual(calls, ['start:File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE']);
		assert.deepStrictEqual(recordedState, {
			phase: 'applied',
			result: {
				attemptedEdits: 1,
				appliedEdits: 1,
				modifiedFiles: [],
				failures: [],
				fileChanges: [],
			},
		});
		assert.strictEqual(refreshCalls, 1);
	});

	test('runAutoApply preserves partial assistant apply state when some edits fail', async () => {
		const pane = createPaneHarness() as unknown as IRunAutoApplyTarget;
		let recordedState: unknown;
		let refreshCalls = 0;
		const infos: string[] = [];
		const warnings: string[] = [];
		pane.editApplicationService = {
			startApplyingSearchReplaceBlocks: async () => ({
				attemptedEdits: 2,
				appliedEdits: 1,
				modifiedFiles: [{ toString: () => 'file:///workspace/src/app.ts' }],
				failures: ['Could not match src/other.ts'],
				fileChanges: [
					{ uri: { toString: () => 'file:///workspace/src/app.ts' }, displayPath: 'src/app.ts', addedLines: 1, removedLines: 1, action: 'modify' },
				],
			}),
			applySearchReplaceBlocks: async () => {
				throw new Error('legacy apply path should not be used');
			},
		};
		pane.notificationService = {
			info: (message: string) => { infos.push(message); },
			warn: (message: string) => { warnings.push(message); },
			error: () => undefined,
		};
		pane.setAssistantApplyState = (_target: { threadId: string; id: string; responseText: string }, state: unknown) => {
			recordedState = state;
		};
		pane.refreshConversation = () => {
			refreshCalls += 1;
		};

		await pane.runAutoApply(
			{ threadId: 'thread-1', id: 'assistant-partial', responseText: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE' },
			'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
		);

		assert.strictEqual((recordedState as { phase: string }).phase, 'partial');
		assert.strictEqual((recordedState as { retryAction: string }).retryAction, 'apply');
		assert.strictEqual(((recordedState as { result: { appliedEdits: number } }).result).appliedEdits, 1);
		assert.deepStrictEqual(((recordedState as { result: { failures: readonly string[] } }).result).failures, ['Could not match src/other.ts']);
		assert.strictEqual(((recordedState as { result: { fileChanges: readonly unknown[] } }).result).fileChanges.length, 1);
		assert.strictEqual(infos.length, 0);
		assert.strictEqual(warnings.length, 1);
		assert.strictEqual(refreshCalls, 1);
	});

	test('renderRuntimeAssistantMessage keeps partial apply retry visible', () => {
		const pane = createPaneHarness() as unknown as IRenderRuntimeAssistantMessageTarget & {
			editApplicationService: {
				hasSearchReplaceBlocks: () => boolean;
			};
		};
		const runtimeState = {
			threadId: 'thread-1',
			streamState: { kind: 'idle' as const },
			messages: [{
				id: 'assistant-partial',
				role: 'assistant' as const,
				createdAt: 1,
				content: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
			}],
			assistantEditApplications: [{
				messageId: 'assistant-partial',
				state: {
					phase: 'partial',
					retryAction: 'apply',
					result: {
						attemptedEdits: 2,
						appliedEdits: 1,
						modifiedFiles: [{ toString: () => 'file:///workspace/src/app.ts' }],
						failures: ['Could not match src/other.ts'],
						fileChanges: [
							{ uri: { toString: () => 'file:///workspace/src/app.ts' }, displayPath: 'src/app.ts', addedLines: 1, removedLines: 1, action: 'modify' as const },
						],
					},
				},
			}],
			checkpoints: [],
			isRunning: false,
			lastUpdatedAt: 1,
		};
		pane.editApplicationService = {
			hasSearchReplaceBlocks: () => true,
		};
		pane.threadRuntimeService = {
			getState: () => runtimeState,
			getAssistantEditApplicationState: () => runtimeState.assistantEditApplications[0].state,
		};
		pane.renderSearchReplaceAwareText = (container: HTMLElement, text: string) => {
			container.textContent = text;
		};
		pane.appendMarkdownSegment = (container: HTMLElement, text: string) => {
			container.textContent = text;
		};
		pane.looksLikePartialSearchReplaceBlock = () => false;

		const rendered = pane.renderRuntimeAssistantMessage(runtimeState.messages[0], 'thread-1');
		const retryButton = Array.from(rendered.querySelectorAll('button')).find(button => button.textContent === 'Retry Apply');

		assert.ok(retryButton);
		assert.ok(rendered.querySelector('.vsclone-edit-apply-summary.phase-partial'));
	});

	test('manual redo rewires through the engine-native bridge and preserves the apply summary state', async () => {
		const pane = createPaneHarness() as unknown as IRenderRuntimeAssistantMessageTarget & {
			pendingAssistantApplyMessageIds: Set<string>;
			editApplicationService: {
				hasSearchReplaceBlocks: () => boolean;
				startApplyingSearchReplaceBlocks: (responseText: string) => Promise<{
					attemptedEdits: number;
					appliedEdits: number;
					modifiedFiles: readonly unknown[];
					failures: readonly string[];
					fileChanges: readonly Array<{ uri: { toString(): string }; displayPath: string; addedLines: number; removedLines: number; action: 'create' | 'modify' }>;
				}>;
				applySearchReplaceBlocks: (responseText: string) => Promise<unknown>;
			};
			threadRuntimeService: {
				getState: (threadId: string) => {
					threadId: string;
					streamState: { kind: 'idle' };
					messages: Array<unknown>;
					assistantEditApplications?: Array<{ messageId: string; state: unknown }>;
					checkpoints: Array<unknown>;
					isRunning: boolean;
					lastUpdatedAt: number;
				} | undefined;
				getAssistantEditApplicationState: (threadId: string, messageId: string) => unknown;
				setAssistantEditApplicationState: (threadId: string, messageId: string, state: unknown) => void;
			};
			refreshConversation: () => void;
		};
		const calls: string[] = [];
		let refreshCalls = 0;
		pane.pendingAssistantApplyMessageIds = new Set();
		let runtimeState = {
			threadId: 'thread-1',
			streamState: { kind: 'idle' as const },
			messages: [
				{
					id: 'assistant-redo',
					role: 'assistant' as const,
					createdAt: 1,
					content: [
						'File: src/a.ts',
						'<<<<<<< SEARCH',
						'old',
						'=======',
						'new',
						'>>>>>>> REPLACE',
					].join('\n'),
				},
			],
			assistantEditApplications: [{
				messageId: 'assistant-redo',
				state: {
					phase: 'undone',
					result: {
						attemptedEdits: 2,
						appliedEdits: 2,
						modifiedFiles: [
							{ toString: () => 'file:///workspace/src/a.ts' },
							{ toString: () => 'file:///workspace/src/b.ts' },
						],
						failures: [],
						fileChanges: [
							{ uri: { toString: () => 'file:///workspace/src/a.ts' }, displayPath: 'src/a.ts', addedLines: 1, removedLines: 1, action: 'modify' },
							{ uri: { toString: () => 'file:///workspace/src/b.ts' }, displayPath: 'src/b.ts', addedLines: 2, removedLines: 0, action: 'create' },
						],
					},
				},
			}],
			checkpoints: [],
			isRunning: false,
			lastUpdatedAt: 1,
		};
		pane.editApplicationService = {
			hasSearchReplaceBlocks: () => true,
			startApplyingSearchReplaceBlocks: async (responseText: string) => {
				calls.push(responseText);
				return {
					attemptedEdits: 2,
					appliedEdits: 2,
					modifiedFiles: [
						{ toString: () => 'file:///workspace/src/a.ts' },
						{ toString: () => 'file:///workspace/src/b.ts' },
					],
					failures: [],
					fileChanges: [
						{ uri: { toString: () => 'file:///workspace/src/a.ts' }, displayPath: 'src/a.ts', addedLines: 1, removedLines: 1, action: 'modify' },
						{ uri: { toString: () => 'file:///workspace/src/b.ts' }, displayPath: 'src/b.ts', addedLines: 2, removedLines: 0, action: 'create' },
					],
				};
			},
			applySearchReplaceBlocks: async () => {
				throw new Error('legacy apply path should not be used for redo');
			},
		};
		pane.notificationService = {
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		};
		pane.threadRuntimeService = {
			getState: threadId => threadId === 'thread-1' ? runtimeState : undefined,
			getAssistantEditApplicationState: (threadId, messageId) => threadId === 'thread-1'
				? runtimeState.assistantEditApplications?.find(entry => entry.messageId === messageId)?.state
				: undefined,
			setAssistantEditApplicationState: (_threadId, messageId, state) => {
				runtimeState = {
					...runtimeState,
					assistantEditApplications: [{
						messageId,
						state,
					}],
				};
			},
		};
		pane.refreshConversation = () => {
			refreshCalls += 1;
		};

		const rendered = pane.renderRuntimeAssistantMessage(runtimeState.messages[0] as { id: string; role: 'assistant'; createdAt: number; content: string }, 'thread-1');

		assert.ok(rendered.querySelector('.vsclone-edit-apply-summary-file'));
		const redoButton = Array.from(rendered.querySelectorAll('button')).find(button => button.textContent === 'Redo') as HTMLButtonElement | undefined;
		assert.ok(redoButton);
		redoButton!.click();
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.strictEqual(calls.length, 1);
		assert.ok(calls[0].includes('<<<<<<< SEARCH'));
		assert.strictEqual(refreshCalls, 1);
		assert.strictEqual(runtimeState.assistantEditApplications?.[0]?.messageId, 'assistant-redo');
		assert.strictEqual((runtimeState.assistantEditApplications?.[0]?.state as { phase: string } | undefined)?.phase, 'applied');
	});

	test('undoAssistantEdits preserves partial undo state when only some files revert', async () => {
		const pane = createPaneHarness() as unknown as {
			undoAssistantEdits: (
				target: { threadId: string; id: string; responseText: string },
				applyResult: {
					attemptedEdits: number;
					appliedEdits: number;
					modifiedFiles: readonly unknown[];
					failures: readonly string[];
					fileChanges: readonly Array<{ uri: URI; displayPath: string; addedLines: number; removedLines: number; action: 'modify' }>;
				},
				button: HTMLButtonElement,
			) => Promise<void>;
			editApplicationService: {
				undoEditApply: (fileChanges: readonly unknown[]) => Promise<{
					revertedFiles: URI[];
					failures: string[];
				}>;
			};
			threadRuntimeService: {
				getState: (threadId: string) => unknown;
				setAssistantEditApplicationState: (threadId: string, messageId: string, state: unknown) => void;
			};
			notificationService: {
				info: (message: string) => void;
				warn: (message: string) => void;
				error: (message: string) => void;
			};
			refreshConversation: () => void;
		};
		const warnings: string[] = [];
		let refreshCalls = 0;
		let recordedState: unknown;
		const applyResult = {
			attemptedEdits: 2,
			appliedEdits: 2,
			modifiedFiles: [
				{ toString: () => 'file:///workspace/src/app.ts' },
				{ toString: () => 'file:///workspace/src/other.ts' },
			],
			failures: [],
			fileChanges: [
				{ uri: URI.parse('file:///workspace/src/app.ts'), displayPath: 'src/app.ts', addedLines: 1, removedLines: 1, action: 'modify' as const },
				{ uri: URI.parse('file:///workspace/src/other.ts'), displayPath: 'src/other.ts', addedLines: 1, removedLines: 1, action: 'modify' as const },
			],
		};
		pane.editApplicationService = {
			undoEditApply: async () => ({
				revertedFiles: [URI.parse('file:///workspace/src/app.ts')],
				failures: ['Could not revert src/other.ts'],
			}),
		};
		pane.threadRuntimeService = {
			getState: () => ({
				threadId: 'thread-1',
				streamState: { kind: 'idle' },
				messages: [],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 1,
			}),
			setAssistantEditApplicationState: (_threadId, _messageId, state) => {
				recordedState = state;
			},
		};
		pane.notificationService = {
			info: () => undefined,
			warn: (message: string) => { warnings.push(message); },
			error: () => undefined,
		};
		pane.refreshConversation = () => {
			refreshCalls += 1;
		};

		await pane.undoAssistantEdits(
			{ threadId: 'thread-1', id: 'assistant-undo', responseText: 'unused' },
			applyResult,
			document.createElement('button'),
		);

		assert.deepStrictEqual(recordedState, {
			phase: 'partial',
			retryAction: 'undo',
			result: applyResult,
		});
		assert.strictEqual(warnings.length, 1);
		assert.strictEqual(refreshCalls, 1);
	});

	test('renderRuntimeAssistantMessage keeps partial undo retry visible', () => {
		const pane = createPaneHarness() as unknown as IRenderRuntimeAssistantMessageTarget & {
			editApplicationService: {
				hasSearchReplaceBlocks: () => boolean;
			};
		};
		const runtimeState = {
			threadId: 'thread-1',
			streamState: { kind: 'idle' as const },
			messages: [{
				id: 'assistant-partial-undo',
				role: 'assistant' as const,
				createdAt: 1,
				content: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
			}],
			assistantEditApplications: [{
				messageId: 'assistant-partial-undo',
				state: {
					phase: 'partial',
					retryAction: 'undo',
					result: {
						attemptedEdits: 2,
						appliedEdits: 2,
						modifiedFiles: [
							{ toString: () => 'file:///workspace/src/app.ts' },
							{ toString: () => 'file:///workspace/src/other.ts' },
						],
						failures: [],
						fileChanges: [
							{ uri: { toString: () => 'file:///workspace/src/app.ts' }, displayPath: 'src/app.ts', addedLines: 1, removedLines: 1, action: 'modify' as const },
							{ uri: { toString: () => 'file:///workspace/src/other.ts' }, displayPath: 'src/other.ts', addedLines: 1, removedLines: 1, action: 'modify' as const },
						],
					},
				},
			}],
			checkpoints: [],
			isRunning: false,
			lastUpdatedAt: 1,
		};
		pane.editApplicationService = {
			hasSearchReplaceBlocks: () => true,
		};
		pane.threadRuntimeService = {
			getState: () => runtimeState,
			getAssistantEditApplicationState: () => runtimeState.assistantEditApplications[0].state,
		};
		pane.renderSearchReplaceAwareText = (container: HTMLElement, text: string) => {
			container.textContent = text;
		};
		pane.appendMarkdownSegment = (container: HTMLElement, text: string) => {
			container.textContent = text;
		};
		pane.looksLikePartialSearchReplaceBlock = () => false;

		const rendered = pane.renderRuntimeAssistantMessage(runtimeState.messages[0], 'thread-1');
		const retryButton = Array.from(rendered.querySelectorAll('button')).find(button => button.textContent === 'Retry Undo');

		assert.ok(retryButton);
		assert.ok(rendered.querySelector('.vsclone-edit-apply-summary.phase-partial'));
	});

	test('manual apply button routes through the engine-native bridge instead of the legacy parser', async () => {
		const pane = createPaneHarness() as unknown as IRenderRuntimeAssistantMessageTarget & {
			pendingAssistantApplyMessageIds: Set<string>;
			editApplicationService: {
				hasSearchReplaceBlocks: () => boolean;
				startApplyingSearchReplaceBlocks: (responseText: string) => Promise<{
					attemptedEdits: number;
					appliedEdits: number;
					modifiedFiles: readonly unknown[];
					failures: readonly string[];
					fileChanges: readonly unknown[];
				}>;
				applySearchReplaceBlocks: (responseText: string) => Promise<unknown>;
			};
			notificationService: {
				info: (message: string) => void;
				warn: (message: string) => void;
				error: (message: string) => void;
			};
			threadRuntimeService: {
				getState: (threadId: string) => {
					threadId: string;
					streamState: { kind: 'idle' };
					messages: Array<unknown>;
					assistantEditApplications?: Array<{ messageId: string; state: unknown }>;
					checkpoints: Array<unknown>;
					isRunning: boolean;
					lastUpdatedAt: number;
				} | undefined;
				getAssistantEditApplicationState: (threadId: string, messageId: string) => unknown;
				setAssistantEditApplicationState: (threadId: string, messageId: string, state: unknown) => void;
			};
			refreshConversation: () => void;
		};
		const calls: string[] = [];
		let refreshCalls = 0;
		pane.pendingAssistantApplyMessageIds = new Set();
		let runtimeState = {
			threadId: 'thread-1',
			streamState: { kind: 'idle' as const },
			messages: [
				{
					id: 'assistant-apply',
					role: 'assistant' as const,
					createdAt: 1,
					content: [
						'File: src/app.ts',
						'<<<<<<< SEARCH',
						'old',
						'=======',
						'new',
						'>>>>>>> REPLACE',
					].join('\n'),
				},
			],
			assistantEditApplications: [{
				messageId: 'assistant-apply',
				state: { phase: 'failed' },
			}],
			checkpoints: [],
			isRunning: false,
			lastUpdatedAt: 1,
		};
		pane.editApplicationService = {
			hasSearchReplaceBlocks: () => true,
			startApplyingSearchReplaceBlocks: async (responseText: string) => {
				calls.push(responseText);
				return {
					attemptedEdits: 1,
					appliedEdits: 1,
					modifiedFiles: [],
					failures: [],
					fileChanges: [],
				};
			},
			applySearchReplaceBlocks: async () => {
				throw new Error('legacy apply path should not be used for manual apply');
			},
		};
		pane.notificationService = {
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		};
		pane.threadRuntimeService = {
			getState: threadId => threadId === 'thread-1' ? runtimeState : undefined,
			getAssistantEditApplicationState: (threadId, messageId) => threadId === 'thread-1'
				? runtimeState.assistantEditApplications?.find(entry => entry.messageId === messageId)?.state
				: undefined,
			setAssistantEditApplicationState: (_threadId, messageId, state) => {
				runtimeState = {
					...runtimeState,
					assistantEditApplications: [{
						messageId,
						state,
					}],
				};
			},
		};
		pane.refreshConversation = () => {
			refreshCalls += 1;
		};

		const rendered = pane.renderRuntimeAssistantMessage(runtimeState.messages[0] as { id: string; role: 'assistant'; createdAt: number; content: string }, 'thread-1');

		const applyButton = Array.from(rendered.querySelectorAll('button')).find(button => button.textContent === 'Apply Changes') as HTMLButtonElement | undefined;
		assert.ok(applyButton);
		applyButton!.click();
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual(calls, [
			[
				'File: src/app.ts',
				'<<<<<<< SEARCH',
				'old',
				'=======',
				'new',
				'>>>>>>> REPLACE',
			].join('\n'),
		]);
		assert.strictEqual(refreshCalls, 1);
		assert.strictEqual(runtimeState.assistantEditApplications?.[0]?.messageId, 'assistant-apply');
		assert.strictEqual((runtimeState.assistantEditApplications?.[0]?.state as { phase: string } | undefined)?.phase, 'applied');
	});

	test('refreshConversation renders approval actions only for the live pending runtime request', () => {
		const pane = createPaneHarness() as unknown as IRefreshConversationTarget;
		const approveCalls: string[] = [];
		const rejectCalls: Array<{ threadId: string; reason: string }> = [];
		pane.activeThreadId = 'thread-approval-ui';
		pane.conversationList = document.createElement('div');
		pane.conversationEmptyState = document.createElement('div');
		pane.historyService = {
			getTurns: () => [],
		};
		pane.threadRuntimeService = {
			getState: () => ({
				threadId: 'thread-approval-ui',
				streamState: { kind: 'awaiting_user', toolName: 'edit_file', approvalType: 'edits' },
				messages: [
					{
						role: 'tool',
						type: 'tool_request',
						toolName: 'edit_file',
						approvalType: 'edits',
						params: { path: 'src/old.ts' },
					},
					{
						role: 'tool',
						type: 'tool_request',
						toolName: 'edit_file',
						approvalType: 'edits',
						params: { path: 'src/live.ts' },
					},
				],
				checkpoints: [],
				isRunning: true,
				lastUpdatedAt: 1,
			}),
			approveLatestToolRequest: (threadId: string) => {
				approveCalls.push(threadId);
				return true;
			},
			rejectLatestToolRequest: (threadId: string, reason: string) => {
				rejectCalls.push({ threadId, reason });
				return true;
			},
		};
		pane.renderedMarkdownDisposables = {
			clear: () => undefined,
			add: value => value,
		};
		pane.markdownRendererService = createPlainTextMarkdownRendererStub();
		pane.updateComposerState = () => undefined;
		pane.refreshModelControls = () => undefined;
		pane.scheduleScrollToBottom = () => undefined;

		pane.refreshConversation();

		const toolCards = Array.from(pane.conversationList.querySelectorAll('.vsclone-tool-card'));
		assert.strictEqual(toolCards.length, 2);
		assert.ok(toolCards[0].textContent?.includes('src/old.ts'));
		assert.ok(toolCards[1].textContent?.includes('src/live.ts'));
		assert.strictEqual(toolCards[0].querySelector('.vsclone-runtime-tool-actions'), null);

		const actionButtons = Array.from(toolCards[1].querySelectorAll('.vsclone-runtime-checkpoint-button')) as HTMLButtonElement[];
		assert.strictEqual(actionButtons.length, 2);
		assert.deepStrictEqual(actionButtons.map(button => button.textContent), ['Approve', 'Reject']);

		actionButtons[0].click();
		actionButtons[1].click();

		assert.deepStrictEqual(approveCalls, ['thread-approval-ui']);
		assert.deepStrictEqual(rejectCalls, [{
			threadId: 'thread-approval-ui',
			reason: 'Tool request was rejected by the user.',
		}]);
	});

	test('runtime checkpoint button rewinds through the thread runtime service', async () => {
		const pane = createPaneHarness() as unknown as IRenderRuntimeCheckpointTarget;
		const rewindCalls: Array<{ threadId: string; checkpointId: string }> = [];
		const notifications = {
			info: [] as string[],
			warn: [] as string[],
			error: [] as string[],
		};
		let refreshCount = 0;
		pane.threadRuntimeService = {
			rewindToCheckpoint: async (threadId: string, checkpointId: string) => {
				rewindCalls.push({ threadId, checkpointId });
				return true;
			},
			getState: () => ({
				threadId: 'thread-1',
				streamState: { kind: 'idle' },
				messages: [],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 1,
			}),
		};
		pane.notificationService = {
			info: (message: string) => { notifications.info.push(message); },
			warn: (message: string) => { notifications.warn.push(message); },
			error: (message: string) => { notifications.error.push(message); },
		};
		pane.refreshConversation = () => { refreshCount += 1; };

		const rendered = pane.renderRuntimeCheckpointMessage('thread-1', {
			id: 'checkpoint-9',
			createdAt: 1,
			type: 'tool_edit',
			toolName: 'edit_file',
			snapshots: [{ uri: { toString: () => 'file:///workspace/src/app.ts' }, existed: true, content: 'before' }],
		}, false);

		const button = rendered.querySelector('.vsclone-runtime-checkpoint-button') as HTMLButtonElement | null;
		assert.ok(button);
		button.click();
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual(rewindCalls, [{ threadId: 'thread-1', checkpointId: 'checkpoint-9' }]);
		assert.strictEqual(notifications.info.length, 1);
		assert.strictEqual(notifications.warn.length, 0);
		assert.strictEqual(notifications.error.length, 0);
		assert.strictEqual(refreshCount, 1);
	});

	test('runtime checkpoint rewind stays disabled while assistant apply is pending', async () => {
		const pane = createPaneHarness() as unknown as IRenderRuntimeCheckpointTarget & {
			pendingAssistantApplyMessageIds: Set<string>;
		};
		const rewindCalls: Array<{ threadId: string; checkpointId: string }> = [];
		const notifications = {
			info: [] as string[],
			warn: [] as string[],
			error: [] as string[],
		};
		pane.pendingAssistantApplyMessageIds = new Set(['assistant-pending']);
		pane.threadRuntimeService = {
			rewindToCheckpoint: async (threadId: string, checkpointId: string) => {
				rewindCalls.push({ threadId, checkpointId });
				return true;
			},
			getState: () => ({
				isRunning: false,
				assistantEditApplications: [],
				messages: [{
					id: 'assistant-pending',
					role: 'assistant',
					createdAt: 1,
					content: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
				}],
			}),
		};
		pane.notificationService = {
			info: (message: string) => { notifications.info.push(message); },
			warn: (message: string) => { notifications.warn.push(message); },
			error: (message: string) => { notifications.error.push(message); },
		};
		pane.refreshConversation = () => undefined;

		const rendered = pane.renderRuntimeCheckpointMessage('thread-1', {
			id: 'checkpoint-pending',
			createdAt: 1,
			type: 'tool_edit',
			toolName: 'edit_file',
			snapshots: [],
		}, false);

		const button = rendered.querySelector('.vsclone-runtime-checkpoint-button') as HTMLButtonElement | null;
		assert.ok(button);
		assert.strictEqual(button.disabled, true);
		assert.strictEqual(button.title, 'Wait for edit application to finish before rewinding.');
		button.click();
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual(rewindCalls, []);
		assert.strictEqual(notifications.warn.length, 0);
	});

	test('refreshConversation disables checkpoint rewind while runtime is awaiting user approval', () => {
		const pane = createPaneHarness() as unknown as IRefreshConversationTarget;
		pane.activeThreadId = 'thread-awaiting';
		pane.conversationList = document.createElement('div');
		pane.conversationEmptyState = document.createElement('div');
		pane.historyService = {
			getTurns: () => [],
		};
		pane.threadRuntimeService = {
			getState: () => ({
				threadId: 'thread-awaiting',
				streamState: { kind: 'awaiting_user', toolName: 'edit_file', approvalType: 'edits' },
				messages: [{
					id: 'checkpoint-awaiting',
					role: 'checkpoint',
					createdAt: 1,
					checkpoint: {
						id: 'checkpoint-awaiting',
						createdAt: 1,
						type: 'tool_edit',
						toolName: 'edit_file',
						snapshots: [],
					},
				}],
				assistantEditApplications: [],
				checkpoints: [],
				pausedApproval: {
					requestedAt: 1,
					toolName: 'edit_file',
					params: { path: 'src/app.ts' },
					approvalType: 'edits',
					snapshots: [],
					run: {
						turnId: 'thread-awaiting:turn-1',
						sequence: 1,
						sessionResource: 'vsclone://api/thread-awaiting',
						mode: 'act',
						vendor: 'openai',
						modelId: 'gpt-5',
						modelIdentifier: 'openai/gpt-5',
					},
				},
				isRunning: false,
				lastUpdatedAt: 1,
			}),
			rewindToCheckpoint: async () => true,
		};
		pane.renderedMarkdownDisposables = {
			clear: () => undefined,
			add: value => value,
		};
		pane.markdownRendererService = createPlainTextMarkdownRendererStub();
		pane.updateComposerState = () => undefined;
		pane.refreshModelControls = () => undefined;
		pane.scheduleScrollToBottom = () => undefined;

		pane.refreshConversation();

		const button = pane.conversationList.querySelector('.vsclone-runtime-checkpoint-button') as HTMLButtonElement | null;
		assert.ok(button);
		assert.strictEqual(button.disabled, true);
		assert.strictEqual(button.title, 'Wait for the active run to finish before rewinding.');
	});

	test('checkpoint rewind handler refuses paused approvals even if invoked with a stale enabled button', async () => {
		const pane = createPaneHarness() as unknown as IRenderRuntimeCheckpointTarget;
		const rewindCalls: Array<{ threadId: string; checkpointId: string }> = [];
		const notifications = {
			info: [] as string[],
			warn: [] as string[],
			error: [] as string[],
		};
		pane.threadRuntimeService = {
			rewindToCheckpoint: async (threadId: string, checkpointId: string) => {
				rewindCalls.push({ threadId, checkpointId });
				return true;
			},
			getState: () => ({
				threadId: 'thread-awaiting',
				streamState: { kind: 'awaiting_user', toolName: 'edit_file', approvalType: 'edits' },
				messages: [],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 1,
			}),
		};
		pane.notificationService = {
			info: (message: string) => { notifications.info.push(message); },
			warn: (message: string) => { notifications.warn.push(message); },
			error: (message: string) => { notifications.error.push(message); },
		};
		pane.refreshConversation = () => undefined;

		const rendered = pane.renderRuntimeCheckpointMessage('thread-awaiting', {
			id: 'checkpoint-awaiting',
			createdAt: 1,
			type: 'tool_edit',
			toolName: 'edit_file',
			snapshots: [],
		}, false);
		const button = rendered.querySelector('.vsclone-runtime-checkpoint-button') as HTMLButtonElement | null;
		assert.ok(button);
		button.disabled = false;
		button.click();
		await new Promise(resolve => setTimeout(resolve, 0));

		assert.deepStrictEqual(rewindCalls, []);
		assert.deepStrictEqual(notifications.warn, ['Wait for the active run to finish before rewinding.']);
	});
});
