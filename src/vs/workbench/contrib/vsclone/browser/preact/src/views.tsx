/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Fragment } from 'preact';
// Bundle the NLS helper directly so the generated browser entrypoints do not depend on a
// relative `nls.js` import that resolves against `sourceURL` instead of the emitted file path.
import { localize } from '../../../../../../nls.ts';
import type {
	IVSCloneAssistantBodySegmentView,
	IVSCloneContextChipView,
	IVSCloneConversationActivityItemView,
	IVSCloneConversationDiffCardView,
	IVSCloneConversationDiffLineView,
	IVSCloneConversationImageView,
	IVSCloneConversationItemView,
	IVSCloneConversationSurfaceProps,
	IVSCloneConversationTokenView,
	IVSCloneEditApplySummaryView,
	IVSCloneMentionMenuItemView,
	IVSCloneModelSwitcherSection,
	IVSCloneModelSwitcherViewProps,
	IVSCloneRailViewProps,
} from '../../vscloneViewContracts.js';
import type { VSCloneRailState } from '../../vscloneThreadRail.js';
import type { IVSCloneModelSelection } from '../../../common/vscloneModelSelectionTypes.js';
import type { IVSCloneSettingsModelState, IVSCloneSettingsState } from '../../../common/vscloneSettingsTypes.js';

function Codicon(props: { icon: string; extraClassName?: string }) {
	const className = props.extraClassName ? `codicon ${props.icon} ${props.extraClassName}` : `codicon ${props.icon}`;
	return <span className={className} aria-hidden="true" />;
}

function renderRailState(viewState: VSCloneRailState, errorMessage: string | undefined, onRetry: () => void) {
	if (viewState === 'loading') {
		return (
			<div className="vsclone-thread-rail-state" role="status">
				<div className="vsclone-thread-rail-skeleton" aria-hidden="true">
					{Array.from({ length: 7 }, (_, index) => (
						<div key={index} className="vsclone-thread-rail-skeleton-row">
							<div className="vsclone-thread-rail-skeleton-line" />
							<div className="vsclone-thread-rail-skeleton-line" />
							<div className="vsclone-thread-rail-skeleton-line" />
						</div>
					))}
				</div>
			</div>
		);
	}

	if (viewState === 'error') {
		return (
			<div className="vsclone-thread-rail-state" role="alert">
				<div className="vsclone-thread-rail-state-icon error" aria-hidden="true">!</div>
				<div className="vsclone-thread-rail-state-title">{localize('vsclone.rail.error.title', 'Something went wrong')}</div>
				<div className="vsclone-thread-rail-state-description">
					{errorMessage ?? localize('vsclone.rail.error.description', 'Failed to load threads. Please check your connection and try again.')}
				</div>
				<button type="button" className="vsclone-thread-rail-retry" onClick={() => onRetry()}>
					{localize('vsclone.rail.error.retry', 'Try again')}
				</button>
			</div>
		);
	}

	if (viewState === 'empty') {
		return (
			<div className="vsclone-thread-rail-state" role="status">
				<div className="vsclone-thread-rail-state-icon" aria-hidden="true">
					<span className="codicon codicon-comment-discussion" />
				</div>
				<div className="vsclone-thread-rail-state-title">{localize('vsclone.rail.empty.title', 'No threads yet')}</div>
				<div className="vsclone-thread-rail-state-description">
					{localize('vsclone.rail.empty.description', 'Start a new conversation to create your first thread.')}
				</div>
			</div>
		);
	}

	return <div className="vsclone-thread-rail-state hidden" />;
}

type RailRowGroupKey = 'today' | 'thisWeek' | 'lastWeek' | 'older';

function getRailRowGroup(updatedAt: number, now: number): RailRowGroupKey {
	const ageMs = Math.max(0, now - updatedAt);
	const oneDay = 24 * 60 * 60 * 1000;
	if (ageMs < oneDay) {
		return 'today';
	}
	if (ageMs < 7 * oneDay) {
		return 'thisWeek';
	}
	if (ageMs < 14 * oneDay) {
		return 'lastWeek';
	}
	return 'older';
}

function getRailGroupLabel(group: RailRowGroupKey): string {
	switch (group) {
		case 'today':
			return localize('vsclone.rail.group.today', 'Today');
		case 'thisWeek':
			return localize('vsclone.rail.group.thisWeek', 'Earlier this week');
		case 'lastWeek':
			return localize('vsclone.rail.group.lastWeek', 'Last week');
		case 'older':
			return localize('vsclone.rail.group.older', 'Older');
	}
}

