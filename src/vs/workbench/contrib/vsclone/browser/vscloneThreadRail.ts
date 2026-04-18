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
import { mountVSCloneThreadRail } from './preact/out/thread-rail/index.js';
import type { IVSCloneThreadRailRow } from './vscloneThreadRailTree.js';
import type { IVSCloneMountedView, IVSCloneRailViewProps } from './vscloneViewContracts.js';

export type VSCloneRailTab = 'all' | 'active' | 'archived';
export type VSCloneRailState = 'loading' | 'ready' | 'empty' | 'error';

export type VSCloneRailAction = 'open' | 'copyPrompt' | 'copyResponse' | 'reusePrompt' | 'delete' | 'toggleArchive';

export interface IVSCloneThreadRailActionEvent {
	action: VSCloneRailAction;
	threadId: string;
	archived?: boolean;
}

export interface IVSCloneThreadRailFilterState {
	query: string;
	tab: VSCloneRailTab;
}

interface IDeleteDialogState {
	threadId: string;
	threadTitle: string;
}

let deleteDialogIdPool = 0;

export class VSCloneThreadRail extends Disposable {
	private readonly _onDidSelectThread = this._register(new Emitter<string>());
	readonly onDidSelectThread: Event<string> = this._onDidSelectThread.event;

	private readonly _onDidRequestNewChat = this._register(new Emitter<void>());
	readonly onDidRequestNewChat: Event<void> = this._onDidRequestNewChat.event;

	private readonly _onDidRequestRetry = this._register(new Emitter<void>());
	readonly onDidRequestRetry: Event<void> = this._onDidRequestRetry.event;

	private readonly _onDidRequestAction = this._register(new Emitter<IVSCloneThreadRailActionEvent>());
	readonly onDidRequestAction: Event<IVSCloneThreadRailActionEvent> = this._onDidRequestAction.event;

	private readonly _onDidRequestClose = this._register(new Emitter<void>());
	readonly onDidRequestClose: Event<void> = this._onDidRequestClose.event;

	private readonly _onDidChangeFilterState = this._register(new Emitter<IVSCloneThreadRailFilterState>());
	readonly onDidChangeFilterState: Event<IVSCloneThreadRailFilterState> = this._onDidChangeFilterState.event;

	private container: HTMLElement | undefined;
	private searchInput: HTMLInputElement | undefined;
	private modalContainer: HTMLElement | undefined;
	private modalCancelButton: HTMLButtonElement | undefined;
	private modalConfirmButton: HTMLButtonElement | undefined;
	private modalPreviouslyFocused: HTMLElement | undefined;
	private readonly searchDelayer = this._register(new Delayer<void>(140));
	private readonly deleteDialogId = ++deleteDialogIdPool;
	private mountedView: IVSCloneMountedView<IVSCloneRailViewProps> | undefined;

