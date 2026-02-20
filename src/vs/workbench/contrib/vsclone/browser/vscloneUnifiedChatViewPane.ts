/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/vscloneUnifiedChatViewPane.css';
import { addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Action } from '../../../../base/common/actions.js';
import { fromNow } from '../../../../base/common/date.js';
import { MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IVSCloneChatHistoryQuery, IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn, IVSCloneChatHistoryService } from '../common/vscloneChatHistoryService.js';
import { VSCloneChatHistoryRail, VSCloneRailTab } from './vscloneChatHistoryRail.js';
import { IVSCloneChatSessionService } from './vscloneChatSessionService.js';
import { toVSCloneRailRows } from './vscloneChatHistoryRailTree.js';

const railWidthSetting = 'vsclone.chatHistory.railWidth';
const railMinWidth = 220;
const railMaxWidth = 520;
const compactRailBreakpoint = 900;
const autoCollapseBreakpoint = 760;

export function toVSCloneHistoryQuery(query: string, tab: VSCloneRailTab): IVSCloneChatHistoryQuery {
	return {
		text: query,
		tab,
		includeArchived: tab === 'all',
	};
}

export class VSCloneUnifiedChatViewPane extends ViewPane {
	private readonly composerFocusDisposable = this._register(new MutableDisposable());

	private rootContainer: HTMLElement | undefined;
	private railContainer: HTMLElement | undefined;
	private titleElement: HTMLElement | undefined;
	private backButton: HTMLButtonElement | undefined;
	private railResizeHandle: HTMLElement | undefined;
	private conversationList: HTMLElement | undefined;
	private conversationEmptyState: HTMLElement | undefined;
	private composerInput: HTMLTextAreaElement | undefined;
	private composerSendButton: HTMLButtonElement | undefined;

	private readonly rail = this._register(this.instantiationService.createInstance(VSCloneChatHistoryRail));
	private readonly threadsById = new Map<string, IVSCloneChatHistoryThread>();
	private readonly refreshRailScheduler = this._register(new RunOnceScheduler(() => {
		this.refreshRailRows();
		this.updateThreadHeader();
	}, 90));
	private readonly refreshConversationScheduler = this._register(new RunOnceScheduler(() => {
		this.refreshConversation();
	}, 34));

	private railVisible = true;
	private railWidth = 320;
	private activeThreadId: string | undefined;
	private historyReady = false;
	private isCompactLayout = false;
	private hasAutoCollapsedRail = false;
	private bodyWidth = 0;
	private submittingPrompt = false;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IVSCloneChatHistoryService private readonly historyService: IVSCloneChatHistoryService,
		@IVSCloneChatSessionService private readonly sessionService: IVSCloneChatSessionService,
		@IClipboardService private readonly clipboardService: IClipboardService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this.railWidth = Math.min(railMaxWidth, Math.max(railMinWidth, this.configurationService.getValue<number>(railWidthSetting) ?? 320));

		this._register(this.rail.onDidSelectThread(threadId => {
			void this.openSession(threadId);
		}));
		this._register(this.rail.onDidRequestRetry(() => {
			void this.reloadHistory();
		}));
		this._register(this.rail.onDidChangeFilterState(() => {
			this.refreshRailRows();
		}));
		this._register(this.rail.onDidRequestAction(event => {
			switch (event.action) {
				case 'open':
					void this.openSession(event.threadId);
					break;
				case 'copyPrompt':
					void this.copyPrompt(event.threadId);
					break;
				case 'copyResponse':
					void this.copyResponse(event.threadId);
					break;
				case 'reusePrompt':
					this.reusePrompt(event.threadId);
					break;
				case 'delete':
					void this.deleteThread(event.threadId);
					break;
				case 'toggleArchive':
					void this.historyService.archiveThread(event.threadId, !!event.archived);
					break;
			}
		}));