export function VSCloneThreadRailView(props: IVSCloneRailViewProps) {
	const totalRows = props.rows.length;
	const hasMoreThreads = totalRows > props.initialRowCount;
	const visibleRows = props.showAll ? props.rows : props.rows.slice(0, props.initialRowCount);
	// Compute grouping once per render so each row knows whether it should emit a header above it.
	// Using a single timestamp keeps adjacent rows that straddle the boundary from disagreeing.
	const renderTime = Date.now();
	let lastRenderedGroup: RailRowGroupKey | undefined;

	return (
		<div className="vsclone-thread-rail">
			<div className="vsclone-thread-rail-header">
				<div className="vsclone-thread-rail-search-wrap">
					<span className="vsclone-thread-rail-search-icon codicon codicon-search" aria-hidden="true" />
					<input
						ref={props.searchInputRef}
						className="vsclone-thread-rail-search"
						type="search"
						placeholder={localize('vsclone.rail.search.placeholder', 'Search threads...')}
						aria-label={localize('vsclone.rail.search.ariaLabel', 'Search threads')}
						defaultValue={props.searchQuery}
						onInput={(event) => props.onSearchInput((event.currentTarget as HTMLInputElement).value)}
					/>
				</div>
			</div>
			<div className="vsclone-thread-rail-body">
				<div
					className={props.viewState === 'ready' ? 'vsclone-thread-rail-list' : 'vsclone-thread-rail-list hidden'}
					role="list"
					aria-label={localize('vsclone.rail.list.ariaLabel', 'Conversation threads')}
				>
					{visibleRows.map(row => {
						const selected = row.threadId === props.selectedThreadId || row.selected;
						const hovered = row.threadId === props.hoveredThreadId;
						const pendingDelete = row.threadId === props.pendingDeleteThreadId;
						const running = row.streamStateKind === 'llm' || row.streamStateKind === 'tool';
						const awaitingUser = row.streamStateKind === 'awaiting_user';
						let className = 'vsclone-thread-rail-row';
						if (selected) {
							className += ' selected';
						}
						if (row.hasUnreadAgentMessage) {
							className += ' unread-agent-message';
						}
						if (hovered) {
							className += ' hovered';
						}
						if (pendingDelete) {
							className += ' pending-delete';
						}
						const group = getRailRowGroup(row.updatedAt, renderTime);
						const renderGroupHeader = group !== lastRenderedGroup;
						lastRenderedGroup = group;
						return (
							<Fragment key={row.threadId}>
								{renderGroupHeader ? (
									<div className="vsclone-thread-rail-group-header" role="presentation">
										{getRailGroupLabel(group)}
									</div>
								) : null}
							<div
								className={className}
								data-thread-id={row.threadId}
								role="button"
								tabIndex={0}
								aria-pressed={selected ? 'true' : 'false'}
								aria-label={props.getRowAriaLabel(row)}
								onClick={() => props.onRowSelect(row.threadId)}
								onKeyDown={(event) => {
									// Only the row itself should handle Enter/Space for selection.
									// Without this guard, keypresses on nested buttons would bubble
									// up and re-open the thread.
									if (event.target !== event.currentTarget) {
										return;
									}
									if (event.key === 'Enter' || event.key === ' ') {
										event.preventDefault();
										props.onRowSelect(row.threadId);
									}
								}}
								onContextMenu={(event) => props.onRowContextMenu(row.threadId, event)}
								onMouseEnter={() => props.onRowMouseEnter(row.threadId)}
								onMouseLeave={() => props.onRowMouseLeave(row.threadId)}
							>
								<div className="vsclone-thread-rail-row-leading">
									{running ? (
										<span
											className="vsclone-thread-rail-row-spinner codicon codicon-loading codicon-modifier-spin"
											aria-hidden="true"
										/>
									) : awaitingUser ? (
										<span
											className="vsclone-thread-rail-row-spinner codicon codicon-question"
											aria-hidden="true"
										/>
									) : null}
									<span className="vsclone-thread-rail-row-title">
										{row.title}
									</span>
								</div>
								<div className="vsclone-thread-rail-row-trailing">
									{pendingDelete ? (
										<Fragment>
											<button
												type="button"
												className="vsclone-thread-rail-row-icon"
												title={localize('vsclone.rail.delete.cancel', 'Cancel')}
												aria-label={localize('vsclone.rail.delete.cancel', 'Cancel')}
												onClick={(event) => {
													event.stopPropagation();
													props.onCancelDelete();
												}}
											>
												<span className="codicon codicon-close" aria-hidden="true" />
											</button>
											<button
												type="button"
												className="vsclone-thread-rail-row-icon confirm"
												title={localize('vsclone.rail.delete.confirm', 'Delete')}
												aria-label={localize('vsclone.rail.delete.confirm', 'Delete')}
												onClick={(event) => {
													event.stopPropagation();
													props.onConfirmDelete(row.threadId);
												}}
											>
												<span className="codicon codicon-check" aria-hidden="true" />
											</button>
										</Fragment>
									) : (
										<Fragment>
											<span className="vsclone-thread-rail-row-timestamp">{row.updatedLabel}</span>
											<button
												type="button"
												className="vsclone-thread-rail-row-icon vsclone-thread-rail-row-icon-delete"
												title={localize('vsclone.rail.action.delete', 'Delete thread')}
												aria-label={localize('vsclone.rail.action.delete', 'Delete thread')}
												onClick={(event) => {
													event.stopPropagation();
													props.onRequestDelete(row.threadId);
												}}
											>
												<span className="codicon codicon-trash" aria-hidden="true" />
											</button>
										</Fragment>
									)}
								</div>
							</div>
							</Fragment>
						);
					})}
					{hasMoreThreads ? (
						<button
							type="button"
							className="vsclone-thread-rail-show-more"
							onClick={() => props.onToggleShowAll()}
						>
							{props.showAll
								? localize('vsclone.rail.showLess', 'Show less')
								: localize('vsclone.rail.showMore', 'Show {0} more...', totalRows - props.initialRowCount)}
						</button>
					) : null}
				</div>
				{renderRailState(props.viewState, props.errorMessage, props.onRetry)}
			</div>
			<div className="vsclone-thread-rail-footer">
				<button
					type="button"
					className="vsclone-thread-rail-new-chat"
					onClick={() => props.onNewChat()}
				>
					<span className="codicon codicon-add" aria-hidden="true" />
					<span>{localize('vsclone.rail.newChat', 'New chat')}</span>
				</button>
			</div>
		</div>
	);
}