	private filterState: IVSCloneThreadRailFilterState = { query: '', tab: 'all' };
	private rows: readonly IVSCloneThreadRailRow[] = [];
	private readonly rowsById = new Map<string, IVSCloneThreadRailRow>();
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
		this.container = container;
		// The workbench controller owns the container lifetime and only talks to the generated
		// bundle through a stable mount handle so framework specifics stay out of this file.
		this.mountedView?.dispose();
		this.mountedView = mountVSCloneThreadRail(container, this.createViewProps()) as IVSCloneMountedView<IVSCloneRailViewProps> | undefined;
	}

	override dispose(): void {
		this.mountedView?.dispose();
		this.mountedView = undefined;
		super.dispose();
	}

	setFilterState(filterState: IVSCloneThreadRailFilterState): void {
		this.searchDelayer.cancel();
		this.filterState = filterState;
		this.renderView();
		if (this.searchInput) {
			this.searchInput.value = filterState.query;
		}
	}

	getFilterState(): IVSCloneThreadRailFilterState {
		return this.filterState;
	}

	focusSearch(): void {
		this.searchInput?.focus();
		this.searchInput?.select();
	}

	setRows(rows: readonly IVSCloneThreadRailRow[]): void {
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
		this.renderView();
	}

	setLoading(): void {
		this.viewState = 'loading';
		this.errorMessage = undefined;
		this.renderView();
	}

	setError(message?: string): void {
		this.viewState = 'error';
		this.errorMessage = message;
		this.renderView();
	}

	setSelectedThread(threadId: string | undefined): void {
		this.selectedThreadId = threadId;
		this.renderView();
	}

	getSelectedThread(): string | undefined {
		return this.selectedThreadId;
	}

	confirmDeleteThread(threadId: string, threadTitle: string): void {
		this.pendingDelete = { threadId, threadTitle };
		const targetWindow = this.modalContainer ? DOM.getWindow(this.modalContainer) : DOM.getActiveWindow();
		const activeElement = targetWindow.document.activeElement;
		this.modalPreviouslyFocused = DOM.isHTMLElement(activeElement) ? activeElement : undefined;
		this.renderView();
		// Move focus after the Preact commit so the modal stays keyboard-contained immediately.
		this.modalCancelButton?.focus();
	}

	private renderView(): void {
		if (!this.container || !this.mountedView) {
			return;
		}

		this.mountedView.rerender(this.createViewProps());
	}

	private createViewProps(): IVSCloneRailViewProps {
		return {
			filterState: this.filterState,
			rows: this.rows,
			selectedThreadId: this.selectedThreadId,
			viewState: this.viewState,
			errorMessage: this.errorMessage,
			pendingDelete: this.pendingDelete,
			deleteTitleId: `vsclone-thread-rail-delete-title-${this.deleteDialogId}`,
			deleteDescriptionId: `vsclone-thread-rail-delete-description-${this.deleteDialogId}`,
			searchInputRef: element => { this.searchInput = element ?? undefined; },
			modalContainerRef: element => { this.modalContainer = element ?? undefined; },
			modalCancelButtonRef: element => { this.modalCancelButton = element ?? undefined; },
			modalConfirmButtonRef: element => { this.modalConfirmButton = element ?? undefined; },
			getRowAriaLabel: row => this.getRowAriaLabel(row),
			onBack: () => this._onDidRequestClose.fire(),
			onNewChat: () => this._onDidRequestNewChat.fire(),
			onSearchInput: value => this.handleSearchInput(value),
			onTabSelect: tab => this.updateTab(tab),
			onRowSelect: threadId => this.handleRowClick(threadId),
			onRowContextMenu: (threadId, event) => this.handleRowContextMenu(threadId, event),
			onRetry: () => this._onDidRequestRetry.fire(),
			onDeleteOverlayClick: () => this.hideDeleteDialog(true),
			onCancelDelete: () => this.hideDeleteDialog(true),
			onConfirmDelete: () => this.confirmPendingDelete(),
			onDeleteModalKeyDown: event => this.handleDeleteDialogKeyDown(event),
		};
	}

	private handleSearchInput(value: string): void {
		const query = value.trim();
		if (query === this.filterState.query) {
			return;
		}

		this.filterState = { ...this.filterState, query };
		void this.searchDelayer.trigger(() => {
			this._onDidChangeFilterState.fire(this.filterState);
		});
	}

	private updateTab(tab: VSCloneRailTab): void {
		if (this.filterState.tab === tab) {
			return;
		}
		this.searchDelayer.cancel();
		this.filterState = { ...this.filterState, tab };
		this.renderView();
		this._onDidChangeFilterState.fire(this.filterState);
	}

	private handleRowClick(threadId: string): void {
		this.selectedThreadId = threadId;
		this.renderView();
		this._onDidSelectThread.fire(threadId);
	}

	private handleRowContextMenu(threadId: string, event: MouseEvent): void {
		const row = this.rowsById.get(threadId);
		if (!row) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		// The row context menu is opened repeatedly, so its temporary Action instances must be
		// released on hide rather than accumulating on the long-lived rail object.
		const menuActions = new DisposableStore();
		const actions = [
			menuActions.add(new Action('vsclone.threadRail.open', localize('vsclone.rail.action.open', 'Open'), undefined, true, () => this._onDidRequestAction.fire({ action: 'open', threadId: row.threadId }))),
			menuActions.add(new Action('vsclone.threadRail.copyPrompt', localize('vsclone.rail.action.copyPrompt', 'Copy Prompt'), undefined, true, () => this._onDidRequestAction.fire({ action: 'copyPrompt', threadId: row.threadId }))),
			menuActions.add(new Action('vsclone.threadRail.copyResponse', localize('vsclone.rail.action.copyResponse', 'Copy Response'), undefined, true, () => this._onDidRequestAction.fire({ action: 'copyResponse', threadId: row.threadId }))),
			menuActions.add(new Action('vsclone.threadRail.reusePrompt', localize('vsclone.rail.action.reusePrompt', 'Reuse Prompt'), undefined, true, () => this._onDidRequestAction.fire({ action: 'reusePrompt', threadId: row.threadId }))),
			menuActions.add(new Action('vsclone.threadRail.toggleArchive', row.archived ? localize('vsclone.rail.action.unarchive', 'Unarchive') : localize('vsclone.rail.action.archive', 'Archive'), undefined, true, () => this._onDidRequestAction.fire({ action: 'toggleArchive', threadId: row.threadId, archived: !row.archived }))),
			menuActions.add(new Action('vsclone.threadRail.delete', localize('vsclone.rail.action.delete', 'Delete'), undefined, true, () => this.confirmDeleteThread(row.threadId, row.title))),
		];
		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: event.clientX, y: event.clientY }),
			getActions: () => actions,
			onHide: () => menuActions.dispose(),
		});
	}

	private getRowAriaLabel(row: IVSCloneThreadRailRow): string {
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

	private confirmPendingDelete(): void {
		if (!this.pendingDelete) {
			return;
		}

		const { threadId } = this.pendingDelete;
		this.hideDeleteDialog(false);
		this._onDidRequestAction.fire({ action: 'delete', threadId });
	}

	private hideDeleteDialog(restoreFocus: boolean): void {
		this.pendingDelete = undefined;
		this.renderView();
		if (restoreFocus) {
			if (this.modalPreviouslyFocused?.isConnected) {
				this.modalPreviouslyFocused.focus();
			}
		}
		this.modalPreviouslyFocused = undefined;
	}

	private handleDeleteDialogKeyDown(event: KeyboardEvent): void {
		if (!this.pendingDelete || !this.modalCancelButton || !this.modalConfirmButton || !this.modalContainer) {
			return;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			this.hideDeleteDialog(true);
			return;
		}

		if (event.key !== 'Tab') {
			return;
		}

		// The overlay renders exactly one modal child, so read it structurally instead of querying by
		// selector. That keeps the focus trap resilient to class renames and avoids selector-based DOM coupling.
		const modal = this.modalContainer.firstElementChild;
		if (!DOM.isHTMLElement(modal)) {
			return;
		}

		// The rail can live in secondary workbench windows, so the focus trap must inspect the modal's
		// owning window instead of the process-global document.
		const activeElement = DOM.getWindow(this.modalContainer).document.activeElement;
		const active = DOM.isHTMLElement(activeElement) ? activeElement : undefined;
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
}
