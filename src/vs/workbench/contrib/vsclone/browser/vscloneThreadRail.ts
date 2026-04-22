/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Action } from '../../../../base/common/actions.js';
import { Delayer } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { mountVSCloneThreadRail } from './preact/out/thread-rail/index.js';
import type { IVSCloneThreadRailRow } from './vscloneThreadRailTree.js';
import type { IVSCloneMountedView, IVSCloneRailViewProps } from './vscloneViewContracts.js';

export type VSCloneRailState = 'loading' | 'ready' | 'empty' | 'error';

export type VSCloneRailAction = 'open' | 'copyPrompt' | 'copyResponse' | 'reusePrompt' | 'delete';

export interface IVSCloneThreadRailActionEvent {
	action: VSCloneRailAction;
	threadId: string;
}

const DEFAULT_INITIAL_ROW_COUNT = 3;

export class VSCloneThreadRail extends Disposable {
	private readonly _onDidSelectThread = this._register(new Emitter<string>());
	readonly onDidSelectThread: Event<string> = this._onDidSelectThread.event;

	private readonly _onDidRequestRetry = this._register(new Emitter<void>());
	readonly onDidRequestRetry: Event<void> = this._onDidRequestRetry.event;

	private readonly _onDidRequestAction = this._register(new Emitter<IVSCloneThreadRailActionEvent>());
	readonly onDidRequestAction: Event<IVSCloneThreadRailActionEvent> = this._onDidRequestAction.event;

	private readonly _onDidChangeSearchQuery = this._register(new Emitter<string>());
	readonly onDidChangeSearchQuery: Event<string> = this._onDidChangeSearchQuery.event;

	private readonly _onDidRequestNewChat = this._register(new Emitter<void>());
	readonly onDidRequestNewChat: Event<void> = this._onDidRequestNewChat.event;

	private container: HTMLElement | undefined;
	private searchInput: HTMLInputElement | undefined;
	private mountedView: IVSCloneMountedView<IVSCloneRailViewProps> | undefined;
	private readonly searchDelayer = this._register(new Delayer<void>(140));

	private rows: readonly IVSCloneThreadRailRow[] = [];
	private readonly rowsById = new Map<string, IVSCloneThreadRailRow>();
	private selectedThreadId: string | undefined;
	private hoveredThreadId: string | undefined;
	private pendingDeleteThreadId: string | undefined;
	private showAll = true;
	private searchQuery = '';
	private viewState: VSCloneRailState = 'loading';
	private errorMessage: string | undefined;

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

	setRows(rows: readonly IVSCloneThreadRailRow[]): void {
		this.rows = rows;
		this.rowsById.clear();
		for (const row of rows) {
			this.rowsById.set(row.threadId, row);
		}

		if (this.selectedThreadId && !this.rowsById.has(this.selectedThreadId)) {
			this.selectedThreadId = undefined;
		}
		if (this.hoveredThreadId && !this.rowsById.has(this.hoveredThreadId)) {
			this.hoveredThreadId = undefined;
		}
		if (this.pendingDeleteThreadId && !this.rowsById.has(this.pendingDeleteThreadId)) {
			this.pendingDeleteThreadId = undefined;
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

	getSearchQuery(): string {
		return this.searchQuery;
	}

	focusSearch(): void {
		this.searchInput?.focus();
		this.searchInput?.select();
	}

	private renderView(): void {
		if (!this.container || !this.mountedView) {
			return;
		}

		this.mountedView.rerender(this.createViewProps());
	}

	private createViewProps(): IVSCloneRailViewProps {
		return {
			rows: this.rows,
			selectedThreadId: this.selectedThreadId,
			viewState: this.viewState,
			errorMessage: this.errorMessage,
			hoveredThreadId: this.hoveredThreadId,
			pendingDeleteThreadId: this.pendingDeleteThreadId,
			showAll: this.showAll,
			initialRowCount: DEFAULT_INITIAL_ROW_COUNT,
			searchQuery: this.searchQuery,
			searchInputRef: element => { this.searchInput = element ?? undefined; },
			getRowAriaLabel: row => this.getRowAriaLabel(row),
			onRowSelect: threadId => this.handleRowClick(threadId),
			onRowContextMenu: (threadId, event) => this.handleRowContextMenu(threadId, event),
			onRowMouseEnter: threadId => this.setHoveredThread(threadId),
			onRowMouseLeave: threadId => this.clearHoveredThread(threadId),
			onRequestDelete: threadId => this.setPendingDelete(threadId),
			onCancelDelete: () => this.setPendingDelete(undefined),
			onConfirmDelete: threadId => this.confirmDelete(threadId),
			onToggleShowAll: () => this.toggleShowAll(),
			onSearchInput: value => this.handleSearchInput(value),
			onNewChat: () => this._onDidRequestNewChat.fire(),
			onRetry: () => this._onDidRequestRetry.fire(),
		};
	}

	private handleSearchInput(value: string): void {
		const query = value.trim();
		if (query === this.searchQuery) {
			return;
		}
		this.searchQuery = query;
		void this.searchDelayer.trigger(() => {
			this._onDidChangeSearchQuery.fire(this.searchQuery);
		});
	}

	private setHoveredThread(threadId: string): void {
		if (this.hoveredThreadId === threadId) {
			return;
		}
		this.hoveredThreadId = threadId;
		this.pendingDeleteThreadId = undefined;
		this.renderView();
	}

	private clearHoveredThread(threadId: string): void {
		if (this.hoveredThreadId !== threadId) {
			return;
		}
		this.hoveredThreadId = undefined;
		this.pendingDeleteThreadId = undefined;
		this.renderView();
	}

	private setPendingDelete(threadId: string | undefined): void {
		if (this.pendingDeleteThreadId === threadId) {
			return;
		}
		this.pendingDeleteThreadId = threadId;
		this.renderView();
	}

	private confirmDelete(threadId: string): void {
		this.pendingDeleteThreadId = undefined;
		this.renderView();
		this._onDidRequestAction.fire({ action: 'delete', threadId });
	}

	private toggleShowAll(): void {
		this.showAll = !this.showAll;
		this.renderView();
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
			menuActions.add(new Action('vsclone.threadRail.delete', localize('vsclone.rail.action.delete', 'Delete thread'), undefined, true, () => this.setPendingDelete(row.threadId))),
		];
		this.contextMenuService.showContextMenu({
			getAnchor: () => ({ x: event.clientX, y: event.clientY }),
			getActions: () => actions,
			onHide: () => menuActions.dispose(),
		});
	}

	private getRowAriaLabel(row: IVSCloneThreadRailRow): string {
		return localize(
			'vsclone.rail.row.ariaLabel',
			'{0}. Updated {1}.',
			row.title,
			row.updatedLabel,
		);
	}
}
