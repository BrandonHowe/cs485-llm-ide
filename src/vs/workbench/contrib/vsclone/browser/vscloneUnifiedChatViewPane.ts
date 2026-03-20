/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/vscloneUnifiedChatViewPane.css';
import { addDisposableListener, EventType, getWindow } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Action } from '../../../../base/common/actions.js';
import { fromNow } from '../../../../base/common/date.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IVSCloneChatHistoryQuery, IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn, IVSCloneChatHistoryService } from '../common/vscloneChatHistoryService.js';
import { VSCloneUseVSCodeChatBackendSetting } from '../common/vscloneChatSettings.js';
import { IVSCloneModelCatalogService, type VSCloneReasoningEffortLevel } from '../common/vscloneModelCatalogService.js';
import { IVSCloneChatLocation, IVSCloneThreadModelSelectionService, type IVSCloneModelSelection } from '../common/vscloneThreadModelSelectionService.js';
import { parseToolCalls } from '../common/vscloneToolCallParser.js';
import { VSCloneChatHistoryRail, VSCloneRailTab } from './vscloneChatHistoryRail.js';
import { IVSCloneChatSessionService } from './vscloneChatSessionService.js';
import { VSCloneModelSwitcherWidget } from './vscloneModelSwitcherWidget.js';
import { IVSCloneProviderConfigurationBridge } from './vscloneProviderConfigurationBridge.js';
import { toVSCloneRailRows } from './vscloneChatHistoryRailTree.js';
import { IVSCloneEditApplicationService } from './vscloneEditApplicationService.js';
import { parseToolResultDiff } from '../common/vscloneToolResultDiff.js';

const railWidthSetting = 'vsclone.chatHistory.railWidth';
const modelSwitcherEnabledSetting = 'vsclone.modelSwitcher.enabled';
const railMinWidth = 220;
const railMaxWidth = 520;
const compactRailBreakpoint = 900;

export function toVSCloneHistoryQuery(query: string, tab: VSCloneRailTab): IVSCloneChatHistoryQuery {
	return {
		text: query,
		tab,
		includeArchived: tab === 'all',
	};
}

interface IParsedToolResultBlock {
	readonly toolName: string;
	readonly success: boolean;
	readonly output: string;
	readonly rawXml: string;
	readonly startOffset: number;
	readonly endOffset: number;
}

interface IParsedAgentTraceBlock {
	readonly type: string;
	readonly status?: string;
	readonly message: string;
	readonly rawXml: string;
	readonly startOffset: number;
	readonly endOffset: number;
}

function parseToolResultBlocks(text: string): readonly IParsedToolResultBlock[] {
	const blocks: IParsedToolResultBlock[] = [];
	const pattern = /<tool_result\s+tool_name="([^"]+)"\s+success="(true|false)">([\s\S]*?)<\/tool_result>/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		blocks.push({
			toolName: match[1],
			success: match[2] === 'true',
			output: match[3].trim(),
			rawXml: match[0],
			startOffset: match.index,
			endOffset: match.index + match[0].length,
		});
	}
	return blocks;
}

function parseAgentTraceBlocks(text: string): readonly IParsedAgentTraceBlock[] {
	const blocks: IParsedAgentTraceBlock[] = [];
	const pattern = /<agent_trace\s+type="([^"]+)"(?:\s+status="([^"]+)")?>([\s\S]*?)<\/agent_trace>/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		blocks.push({
			type: match[1],
			status: match[2],
			message: decodeXmlText(match[3].trim()),
			rawXml: match[0],
			startOffset: match.index,
			endOffset: match.index + match[0].length,
		});
	}
	return blocks;
}

function decodeXmlText(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, '\'')
		.replace(/&amp;/g, '&');
}

export class VSCloneUnifiedChatViewPane extends ViewPane {
	private readonly composerFocusDisposable = this._register(new MutableDisposable());

	private rootContainer: HTMLElement | undefined;
	private railContainer: HTMLElement | undefined;
	private railResizeHandle: HTMLElement | undefined;
	private conversationContainer: HTMLElement | undefined;
	private conversationList: HTMLElement | undefined;
	private conversationEmptyState: HTMLElement | undefined;
	private composerInput: HTMLTextAreaElement | undefined;
	private composerSendButton: HTMLButtonElement | undefined;
	private modelSwitcher: VSCloneModelSwitcherWidget | undefined;
	private reasoningEffortContainer: HTMLElement | undefined;
	private reasoningEffortSelect: HTMLSelectElement | undefined;