		this._register(this.historyService.onDidChange(event => {
			if (!this.historyReady) {
				return;
			}

			const affectsActiveThread = !this.activeThreadId || event.threadIds.includes(this.activeThreadId);
			if (event.reason === 'turnUpdate') {
				if (affectsActiveThread) {
					this.refreshConversationScheduler.schedule(24);
				}
				this.refreshRailScheduler.schedule();
				return;
			}

			if (affectsActiveThread || event.reason === 'clear') {
				this.refreshConversationScheduler.schedule(0);
			}
			this.refreshRailScheduler.schedule(0);
		}));
	}

	override focus(): void {
		super.focus();
		if (!this.historyReady) {
			this.rail.focusSearch();
			return;
		}
		this.focusInput();
	}

	override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.bodyWidth = width;
		this.applyResponsiveLayout(width);
		this.applyRailLayout();
	}

	focusInput(): void {
		this.composerInput?.focus();
	}

	focusRail(): void {
		this.rail.focusSearch();
	}

	toggleRail(): void {
		this.railVisible = !this.railVisible;
		this.applyRailLayout();
	}

	async openSession(threadId?: string): Promise<void> {
		const targetThreadId = threadId ?? this.activeThreadId ?? this.rail.getSelectedThread();
		if (!targetThreadId) {
			this.activeThreadId = undefined;
			this.rail.setSelectedThread(undefined);
			this.refreshConversation();
			this.updateThreadHeader();
			this.focusInput();
			return;
		}

		if (!this.threadsById.has(targetThreadId)) {
			return;
		}

		this.activeThreadId = targetThreadId;
		this.rail.setSelectedThread(targetThreadId);
		this.refreshConversation();
		this.updateThreadHeader();

		if (this.isCompactLayout) {
			// In compact layouts we collapse the rail after opening a thread so the message area keeps usable width.
			this.railVisible = false;
			this.applyRailLayout();
		}
		this.focusInput();
	}

	async deleteActiveThread(): Promise<void> {
		if (!this.activeThreadId) {
			return;
		}
		await this.deleteThread(this.activeThreadId);
	}

	async copyPrompt(threadId?: string): Promise<void> {
		const latestTurn = this.getLatestTurn(threadId);
		if (!latestTurn) {
			return;
		}
		await this.clipboardService.writeText(latestTurn.promptText);
	}

	async copyResponse(threadId?: string): Promise<void> {
		const latestTurn = this.getLatestTurn(threadId);
		if (!latestTurn) {
			return;
		}
		await this.clipboardService.writeText(latestTurn.responsePlainText || latestTurn.responseMarkdown);
	}

	reusePrompt(threadId?: string): void {
		const latestTurn = this.getLatestTurn(threadId);
		if (!latestTurn || !this.composerInput) {
			return;
		}
		this.composerInput.value = latestTurn.promptText;
		this.updateComposerMetrics();
		this.focusInput();
	}

	override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);

		parent.classList.add('vsclone-unified-chat-view-pane');
		this.rootContainer = parent;
		parent.replaceChildren();

		const header = document.createElement('div');
		header.className = 'vsclone-chat-header';
		const backButton = document.createElement('button');
		backButton.type = 'button';
		backButton.className = 'vsclone-chat-header-back';
		backButton.textContent = localize('vsclone.header.back', 'Back');
		backButton.title = localize('vsclone.header.back.tooltip', 'Show chat history');
		this.backButton = backButton;
		header.appendChild(backButton);

		const title = document.createElement('div');
		title.className = 'vsclone-chat-header-title';
		title.textContent = localize('vsclone.header.defaultTitle', 'New Chat');
		this.titleElement = title;
		header.appendChild(title);

		const overflow = document.createElement('button');
		overflow.type = 'button';
		overflow.className = 'vsclone-chat-header-overflow';
		overflow.textContent = '⋮';
		overflow.title = localize('vsclone.header.more', 'More actions');
		header.appendChild(overflow);

		const content = document.createElement('div');
		content.className = 'vsclone-chat-content';

		const railContainer = document.createElement('div');
		railContainer.className = 'vsclone-chat-left-rail';
		this.railContainer = railContainer;
		this.rail.render(railContainer);
		content.appendChild(railContainer);

		const resizeHandle = document.createElement('div');
		resizeHandle.className = 'vsclone-chat-rail-resize-handle';
		this.railResizeHandle = resizeHandle;
		content.appendChild(resizeHandle);

		const conversation = document.createElement('div');
		conversation.className = 'vsclone-chat-conversation';
		content.appendChild(conversation);
		this.renderConversationSurface(conversation);

		parent.appendChild(header);
		parent.appendChild(content);

		this.applyResponsiveLayout(this.bodyWidth || parent.clientWidth);
		this.applyRailLayout();
		this.updateThreadHeader();
		this.refreshConversation();

		this._register(addDisposableListener(backButton, EventType.CLICK, () => {
			this.railVisible = true;
			this.applyRailLayout();
			this.rail.focusSearch();
		}));

		this._register(addDisposableListener(overflow, EventType.CLICK, (event: MouseEvent) => {
			event.stopPropagation();
			this.contextMenuService.showContextMenu({
				getAnchor: () => ({ x: event.clientX, y: event.clientY }),
				getActions: () => [
					new Action('vsclone.chatHistory.copyPrompt', localize('vsclone.header.copyPrompt', 'Copy Prompt'), undefined, true, () => this.copyPrompt()),
					new Action('vsclone.chatHistory.copyResponse', localize('vsclone.header.copyResponse', 'Copy Response'), undefined, true, () => this.copyResponse()),
					new Action('vsclone.chatHistory.reusePrompt', localize('vsclone.header.reusePrompt', 'Reuse Prompt'), undefined, true, () => this.reusePrompt()),
					new Action('vsclone.chatHistory.deleteThread', localize('vsclone.header.deleteThread', 'Delete Thread'), undefined, true, () => this.deleteActiveThread()),
				],
			});
		}));

		if (resizeHandle) {
			this.installRailResizer(resizeHandle);
		}

		void this.reloadHistory();
	}

	private renderConversationSurface(parent: HTMLElement): void {
		const messages = document.createElement('div');
		messages.className = 'vsclone-thread-messages';
		this.conversationList = messages;

		const emptyState = document.createElement('div');
		emptyState.className = 'vsclone-thread-empty-state';
		emptyState.textContent = localize('vsclone.thread.empty', 'Start a new chat from the composer below.');
		this.conversationEmptyState = emptyState;

		const composer = document.createElement('div');
		composer.className = 'vsclone-thread-composer';

		const input = document.createElement('textarea');
		input.className = 'vsclone-thread-composer-input';
		input.rows = 1;
		input.placeholder = localize('vsclone.composer.placeholder', 'Ask a follow-up question...');
		this.composerInput = input;

		const send = document.createElement('button');
		send.type = 'button';
		send.className = 'vsclone-thread-composer-send';
		send.textContent = localize('vsclone.composer.send', 'Send');
		this.composerSendButton = send;

		const hint = document.createElement('div');
		hint.className = 'vsclone-thread-composer-hint';
		hint.textContent = localize('vsclone.composer.hint', 'Press Enter to send, Shift+Enter for new line');

		composer.appendChild(input);
		composer.appendChild(send);
		composer.appendChild(hint);

		parent.appendChild(messages);
		parent.appendChild(emptyState);
		parent.appendChild(composer);

		this._register(addDisposableListener(input, EventType.INPUT, () => {
			this.updateComposerMetrics();
			this.updateComposerState();
		}));

		this._register(addDisposableListener(input, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
				return;
			}
			event.preventDefault();
			void this.submitPrompt();
		}));

		this._register(addDisposableListener(send, EventType.CLICK, () => {
			void this.submitPrompt();
		}));

		this.composerFocusDisposable.value = toDisposable(() => {
			input.blur();
		});
		this.updateComposerMetrics();
		this.updateComposerState();
	}

	private async submitPrompt(): Promise<void> {
		if (!this.composerInput) {
			return;
		}
		if (this.submittingPrompt) {
			return;
		}
		const promptText = this.composerInput.value.trim();
		if (!promptText) {
			return;
		}

		const activeThreadId = this.activeThreadId;
		if (activeThreadId && this.isThreadBusy(activeThreadId)) {
			return;
		}

		const existingThread = activeThreadId ? this.resolveThreadById(activeThreadId) : undefined;
		this.submittingPrompt = true;
		this.updateComposerState();

		try {
			const submission = await this.sessionService.submitPrompt(promptText, {
				threadId: activeThreadId,
				sessionResource: existingThread?.sessionResource,
			});
			if (!submission) {
				return;
			}

			this.activeThreadId = submission.threadId;
			this.rail.setSelectedThread(submission.threadId);
			this.composerInput.value = '';
			this.updateComposerMetrics();
			this.updateThreadHeader();
			this.refreshConversation();
		} finally {
			this.submittingPrompt = false;
			this.updateComposerState();
		}
	}

	private applyResponsiveLayout(width: number): void {
		const compact = width > 0 && width < compactRailBreakpoint;
		this.isCompactLayout = compact;
		this.rootContainer?.classList.toggle('compact-layout', compact);

		// We collapse rail once when crossing into very narrow widths to avoid a stuck two-column layout.
		if (compact && width < autoCollapseBreakpoint && this.railVisible && this.activeThreadId && !this.hasAutoCollapsedRail) {
			this.railVisible = false;
			this.hasAutoCollapsedRail = true;
		}
		if (!compact) {
			this.hasAutoCollapsedRail = false;
		}
	}

	private getEffectiveRailWidth(): number {
		const viewportWidth = this.bodyWidth || this.rootContainer?.clientWidth || railMaxWidth;
		if (this.isCompactLayout) {
			return Math.min(Math.max(railMinWidth, viewportWidth - 56), railMaxWidth);
		}

		// Clamp to at most 55% of the pane so the composer and thread view stay usable while resizing.
		const maxFromPane = Math.max(railMinWidth, Math.floor(viewportWidth * 0.55));
		return Math.min(railMaxWidth, maxFromPane, this.railWidth);
	}

	private async reloadHistory(): Promise<void> {
		if (!this.rootContainer) {
			return;
		}

		this.rail.setLoading();
		try {
			await this.historyService.initialize();
			this.historyReady = true;
			this.refreshRailRows();
			this.refreshConversation();
		} catch {
			this.historyReady = false;
			this.rail.setError(localize('vsclone.rail.load.error', 'Failed to load chat history. Please try again.'));
		}
	}

	private refreshRailRows(): void {
		if (!this.historyReady) {
			return;
		}

		const filterState = this.rail.getFilterState();
		const threads = this.historyService.getThreads(toVSCloneHistoryQuery(filterState.query, filterState.tab));
		this.threadsById.clear();
		for (const thread of threads) {
			this.threadsById.set(thread.threadId, thread);
		}

		if (this.activeThreadId && !this.threadsById.has(this.activeThreadId)) {
			this.activeThreadId = undefined;
		}

		const rows = toVSCloneRailRows(threads, this.activeThreadId, timestamp => fromNow(timestamp, true));
		this.rail.setRows(rows);
		if (!this.activeThreadId) {
			this.rail.setSelectedThread(undefined);
		} else {
			this.rail.setSelectedThread(this.activeThreadId);
		}
		this.updateThreadHeader();
	}

	private refreshConversation(): void {
		if (!this.conversationList || !this.conversationEmptyState) {
			return;
		}

		const turns = this.activeThreadId ? this.historyService.getTurns(this.activeThreadId) : [];
		const hasTurns = turns.length > 0;
		this.conversationList.replaceChildren();
		this.conversationEmptyState.classList.toggle('hidden', hasTurns);

		if (hasTurns) {
			const fragment = document.createDocumentFragment();
			for (const turn of turns) {
				fragment.appendChild(this.renderUserMessage(turn));
				fragment.appendChild(this.renderAssistantMessage(turn));
			}
			this.conversationList.appendChild(fragment);
		}

		this.updateComposerState();
		this.scheduleScrollToBottom();
	}

	private renderUserMessage(turn: IVSCloneChatHistoryTurn): HTMLElement {
		const item = document.createElement('div');
		item.className = 'vsclone-thread-message user';

		const meta = document.createElement('div');
		meta.className = 'vsclone-thread-message-meta';
		meta.textContent = localize('vsclone.thread.userLabel', 'You');
		item.appendChild(meta);

		const body = document.createElement('div');
		body.className = 'vsclone-thread-message-body';
		body.textContent = turn.promptText;
		item.appendChild(body);

		return item;
	}

	private renderAssistantMessage(turn: IVSCloneChatHistoryTurn): HTMLElement {
		const item = document.createElement('div');
		item.className = 'vsclone-thread-message assistant';
		item.classList.toggle('error', turn.status === 'failed');

		const meta = document.createElement('div');
		meta.className = 'vsclone-thread-message-meta';
		meta.textContent = localize('vsclone.thread.assistantLabel', 'Assistant');
		item.appendChild(meta);

		const body = document.createElement('div');
		body.className = 'vsclone-thread-message-body';
		const text = turn.responsePlainText || turn.responseMarkdown;
		if (text.trim().length > 0) {
			body.textContent = text;
		} else if (turn.status === 'pending' || turn.status === 'streaming') {
			body.textContent = localize('vsclone.thread.assistant.pending', 'Thinking...');
			item.classList.add('streaming');
		} else if (turn.status === 'cancelled') {
			body.textContent = localize('vsclone.thread.assistant.cancelled', 'Response generation was cancelled.');
		} else if (turn.status === 'failed') {
			body.textContent = localize('vsclone.thread.assistant.failed', 'Something went wrong while generating the response.');
		}
		item.appendChild(body);
		return item;
	}

	private updateComposerMetrics(): void {
		if (!this.composerInput) {
			return;
		}

		// Force auto height first so scrollHeight reflects the current value after deletions.
		this.composerInput.style.height = '0px';
		const nextHeight = Math.max(40, Math.min(132, this.composerInput.scrollHeight));
		this.composerInput.style.height = `${nextHeight}px`;
	}

	private updateComposerState(): void {
		if (!this.composerInput || !this.composerSendButton) {
			return;
		}

		const hasText = this.composerInput.value.trim().length > 0;
		const threadBusy = this.activeThreadId ? this.isThreadBusy(this.activeThreadId) : false;
		const composerBusy = threadBusy || this.submittingPrompt;
		const disabled = !hasText || composerBusy;
		this.composerSendButton.disabled = disabled;
		this.composerInput.disabled = composerBusy;
		if (this.composerInput.disabled) {
			this.composerInput.placeholder = localize('vsclone.composer.waiting', 'Waiting for response...');
		} else {
			this.composerInput.placeholder = localize('vsclone.composer.placeholder', 'Ask a follow-up question...');
		}
	}

	private scheduleScrollToBottom(): void {
		if (!this.conversationList) {
			return;
		}
		setTimeout(() => {
			if (!this.conversationList) {
				return;
			}
			this.conversationList.scrollTop = this.conversationList.scrollHeight;
		}, 0);
	}

	private isThreadBusy(threadId: string): boolean {
		const latestTurn = this.historyService.getTurns(threadId).at(-1);
		return latestTurn?.status === 'pending' || latestTurn?.status === 'streaming';
	}

	private updateThreadHeader(): void {
		if (!this.titleElement) {
			return;
		}

		const thread = this.activeThreadId ? this.threadsById.get(this.activeThreadId) : undefined;
		this.titleElement.textContent = thread?.title || localize('vsclone.header.defaultTitle', 'New Chat');
		this.backButton?.classList.toggle('visible', !this.railVisible);
	}

	private applyRailLayout(): void {
		if (!this.rootContainer || !this.railContainer || !this.railResizeHandle) {
			return;
		}

		this.rootContainer.classList.toggle('rail-hidden', !this.railVisible);
		this.rootContainer.classList.toggle('showing-rail', this.isCompactLayout && this.railVisible);
		this.railContainer.style.width = this.railVisible ? `${this.getEffectiveRailWidth()}px` : '0px';
		this.railResizeHandle.style.display = this.railVisible && !this.isCompactLayout ? '' : 'none';
		this.updateThreadHeader();
	}

	private installRailResizer(handle: HTMLElement): void {
		this._register(addDisposableListener(handle, EventType.MOUSE_DOWN, (startEvent: MouseEvent) => {
			if (this.isCompactLayout) {
				return;
			}

			startEvent.preventDefault();
			startEvent.stopPropagation();

			const startWidth = this.railWidth;
			const startX = startEvent.clientX;
			const document = handle.ownerDocument;

			const moveDisposable = addDisposableListener(document, EventType.MOUSE_MOVE, (moveEvent: MouseEvent) => {
				const delta = moveEvent.clientX - startX;
				const width = Math.min(railMaxWidth, Math.max(railMinWidth, startWidth + delta));
				if (width === this.railWidth) {
					return;
				}
				this.railWidth = width;
				this.applyRailLayout();
			});

			const upDisposable = addDisposableListener(document, EventType.MOUSE_UP, () => {
				moveDisposable.dispose();
				upDisposable.dispose();
				void this.configurationService.updateValue(railWidthSetting, this.railWidth);
			});
		}));
	}

	private getLatestTurn(threadId?: string): IVSCloneChatHistoryTurn | undefined {
		const candidateThreadId = threadId ?? this.activeThreadId ?? this.rail.getSelectedThread();
		if (!candidateThreadId) {
			return undefined;
		}
		const turns = this.historyService.getTurns(candidateThreadId);
		return turns.at(-1);
	}

	private resolveThreadById(threadId: string): IVSCloneChatHistoryThread | undefined {
		const cached = this.threadsById.get(threadId);
		if (cached) {
			return cached;
		}

		return this.historyService.getThreads({ includeArchived: true }).find(thread => thread.threadId === threadId);
	}

	private async deleteThread(threadId: string): Promise<void> {
		this.sessionService.cancelThread(threadId);
		await this.historyService.deleteThread(threadId);

		if (this.activeThreadId === threadId) {
			this.activeThreadId = undefined;
		}

		this.refreshRailRows();
		this.refreshConversation();
	}
}