function renderModelSwitcherBody(
	state: IVSCloneSettingsState,
	sections: readonly IVSCloneModelSwitcherSection[],
	selected: IVSCloneModelSelection | undefined,
	onRefreshCatalog: () => void,
	onManageProviders: () => void,
	onSelectModel: (model: IVSCloneSettingsModelState) => void,
) {
	if (state.status === 'loading') {
		return (
			<div className="vsclone-model-switcher-state">
				<Codicon icon="codicon-loading codicon-modifier-spin" extraClassName="vsclone-model-switcher-spinner" />
				<div className="vsclone-model-switcher-state-title">{localize('vsclone.modelSwitcher.loading', 'Loading models...')}</div>
			</div>
		);
	}

	if (state.status === 'error') {
		return (
			<div className="vsclone-model-switcher-state error">
				<div className="vsclone-model-switcher-state-leading">
					<Codicon icon="codicon-error" extraClassName="vsclone-model-switcher-state-icon" />
					<div className="vsclone-model-switcher-state-title">{localize('vsclone.modelSwitcher.errorTitle', 'Error loading models')}</div>
				</div>
				<div className="vsclone-model-switcher-state-description">
					{state.errorMessage || localize('vsclone.modelSwitcher.errorDescription', 'Failed to fetch model catalog. Check your network connection.')}
				</div>
				<button
					type="button"
					className="vsclone-model-switcher-state-action"
					onClick={(event) => {
						event.stopPropagation();
						onRefreshCatalog();
					}}
				>
					{localize('vsclone.modelSwitcher.tryAgain', 'Try again')}
				</button>
			</div>
		);
	}

	if (sections.length === 0) {
		return (
			<div className="vsclone-model-switcher-state">
				<Codicon icon="codicon-info" extraClassName="vsclone-model-switcher-state-icon" />
				<div className="vsclone-model-switcher-state-title">{localize('vsclone.modelSwitcher.emptyTitle', 'No models available')}</div>
				<div className="vsclone-model-switcher-state-description">{localize('vsclone.modelSwitcher.emptyDescription', 'Sign in to a provider to get started')}</div>
				<button
					type="button"
					className="vsclone-model-switcher-state-action"
					onClick={(event) => {
						event.stopPropagation();
						onManageProviders();
					}}
				>
					<Codicon icon="codicon-settings-gear" />
					<span>{localize('vsclone.modelSwitcher.emptyAction', 'Manage Providers')}</span>
				</button>
			</div>
		);
	}

	return (
		<Fragment>
			{sections.map(section => (
				<div key={section.label}>
					<div className="vsclone-model-switcher-section">
						<span className="vsclone-model-switcher-section-label">{section.label}</span>
						{section.count !== undefined ? (
							<Fragment>
								<span className="vsclone-model-switcher-section-separator" aria-hidden="true">·</span>
								<span className="vsclone-model-switcher-section-count">{section.count}</span>
							</Fragment>
						) : null}
					</div>
					{section.models.map(model => {
						const isSelected = selected?.modelIdentifier === model.identifier;
						const className = !model.isSelectable
							? isSelected ? 'vsclone-model-switcher-row selected locked' : 'vsclone-model-switcher-row locked'
							: isSelected ? 'vsclone-model-switcher-row selected' : 'vsclone-model-switcher-row';
						return (
							<button
								key={model.identifier}
								type="button"
								className={className}
								aria-pressed={isSelected ? 'true' : 'false'}
								aria-label={model.isSelectable
									? localize('vsclone.modelSwitcher.row.aria', '{0} model', model.modelName)
									: localize('vsclone.modelSwitcher.row.requiresSignIn.aria', '{0} model, provider requires sign in', model.modelName)}
								onClick={(event) => {
									event.stopPropagation();
									onSelectModel(model);
								}}
							>
								<span className="vsclone-model-switcher-row-label" title={model.modelName}>{model.modelName}</span>
								{!model.isSelectable ? (
									<Fragment>
										<Codicon icon="codicon-lock" extraClassName="vsclone-model-switcher-row-lock" />
										<div className="vsclone-model-switcher-row-subtext">{localize('vsclone.modelSwitcher.requiresSignIn', 'Sign in to use this provider')}</div>
									</Fragment>
								) : null}
							</button>
						);
					})}
				</div>
			))}
		</Fragment>
	);
}

export function VSCloneModelSwitcherView(props: IVSCloneModelSwitcherViewProps) {
	return (
		<div ref={props.rootRef} className={props.isOpen ? 'vsclone-model-switcher-root open' : 'vsclone-model-switcher-root'}>
			<button
				ref={props.buttonRef}
				type="button"
				className="vsclone-model-switcher-button"
				id={props.buttonId}
				aria-haspopup="dialog"
				aria-controls={props.menuId}
				aria-expanded={props.isOpen ? 'true' : 'false'}
				aria-label={props.buttonAriaLabel}
				onClick={() => props.onToggleOpen()}
			>
				<span className="vsclone-model-switcher-button-model" title={props.buttonLabel}>{props.buttonLabel}</span>
				<Codicon icon={props.isOpen ? 'codicon-chevron-up' : 'codicon-chevron-down'} extraClassName="vsclone-model-switcher-button-chevron" />
			</button>
			<div
				className={props.isOpen ? 'vsclone-model-switcher-menu' : 'vsclone-model-switcher-menu hidden'}
				id={props.menuId}
				role="dialog"
				aria-modal="false"
				aria-labelledby={props.buttonId}
			>
				<div className="vsclone-model-switcher-menu-header">
					<div className="vsclone-model-switcher-menu-title">{localize('vsclone.modelSwitcher.menu.title', 'Select model')}</div>
					<button
						type="button"
						className="vsclone-model-switcher-refresh"
						title={localize('vsclone.modelSwitcher.refresh', 'Refresh models')}
						aria-label={localize('vsclone.modelSwitcher.refresh', 'Refresh models')}
						onClick={(event) => {
							event.stopPropagation();
							props.onRefreshCatalog();
						}}
					>
						<Codicon icon="codicon-refresh" />
					</button>
				</div>
				<div className="vsclone-model-switcher-menu-body">
					{renderModelSwitcherBody(props.state, props.sections, props.selected, props.onRefreshCatalog, props.onManageProviders, props.onSelectModel)}
				</div>
				<div className="vsclone-model-switcher-menu-footer single-action">
					<button
						type="button"
						className="vsclone-model-switcher-footer-button"
						onClick={(event) => {
							event.stopPropagation();
							props.onManageProviders();
						}}
					>
						<Codicon icon="codicon-settings-gear" />
						<span>{localize('vsclone.modelSwitcher.manageProviders', 'Manage Providers')}</span>
					</button>
				</div>
			</div>
		</div>
	);
}