	private readonly rail = this._register(this.instantiationService.createInstance(VSCloneChatHistoryRail));
	private readonly threadsById = new Map<string, IVSCloneChatHistoryThread>();
	private readonly refreshRailScheduler = this._register(new RunOnceScheduler(() => {
		this.refreshRailRows();
	}, 90));
	private readonly refreshConversationScheduler = this._register(new RunOnceScheduler(() => {
		this.refreshConversation();
	}, 34));

	private railVisible = false;
	private railWidth = 320;
	private activeThreadId: string | undefined;
	private historyReady = false;
	private isCompactLayout = false;
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
		@IVSCloneThreadModelSelectionService private readonly modelSelectionService: IVSCloneThreadModelSelectionService,
		@IVSCloneModelCatalogService private readonly modelCatalogService: IVSCloneModelCatalogService,
		@IVSCloneProviderConfigurationBridge private readonly providerConfigurationBridge: IVSCloneProviderConfigurationBridge,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IVSCloneEditApplicationService private readonly editApplicationService: IVSCloneEditApplicationService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this.railWidth = Math.min(railMaxWidth, Math.max(railMinWidth, this.configurationService.getValue<number>(railWidthSetting) ?? 320));

		this._register(this.rail.onDidSelectThread(threadId => {
			void this.openSession(threadId);
		}));
		this._register(this.rail.onDidRequestRetry(() => {
			void this.reloadHistory();
		}));
		this._register(this.rail.onDidRequestNewChat(() => {
			this.showComposerForNewChat();
		}));
		this._register(this.rail.onDidRequestClose(() => {
			this.railVisible = false;
			this.applyRailLayout();
			this.focusInput();
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

		this._register(this.modelSelectionService.onDidChangeSelection(() => {
			this.refreshModelControls();
		}));
		this._register(this.modelCatalogService.onDidChangeCatalog(() => {
			this.refreshModelControls();
		}));

		void this.modelSelectionService.initialize();
	}

	override focus(): void {
		super.focus();
		if (!this.historyReady || this.railVisible) {
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
		this.railVisible = true;
		this.applyRailLayout();
		this.rail.focusSearch();
	}

	toggleRail(): void {
		this.railVisible = !this.railVisible;
		this.applyRailLayout();
		if (this.railVisible) {
			this.rail.focusSearch();
		} else {
			this.focusInput();
		}
	}

	openModelPicker(): void {
		this.modelSwitcher?.open();
	}

	async refreshModelCatalog(): Promise<void> {
		await this.modelCatalogService.refreshCatalog();
		this.refreshModelControls();
	}

	async manageProviders(): Promise<void> {
		await this.providerConfigurationBridge.openManageProvidersPicker();
		await this.modelCatalogService.refreshCatalog();
		this.refreshModelControls();
	}

	async resetModelSelection(): Promise<void> {
		if (!this.activeThreadId) {
			return;
		}
		await this.modelSelectionService.resetSelectionForThread(this.activeThreadId);
		this.refreshModelControls();
	}

	async switchToNextModel(): Promise<void> {
		const context = this.getModelSwitcherContext();
		await this.modelSelectionService.switchToNextModel(context.threadId, context.location);
		this.refreshModelControls();
	}

	async openSession(threadId?: string): Promise<void> {
		const targetThreadId = threadId ?? this.activeThreadId ?? this.rail.getSelectedThread();
		if (!targetThreadId) {
			this.showComposerForNewChat();
			return;
		}

		if (!this.threadsById.has(targetThreadId)) {
			return;
		}

		this.activeThreadId = targetThreadId;
		this.rail.setSelectedThread(targetThreadId);
		this.railVisible = false;
		this.refreshModelControls();
		this.refreshConversation();
		this.applyRailLayout();
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
		this.conversationContainer = conversation;
		content.appendChild(conversation);

		parent.appendChild(content);
		try {
			this.renderConversationSurface(conversation);
		} catch (error) {
			onUnexpectedError(error);
			this.renderConversationFallback(conversation);
		}

		this.applyResponsiveLayout(this.bodyWidth || parent.clientWidth);
		this.applyRailLayout();
		this.refreshConversation();

		if (resizeHandle) {
			this.installRailResizer(resizeHandle);
		}

		void this.reloadHistory();
	}

	private renderConversationSurface(parent: HTMLElement): void {
		const actions = document.createElement('div');
		actions.className = 'vsclone-thread-actions';

		const historyButton = document.createElement('button');
		historyButton.type = 'button';
		historyButton.className = 'vsclone-thread-action-button';
		historyButton.textContent = localize('vsclone.thread.actions.history', 'Chat History');
		// Mirror tooltip text into an accessible name so screen readers announce this icon-like action clearly.
		const historyButtonLabel = localize('vsclone.thread.actions.history.tooltip', 'Show chat history');
		historyButton.title = historyButtonLabel;
		historyButton.setAttribute('aria-label', historyButtonLabel);
		actions.appendChild(historyButton);

		const overflowButton = document.createElement('button');
		overflowButton.type = 'button';
		overflowButton.className = 'vsclone-thread-action-overflow';
		overflowButton.textContent = '\u22ef';
		const overflowButtonLabel = localize('vsclone.thread.actions.more', 'More actions');
		overflowButton.title = overflowButtonLabel;
		overflowButton.setAttribute('aria-label', overflowButtonLabel);
		overflowButton.setAttribute('aria-haspopup', 'menu');
		actions.appendChild(overflowButton);

		const messages = document.createElement('div');
		messages.className = 'vsclone-thread-messages';
		// Announce newly appended message bubbles without repeatedly reading the whole transcript.
		messages.setAttribute('role', 'log');
		messages.setAttribute('aria-live', 'polite');
		messages.setAttribute('aria-relevant', 'additions text');
		messages.setAttribute('aria-label', localize('vsclone.thread.messages', 'Conversation messages'));
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
		input.setAttribute('aria-label', localize('vsclone.composer.inputLabel', 'Chat message'));
		this.composerInput = input;

		const send = document.createElement('button');
		send.type = 'button';
		send.className = 'vsclone-thread-composer-send';
		send.textContent = localize('vsclone.composer.send', 'Send');
		this.composerSendButton = send;

		const controls = document.createElement('div');
		controls.className = 'vsclone-thread-composer-controls';
		this.reasoningEffortContainer = undefined;
		this.reasoningEffortSelect = undefined;

		const modelSwitcherEnabled = this.configurationService.getValue<boolean>(modelSwitcherEnabledSetting) ?? true;
		if (modelSwitcherEnabled) {
			const modelSwitcherHost = document.createElement('div');
			modelSwitcherHost.className = 'vsclone-thread-model-switcher';
			controls.appendChild(modelSwitcherHost);
			try {
				this.modelSwitcher = this._register(new VSCloneModelSwitcherWidget(
					this.modelCatalogService,
					this.modelSelectionService,
					this.providerConfigurationBridge,
					() => this.getModelSwitcherContext(),
				));
				this.modelSwitcher.render(modelSwitcherHost);
			} catch (error) {
				onUnexpectedError(error);
				modelSwitcherHost.remove();
				this.modelSwitcher = undefined;
			}

			const reasoningEffortHost = document.createElement('div');
			reasoningEffortHost.className = 'vsclone-thread-reasoning-level hidden';
			const reasoningEffortSelect = document.createElement('select');
			reasoningEffortSelect.className = 'vsclone-thread-reasoning-level-select';
			reasoningEffortSelect.setAttribute('aria-label', localize('vsclone.composer.reasoningEffort', 'Reasoning level'));
			reasoningEffortHost.appendChild(reasoningEffortSelect);
			controls.appendChild(reasoningEffortHost);
			this.reasoningEffortContainer = reasoningEffortHost;
			this.reasoningEffortSelect = reasoningEffortSelect;
		}
		const hint = document.createElement('div');
		hint.className = 'vsclone-thread-composer-hint';
		hint.textContent = localize('vsclone.composer.hint', 'Press Enter to send, Shift+Enter for new line');
		// Associate keyboard-help text to the composer so instructions are available to assistive technology.
		hint.id = `${this.id}-composer-hint`;
		input.setAttribute('aria-describedby', hint.id);

		composer.appendChild(input);
		composer.appendChild(send);
		composer.appendChild(controls);
		composer.appendChild(hint);

		parent.appendChild(actions);
		parent.appendChild(messages);
		parent.appendChild(emptyState);
		parent.appendChild(composer);

		this._register(addDisposableListener(historyButton, EventType.CLICK, () => {
			this.railVisible = true;
			this.applyRailLayout();
			this.rail.focusSearch();
		}));

		this._register(addDisposableListener(overflowButton, EventType.CLICK, (event: MouseEvent) => {
			event.stopPropagation();
			this.contextMenuService.showContextMenu({
				getAnchor: () => ({ x: event.clientX, y: event.clientY }),
				getActions: () => [
					new Action('vsclone.chatHistory.copyPrompt', localize('vsclone.thread.actions.copyPrompt', 'Copy Prompt'), undefined, true, () => this.copyPrompt()),
					new Action('vsclone.chatHistory.copyResponse', localize('vsclone.thread.actions.copyResponse', 'Copy Response'), undefined, true, () => this.copyResponse()),
					new Action('vsclone.chatHistory.reusePrompt', localize('vsclone.thread.actions.reusePrompt', 'Reuse Prompt'), undefined, true, () => this.reusePrompt()),
					new Action('vsclone.chatHistory.deleteThread', localize('vsclone.thread.actions.deleteThread', 'Delete Thread'), undefined, true, () => this.deleteActiveThread()),
				],
			});
		}));

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
		if (this.reasoningEffortSelect) {
			this._register(addDisposableListener(this.reasoningEffortSelect, EventType.CHANGE, () => {
				void this.updateReasoningEffortSelection();
			}));
		}

		this.composerFocusDisposable.value = toDisposable(() => {
			input.blur();
		});
		this.updateComposerMetrics();
		this.updateComposerState();
		this.refreshReasoningEffortControl();
		if (this.modelSwitcher) {
			void this.modelCatalogService.refreshCatalog();
		}
	}

	private renderConversationFallback(parent: HTMLElement): void {
		parent.replaceChildren();

		const fallback = document.createElement('div');
		fallback.className = 'vsclone-thread-empty-state';
		fallback.textContent = localize('vsclone.thread.renderError', 'Failed to render the chat UI. Reload the window and try again.');
		parent.appendChild(fallback);
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

		const selectedModel = this.getCurrentComposerModelSelection(activeThreadId);
		const existingThread = activeThreadId ? this.resolveThreadById(activeThreadId) : undefined;
		this.submittingPrompt = true;
		this.updateComposerState();

		try {
			const submission = await this.sessionService.submitPrompt(promptText, {
				threadId: activeThreadId,
				sessionResource: existingThread?.sessionResource,
				modelSelection: selectedModel,
			});
			if (!submission) {
				return;
			}

			if (!activeThreadId && selectedModel) {
				await this.modelSelectionService.setSelectionForThread(submission.threadId, {
					...selectedModel,
					threadId: submission.threadId,
					location: 'chat',
					selectedAt: Date.now(),
				});
			}

			this.activeThreadId = submission.threadId;
			this.rail.setSelectedThread(submission.threadId);
			this.railVisible = false;
			this.composerInput.value = '';
			this.updateComposerMetrics();
			this.refreshModelControls();
			this.refreshConversation();
			this.applyRailLayout();
		} finally {
			this.submittingPrompt = false;
			this.updateComposerState();
		}
	}

	private applyResponsiveLayout(width: number): void {
		const compact = width > 0 && width < compactRailBreakpoint;
		this.isCompactLayout = compact;
		this.rootContainer?.classList.toggle('compact-layout', compact);
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
			if (!this.activeThreadId) {
				// Default to composer mode when opening VSClone with no active thread.
				this.railVisible = false;
				this.applyRailLayout();
			}
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
		this.refreshModelControls();
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
			if (text.includes('<tool_call>') || text.includes('<tool_result') || text.includes('<agent_trace')) {
				this.renderToolAwareAssistantText(body, text, turn.status === 'streaming');
			} else {
				body.textContent = text;
			}
		} else if (turn.status === 'pending' || turn.status === 'streaming') {
			body.textContent = localize('vsclone.thread.assistant.pending', 'Thinking...');
			item.classList.add('streaming');
		} else if (turn.status === 'cancelled') {
			body.textContent = localize('vsclone.thread.assistant.cancelled', 'Response generation was cancelled.');
		} else if (turn.status === 'failed') {
			body.textContent = localize('vsclone.thread.assistant.failed', 'Something went wrong while generating the response.');
		}
		item.appendChild(body);

		if (turn.status === 'completed' && text.trim().length > 0 && this.editApplicationService.hasSearchReplaceBlocks(text)) {
			const applyButton = document.createElement('button');
			applyButton.type = 'button';
			applyButton.className = 'vsclone-thread-message-apply';
			applyButton.textContent = localize('vsclone.thread.assistant.apply', 'Apply Changes');
			applyButton.addEventListener(EventType.CLICK, () => {
				void this.applyAssistantEdits(turn, applyButton);
			});
			item.appendChild(applyButton);
		}

		return item;
	}

	private renderToolAwareAssistantText(container: HTMLElement, text: string, streaming: boolean): void {
		type ParsedBlock = {
			readonly kind: 'tool_call' | 'tool_result' | 'trace';
			readonly startOffset: number;
			readonly endOffset: number;
			readonly rawXml: string;
			readonly toolName: string;
			readonly success?: boolean;
			readonly output?: string;
			readonly traceType?: string;
			readonly traceStatus?: string;
			readonly traceMessage?: string;
		};

		const callBlocks = parseToolCalls(text).toolCalls.map<ParsedBlock>(call => ({
			kind: 'tool_call',
			startOffset: call.startOffset,
			endOffset: call.endOffset,
			rawXml: call.rawXml,
			toolName: call.name,
		}));
		const resultBlocks = parseToolResultBlocks(text).map<ParsedBlock>(result => ({
			kind: 'tool_result',
			startOffset: result.startOffset,
			endOffset: result.endOffset,
			rawXml: result.rawXml,
			toolName: result.toolName,
			success: result.success,
			output: result.output,
		}));
		const traceBlocks = parseAgentTraceBlocks(text).map<ParsedBlock>(trace => ({
			kind: 'trace',
			startOffset: trace.startOffset,
			endOffset: trace.endOffset,
			rawXml: trace.rawXml,
			toolName: '',
			traceType: trace.type,
			traceStatus: trace.status,
			traceMessage: trace.message,
		}));
		const hasTraceBlocks = traceBlocks.length > 0;

		const blocks = [...callBlocks, ...resultBlocks, ...traceBlocks].sort((left, right) => left.startOffset - right.startOffset);
		if (blocks.length === 0) {
			container.textContent = text;
			return;
		}

		let cursor = 0;
		for (const block of blocks) {
			if (block.startOffset > cursor) {
				this.appendPlainAssistantTextSegment(container, text.slice(cursor, block.startOffset));
			}

			if (block.kind === 'tool_call') {
				// When agent trace markers are available, prefer those concise status lines and suppress
				// the raw tool XML block to reduce visual noise in the transcript.
				if (!hasTraceBlocks) {
					container.appendChild(this.renderToolCallStatusLine(block.toolName, streaming));
				}
			} else if (block.kind === 'tool_result') {
				const diffCard = (block.success && block.output)
					? this.renderToolResultDiffCard(block.toolName, block.output)
					: undefined;
				if (diffCard) {
					container.appendChild(diffCard);
				}
				// Keep a fallback status line for older turns that do not contain <agent_trace> markers.
				if (!hasTraceBlocks && !diffCard) {
					container.appendChild(this.renderToolResultStatusLine(block.toolName, !!block.success));
				}
			} else {
				container.appendChild(this.renderAgentTraceBlock(block.traceType ?? '', block.traceMessage ?? '', block.traceStatus));
			}
			cursor = block.endOffset;
		}

		if (cursor < text.length) {
			this.appendPlainAssistantTextSegment(container, text.slice(cursor));
		}
	}

	private appendPlainAssistantTextSegment(container: HTMLElement, text: string): void {
		if (!text || text.trim().length === 0) {
			return;
		}
		const segment = document.createElement('div');
		segment.className = 'vsclone-thread-message-text-segment';
		segment.textContent = text;
		container.appendChild(segment);
	}

	private renderToolCallStatusLine(toolName: string, streaming: boolean): HTMLElement {
		const line = document.createElement('div');
		line.className = 'vsclone-agent-trace-line';
		line.classList.add('type-tool', 'status-start');
		line.textContent = streaming
			? localize('vsclone.thread.toolCall.running', 'Tool call running: {0}', toolName)
			: localize('vsclone.thread.toolCall.complete', 'Tool call: {0}', toolName);
		return line;
	}

	private renderToolResultStatusLine(toolName: string, success: boolean): HTMLElement {
		const line = document.createElement('div');
		line.className = 'vsclone-agent-trace-line';
		line.classList.add('type-tool_result', success ? 'status-success' : 'status-error');
		line.textContent = success
			? localize('vsclone.thread.toolResult.success', 'Tool result: {0} (success)', toolName)
			: localize('vsclone.thread.toolResult.failure', 'Tool result: {0} (failed)', toolName);
		return line;
	}

	private renderAgentTraceBlock(type: string, message: string, status: string | undefined): HTMLElement {
		const line = document.createElement('div');
		line.className = 'vsclone-agent-trace-line';
		line.classList.add(type ? `type-${type}` : 'type-unknown');
		if (status) {
			line.classList.add(`status-${status}`);
		}
		line.textContent = message || localize('vsclone.thread.trace.empty', '(trace event)');
		return line;
	}

	/**
	 * Diff cards surface mutating tool output inline so users can inspect applied changes
	 * without interruptive dialogs or opening a separate editor just to verify the patch.
	 */
	private renderToolResultDiffCard(toolName: string, output: string): HTMLElement | undefined {
		const parsedDiff = parseToolResultDiff(output);
		if (!parsedDiff) {
			return undefined;
		}

		const card = document.createElement('div');
		card.className = 'vsclone-tool-diff-card';

		const title = document.createElement('div');
		title.className = 'vsclone-tool-diff-title';
		switch (toolName) {
			case 'edit_file':
				title.textContent = localize('vsclone.thread.toolDiff.editedTitle', 'Applied file edits');
				break;
			case 'create_file':
				title.textContent = localize('vsclone.thread.toolDiff.createdTitle', 'Created file');
				break;
			default:
				title.textContent = localize('vsclone.thread.toolDiff.genericTitle', 'Applied workspace change');
				break;
		}
		card.appendChild(title);

		if (parsedDiff.summary) {
			const summary = document.createElement('div');
			summary.className = 'vsclone-tool-diff-summary';
			summary.textContent = parsedDiff.summary;
			card.appendChild(summary);
		}

		const body = document.createElement('div');
		body.className = 'vsclone-tool-diff-body';
		for (const rawLine of parsedDiff.diff.split('\n')) {
			const line = document.createElement('div');
			line.className = 'vsclone-tool-diff-line';
			if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
				line.classList.add('added');
			} else if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
				line.classList.add('removed');
			} else if (rawLine.startsWith('@@')) {
				line.classList.add('hunk');
			} else if (rawLine.startsWith('---') || rawLine.startsWith('+++')) {
				line.classList.add('file');
			}
			line.textContent = rawLine || ' ';
			body.appendChild(line);
		}
		card.appendChild(body);
		return card;
	}

