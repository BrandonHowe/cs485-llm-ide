/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { Action } from '../../../../base/common/actions.js';
import { Delayer } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IVSCloneChatHistoryRailRow } from './vscloneChatHistoryRailTree.js';

export type VSCloneRailTab = 'all' | 'active' | 'archived';
export type VSCloneRailState = 'loading' | 'ready' | 'empty' | 'error';

export type VSCloneRailAction = 'open' | 'copyPrompt' | 'copyResponse' | 'reusePrompt' | 'delete' | 'toggleArchive';

export interface IVSCloneChatHistoryRailActionEvent {
	action: VSCloneRailAction;
	threadId: string;
	archived?: boolean;
}

export interface IVSCloneChatHistoryRailFilterState {
	query: string;
	tab: VSCloneRailTab;
}

interface IDeleteDialogState {
	threadId: string;
	threadTitle: string;
}

let deleteDialogIdPool = 0;

export class VSCloneChatHistoryRail extends Disposable {
	private readonly _onDidSelectThread = this._register(new Emitter<string>());
	readonly onDidSelectThread: Event<string> = this._onDidSelectThread.event;

	private readonly _onDidRequestNewChat = this._register(new Emitter<void>());
	readonly onDidRequestNewChat: Event<void> = this._onDidRequestNewChat.event;

	private readonly _onDidRequestRetry = this._register(new Emitter<void>());
	readonly onDidRequestRetry: Event<void> = this._onDidRequestRetry.event;

	private readonly _onDidRequestAction = this._register(new Emitter<IVSCloneChatHistoryRailActionEvent>());
	readonly onDidRequestAction: Event<IVSCloneChatHistoryRailActionEvent> = this._onDidRequestAction.event;

	private readonly _onDidRequestClose = this._register(new Emitter<void>());
	readonly onDidRequestClose: Event<void> = this._onDidRequestClose.event;

	private readonly _onDidChangeFilterState = this._register(new Emitter<IVSCloneChatHistoryRailFilterState>());
	readonly onDidChangeFilterState: Event<IVSCloneChatHistoryRailFilterState> = this._onDidChangeFilterState.event;

	private listContainer: HTMLElement | undefined;
	private stateContainer: HTMLElement | undefined;
	private searchInput: HTMLInputElement | undefined;
	private tabButtons = new Map<VSCloneRailTab, HTMLButtonElement>();
	private modalContainer: HTMLElement | undefined;
	private modalDescription: HTMLElement | undefined;
	private modalCancelButton: HTMLButtonElement | undefined;
	private modalConfirmButton: HTMLButtonElement | undefined;
	private modalPreviouslyFocused: HTMLElement | undefined;
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly searchDelayer = this._register(new Delayer<void>(140));
	private readonly deleteDialogId = ++deleteDialogIdPool;

	private filterState: IVSCloneChatHistoryRailFilterState = { query: '', tab: 'all' };
	private rows: readonly IVSCloneChatHistoryRailRow[] = [];
	private readonly rowsById = new Map<string, IVSCloneChatHistoryRailRow>();
	private selectedThreadId: string | undefined;
	private viewState: VSCloneRailState = 'loading';
	private errorMessage: string | undefined;
	private pendingDelete: IDeleteDialogState | undefined;

	constructor(
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
	) {
		super();
	}