function getToolIconClass(toolName: string): string {
	const lower = toolName.toLowerCase();
	if (lower.includes('read')) {
		return 'codicon-file';
	}
	if (lower.includes('edit') || lower.includes('write')) {
		return 'codicon-edit';
	}
	if (lower.includes('create')) {
		return 'codicon-new-file';
	}
	if (lower.includes('run') || lower.includes('exec') || lower.includes('command') || lower.includes('terminal')) {
		return 'codicon-terminal';
	}
	if (lower.includes('search') || lower.includes('grep') || lower.includes('find')) {
		return 'codicon-search';
	}
	if (lower.includes('completion') || lower.includes('attempt')) {
		return 'codicon-sparkle';
	}
	if (lower.includes('delete') || lower.includes('remove')) {
		return 'codicon-trash';
	}
	if (lower.includes('list') || lower.includes('ls')) {
		return 'codicon-list-tree';
	}
	return 'codicon-tools';
}

function renderDiffLineContent(line: IVSCloneConversationDiffLineView) {
	if (line.tokens && line.tokens.length > 0) {
		return line.tokens.map((token: IVSCloneConversationTokenView, index: number) => (
			<span key={index} className={token.className}>{token.text}</span>
		));
	}

	if (line.text !== undefined) {
		return line.text;
	}

	return null;
}

function DiffCard(props: { card: IVSCloneConversationDiffCardView }) {
	return (
		<div className="vsclone-tool-diff-card">
			<div className="vsclone-tool-diff-title">
				<Codicon icon="codicon-file" extraClassName="vsclone-tool-diff-title-icon" />
				{props.card.title.onLabelClick ? (
					<a
						href="#"
						className="vsclone-tool-diff-title-filename"
						title={props.card.title.labelTitle}
						onClick={(event) => {
							event.preventDefault();
							props.card.title.onLabelClick?.();
						}}
					>
						{props.card.title.label}
					</a>
				) : (
					<span className="vsclone-tool-diff-title-filename" title={props.card.title.labelTitle}>
						{props.card.title.label}
					</span>
				)}
				{props.card.title.lineLabel ? (
					props.card.title.onLineClick ? (
						<a
							href="#"
							className="vsclone-tool-diff-title-line"
							title={props.card.title.lineTitle}
							onClick={(event) => {
								event.preventDefault();
								props.card.title.onLineClick?.();
							}}
						>
							{props.card.title.lineLabel}
						</a>
					) : (
						<span className="vsclone-tool-diff-title-line" title={props.card.title.lineTitle}>
							{props.card.title.lineLabel}
						</span>
					)
				) : null}
			</div>
			<div className="vsclone-tool-diff-body">
				{props.card.lines.map(line => (
					<div
						key={line.key}
						className={line.className}
						title={line.title}
						onClick={line.onClick}
					>
						{line.className.includes('file') || line.className.includes('hunk') ? null : (
							<span className="vsclone-tool-diff-gutter">{line.gutterText ?? ''}</span>
						)}
						{!line.className.includes('file') ? renderDiffLineContent(line) : null}
					</div>
				))}
			</div>
		</div>
	);
}