	private async applyAssistantEdits(turn: IVSCloneChatHistoryTurn, button: HTMLButtonElement): Promise<void> {
		const responseText = turn.responsePlainText || turn.responseMarkdown;
		if (!responseText) {
			return;
		}

		const defaultButtonLabel = localize('vsclone.thread.assistant.apply', 'Apply Changes');
		button.disabled = true;
		button.textContent = localize('vsclone.thread.assistant.apply.pending', 'Applying...');

		try {
			const applyResult = await this.editApplicationService.applySearchReplaceBlocks(responseText);
			if (applyResult.appliedEdits > 0) {
				this.notificationService.info(localize(
					'vsclone.thread.assistant.apply.success',
					'Applied {0} edit(s) across {1} file(s).',
					applyResult.appliedEdits,
					applyResult.modifiedFiles.length,
				));
			} else {
				const failureDetails = applyResult.failures[0] ?? localize('vsclone.thread.assistant.apply.noChanges.reason', 'No matching SEARCH block was found.');
				this.notificationService.warn(localize(
					'vsclone.thread.assistant.apply.noChanges',
					'No changes were applied. {0}',
					failureDetails,
				));
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.notificationService.error(localize('vsclone.thread.assistant.apply.error', 'Failed to apply suggested changes: {0}', message));
		} finally {
			button.disabled = false;
			button.textContent = defaultButtonLabel;
		}
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
		const requiresExplicitModelSelection = !(this.configurationService.getValue<boolean>(VSCloneUseVSCodeChatBackendSetting) ?? false);
		const hasSelectedModel = !requiresExplicitModelSelection || !!this.getCurrentComposerModelSelection(this.activeThreadId);
		const disabled = !hasText || composerBusy || !hasSelectedModel;
		this.composerSendButton.disabled = disabled;
		this.composerInput.disabled = composerBusy;
		if (this.reasoningEffortSelect) {
			const reasoningControlHidden = this.reasoningEffortContainer?.classList.contains('hidden') ?? true;
			this.reasoningEffortSelect.disabled = composerBusy || reasoningControlHidden;
		}
		if (this.composerInput.disabled) {
			this.composerInput.placeholder = localize('vsclone.composer.waiting', 'Waiting for response...');
		} else if (!hasSelectedModel) {
			// The direct VSClone API path needs a concrete provider/model pair before we can send.
			this.composerInput.placeholder = localize('vsclone.composer.signInRequired', 'Sign in to a provider and choose a model to start chatting...');
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

	private applyRailLayout(): void {
		if (!this.rootContainer || !this.railContainer || !this.railResizeHandle) {
			return;
		}

		this.rootContainer.classList.toggle('rail-hidden', !this.railVisible);
		this.rootContainer.classList.toggle('history-screen', this.railVisible);
		this.railContainer.style.width = this.railVisible ? '100%' : '0px';
		this.railResizeHandle.style.display = 'none';
		if (this.conversationContainer) {
			this.conversationContainer.style.display = this.railVisible ? 'none' : '';
		}
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
			const targetWindow = getWindow(handle);

			const moveDisposable = addDisposableListener(targetWindow.document, EventType.MOUSE_MOVE, (moveEvent: MouseEvent) => {
				const delta = moveEvent.clientX - startX;
				const width = Math.min(railMaxWidth, Math.max(railMinWidth, startWidth + delta));
				if (width === this.railWidth) {
					return;
				}
				this.railWidth = width;
				this.applyRailLayout();
			});

			const upDisposable = addDisposableListener(targetWindow.document, EventType.MOUSE_UP, () => {
				moveDisposable.dispose();
				upDisposable.dispose();
				void this.configurationService.updateValue(railWidthSetting, this.railWidth);
			});
		}));
	}