	render(container: HTMLElement): void {
		container.classList.add('vsclone-chat-history-rail');
		container.replaceChildren();

		const header = document.createElement('div');
		header.className = 'vsclone-chat-history-rail-header';

		const headerRow = document.createElement('div');
		headerRow.className = 'vsclone-chat-history-rail-header-row';

		const backButton = document.createElement('button');
		backButton.type = 'button';
		backButton.className = 'vsclone-chat-history-back';
		backButton.textContent = '\u2190';
		const backButtonLabel = localize('vsclone.rail.back.tooltip', 'Back to conversation');
		backButton.title = backButtonLabel;
		backButton.setAttribute('aria-label', backButtonLabel);
		this._register(DOM.addDisposableListener(backButton, DOM.EventType.CLICK, () => this._onDidRequestClose.fire()));
		headerRow.appendChild(backButton);

		const title = document.createElement('div');
		title.className = 'vsclone-chat-history-rail-title';
		title.textContent = localize('vsclone.rail.title', 'Chat History').toUpperCase();
		headerRow.appendChild(title);

		const newChatButton = document.createElement('button');
		newChatButton.type = 'button';
		newChatButton.className = 'vsclone-chat-history-new-chat';
		newChatButton.textContent = localize('vsclone.rail.newChat', 'New Chat');
		this._register(DOM.addDisposableListener(newChatButton, DOM.EventType.CLICK, () => this._onDidRequestNewChat.fire()));
		headerRow.appendChild(newChatButton);
		header.appendChild(headerRow);

		const search = document.createElement('input');
		search.className = 'vsclone-chat-history-search';
		search.type = 'search';
		search.placeholder = localize('vsclone.rail.search.placeholder', 'Search threads...');
		search.setAttribute('aria-label', localize('vsclone.rail.search.ariaLabel', 'Search chat history'));
		search.value = this.filterState.query;
		this.searchInput = search;
		header.appendChild(search);

		const tabsContainer = document.createElement('div');
		tabsContainer.className = 'vsclone-chat-history-tabs';
		for (const tab of ['all', 'active', 'archived'] as const) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'vsclone-chat-history-tab';
			button.textContent = tab === 'all' ? localize('vsclone.rail.tab.all', 'All') : tab === 'active' ? localize('vsclone.rail.tab.active', 'Active') : localize('vsclone.rail.tab.archived', 'Archived');
			button.dataset.tab = tab;
			this.tabButtons.set(tab, button);
			tabsContainer.appendChild(button);
			this._register(DOM.addDisposableListener(button, DOM.EventType.CLICK, () => this.updateTab(tab)));
		}
		header.appendChild(tabsContainer);

		this._register(DOM.addDisposableListener(search, DOM.EventType.INPUT, () => {
			const query = search.value.trim();
			if (query === this.filterState.query) {
				return;
			}

			this.filterState = { ...this.filterState, query };
			void this.searchDelayer.trigger(() => {
				this._onDidChangeFilterState.fire(this.filterState);
			});
		}));

		const body = document.createElement('div');
		body.className = 'vsclone-chat-history-rail-body';

		const listContainer = document.createElement('div');
		listContainer.className = 'vsclone-chat-history-list';
		listContainer.setAttribute('role', 'list');
		listContainer.setAttribute('aria-label', localize('vsclone.rail.list.ariaLabel', 'Conversation threads'));
		this.listContainer = listContainer;
		this._register(DOM.addDisposableListener(listContainer, DOM.EventType.CLICK, (event: MouseEvent) => this.onListClick(event)));
		this._register(DOM.addDisposableListener(listContainer, DOM.EventType.CONTEXT_MENU, (event: MouseEvent) => this.onListContextMenu(event)));
		body.appendChild(listContainer);

		const stateContainer = document.createElement('div');
		stateContainer.className = 'vsclone-chat-history-state';
		this.stateContainer = stateContainer;
		body.appendChild(stateContainer);

		const modal = this.createDeleteModal();
		this.modalContainer = modal;
		container.appendChild(header);
		container.appendChild(body);
		container.appendChild(modal);