function formatThinkingDurationPreact(durationMs: number): string {
	const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
	if (totalSeconds < 60) {
		return localize('vsclone.thinking.duration.seconds', '{0}s', totalSeconds.toString());
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (seconds === 0) {
		return localize('vsclone.thinking.duration.minutesOnly', '{0}m', minutes.toString());
	}
	return localize('vsclone.thinking.duration.minutesSeconds', '{0}m {1}s', minutes.toString(), seconds.toString());
}

function ThinkingBlock(props: { messages: readonly string[]; open: boolean; durationMs?: number }) {
	const stepCount = props.messages.filter(message => message.trim()).length;
	const qualifier = props.durationMs !== undefined
		? localize('vsclone.thread.thinking.forDuration', 'for {0}', formatThinkingDurationPreact(props.durationMs))
		: stepCount <= 3
			? localize('vsclone.thread.thinking.briefly', 'briefly')
			: stepCount <= 10
				? localize('vsclone.thread.thinking.moment', 'for a moment')
				: localize('vsclone.thread.thinking.while', 'for a while');
	return (
		<details className="vsclone-thinking-block" open={props.open}>
			<summary className="vsclone-thinking-summary">
				{props.open ? (
					<span className="vsclone-thinking-summary-label">
						{localize('vsclone.thread.thinking.active', 'Thinking…')}
					</span>
				) : (
					<span className="vsclone-thinking-summary-label">
						<strong>{localize('vsclone.thread.thinking.past', 'Thought')}</strong>
						<span className="vsclone-thinking-summary-qualifier">{qualifier}</span>
					</span>
				)}
			</summary>
			<div className="vsclone-thinking-content">
				{props.messages.filter(message => message.trim()).map((message, index) => (
					<div key={index} className="vsclone-thinking-step">{message}</div>
				))}
			</div>
		</details>
	);
}

function ToolCard(props: { item: Extract<IVSCloneConversationActivityItemView, { kind: 'tool' }> }) {
	return (
		<div className={`vsclone-tool-card status-${props.item.status}`}>
			<div className="vsclone-tool-card-header">
				<Codicon icon={getToolIconClass(props.item.toolName)} extraClassName="vsclone-tool-card-icon" />
				<span className="vsclone-tool-card-label">{props.item.displayMessage}</span>
				<Codicon
					icon={
						props.item.status === 'running'
							? 'codicon-loading codicon-modifier-spin'
							: props.item.status === 'error'
								? 'codicon-error'
								: 'codicon-check'
					}
					extraClassName="vsclone-tool-card-status"
				/>
			</div>
			{props.item.diffCard ? <DiffCard card={props.item.diffCard} /> : null}
			{props.item.outputHtml ? <div className="vsclone-tool-card-output" dangerouslySetInnerHTML={{ __html: props.item.outputHtml }} /> : null}
		</div>
	);
}

function CompactToolRow(props: { item: Extract<IVSCloneConversationActivityItemView, { kind: 'tool' }> }) {
	return (
		<div className={`vsclone-activity-row status-${props.item.status}`}>
			<Codicon
				icon={
					props.item.status === 'running'
						? 'codicon-loading codicon-modifier-spin'
						: props.item.status === 'error'
							? 'codicon-error'
							: 'codicon-check'
				}
				extraClassName="vsclone-activity-row-status"
			/>
			<Codicon icon={getToolIconClass(props.item.toolName)} extraClassName="vsclone-activity-row-icon" />
			<span className="vsclone-activity-row-label">{props.item.displayMessage}</span>
		</div>
	);
}

function ActivityGroup(props: { items: readonly IVSCloneConversationActivityItemView[]; streaming: boolean }) {
	const toolItems = props.items.filter((item): item is Extract<IVSCloneConversationActivityItemView, { kind: 'tool' }> => item.kind === 'tool');
	const thinkingItems = props.items.filter((item): item is Extract<IVSCloneConversationActivityItemView, { kind: 'thinking' }> => item.kind === 'thinking');
	const hasDiffCards = toolItems.some(item => item.diffCard);
	const isRunning = props.streaming && toolItems.some(item => item.status === 'running');

	if (toolItems.length === 1 && thinkingItems.length === 0) {
		return <ToolCard item={toolItems[0]} />;
	}

	if (toolItems.length === 0 && thinkingItems.length > 0) {
		return <ThinkingBlock messages={thinkingItems.map(item => item.message)} open={props.streaming} />;
	}

	return (
		<details className="vsclone-activity-group" open={props.streaming || hasDiffCards}>
			<summary className="vsclone-activity-summary">
				<Codicon icon="codicon-tools" extraClassName="vsclone-activity-icon" />
				<span>
					{isRunning
						? localize('vsclone.activity.running', 'Running tools...')
						: toolItems.length === 1
							? localize('vsclone.activity.single', 'Used 1 tool')
							: localize('vsclone.activity.count', 'Used {0} tools', toolItems.length.toString())}
				</span>
			</summary>
			<div className="vsclone-activity-content">
				{thinkingItems.length > 0 ? <ThinkingBlock messages={thinkingItems.map(item => item.message)} open={props.streaming} /> : null}
				{toolItems.map(item => (
					<Fragment key={`${item.toolName}-${item.displayMessage}`}>
						<CompactToolRow item={item} />
						{item.diffCard ? <DiffCard card={item.diffCard} /> : null}
					</Fragment>
				))}
			</div>
		</details>
	);
}

function EditApplySummaryCard(props: { summary: IVSCloneEditApplySummaryView }) {
	return (
		<div className={`vsclone-edit-apply-summary phase-${props.summary.phase}`}>
			<div className="vsclone-edit-apply-summary-header">
				<span className="vsclone-edit-apply-summary-count">{props.summary.countLabel}</span>
				<button
					type="button"
					className="vsclone-edit-apply-summary-undo"
					onClick={() => props.summary.onAction()}
				>
					<span>{props.summary.actionLabel}</span>
					<Codicon icon={props.summary.actionIconClass} extraClassName="vsclone-edit-apply-summary-undo-icon" />
				</button>
			</div>
			{props.summary.files.map(file => (
				<div key={file.key} className="vsclone-edit-apply-summary-file">
					<span className="vsclone-edit-apply-summary-file-path" title={file.pathTitle}>{file.pathLabel}</span>
					<span className="vsclone-edit-apply-summary-file-stats">
						<span className="vsclone-edit-apply-summary-file-added">{file.addedLabel}</span>
						<span className="vsclone-edit-apply-summary-file-removed">{file.removedLabel}</span>
					</span>
					<button
						type="button"
						className="vsclone-edit-apply-summary-review"
						onClick={() => file.onReview()}
					>
						<span>{localize('vsclone.thread.assistant.apply.review', 'Review')}</span>
						<Codicon icon="codicon-arrow-right" extraClassName="vsclone-edit-apply-summary-review-icon" />
					</button>
				</div>
			))}
		</div>
	);
}

function ConversationImageStrip(props: { images: readonly IVSCloneConversationImageView[]; className: string; removable: boolean }) {
	return (
		<div className={props.className}>
			{props.images.map(image => (
				props.removable ? (
					<div key={image.key} className="vsclone-composer-image-thumb">
						<img
							src={image.dataUrl}
							alt={image.alt}
							className="vsclone-composer-image-thumb-img"
							onClick={() => image.onOpen()}
						/>
						{image.onRemove ? (
							<button
								type="button"
								className="vsclone-composer-image-thumb-remove"
								aria-label={image.removeAriaLabel}
								onClick={(event) => {
									event.stopPropagation();
									image.onRemove?.();
								}}
							>
								<Codicon icon="codicon-close" />
							</button>
						) : null}
					</div>
				) : (
					<button
						key={image.key}
						type="button"
						className="vsclone-thread-image-thumb"
						aria-label={image.buttonAriaLabel}
						onClick={() => image.onOpen()}
					>
						<img src={image.dataUrl} alt={image.alt} className="vsclone-thread-image-thumb-img" />
					</button>
				)
			))}
		</div>
	);
}

function ContextChipStrip(props: { chips: readonly IVSCloneContextChipView[]; stripRef: (element: HTMLElement | null) => void }) {
	const className = props.chips.length === 0 ? 'vsclone-composer-context-strip hidden' : 'vsclone-composer-context-strip';
	return (
		<div ref={props.stripRef} className={className}>
			{props.chips.map(chip => (
				<div key={chip.key} className={`vsclone-composer-context-chip kind-${chip.kind}`} title={chip.title}>
					<Codicon icon={chip.iconClass} extraClassName="vsclone-composer-context-chip-icon" />
					<span className="vsclone-composer-context-chip-label">{chip.label}</span>
					<button
						type="button"
						className="vsclone-composer-context-chip-remove"
						aria-label={chip.removeAriaLabel}
						onClick={(event) => {
							event.stopPropagation();
							chip.onRemove();
						}}
					>
						<Codicon icon="codicon-close" />
					</button>
				</div>
			))}
		</div>
	);
}

function MentionMenu(props: {
	open: boolean;
	query: string;
	items: readonly IVSCloneMentionMenuItemView[];
	activeIndex: number;
	loading: boolean;
	emptyLabel: string;
	menuRef: (element: HTMLElement | null) => void;
	onSelect: (index: number) => void;
	onHover: (index: number) => void;
}) {
	if (!props.open) {
		return <div ref={props.menuRef} className="vsclone-mention-menu hidden" />;
	}
	return (
		<div ref={props.menuRef} className="vsclone-mention-menu" role="listbox">
			<div className="vsclone-mention-menu-header">
				<Codicon icon="codicon-mention" extraClassName="vsclone-mention-menu-header-icon" />
				<span className="vsclone-mention-menu-header-query">{props.query.length > 0 ? props.query : localize('vsclone.mention.menu.hint', 'Type to search files and folders')}</span>
			</div>
			{props.loading ? (
				<div className="vsclone-mention-menu-empty">{localize('vsclone.mention.menu.loading', 'Searching...')}</div>
			) : props.items.length === 0 ? (
				<div className="vsclone-mention-menu-empty">{props.emptyLabel}</div>
			) : (
				<div className="vsclone-mention-menu-list">
					{props.items.map((item, index) => (
						<button
							key={item.key}
							type="button"
							role="option"
							aria-selected={index === props.activeIndex ? 'true' : 'false'}
							className={index === props.activeIndex ? 'vsclone-mention-menu-item active' : 'vsclone-mention-menu-item'}
							onMouseEnter={() => props.onHover(index)}
							onMouseDown={(event) => {
								event.preventDefault();
								props.onSelect(index);
							}}
						>
							<Codicon icon={item.iconClass} extraClassName="vsclone-mention-menu-item-icon" />
							<span className="vsclone-mention-menu-item-label">{item.label}</span>
							<span className="vsclone-mention-menu-item-detail">{item.detail}</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

function AssistantSegment(props: { segment: IVSCloneAssistantBodySegmentView }) {
	switch (props.segment.kind) {
		case 'markdown':
			return <div className={props.segment.className} dangerouslySetInnerHTML={{ __html: props.segment.html }} />;
		case 'thinking':
			return <ThinkingBlock messages={props.segment.messages} open={props.segment.open} durationMs={props.segment.durationMs} />;
		case 'activity':
			return <ActivityGroup items={props.segment.items} streaming={props.segment.streaming} />;
		case 'streamingEditIndicator':
			return (
				<div className="vsclone-streaming-edit-indicator">
					<Codicon icon="codicon-loading codicon-modifier-spin" />
					<span>{props.segment.label}</span>
				</div>
			);
		case 'searchReplaceDiff':
		case 'toolDiff':
			return <DiffCard card={props.segment.card} />;
	}
}

/**
 * Cursor-style "Explored N files, M searches" expander: collapses runs of consecutive
 * non-edit activity (thinking + read/list/grep/search tool calls) into a single summary
 * the user can expand. Any segment that introduces or contains an edit (diff card, edit
 * tool, streaming-edit indicator) -- or any plain assistant text -- breaks the run so edits
 * stay visible inline.
 */
const EXPLORE_GROUP_THRESHOLD = 3;

function isExploreSegment(segment: IVSCloneAssistantBodySegmentView): boolean {
	if (segment.kind === 'thinking') {
		return true;
	}
	if (segment.kind !== 'activity') {
		return false;
	}
	for (const item of segment.items) {
		if (item.kind !== 'tool') {
			continue;
		}
		if (item.diffCard) {
			return false;
		}
		const lower = item.toolName.toLowerCase();
		if (lower.includes('edit') || lower.includes('write') || lower.includes('create') || lower.includes('delete') || lower.includes('remove')) {
			return false;
		}
	}
	return true;
}

function countExploredOps(segments: readonly IVSCloneAssistantBodySegmentView[]): { files: number; searches: number } {
	let files = 0;
	let searches = 0;
	for (const segment of segments) {
		if (segment.kind !== 'activity') {
			continue;
		}
		for (const item of segment.items) {
			if (item.kind !== 'tool') {
				continue;
			}
			const lower = item.toolName.toLowerCase();
			if (lower.includes('search') || lower.includes('grep') || lower.includes('find')) {
				searches += 1;
			} else if (lower.includes('read') || lower.includes('list') || lower.includes('ls')) {
				files += 1;
			}
		}
	}
	return { files, searches };
}

function getSegmentKey(segment: IVSCloneAssistantBodySegmentView): string {
	return segment.kind === 'searchReplaceDiff' || segment.kind === 'toolDiff' ? segment.card.key : segment.key;
}

function ExploredSummary(props: { segments: readonly IVSCloneAssistantBodySegmentView[]; defaultOpen: boolean }) {
	const { files, searches } = countExploredOps(props.segments);
	const parts: string[] = [];
	if (files > 0) {
		parts.push(files === 1
			? localize('vsclone.explored.fileOne', '1 file')
			: localize('vsclone.explored.fileMany', '{0} files', files.toString()));
	}
	if (searches > 0) {
		parts.push(searches === 1
			? localize('vsclone.explored.searchOne', '1 search')
			: localize('vsclone.explored.searchMany', '{0} searches', searches.toString()));
	}
	const label = parts.length > 0
		? localize('vsclone.explored.prefixed', 'Explored {0}', parts.join(', '))
		: localize('vsclone.explored.thinkingOnly', 'Thought through this');
	return (
		<details className="vsclone-explored-group" open={props.defaultOpen}>
			<summary className="vsclone-explored-summary">
				<span className="vsclone-explored-summary-label">{label}</span>
			</summary>
			<div className="vsclone-explored-content">
				{props.segments.map(segment => (
					<AssistantSegment key={getSegmentKey(segment)} segment={segment} />
				))}
			</div>
		</details>
	);
}

type AssistantSegmentRun =
	| { kind: 'segment'; segment: IVSCloneAssistantBodySegmentView }
	| { kind: 'explored'; segments: readonly IVSCloneAssistantBodySegmentView[]; key: string };

function partitionAssistantSegments(segments: readonly IVSCloneAssistantBodySegmentView[]): readonly AssistantSegmentRun[] {
	const out: AssistantSegmentRun[] = [];
	let run: IVSCloneAssistantBodySegmentView[] = [];
	const flush = () => {
		if (run.length === 0) {
			return;
		}
		if (run.length >= EXPLORE_GROUP_THRESHOLD) {
			out.push({ kind: 'explored', segments: run, key: `explored-${getSegmentKey(run[0])}` });
		} else {
			for (const seg of run) {
				out.push({ kind: 'segment', segment: seg });
			}
		}
		run = [];
	};
	for (const segment of segments) {
		if (isExploreSegment(segment)) {
			run.push(segment);
		} else {
			flush();
			out.push({ kind: 'segment', segment });
		}
	}
	flush();
	return out;
}

function ConversationItem(props: { item: IVSCloneConversationItemView }) {
	if (props.item.kind === 'user') {
		return (
			<div className="vsclone-thread-message user">
				<div className="vsclone-thread-message-meta">{props.item.metaLabel}</div>
				<div className="vsclone-thread-message-body">
					{props.item.promptText ? <div className="vsclone-thread-message-user-text">{props.item.promptText}</div> : null}
					{props.item.promptImages.length > 0 ? (
						<ConversationImageStrip images={props.item.promptImages} className="vsclone-thread-image-strip" removable={false} />
					) : null}
				</div>
			</div>
		);
	}

	const streaming = props.item.streaming;
	return (
		<div className={`vsclone-thread-message assistant${streaming ? ' streaming' : ''}${props.item.error ? ' error' : ''}`}>
			<div className="vsclone-thread-message-meta">{props.item.metaLabel}</div>
			<div className="vsclone-thread-message-body">
				{partitionAssistantSegments(props.item.segments).map(run => (
					run.kind === 'segment'
						? <AssistantSegment key={getSegmentKey(run.segment)} segment={run.segment} />
						: <ExploredSummary key={run.key} segments={run.segments} defaultOpen={streaming} />
				))}
			</div>
			{props.item.editApplySummary ? <EditApplySummaryCard summary={props.item.editApplySummary} /> : null}
			{props.item.applyAction ? (
				<button
					type="button"
					className={props.item.applyAction.pending ? 'vsclone-thread-message-apply pending' : 'vsclone-thread-message-apply'}
					disabled={props.item.applyAction.pending || !props.item.applyAction.onClick}
					onClick={() => props.item.applyAction.onClick?.()}
				>
					{props.item.applyAction.label}
				</button>
			) : null}
		</div>
	);
}

export function VSCloneUnifiedConversationSurface(props: IVSCloneConversationSurfaceProps) {
	return (
		<Fragment>
			<div className="vsclone-thread-actions">
				<button
					type="button"
					className="vsclone-thread-action-button"
					title={localize('vsclone.thread.actions.history.tooltip', 'Show threads')}
					aria-label={localize('vsclone.thread.actions.history.tooltip', 'Show threads')}
					onClick={() => props.onHistoryClick()}
				>
					{localize('vsclone.thread.actions.history', 'Threads')}
				</button>
			</div>
			<div
				ref={props.conversationListRef}
				className={props.emptyStateHidden ? 'vsclone-thread-messages' : 'vsclone-thread-messages hidden'}
				role="log"
				aria-live="polite"
				aria-relevant="additions text"
				aria-label={localize('vsclone.thread.messages', 'Conversation messages')}
			>
				{props.conversationItems.map(item => <ConversationItem key={item.key} item={item} />)}
			</div>
			<div
				ref={props.conversationEmptyStateRef}
				className={props.emptyStateHidden ? 'vsclone-thread-empty-state hidden' : 'vsclone-thread-empty-state'}
			>
				<div className="vsclone-thread-empty-state-icon" aria-hidden="true">
					<span className="codicon codicon-comment-discussion" />
				</div>
				<div className="vsclone-thread-empty-state-title">
					{localize('vsclone.thread.empty.title', 'Start a new chat')}
				</div>
				<div className="vsclone-thread-empty-state-description">
					{localize('vsclone.thread.empty.description', 'Type a prompt in the composer below to begin.')}
				</div>
			</div>
			<div className="vsclone-thread-composer">
				<ConversationImageStrip
					images={props.pendingImages}
					className={props.pendingImages.length === 0 ? 'vsclone-composer-image-strip hidden' : 'vsclone-composer-image-strip'}
					removable={true}
				/>
				<ContextChipStrip chips={props.pendingContextChips} stripRef={props.composerContextStripRef} />
				<div className="vsclone-composer-input-wrap">
					<textarea
						ref={props.composerInputRef}
						className="vsclone-thread-composer-input"
						rows={1}
						placeholder={props.composerInputPlaceholder}
						disabled={props.composerInputDisabled}
						aria-label={localize('vsclone.composer.inputLabel', 'Chat message')}
						aria-describedby={props.composerHintId}
						onInput={() => props.onComposerInput()}
						onKeyDown={(event) => props.onComposerKeyDown(event)}
						onPaste={(event) => props.onComposerPaste(event)}
					/>
					<MentionMenu
						open={props.mentionMenuOpen}
						query={props.mentionMenuQuery}
						items={props.mentionMenuItems}
						activeIndex={props.mentionMenuActiveIndex}
						loading={props.mentionMenuLoading}
						emptyLabel={props.mentionMenuEmptyLabel}
						menuRef={props.mentionMenuRef}
						onSelect={props.onMentionItemSelect}
						onHover={props.onMentionItemHover}
					/>
				</div>
				<div className="vsclone-thread-composer-toolbar">
					<div ref={props.planModeContainerRef} className={props.addContextMenuOpen ? 'vsclone-add-context-root open' : 'vsclone-add-context-root'}>
						<button
							ref={props.addContextButtonRef}
							type="button"
							className="vsclone-add-context-button"
							aria-haspopup="menu"
							aria-expanded={props.addContextMenuOpen ? 'true' : 'false'}
							aria-label={localize('vsclone.composer.addContext', 'Add context')}
							title={localize('vsclone.composer.addContextTooltip', 'Add context')}
							onClick={() => props.onAddContextClick()}
						>
							<Codicon icon="codicon-add" />
						</button>
						<div
							ref={props.addContextMenuRef}
							className={props.addContextMenuOpen ? 'vsclone-add-context-menu' : 'vsclone-add-context-menu hidden'}
							role="menu"
						>
							<button
								type="button"
								className="vsclone-add-context-menu-item"
								role="menuitem"
								onClick={() => props.onAddImageClick()}
							>
								<Codicon icon="codicon-file-media" />
								{localize('vsclone.composer.addImage', 'Add Image')}
							</button>
							<button
								type="button"
								className="vsclone-add-context-menu-item"
								role="menuitem"
								onClick={() => props.onAddCodeSelectionClick()}
							>
								<Codicon icon="codicon-selection" />
								{localize('vsclone.composer.addCodeSelection', 'Add Code Selection')}
							</button>
							<button
								ref={props.planModeSwitchButtonRef}
								type="button"
								className={props.planModeEnabled ? 'vsclone-add-context-menu-item checked' : 'vsclone-add-context-menu-item'}
								role="menuitemcheckbox"
								aria-checked={props.planModeEnabled ? 'true' : 'false'}
								disabled={props.planModeDisabled}
								onClick={() => props.onPlanModeClick()}
							>
								<Codicon icon="codicon-map" />
								{localize('vsclone.composer.mode.title', 'Plan Mode')}
								<span
									ref={props.addContextMenuToggleRef}
									className={props.planModeEnabled ? 'vsclone-add-context-menu-toggle active' : 'vsclone-add-context-menu-toggle'}
								/>
							</button>
						</div>
					</div>
					<div className="vsclone-thread-composer-controls">
						{props.modelSwitcherEnabled ? <div ref={props.modelSwitcherHostRef} className="vsclone-thread-model-switcher" /> : null}
						<div
							ref={props.reasoningEffortContainerRef}
							className={props.reasoningEffortVisible ? 'vsclone-thread-reasoning-level' : 'vsclone-thread-reasoning-level hidden'}
						>
							<select
								ref={props.reasoningEffortSelectRef}
								className="vsclone-thread-reasoning-level-select"
								aria-label={localize('vsclone.composer.reasoningEffort', 'Reasoning level')}
								disabled={props.reasoningEffortDisabled}
								value={props.reasoningEffortValue}
								onChange={() => props.onReasoningEffortChange()}
							>
								{props.reasoningEffortOptions.map(option => (
									<option key={option.value} value={option.value}>{option.label}</option>
								))}
							</select>
						</div>
					</div>
					<button
						ref={props.composerSendButtonRef}
						type="button"
						className={props.composerSendStopMode ? 'vsclone-thread-composer-send stop-mode' : 'vsclone-thread-composer-send'}
						aria-label={props.composerSendAriaLabel}
						title={props.composerSendTitle}
						disabled={props.composerSendDisabled}
						onClick={() => props.onComposerSendClick()}
					>
						{props.composerSendStopMode ? localize('vsclone.composer.stop', 'Stop') : <Codicon icon="codicon-send" />}
					</button>
				</div>
				<div id={props.composerHintId} className="vsclone-thread-composer-hint">
					{localize('vsclone.composer.hint', 'Press Enter to send, Shift+Enter for new line')}
				</div>
				<input
					ref={props.imageFileInputRef}
					type="file"
					className="vsclone-composer-image-file-input"
					accept="image/png,image/jpeg,image/gif,image/webp"
					multiple={true}
					onChange={() => props.onImageFileInputChange()}
				/>
			</div>
		</Fragment>
	);
}