	private refreshModelControls(): void {
		this.modelSwitcher?.refresh();
		this.refreshReasoningEffortControl();
	}

	private getCurrentComposerModelSelection(threadId: string | undefined): IVSCloneModelSelection | undefined {
		const selectedModel = this.modelSelectionService.getCurrentSelectionForThread(threadId ?? '', 'chat');
		if (!selectedModel) {
			return undefined;
		}

		const selectedModelDescriptor = this.modelCatalogService.getModel(selectedModel.modelIdentifier);
		const supportedReasoningLevels = selectedModelDescriptor?.reasoningEffortLevels;
		if (!supportedReasoningLevels || supportedReasoningLevels.length === 0) {
			return { ...selectedModel, threadId: threadId ?? undefined, reasoningEffort: undefined };
		}

		// Read directly from the visible select so a quick Send click right after changing the dropdown
		// uses the new value even before storage/event propagation catches up.
		const selectedFromControl = this.reasoningEffortSelect?.value as VSCloneReasoningEffortLevel | undefined;
		const resolvedReasoningEffort = selectedFromControl && supportedReasoningLevels.includes(selectedFromControl)
			? selectedFromControl
			: selectedModel.reasoningEffort && supportedReasoningLevels.includes(selectedModel.reasoningEffort)
				? selectedModel.reasoningEffort
				: selectedModelDescriptor.defaultReasoningEffort ?? supportedReasoningLevels[0];

		return {
			...selectedModel,
			threadId: threadId ?? undefined,
			reasoningEffort: resolvedReasoningEffort,
		};
	}