		this.refreshTabStyles();
		this.renderState();
	}

	setFilterState(filterState: IVSCloneChatHistoryRailFilterState): void {
		this.searchDelayer.cancel();
		this.filterState = filterState;
		if (this.searchInput) {
			this.searchInput.value = filterState.query;
		}
		this.refreshTabStyles();
	}

	getFilterState(): IVSCloneChatHistoryRailFilterState {
		return this.filterState;
	}

	focusSearch(): void {
		this.searchInput?.focus();
		this.searchInput?.select();
	}

	setRows(rows: readonly IVSCloneChatHistoryRailRow[]): void {
		this.rows = rows;
		this.rowsById.clear();
		for (const row of rows) {
			this.rowsById.set(row.threadId, row);
		}

		if (this.selectedThreadId && !this.rowsById.has(this.selectedThreadId)) {
			this.selectedThreadId = undefined;
		}

		this.viewState = rows.length === 0 ? 'empty' : 'ready';
		this.errorMessage = undefined;
		this.renderState();
	}

	setLoading(): void {
		this.viewState = 'loading';
		this.errorMessage = undefined;
		this.renderState();
	}

	setError(message?: string): void {
		this.viewState = 'error';
		this.errorMessage = message;
		this.renderState();
	}

	setSelectedThread(threadId: string | undefined): void {
		const previous = this.selectedThreadId;
		this.selectedThreadId = threadId;
		if (!this.listContainer || this.viewState !== 'ready') {
			return;
		}

		if (previous && previous !== threadId) {
			this.setRowSelection(previous, false);
		}
		if (threadId) {
			this.setRowSelection(threadId, true);
		}
	}

	getSelectedThread(): string | undefined {
		return this.selectedThreadId;
	}

	confirmDeleteThread(threadId: string, threadTitle: string): void {
		this.pendingDelete = { threadId, threadTitle };
		const targetWindow = this.modalContainer ? DOM.getWindow(this.modalContainer) : DOM.getActiveWindow();
		const activeElement = targetWindow.document.activeElement;
		this.modalPreviouslyFocused = DOM.isHTMLElement(activeElement) ? activeElement : undefined;
		if (this.modalDescription) {
			this.modalDescription.textContent = localize('vsclone.rail.delete.message', 'Are you sure you want to delete "{0}"? This action cannot be undone.', threadTitle);
		}
		this.modalContainer?.classList.add('visible');
		this.modalContainer?.setAttribute('aria-hidden', 'false');
		// Move focus into the dialog immediately so keyboard and screen-reader users remain in modal context.
		this.modalCancelButton?.focus();
	}

	private updateTab(tab: VSCloneRailTab): void {
		if (this.filterState.tab === tab) {
			return;
		}
		this.searchDelayer.cancel();
		this.filterState = { ...this.filterState, tab };
		this.refreshTabStyles();
		this._onDidChangeFilterState.fire(this.filterState);
	}

	private refreshTabStyles(): void {
		for (const [tab, button] of this.tabButtons) {
			const selected = this.filterState.tab === tab;
			button.classList.toggle('active', selected);
			button.setAttribute('aria-pressed', String(selected));
		}
	}

	private renderState(): void {
		if (!this.listContainer || !this.stateContainer) {
			return;
		}

		this.renderDisposables.clear();

		this.listContainer.classList.toggle('hidden', this.viewState !== 'ready');
		this.stateContainer.classList.toggle('hidden', this.viewState === 'ready');
		if (this.viewState === 'ready') {
			this.stateContainer.removeAttribute('role');
		}

		if (this.viewState === 'ready') {
			this.renderRows();
			return;
		}

		if (this.viewState === 'loading') {
			this.renderLoadingState();
			return;
		}

		if (this.viewState === 'error') {
			this.renderErrorState();
			return;
		}

		this.renderEmptyState();
	}

	private renderRows(): void {
		if (!this.listContainer) {
			return;
		}

		this.listContainer.replaceChildren();
		const fragment = document.createDocumentFragment();
		for (const row of this.rows) {
			fragment.appendChild(this.createRowElement(row));
		}
		this.listContainer.appendChild(fragment);
	}

	private createRowElement(row: IVSCloneChatHistoryRailRow): HTMLElement {
		const rowElement = document.createElement('button');
		rowElement.type = 'button';
		rowElement.className = 'vsclone-chat-history-row';
		rowElement.classList.toggle('selected', row.threadId === this.selectedThreadId || row.selected);
		rowElement.dataset.threadId = row.threadId;
		rowElement.setAttribute('aria-pressed', String(row.threadId === this.selectedThreadId || row.selected));
		rowElement.setAttribute('aria-label', this.getRowAriaLabel(row));

		const top = document.createElement('div');
		top.className = 'vsclone-chat-history-row-top';
		const title = document.createElement('div');
		title.className = 'vsclone-chat-history-row-title';
		title.textContent = row.title;
		top.appendChild(title);

		const timestamp = document.createElement('div');
		timestamp.className = 'vsclone-chat-history-row-timestamp';
		timestamp.textContent = row.updatedLabel;
		top.appendChild(timestamp);
		rowElement.appendChild(top);

		const preview = document.createElement('div');
		preview.className = 'vsclone-chat-history-row-preview';
		preview.textContent = row.preview;
		rowElement.appendChild(preview);

		const metadata = document.createElement('div');
		metadata.className = 'vsclone-chat-history-row-metadata';
		metadata.textContent = localize('vsclone.rail.turnCount', '{0} turns', row.turnCount);
		if (row.archived) {
			const archived = document.createElement('span');
			archived.className = 'vsclone-chat-history-row-archived';
			archived.textContent = localize('vsclone.rail.archived.badge', 'Archived');
			metadata.appendChild(archived);
		}
		rowElement.appendChild(metadata);
		return rowElement;
	}

	private setRowSelection(threadId: string, selected: boolean): void {
		if (!this.listContainer) {
			return;
		}

		for (const child of this.listContainer.children) {
			if (!DOM.isHTMLElement(child) || !child.classList.contains('vsclone-chat-history-row')) {
				continue;
			}
			if (child.dataset.threadId === threadId) {
				child.classList.toggle('selected', selected);
				child.setAttribute('aria-pressed', String(selected));
				return;
			}
		}
	}

	private getRowAriaLabel(row: IVSCloneChatHistoryRailRow): string {
		const archivedSuffix = row.archived ? localize('vsclone.rail.row.archived', 'Archived.') : '';
		return localize(
			'vsclone.rail.row.ariaLabel',
			'{0}. {1} turns. Updated {2}. {3}',
			row.title,
			row.turnCount,
			row.updatedLabel,
			archivedSuffix,
		).trim();
	}

	private onListClick(event: MouseEvent): void {
		const row = this.getRowFromEvent(event);
		if (!row) {
			return;
		}

		const previous = this.selectedThreadId;
		this.selectedThreadId = row.threadId;
		if (previous && previous !== row.threadId) {
			this.setRowSelection(previous, false);
		}
		this.setRowSelection(row.threadId, true);
		this._onDidSelectThread.fire(row.threadId);
	}

	private onListContextMenu(event: MouseEvent): void {
		const row = this.getRowFromEvent(event);
		if (!row) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		// The row context menu is opened repeatedly, so its temporary Action instances must be
		// released on hide rather than accumulating on the long-lived rail object.
		const menuActions = new DisposableStore();
		const actions = [
			menuActions.add(new Action('vsclone.chatHistory.open', localize('vsclone.rail.action.open', 'Open'), undefined, true, () => this._onDidRequestAction.fire({ action: 'open', threadId: row.threadId }))),
			menuActions.add(new Action('vsclone.chatHistory.copyPrompt', localize('vsclone.rail.action.copyPrompt', 'Copy Prompt'), undefined, true, () => this._onDidRequestAction.fire({ action: 'copyPrompt', threadId: row.threadId }))),
			menuActions.add(new Action('vsclone.chatHistory.copyResponse', localize('vsclone.rail.action.copyResponse', 'Copy Response'), undefined, true, () => this._onDidRequestAction.fire({ action: 'copyResponse', threadId: row.threadId }))),
			menuActions.add(new Action('vsclone.chatHistory.reusePrompt', localize('vsclone.rail.action.reusePrompt', 'Reuse Prompt'), undefined, true, () => this._onDidRequestAction.fire({ action: 'reusePrompt', threadId: row.threadId }))),
			menuActions.add(new Action('vsclone.chatHistory.toggleArchive', row.archived ? localize('vsclone.rail.action.unarchive', 'Unarchive') : localize('vsclone.rail.action.archive', 'Archive'), undefined, true, () => this._onDidRequestAction.fire({ action: 'toggleArchive', threadId: row.threadId, archived: !row.archived }))),
			menuActions.add(new Action('vsclone.chatHistory.delete', localize('vsclone.rail.action.delete', 'Delete'), undefined, true, () => this.confirmDeleteThread(row.threadId, row.title))),
		];
		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: event.clientX, y: event.clientY }),
			getActions: () => actions,
			onHide: () => menuActions.dispose(),
		});
	}

	private getRowFromEvent(event: MouseEvent): IVSCloneChatHistoryRailRow | undefined {
		const target = event.target;
		if (!DOM.isHTMLElement(target) || !this.listContainer) {
			return undefined;
		}

		const rowElement = target.closest<HTMLElement>('.vsclone-chat-history-row');
		if (!rowElement || !this.listContainer.contains(rowElement)) {
			return undefined;
		}

		const threadId = rowElement.dataset.threadId;
		if (!threadId) {
			return undefined;
		}

		return this.rowsById.get(threadId);
	}

	private renderEmptyState(): void {
		if (!this.stateContainer) {
			return;
		}
		this.stateContainer.replaceChildren();
		this.stateContainer.setAttribute('role', 'status');
		const icon = document.createElement('div');
		icon.className = 'vsclone-chat-history-state-icon';
		icon.textContent = '[]';
		icon.setAttribute('aria-hidden', 'true');
		const heading = document.createElement('div');
		heading.className = 'vsclone-chat-history-state-title';
		heading.textContent = localize('vsclone.rail.empty.title', 'No conversations yet');
		const description = document.createElement('div');
		description.className = 'vsclone-chat-history-state-description';
		description.textContent = localize('vsclone.rail.empty.description', 'Start a new conversation to begin your chat history.');
		this.stateContainer.appendChild(icon);
		this.stateContainer.appendChild(heading);
		this.stateContainer.appendChild(description);
	}

	private renderErrorState(): void {
		if (!this.stateContainer) {
			return;
		}
		this.stateContainer.replaceChildren();
		this.stateContainer.setAttribute('role', 'alert');
		const icon = document.createElement('div');
		icon.className = 'vsclone-chat-history-state-icon error';
		icon.textContent = '!';
		icon.setAttribute('aria-hidden', 'true');
		const heading = document.createElement('div');
		heading.className = 'vsclone-chat-history-state-title';
		heading.textContent = localize('vsclone.rail.error.title', 'Something went wrong');
		const description = document.createElement('div');
		description.className = 'vsclone-chat-history-state-description';
		description.textContent = this.errorMessage ?? localize('vsclone.rail.error.description', 'Failed to load chat history. Please check your connection and try again.');
		const retryButton = document.createElement('button');
		retryButton.type = 'button';
		retryButton.className = 'vsclone-chat-history-retry';
		retryButton.textContent = localize('vsclone.rail.error.retry', 'Try again');
		this.renderDisposables.add(DOM.addDisposableListener(retryButton, DOM.EventType.CLICK, () => this._onDidRequestRetry.fire()));

		this.stateContainer.appendChild(icon);
		this.stateContainer.appendChild(heading);
		this.stateContainer.appendChild(description);
		this.stateContainer.appendChild(retryButton);
	}

	private renderLoadingState(): void {
		if (!this.stateContainer) {
			return;
		}
		this.stateContainer.replaceChildren();
		this.stateContainer.setAttribute('role', 'status');
		const skeleton = document.createElement('div');
		skeleton.className = 'vsclone-chat-history-skeleton';
		skeleton.setAttribute('aria-hidden', 'true');
		for (let i = 0; i < 7; i++) {
			const row = document.createElement('div');
			row.className = 'vsclone-chat-history-skeleton-row';
			for (let j = 0; j < 3; j++) {
				const line = document.createElement('div');
				line.className = 'vsclone-chat-history-skeleton-line';
				row.appendChild(line);
			}
			skeleton.appendChild(row);
		}
		this.stateContainer.appendChild(skeleton);
	}

	private createDeleteModal(): HTMLElement {
		const overlay = document.createElement('div');
		overlay.className = 'vsclone-chat-history-delete-overlay';
		overlay.setAttribute('aria-hidden', 'true');

		const modal = document.createElement('div');
		modal.className = 'vsclone-chat-history-delete-modal';
		modal.setAttribute('role', 'dialog');
		modal.setAttribute('aria-modal', 'true');
		modal.setAttribute('aria-labelledby', `vsclone-chat-history-delete-title-${this.deleteDialogId}`);
		modal.setAttribute('aria-describedby', `vsclone-chat-history-delete-description-${this.deleteDialogId}`);

		const title = document.createElement('div');
		title.className = 'vsclone-chat-history-delete-title';
		title.textContent = localize('vsclone.rail.delete.title', 'Delete thread?');
		title.id = `vsclone-chat-history-delete-title-${this.deleteDialogId}`;

		const description = document.createElement('div');
		description.className = 'vsclone-chat-history-delete-description';
		description.id = `vsclone-chat-history-delete-description-${this.deleteDialogId}`;
		this.modalDescription = description;

		const actions = document.createElement('div');
		actions.className = 'vsclone-chat-history-delete-actions';

		const cancel = document.createElement('button');
		cancel.type = 'button';
		cancel.className = 'vsclone-chat-history-delete-cancel';
		cancel.textContent = localize('vsclone.rail.delete.cancel', 'Cancel');
		this.modalCancelButton = cancel;
		this._register(DOM.addDisposableListener(cancel, DOM.EventType.CLICK, () => {
			this.pendingDelete = undefined;
			this.closeDeleteModal();
		}));

		const confirm = document.createElement('button');
		confirm.type = 'button';
		confirm.className = 'vsclone-chat-history-delete-confirm';
		confirm.textContent = localize('vsclone.rail.delete.confirm', 'Delete');
		this.modalConfirmButton = confirm;
		this._register(DOM.addDisposableListener(confirm, DOM.EventType.CLICK, () => {
			if (!this.pendingDelete) {
				return;
			}
			const request = this.pendingDelete;
			this.pendingDelete = undefined;
			this.closeDeleteModal();
			this._onDidRequestAction.fire({ action: 'delete', threadId: request.threadId });
		}));

		actions.appendChild(cancel);
		actions.appendChild(confirm);
		modal.appendChild(title);
		modal.appendChild(description);
		modal.appendChild(actions);
		overlay.appendChild(modal);

		this._register(DOM.addDisposableListener(overlay, DOM.EventType.CLICK, (event: MouseEvent) => {
			if (event.target === overlay) {
				this.pendingDelete = undefined;
				this.closeDeleteModal();
			}
		}));

		this._register(DOM.addDisposableListener(overlay, DOM.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (!overlay.classList.contains('visible')) {
				return;
			}

			if (event.key === 'Escape') {
				event.preventDefault();
				this.pendingDelete = undefined;
				this.closeDeleteModal();
				return;
			}

			// Keep keyboard focus cycling inside the modal while it is visible.
			if (event.key === 'Tab' && this.modalCancelButton && this.modalConfirmButton) {
				const active = DOM.getWindow(overlay).document.activeElement;
				if (event.shiftKey) {
					if (!active || active === this.modalCancelButton || !modal.contains(active)) {
						event.preventDefault();
						this.modalConfirmButton.focus();
					}
					return;
				}
				if (!active || active === this.modalConfirmButton || !modal.contains(active)) {
					event.preventDefault();
					this.modalCancelButton.focus();
				}
			}
		}));

		return overlay;
	}

	private closeDeleteModal(): void {
		this.modalContainer?.classList.remove('visible');
		this.modalContainer?.setAttribute('aria-hidden', 'true');
		if (this.modalPreviouslyFocused?.isConnected) {
			this.modalPreviouslyFocused.focus();
		}
		this.modalPreviouslyFocused = undefined;
	}
}
