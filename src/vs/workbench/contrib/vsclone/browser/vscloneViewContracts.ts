/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVSCloneThreadRailRow } from './vscloneThreadRailTree.js';
import type { VSCloneRailState } from './vscloneThreadRail.js';
import type { IVSCloneModelSelection } from '../common/vscloneModelSelectionTypes.js';
import type { IVSCloneSettingsModelState, IVSCloneSettingsState } from '../common/vscloneSettingsTypes.js';

// The workbench controllers and the bundled Preact sub-apps communicate through plain data
// contracts so the browser workbench never needs to import framework code directly.
export interface IVSCloneMountedView<Props> {
	rerender(props: Props): void;
	dispose(): void;
}

export interface IVSCloneRailViewProps {
	rows: readonly IVSCloneThreadRailRow[];
	selectedThreadId: string | undefined;
	viewState: VSCloneRailState;
	errorMessage: string | undefined;
	hoveredThreadId: string | undefined;
	pendingDeleteThreadId: string | undefined;
	showAll: boolean;
	initialRowCount: number;
	searchQuery: string;
	searchInputRef: (element: HTMLInputElement | null) => void;
	getRowAriaLabel: (row: IVSCloneThreadRailRow) => string;
	onRowSelect: (threadId: string) => void;
	onRowContextMenu: (threadId: string, event: MouseEvent) => void;
	onRowMouseEnter: (threadId: string) => void;
	onRowMouseLeave: (threadId: string) => void;
	onRequestDelete: (threadId: string) => void;
	onCancelDelete: () => void;
	onConfirmDelete: (threadId: string) => void;
	onToggleShowAll: () => void;
	onSearchInput: (value: string) => void;
	onNewChat: () => void;
	onRetry: () => void;
}

export interface IVSCloneModelSwitcherSection {
	label: string;
	count?: number;
	models: readonly IVSCloneSettingsModelState[];
}

export interface IVSCloneModelSwitcherViewProps {
	isOpen: boolean;
	buttonId: string;
	menuId: string;
	buttonLabel: string;
	buttonAriaLabel: string;
	state: IVSCloneSettingsState;
	selected: IVSCloneModelSelection | undefined;
	sections: readonly IVSCloneModelSwitcherSection[];
	showResetAction: boolean;
	rootRef: (element: HTMLElement | null) => void;
	buttonRef: (element: HTMLButtonElement | null) => void;
	onToggleOpen: () => void;
	onRefreshCatalog: () => void;
	onManageProviders: () => void;
	onResetSelection: () => void;
	onSelectModel: (model: IVSCloneSettingsModelState) => void;
}

export interface IVSCloneConversationImageView {
	key: string;
	dataUrl: string;
	alt: string;
	buttonAriaLabel: string;
	onOpen: () => void;
	onRemove?: () => void;
	removeAriaLabel?: string;
}

export interface IVSCloneConversationTokenView {
	text: string;
	className?: string;
}

export interface IVSCloneConversationDiffTitleView {
	label: string;
	labelTitle?: string;
	onLabelClick?: () => void;
	lineLabel?: string;
	lineTitle?: string;
	onLineClick?: () => void;
}

export interface IVSCloneConversationDiffLineView {
	key: string;
	className: string;
	gutterText?: string;
	text?: string;
	tokens?: readonly IVSCloneConversationTokenView[];
	title?: string;
	onClick?: () => void;
}

export interface IVSCloneConversationDiffCardView {
	key: string;
	title: IVSCloneConversationDiffTitleView;
	lines: readonly IVSCloneConversationDiffLineView[];
}

export interface IVSCloneEditApplySummaryFileView {
	key: string;
	pathLabel: string;
	pathTitle: string;
	addedLabel: string;
	removedLabel: string;
	onReview: () => void;
}

export interface IVSCloneEditApplySummaryView {
	phase: 'applied' | 'undone';
	countLabel: string;
	actionLabel: string;
	actionIconClass: string;
	onAction: () => void;
	files: readonly IVSCloneEditApplySummaryFileView[];
}

export interface IVSCloneConversationThinkingItemView {
	kind: 'thinking';
	message: string;
}

export interface IVSCloneConversationToolItemView {
	kind: 'tool';
	toolName: string;
	displayMessage: string;
	status: 'running' | 'complete' | 'success' | 'error';
	outputHtml?: string;
	diffCard?: IVSCloneConversationDiffCardView;
}

export type IVSCloneConversationActivityItemView =
	| IVSCloneConversationThinkingItemView
	| IVSCloneConversationToolItemView;