	private refreshReasoningEffortControl(): void {
		if (!this.reasoningEffortContainer || !this.reasoningEffortSelect) {
			return;
		}

		const selectedModel = this.modelSelectionService.getCurrentSelectionForThread(this.activeThreadId ?? '', 'chat');
		const selectedModelDescriptor = selectedModel ? this.modelCatalogService.getModel(selectedModel.modelIdentifier) : undefined;
		const supportedReasoningLevels = selectedModelDescriptor?.reasoningEffortLevels;
		if (!selectedModel || !supportedReasoningLevels || supportedReasoningLevels.length === 0) {
			this.reasoningEffortContainer.classList.add('hidden');
			this.reasoningEffortSelect.replaceChildren();
			this.updateComposerState();
			return;
		}

		const selectedReasoningEffort = selectedModel.reasoningEffort && supportedReasoningLevels.includes(selectedModel.reasoningEffort)
			? selectedModel.reasoningEffort
			: selectedModelDescriptor.defaultReasoningEffort ?? supportedReasoningLevels[0];

		this.reasoningEffortSelect.replaceChildren(
			...supportedReasoningLevels.map(level => {
				const option = document.createElement('option');
				option.value = level;
				option.textContent = this.toReasoningEffortLabel(level);
				return option;
			}),
		);
		this.reasoningEffortSelect.value = selectedReasoningEffort;
		this.reasoningEffortContainer.classList.remove('hidden');
		this.updateComposerState();
	}

	private async updateReasoningEffortSelection(): Promise<void> {
		if (!this.reasoningEffortSelect) {
			return;
		}

		const selectedModel = this.modelSelectionService.getCurrentSelectionForThread(this.activeThreadId ?? '', 'chat');
		const selectedModelDescriptor = selectedModel ? this.modelCatalogService.getModel(selectedModel.modelIdentifier) : undefined;
		const supportedReasoningLevels = selectedModelDescriptor?.reasoningEffortLevels;
		if (!selectedModel || !supportedReasoningLevels || supportedReasoningLevels.length === 0) {
			return;
		}

		const nextReasoningEffort = this.reasoningEffortSelect.value as VSCloneReasoningEffortLevel;
		if (!supportedReasoningLevels.includes(nextReasoningEffort) || selectedModel.reasoningEffort === nextReasoningEffort) {
			return;
		}

		await this.modelSelectionService.setSelectionForThread(this.activeThreadId ?? '', {
			...selectedModel,
			threadId: this.activeThreadId,
			location: 'chat',
			reasoningEffort: nextReasoningEffort,
			selectedAt: Date.now(),
		});
	}

	private toReasoningEffortLabel(level: VSCloneReasoningEffortLevel): string {
		switch (level) {
			case 'xhigh': return localize('vsclone.composer.reasoningEffort.xhigh', 'Extra High');
			case 'max': return localize('vsclone.composer.reasoningEffort.max', 'Max');
			case 'high': return localize('vsclone.composer.reasoningEffort.high', 'High');
			case 'medium': return localize('vsclone.composer.reasoningEffort.medium', 'Medium');
			case 'standard': return localize('vsclone.composer.reasoningEffort.standard', 'Standard');
			case 'low': return localize('vsclone.composer.reasoningEffort.low', 'Low');
			case 'minimal': return localize('vsclone.composer.reasoningEffort.minimal', 'Minimal');
			case 'lite': return localize('vsclone.composer.reasoningEffort.lite', 'Lite');
			case 'none': return localize('vsclone.composer.reasoningEffort.none', 'None');
		}
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

	private getModelSwitcherContext(): { threadId: string; location: IVSCloneChatLocation } {
		return {
			threadId: this.activeThreadId ?? '',
			location: 'chat',
		};
	}

	private async deleteThread(threadId: string): Promise<void> {
		this.sessionService.cancelThread(threadId);
		await this.historyService.deleteThread(threadId);

		if (this.activeThreadId === threadId) {
			this.showComposerForNewChat();
		}

		this.refreshRailRows();
		this.refreshModelControls();
		this.refreshConversation();
	}

	private showComposerForNewChat(): void {
		this.activeThreadId = undefined;
		this.rail.setSelectedThread(undefined);
		this.refreshModelControls();
		this.refreshConversation();
		this.railVisible = false;
		this.applyRailLayout();
		this.focusInput();
	}
}