export type IVSCloneAssistantBodySegmentView =
	| {
		kind: 'markdown';
		key: string;
		className: string;
		html: string;
	}
	| {
		kind: 'thinking';
		key: string;
		messages: readonly string[];
		open: boolean;
	}
	| {
		kind: 'activity';
		key: string;
		items: readonly IVSCloneConversationActivityItemView[];
		streaming: boolean;
	}
	| {
		kind: 'streamingEditIndicator';
		key: string;
		label: string;
	}
	| {
		kind: 'searchReplaceDiff';
		card: IVSCloneConversationDiffCardView;
	}
	| {
		kind: 'toolDiff';
		card: IVSCloneConversationDiffCardView;
	};

export type IVSCloneConversationItemView =
	| {
		kind: 'user';
		key: string;
		metaLabel: string;
		promptText?: string;
		promptImages: readonly IVSCloneConversationImageView[];
	}
	| {
		kind: 'assistant';
		key: string;
		metaLabel: string;
		streaming: boolean;
		error: boolean;
		segments: readonly IVSCloneAssistantBodySegmentView[];
		editApplySummary?: IVSCloneEditApplySummaryView;
		applyAction?: {
			label: string;
			pending: boolean;
			onClick?: () => void;
		};
	};

export interface IVSCloneReasoningEffortOptionView {
	value: string;
	label: string;
}

export interface IVSCloneContextChipView {
	key: string;
	kind: 'file' | 'folder' | 'codeSelection';
	label: string;
	title: string;
	iconClass: string;
	removeAriaLabel: string;
	onRemove: () => void;
}

export interface IVSCloneMentionMenuItemView {
	key: string;
	label: string;
	detail: string;
	iconClass: string;
}

export interface IVSCloneConversationSurfaceProps {
	modelSwitcherEnabled: boolean;
	composerHintId: string;
	conversationItems: readonly IVSCloneConversationItemView[];
	pendingImages: readonly IVSCloneConversationImageView[];
	pendingContextChips: readonly IVSCloneContextChipView[];
	emptyStateHidden: boolean;
	addContextMenuOpen: boolean;
	planModeEnabled: boolean;
	planModeDisabled: boolean;
	composerInputDisabled: boolean;
	composerInputPlaceholder: string;
	composerSendDisabled: boolean;
	composerSendStopMode: boolean;
	composerSendAriaLabel: string;
	composerSendTitle: string;
	reasoningEffortVisible: boolean;
	reasoningEffortDisabled: boolean;
	reasoningEffortOptions: readonly IVSCloneReasoningEffortOptionView[];
	reasoningEffortValue?: string;
	mentionMenuOpen: boolean;
	mentionMenuQuery: string;
	mentionMenuItems: readonly IVSCloneMentionMenuItemView[];
	mentionMenuActiveIndex: number;
	mentionMenuLoading: boolean;
	mentionMenuEmptyLabel: string;
	conversationListRef: (element: HTMLElement | null) => void;
	conversationEmptyStateRef: (element: HTMLElement | null) => void;
	composerInputRef: (element: HTMLTextAreaElement | null) => void;
	composerSendButtonRef: (element: HTMLButtonElement | null) => void;
	modelSwitcherHostRef: (element: HTMLElement | null) => void;
	reasoningEffortContainerRef: (element: HTMLElement | null) => void;
	reasoningEffortSelectRef: (element: HTMLSelectElement | null) => void;
	planModeContainerRef: (element: HTMLElement | null) => void;
	planModeSwitchButtonRef: (element: HTMLButtonElement | null) => void;
	addContextMenuToggleRef: (element: HTMLSpanElement | null) => void;
	addContextButtonRef: (element: HTMLButtonElement | null) => void;
	addContextMenuRef: (element: HTMLElement | null) => void;
	composerImageStripRef: (element: HTMLElement | null) => void;
	composerContextStripRef: (element: HTMLElement | null) => void;
	mentionMenuRef: (element: HTMLElement | null) => void;
	imageFileInputRef: (element: HTMLInputElement | null) => void;
	onHistoryClick: () => void;
	onComposerInput: () => void;
	onComposerKeyDown: (event: KeyboardEvent) => void;
	onComposerPaste: (event: ClipboardEvent) => void;
	onComposerSendClick: () => void;
	onAddContextClick: () => void;
	onAddImageClick: () => void;
	onAddCodeSelectionClick: () => void;
	onPlanModeClick: () => void;
	onReasoningEffortChange: () => void;
	onImageFileInputChange: () => void;
	onMentionItemSelect: (index: number) => void;
	onMentionItemHover: (index: number) => void;
}
