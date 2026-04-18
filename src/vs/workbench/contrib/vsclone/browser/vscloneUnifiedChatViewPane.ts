/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */
// Keep this view's DOM event names, CSS classes, ARIA roles, parser tokens, and other transport
// or styling literals inline because they are implementation details, not user-facing copy. The
// actual visible strings in this file still go through `localize(...)` at their call sites.

import "./media/vscloneUnifiedChatViewPane.css";
import {
	addDisposableListener,
	EventType,
	getActiveWindow,
	getWindow,
} from "../../../../base/browser/dom.js";
import { RunOnceScheduler } from "../../../../base/common/async.js";
import { Action } from "../../../../base/common/actions.js";
import { fromNow } from "../../../../base/common/date.js";
import { onUnexpectedError } from "../../../../base/common/errors.js";
import { MarkdownString } from "../../../../base/common/htmlContent.js";
import {
	DisposableStore,
	MutableDisposable,
	toDisposable,
} from "../../../../base/common/lifecycle.js";
import { localize } from "../../../../nls.js";
import { IClipboardService } from "../../../../platform/clipboard/common/clipboardService.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { IContextKeyService } from "../../../../platform/contextkey/common/contextkey.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IHoverService } from "../../../../platform/hover/browser/hover.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { IKeybindingService } from "../../../../platform/keybinding/common/keybinding.js";
import { INotificationService } from "../../../../platform/notification/common/notification.js";
import { IOpenerService } from "../../../../platform/opener/common/opener.js";
import { IMarkdownRendererService } from "../../../../platform/markdown/browser/markdownRenderer.js";
import { IThemeService } from "../../../../platform/theme/common/themeService.js";
import {
	IViewPaneOptions,
	ViewPane,
} from "../../../browser/parts/views/viewPane.js";
import { IViewDescriptorService } from "../../../common/views.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import { URI } from "../../../../base/common/uri.js";
import { VSCloneChatRailWidthSetting } from "../common/vscloneChatViewSettings.js";
import {
	type VSCloneReasoningEffortLevel,
} from "../common/vscloneModelCapabilities.js";
import { IVSClonePlanModeService } from "../common/vsclonePlanModeService.js";
import { type VSCloneChatMode } from "../common/vsclonePlanModeTypes.js";
import {
	type IVSCloneChatLocation,
	type IVSCloneModelSelection,
} from "../common/vscloneModelSelectionTypes.js";
import { IVSCloneSettingsService } from "../common/vscloneSettingsService.js";
import {
	VSCloneThreadRail,
	VSCloneRailTab,
} from "./vscloneThreadRail.js";
import { IVSCloneChatThreadService } from "./vscloneChatThreadService.js";
import { VSCloneModelSwitcherWidget } from "./vscloneModelSwitcherWidget.js";
import { IVSCloneProviderConfigurationBridge } from "./vscloneProviderConfigurationBridge.js";
import { IVSCloneThreadRuntimeService } from "./vscloneThreadRuntimeService.js";
import {
	type IVSCloneThreadCatalogEntry,
	toVSCloneThreadRailRows,
} from "./vscloneThreadRailTree.js";
import {
	IVSCloneEditCodeService,
	type VSCloneEditApplyResult as IVSCloneEditApplyResult,
	type VSCloneEditFileChange as IVSCloneEditFileChange,
} from "./vscloneEditCodeServiceInterface.js";
import { parseToolResultDiff } from "../common/vscloneToolResultDiff.js";
import {
	toVSCloneImageDataUrl,
	type IVSCloneImageAttachment,
} from "../common/vscloneImageAttachmentTypes.js";
import {
	type IVSCloneThreadRuntimeAssistantEditSuggestion,
	type IVSCloneThreadRuntimeCatalogQuery,
	type IVSCloneThreadRuntimeCheckpoint,
	type IVSCloneThreadRuntimeMessage,
	type IVSCloneThreadRuntimeState,
} from "../common/vscloneThreadRuntimeTypes.js";

const railWidthSetting = VSCloneChatRailWidthSetting;
const modelSwitcherEnabledSetting = "vsclone.modelSwitcher.enabled";
const railMinWidth = 220;
const railMaxWidth = 520;
const compactRailBreakpoint = 900;

// Read-only tool calls get collapsed to a single italic status line. `list_directory` is kept
// alongside `ls_dir` so historical transcripts that used the old alias still render compactly.
const COMPACT_RUNTIME_TOOL_NAMES = new Set<string>([
	"read_file",
	"ls_dir",
	"list_directory",
	"search_for_files",
]);

function isCompactRuntimeTool(toolName: string): boolean {
	return COMPACT_RUNTIME_TOOL_NAMES.has(toolName);
}

// Edit-producing tools get their own flattened treatment: the final diff card renders inline
// without an outer tool-card wrapper, "Running" transitions are suppressed, and the approval
// request stays visible because it needs the Approve/Reject buttons.
const FLAT_DIFF_RUNTIME_TOOL_NAMES = new Set<string>([
	"edit_file",
	"create_file",
]);

function isFlatDiffRuntimeTool(toolName: string): boolean {
	return FLAT_DIFF_RUNTIME_TOOL_NAMES.has(toolName);
}

// Light palette for language tags on edit cards. Kept deliberately small; unknown languages
// fall back to a neutral token. Colors pull from VS Code symbol-icon tokens so themes can still
// override them without the chat pane needing to ship a full icon-theme dependency.
const LANG_TAG_COLOR_CLASS: Record<string, string> = {
	TS: "lang-ts",
	TSX: "lang-ts",
	JS: "lang-js",
	JSX: "lang-js",
	CSS: "lang-css",
	SCSS: "lang-css",
	HTML: "lang-html",
	JSON: "lang-json",
	MD: "lang-md",
	PY: "lang-py",
	RS: "lang-rs",
	GO: "lang-go",
};

interface ICompactRuntimeToolAction {
	readonly past: string;
	readonly gerund: string;
	readonly infinitive: string;
}

interface IApprovalSearchReplaceBlock {
	readonly searchText: string;
	readonly replaceText: string;
}

// Mirrors the SEARCH/REPLACE parser in vscloneToolExecutionService so the approval row can
// preview pending edits without pulling in the execution service from the view layer.
function parseApprovalSearchReplaceBlocks(changes: string): readonly IApprovalSearchReplaceBlock[] {
	const normalized = changes.replace(/\r\n/g, "\n");
	const blockPattern = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
	const blocks: IApprovalSearchReplaceBlock[] = [];
	let match: RegExpExecArray | null;
	while ((match = blockPattern.exec(normalized)) !== null) {
		blocks.push({ searchText: match[1], replaceText: match[2] });
	}
	return blocks;
}

function compactRuntimeToolAction(toolName: string): ICompactRuntimeToolAction {
	switch (toolName) {
		case "ls_dir":
		case "list_directory":
			return { past: "Listed", gerund: "Listing", infinitive: "list" };
		case "search_for_files":
			return { past: "Searched for", gerund: "Searching for", infinitive: "search" };
		case "edit_file":
			return { past: "Edited", gerund: "Editing", infinitive: "edit" };
		case "create_file":
			return { past: "Created", gerund: "Creating", infinitive: "create" };
		case "read_file":
		default:
			return { past: "Read", gerund: "Reading", infinitive: "read" };
	}
}

interface IPendingImageAttachment extends IVSCloneImageAttachment {
	readonly dataUrl: string;
}

export function toVSCloneHistoryQuery(
	query: string,
	tab: VSCloneRailTab,
): IVSCloneThreadRuntimeCatalogQuery {
	return {
		text: query,
		tab,
		includeArchived: tab === "all",
	};
}

interface IUnifiedDiffHunkHeader {
	readonly originalStartLineNumber: number;
	readonly originalLineCount: number;
	readonly modifiedStartLineNumber: number;
	readonly modifiedLineCount: number;
}

interface IRenderedToolDiffLine {
	readonly sourceLineIndex: number;
	readonly rawText: string;
	readonly kind: "file" | "hunk" | "context" | "added" | "removed";
	readonly navigationLineNumber?: number;
}

interface IDiffLineNavigationState {
	startLineNumber?: number;
	endLineNumber?: number;
}

/**
 * Per-turn lifecycle for an assistant turn that contains SEARCH/REPLACE blocks. Auto-apply
 * starts in `pending`, lands in `applied` (success) or `failed` (no matching SEARCH block),
 * and can flip between `applied` and `undone` as the user toggles Undo/Redo. Partial apply and
 * partial undo keep the summary visible with an explicit retry action so the UI does not pretend
 * the workflow is terminal when only some files actually succeeded.
 */
type EditApplyState =
	| { readonly phase: "pending" }
	| { readonly phase: "failed" }
	| { readonly phase: "applied"; readonly result: IVSCloneEditApplyResult }
	| { readonly phase: "undone"; readonly result: IVSCloneEditApplyResult }
	| { readonly phase: "partial"; readonly result: IVSCloneEditApplyResult; readonly retryAction: "apply" | "undo" };

interface IAssistantApplyTarget {
	readonly threadId: string;
	readonly id: string;
	readonly responseText: string;
}

interface IVSCloneThreadRuntimeCatalogService {
	getThreads?(
		query?: IVSCloneThreadRuntimeCatalogQuery,
	): readonly IVSClonePaneThreadCatalogEntry[];
	isDeletedThread?(threadId: string): boolean;
	archiveThread?(threadId: string, archived: boolean): boolean | Promise<boolean>;
	deleteThread?(threadId: string): boolean | Promise<boolean>;
}

interface IVSClonePaneThreadCatalogEntry extends IVSCloneThreadCatalogEntry {
	readonly sessionResource?: string;
	readonly activeModelIdentifier?: string;
	readonly createdAt: number;
}

export class VSCloneUnifiedChatViewPane extends ViewPane {
	private readonly composerFocusDisposable = this._register(
		new MutableDisposable(),
	);
	private readonly renderedMarkdownDisposables = this._register(
		new DisposableStore(),
	);

	private rootContainer: HTMLElement | undefined;
	private railContainer: HTMLElement | undefined;
	private railResizeHandle: HTMLElement | undefined;
	private conversationContainer: HTMLElement | undefined;
	private conversationList: HTMLElement | undefined;
	private conversationEmptyState: HTMLElement | undefined;
	private composerInput: HTMLTextAreaElement | undefined;
	private composerSendButton: HTMLButtonElement | undefined;
	private modelSwitcher: VSCloneModelSwitcherWidget | undefined;
	private planModeContainer: HTMLElement | undefined;
	private planModeSwitchButton: HTMLButtonElement | undefined;
	private addContextMenuToggle: HTMLSpanElement | undefined;
	private reasoningEffortContainer: HTMLElement | undefined;
	private reasoningEffortSelect: HTMLSelectElement | undefined;
	private composerImageStrip: HTMLElement | undefined;
	private pendingImages: IPendingImageAttachment[] = [];

	private readonly rail = this._register(
		this.instantiationService.createInstance(VSCloneThreadRail),
	);
	private readonly threadsById = new Map<string, IVSClonePaneThreadCatalogEntry>();
	// Durable apply summaries now live on the runtime branch via the assistant-edit application API.
	// The pane only keeps a transient pending set so repeated refreshes do not launch duplicate
	// browser-local apply work while the engine bridge is still running.
	private readonly pendingAssistantApplyMessageIds = new Set<string>();
	private readonly refreshRailScheduler = this._register(
		new RunOnceScheduler(() => {
			this.refreshRailRows();
		}, 90),
	);
	private readonly refreshConversationScheduler = this._register(
		new RunOnceScheduler(() => {
			this.refreshConversation();
		}, 34),
	);

	private railVisible = false;
	private railWidth = 320;
	private activeThreadId: string | undefined;
	private catalogReady = false;
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
		@IVSCloneChatThreadService
		private readonly chatThreadService: IVSCloneChatThreadService,
		@IVSCloneSettingsService
		private readonly settingsService: IVSCloneSettingsService,
		@IVSClonePlanModeService
		private readonly planModeService: IVSClonePlanModeService,
		@IVSCloneProviderConfigurationBridge
		private readonly providerConfigurationBridge: IVSCloneProviderConfigurationBridge,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IVSCloneEditCodeService
		private readonly editCodeService: IVSCloneEditCodeService,
		@IVSCloneThreadRuntimeService
		private readonly threadRuntimeService: IVSCloneThreadRuntimeService,
		@INotificationService
		private readonly notificationService: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
		@IMarkdownRendererService
		private readonly markdownRendererService: IMarkdownRendererService,
	) {
		super(
			options,
			keybindingService,
			contextMenuService,
			configurationService,
			contextKeyService,
			viewDescriptorService,
			instantiationService,
			openerService,
			themeService,
			hoverService,
		);

		this.railWidth = Math.min(
			railMaxWidth,
			Math.max(
				railMinWidth,
				this.configurationService.getValue<number>(railWidthSetting) ?? 320,
			),
		);

		this._register(
			this.rail.onDidSelectThread((threadId) => {
				void this.openSession(threadId);
			}),
		);
		this._register(
			this.rail.onDidRequestRetry(() => {
				void this.reloadHistory();
			}),
		);
		this._register(
			this.rail.onDidRequestNewChat(() => {
				this.showComposerForNewChat();
			}),
		);
		this._register(
			this.rail.onDidRequestClose(() => {
				this.railVisible = false;
				this.applyRailLayout();
				this.focusInput();
			}),
		);
		this._register(
			this.rail.onDidChangeFilterState(() => {
				this.refreshRailRows();
			}),
		);
		this._register(
			this.rail.onDidRequestAction((event) => {
				switch (event.action) {
					case "open":
						void this.openSession(event.threadId);
						break;
					case "copyPrompt":
						void this.copyPrompt(event.threadId);
						break;
					case "copyResponse":
						void this.copyResponse(event.threadId);
						break;
					case "reusePrompt":
						this.reusePrompt(event.threadId);
						break;
					case "delete":
						void this.deleteThread(event.threadId);
						break;
					case "toggleArchive":
						void this.setThreadArchived(
							event.threadId,
							!!event.archived,
						);
						break;
				}
			}),
		);

		this._register(
			this.threadRuntimeService.onDidChangeState((state) => {
				this.syncThreadCatalogEntryFromRuntime(state);
				this.refreshRailScheduler.schedule(0);
				if (state.threadId !== this.activeThreadId) {
					return;
				}
				this.refreshConversationScheduler.schedule(0);
				this.maybeAutoApplyRuntimeAssistantMessages(state);
				this.updateComposerState();
				this.refreshPlanModeControl();
			}),
		);

		this._register(
			this.planModeService.onDidChangeMode(() => {
				this.refreshPlanModeControl();
				this.updateComposerState();
			}),
		);
		this._register(
			this.settingsService.onDidChangeState(() => {
				this.refreshModelControls();
			}),
		);

		void this.settingsService.initialize();
	}

	override focus(): void {
		super.focus();
		if (!this.catalogReady || this.railVisible) {
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
		await this.settingsService.refreshState();
		this.refreshModelControls();
	}

	async manageProviders(): Promise<void> {
		await this.providerConfigurationBridge.openManageProvidersPicker();
		await this.settingsService.refreshState();
		this.refreshModelControls();
	}

	async resetModelSelection(): Promise<void> {
		if (!this.activeThreadId) {
			return;
		}
		await this.settingsService.resetSelectionForThread(
			this.activeThreadId,
		);
		this.refreshModelControls();
	}

	async switchToNextModel(): Promise<void> {
		const context = this.getModelSwitcherContext();
		await this.settingsService.switchToNextModel(
			context.threadId,
			context.location,
		);
		this.refreshModelControls();
	}

	async openSession(threadId?: string): Promise<void> {
		const targetThreadId =
			threadId ?? this.activeThreadId ?? this.rail.getSelectedThread();
		if (!targetThreadId) {
			this.showComposerForNewChat();
			return;
		}

		if (!this.threadsById.has(targetThreadId)) {
			return;
		}

		const previousActiveThreadId = this.activeThreadId;
		const runtimeState = this.threadRuntimeService?.getState?.(targetThreadId);
		if (!runtimeState) {
			// The rail is runtime-owned now. If a selected row no longer has runtime state, fail
			// closed instead of silently reconstructing UI state from a stale cache.
			if (!previousActiveThreadId || previousActiveThreadId === targetThreadId) {
				this.showComposerForNewChat();
			} else {
				this.rail.setSelectedThread(previousActiveThreadId);
			}
			return;
		}
		this.activeThreadId = targetThreadId;
		this.rail.setSelectedThread(targetThreadId);
		this.railVisible = false;
		this.refreshPlanModeControl();
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
		const latestPrompt = this.getLatestConversationPrompt(threadId);
		if (!latestPrompt) {
			return;
		}
		await this.clipboardService.writeText(latestPrompt.content);
	}

	async copyResponse(threadId?: string): Promise<void> {
		const latestResponse = this.getLatestConversationResponse(threadId);
		if (!latestResponse) {
			return;
		}
		await this.clipboardService.writeText(latestResponse.content);
	}

	reusePrompt(threadId?: string): void {
		const latestPrompt = this.getLatestConversationPrompt(threadId);
		if (!latestPrompt || !this.composerInput) {
			return;
		}
		this.composerInput.value = latestPrompt.content;
		// Rehydrating stored images here makes "reuse prompt" faithful for multimodal turns instead
		// of silently dropping the visual context that the original request depended on.
		this.pendingImages = this.toPendingImages(latestPrompt.imageAttachments);
		this.renderImageStrip();
		this.updateComposerMetrics();
		this.focusInput();
	}

	override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);

		parent.classList.add("vsclone-unified-chat-view-pane");
		this.rootContainer = parent;
		parent.replaceChildren();

		const content = document.createElement("div");
		content.className = "vsclone-chat-content";

		const railContainer = document.createElement("div");
		railContainer.className = "vsclone-chat-left-rail";
		this.railContainer = railContainer;
		this.rail.render(railContainer);
		content.appendChild(railContainer);

		const resizeHandle = document.createElement("div");
		resizeHandle.className = "vsclone-chat-rail-resize-handle";
		this.railResizeHandle = resizeHandle;
		content.appendChild(resizeHandle);

		const conversation = document.createElement("div");
		conversation.className = "vsclone-chat-conversation";
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
		const actions = document.createElement("div");
		actions.className = "vsclone-thread-actions";

		const threadButton = document.createElement("button");
		threadButton.type = "button";
		threadButton.className = "vsclone-thread-action-button";
		threadButton.textContent = localize(
			"vsclone.thread.actions.history",
			"Threads",
		);
		// Mirror tooltip text into an accessible name so screen readers announce this icon-like action clearly.
		const threadButtonLabel = localize(
			"vsclone.thread.actions.history.tooltip",
			"Show threads",
		);
		threadButton.title = threadButtonLabel;
		threadButton.setAttribute("aria-label", threadButtonLabel);
		actions.appendChild(threadButton);

		const overflowButton = document.createElement("button");
		overflowButton.type = "button";
		overflowButton.className = "vsclone-thread-action-overflow";
		overflowButton.textContent = "\u22ef";
		const overflowButtonLabel = localize(
			"vsclone.thread.actions.more",
			"More actions",
		);
		overflowButton.title = overflowButtonLabel;
		overflowButton.setAttribute("aria-label", overflowButtonLabel);
		overflowButton.setAttribute("aria-haspopup", "menu");
		actions.appendChild(overflowButton);

		const messages = document.createElement("div");
		messages.className = "vsclone-thread-messages";
		// Announce newly appended message bubbles without repeatedly reading the whole transcript.
		messages.setAttribute("role", "log");
		messages.setAttribute("aria-live", "polite");
		messages.setAttribute("aria-relevant", "additions text");
		messages.setAttribute(
			"aria-label",
			localize("vsclone.thread.messages", "Conversation messages"),
		);
		this.conversationList = messages;

		const emptyState = document.createElement("div");
		emptyState.className = "vsclone-thread-empty-state";
		emptyState.textContent = localize(
			"vsclone.thread.empty",
			"Start a new chat from the composer below.",
		);
		this.conversationEmptyState = emptyState;

		const composer = document.createElement("div");
		composer.className = "vsclone-thread-composer";

		const input = document.createElement("textarea");
		input.className = "vsclone-thread-composer-input";
		input.rows = 1;
		input.placeholder = localize(
			"vsclone.composer.placeholder",
			"Ask a follow-up question...",
		);
		input.setAttribute(
			"aria-label",
			localize("vsclone.composer.inputLabel", "Chat message"),
		);
		this.composerInput = input;

		const send = document.createElement('button');
		send.type = 'button';
		send.className = 'vsclone-thread-composer-send';
		send.setAttribute(
			'aria-label',
			localize("vsclone.composer.send", "Send message"),
		);
		send.title = localize("vsclone.composer.sendTooltip", "Send message");
		const sendIcon = document.createElement('span');
		sendIcon.className = 'codicon codicon-send';
		sendIcon.setAttribute('aria-hidden', 'true');
		send.appendChild(sendIcon);
		this.composerSendButton = send;

		const controls = document.createElement('div');
		controls.className = 'vsclone-thread-composer-controls';
		this.planModeContainer = undefined;
		this.planModeSwitchButton = undefined;
		this.addContextMenuToggle = undefined;
		this.reasoningEffortContainer = undefined;
		this.reasoningEffortSelect = undefined;

		const modelSwitcherEnabled =
			this.configurationService.getValue<boolean>(
				modelSwitcherEnabledSetting,
			) ?? true;
		if (modelSwitcherEnabled) {
			const modelSwitcherHost = document.createElement("div");
			modelSwitcherHost.className = "vsclone-thread-model-switcher";
			controls.appendChild(modelSwitcherHost);
			try {
				this.modelSwitcher = this._register(
					new VSCloneModelSwitcherWidget(
						this.settingsService,
						this.providerConfigurationBridge,
						() => this.getModelSwitcherContext(),
					),
				);
				this.modelSwitcher.render(modelSwitcherHost);
			} catch (error) {
				onUnexpectedError(error);
				modelSwitcherHost.remove();
				this.modelSwitcher = undefined;
			}

			const reasoningEffortHost = document.createElement("div");
			reasoningEffortHost.className = "vsclone-thread-reasoning-level hidden";
			const reasoningEffortSelect = document.createElement("select");
			reasoningEffortSelect.className = "vsclone-thread-reasoning-level-select";
			reasoningEffortSelect.setAttribute(
				"aria-label",
				localize("vsclone.composer.reasoningEffort", "Reasoning level"),
			);
			reasoningEffortHost.appendChild(reasoningEffortSelect);
			controls.appendChild(reasoningEffortHost);
			this.reasoningEffortContainer = reasoningEffortHost;
			this.reasoningEffortSelect = reasoningEffortSelect;
		}

		// "+" context menu button with popup for adding images, files, and toggling plan mode.
		const addContextRoot = document.createElement('div');
		addContextRoot.className = 'vsclone-add-context-root';
		const addContextButton = document.createElement('button');
		addContextButton.type = 'button';
		addContextButton.className = 'vsclone-add-context-button';
		addContextButton.setAttribute('aria-haspopup', 'menu');
		addContextButton.setAttribute('aria-label', localize("vsclone.composer.addContext", "Add context"));
		addContextButton.title = localize("vsclone.composer.addContextTooltip", "Add context");
		const addContextIcon = document.createElement('span');
		addContextIcon.className = 'codicon codicon-add';
		addContextIcon.setAttribute('aria-hidden', 'true');
		addContextButton.appendChild(addContextIcon);
		addContextRoot.appendChild(addContextButton);

		const addContextMenuId = `${this.id}-add-context-menu`;
		const addContextMenu = document.createElement('div');
		addContextMenu.className = 'vsclone-add-context-menu hidden';
		addContextMenu.id = addContextMenuId;
		addContextMenu.setAttribute('role', 'menu');
		addContextButton.setAttribute('aria-controls', addContextMenuId);

		const addImageItem = document.createElement('button');
		addImageItem.type = 'button';
		addImageItem.className = 'vsclone-add-context-menu-item';
		addImageItem.setAttribute('role', 'menuitem');
		const addImageIcon = document.createElement('span');
		addImageIcon.className = 'codicon codicon-file-media';
		addImageIcon.setAttribute('aria-hidden', 'true');
		addImageItem.appendChild(addImageIcon);
		addImageItem.appendChild(document.createTextNode(localize("vsclone.composer.addImage", "Add Image")));

		const planModeItem = document.createElement('button');
		planModeItem.type = 'button';
		planModeItem.className = 'vsclone-add-context-menu-item';
		planModeItem.setAttribute('role', 'menuitemcheckbox');
		const planModeItemIcon = document.createElement('span');
		planModeItemIcon.className = 'codicon codicon-map';
		planModeItemIcon.setAttribute('aria-hidden', 'true');
		planModeItem.appendChild(planModeItemIcon);
		planModeItem.appendChild(document.createTextNode(localize("vsclone.composer.mode.title", "Plan Mode")));
		const planModeToggle = document.createElement('span');
		planModeToggle.className = 'vsclone-add-context-menu-toggle';
		planModeItem.appendChild(planModeToggle);

		addContextMenu.appendChild(addImageItem);
		addContextMenu.appendChild(planModeItem);
		addContextRoot.appendChild(addContextMenu);

		this.planModeContainer = addContextRoot;
		this.planModeSwitchButton = planModeItem;
		this.addContextMenuToggle = planModeToggle;

		const hint = document.createElement('div');
		hint.className = 'vsclone-thread-composer-hint';
		hint.textContent = localize("vsclone.composer.hint", "Press Enter to send, Shift+Enter for new line");
		hint.id = `${this.id}-composer-hint`;
		input.setAttribute('aria-describedby', hint.id);

		const toolbar = document.createElement('div');
		toolbar.className = 'vsclone-thread-composer-toolbar';
		toolbar.appendChild(addContextRoot);
		toolbar.appendChild(controls);
		toolbar.appendChild(send);

		const imageStrip = document.createElement('div');
		imageStrip.className = 'vsclone-composer-image-strip hidden';
		this.composerImageStrip = imageStrip;

		const imageFileInput = document.createElement('input');
		imageFileInput.type = 'file';
		imageFileInput.accept = 'image/png,image/jpeg,image/gif,image/webp';
		imageFileInput.multiple = true;
		imageFileInput.className = 'vsclone-composer-image-file-input';

		composer.appendChild(imageStrip);
		composer.appendChild(input);
		composer.appendChild(toolbar);
		composer.appendChild(hint);

		parent.appendChild(actions);
		parent.appendChild(messages);
		parent.appendChild(emptyState);
		parent.appendChild(composer);

		this._register(
			addDisposableListener(threadButton, EventType.CLICK, () => {
				this.railVisible = true;
				this.applyRailLayout();
				this.rail.focusSearch();
			}),
		);

		this._register(
			addDisposableListener(
				overflowButton,
				EventType.CLICK,
				(event: MouseEvent) => {
					event.stopPropagation();
					// Context menus allocate Action disposables on every open, so we tie their lifetime to
					// the menu instance instead of registering them on the long-lived view.
					const menuActions = new DisposableStore();
					const actions = [
						menuActions.add(new Action(
							"vsclone.threadRail.copyPrompt",
							localize("vsclone.thread.actions.copyPrompt", "Copy Prompt"),
							undefined,
							true,
							() => this.copyPrompt(),
						)),
						menuActions.add(new Action(
							"vsclone.threadRail.copyResponse",
							localize(
								"vsclone.thread.actions.copyResponse",
								"Copy Response",
							),
							undefined,
							true,
							() => this.copyResponse(),
						)),
						menuActions.add(new Action(
							"vsclone.threadRail.reusePrompt",
							localize("vsclone.thread.actions.reusePrompt", "Reuse Prompt"),
							undefined,
							true,
							() => this.reusePrompt(),
						)),
						menuActions.add(new Action(
							"vsclone.threadRail.deleteThread",
							localize(
								"vsclone.thread.actions.deleteThread",
								"Delete Thread",
							),
							undefined,
							true,
							() => this.deleteActiveThread(),
						)),
					];
					this.contextMenuService.showContextMenu({
						getAnchor: () => ({ x: event.clientX, y: event.clientY }),
						getActions: () => actions,
						onHide: () => menuActions.dispose(),
					});
				},
			),
		);

		this._register(
			addDisposableListener(input, EventType.INPUT, () => {
				this.updateComposerMetrics();
				this.updateComposerState();
			}),
		);

		this._register(
			addDisposableListener(
				input,
				EventType.KEY_DOWN,
				(event: KeyboardEvent) => {
					if (
						event.key !== "Enter" ||
						event.shiftKey ||
						event.altKey ||
						event.ctrlKey ||
						event.metaKey
					) {
						return;
					}
					event.preventDefault();
					void this.handleComposerPrimaryAction();
				},
			),
		);

		this._register(
			addDisposableListener(input, 'paste', (event: ClipboardEvent) => {
				const items = event.clipboardData?.items;
				if (!items) {
					return;
				}
				const imageFiles: File[] = [];
				for (const item of Array.from(items)) {
					if (item.type.startsWith('image/')) {
						const file = item.getAsFile();
						if (file) {
							imageFiles.push(file);
						}
					}
				}
				if (imageFiles.length > 0) {
					event.preventDefault();
					void this.handleImageFiles(imageFiles);
				}
			}),
		);

		this._register(
			addDisposableListener(send, EventType.CLICK, () => {
				void this.handleComposerPrimaryAction();
			}),
		);
		// "+" context menu: open/close popup
		let addContextMenuOpen = false;
		const toggleAddContextMenu = (open?: boolean) => {
			addContextMenuOpen = open ?? !addContextMenuOpen;
			addContextMenu.classList.toggle('hidden', !addContextMenuOpen);
			addContextRoot.classList.toggle('open', addContextMenuOpen);
			addContextButton.setAttribute('aria-expanded', String(addContextMenuOpen));
		};
		this._register(
			addDisposableListener(addContextButton, EventType.CLICK, () => {
				toggleAddContextMenu();
			}),
		);
		const targetWindow = getWindow(composer);
		this._register(
			addDisposableListener(targetWindow.document, EventType.MOUSE_DOWN, (event: MouseEvent) => {
				if (!addContextMenuOpen) {
					return;
				}
				const clickTarget = event.target as Node | null;
				if (clickTarget && addContextRoot.contains(clickTarget)) {
					return;
				}
				toggleAddContextMenu(false);
			}),
		);
		this._register(
			addDisposableListener(targetWindow.document, EventType.KEY_DOWN, (event: KeyboardEvent) => {
				if (addContextMenuOpen && event.key === 'Escape') {
					event.preventDefault();
					toggleAddContextMenu(false);
					addContextButton.focus();
				}
			}),
		);
		this._register(
			addDisposableListener(addImageItem, EventType.CLICK, () => {
				toggleAddContextMenu(false);
				imageFileInput.click();
			}),
		);
		this._register(
			addDisposableListener(imageFileInput, EventType.CHANGE, () => {
				if (imageFileInput.files) {
					void this.handleImageFiles(imageFileInput.files);
				}
				imageFileInput.value = '';
			}),
		);
		this._register(
			addDisposableListener(planModeItem, EventType.CLICK, () => {
				const nextMode = this.getCurrentComposerMode() === 'plan' ? 'act' : 'plan';
				void this.updatePlanModeSelection(nextMode);
			}),
		);
		if (this.reasoningEffortSelect) {
			this._register(
				addDisposableListener(
					this.reasoningEffortSelect,
					EventType.CHANGE,
					() => {
						void this.updateReasoningEffortSelection();
					},
				),
			);
		}

		this.composerFocusDisposable.value = toDisposable(() => {
			input.blur();
		});
		this.updateComposerMetrics();
		this.updateComposerState();
		this.refreshPlanModeControl();
		this.refreshReasoningEffortControl();
		if (this.modelSwitcher) {
			void this.settingsService.refreshState();
		}
	}

	private renderConversationFallback(parent: HTMLElement): void {
		parent.replaceChildren();

		const fallback = document.createElement("div");
		fallback.className = "vsclone-thread-empty-state";
		fallback.textContent = localize(
			"vsclone.thread.renderError",
			"Failed to render the chat UI. Reload the window and try again.",
		);
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
		if (activeThreadId && this.hasPendingAssistantApply(activeThreadId)) {
			return;
		}

		// Wait for restore-backed state before reading the visible composer controls so an eager send
		// cannot capture fallback defaults while thread selections and plan mode are still hydrating.
		await this.planModeService.initialize();
		await this.settingsService.initialize();
		const selectedModel = this.getCurrentComposerModelSelection(activeThreadId);
		const existingThread = activeThreadId
			? this.resolveThreadById(activeThreadId)
			: undefined;
		this.submittingPrompt = true;
		this.updateComposerState();

		try {
			const imageAttachments = this.pendingImages.length > 0
				? this.pendingImages.map(img => ({ mimeType: img.mimeType, base64Data: img.base64Data }))
				: undefined;
			const submission = await this.chatThreadService.sendMessage(promptText, {
				threadId: activeThreadId,
				sessionResource: existingThread?.sessionResource,
				modelSelection: selectedModel,
				imageAttachments,
			});
			if (!submission) {
				return;
			}

			const runtimeState = this.getThreadRuntimeState(submission.threadId);
			if (runtimeState) {
				this.threadsById.set(
					submission.threadId,
					this.buildThreadCatalogEntryFromRuntime(runtimeState, this.threadsById.get(submission.threadId), {
						sessionResource: submission.sessionResource,
					}),
				);
			}
			this.activeThreadId = submission.threadId;
			this.rail.setSelectedThread(submission.threadId);
			this.railVisible = false;
			this.composerInput.value = "";
			this.pendingImages = [];
			this.renderImageStrip();
			this.updateComposerMetrics();
			this.refreshModelControls();
			this.refreshConversation();
			this.applyRailLayout();
		} finally {
			this.submittingPrompt = false;
			this.updateComposerState();
		}
	}

	private getBusyThreadId(): string | undefined {
		const activeThreadId = this.activeThreadId;
		if (!activeThreadId || !this.isThreadBusy(activeThreadId)) {
			return undefined;
		}
		return activeThreadId;
	}

	private async handleComposerPrimaryAction(): Promise<void> {
		const busyThreadId = this.getBusyThreadId();
		if (busyThreadId) {
			// Keep the stop affordance responsive immediately after the user clicks it because the
			// turn status update lands asynchronously after the transport observes the cancellation.
			this.chatThreadService.cancelThread(busyThreadId);
			this.updateComposerState();
			return;
		}

		await this.submitPrompt();
	}

	private async handleImageFiles(files: FileList | File[]): Promise<void> {
		const selectedModel = this.getCurrentComposerModelSelection(this.activeThreadId);
		if (selectedModel) {
			const modelDescriptor = this.settingsService.getModel(selectedModel.modelIdentifier);
			if (modelDescriptor && !modelDescriptor.supportsImages) {
				this.notificationService.warn(
					localize("vsclone.composer.imageNotSupported", "The selected model does not support image attachments."),
				);
				return;
			}
		}

		for (const file of Array.from(files)) {
			if (!file.type.startsWith('image/')) {
				continue;
			}
			try {
				const base64Data = await this.readFileAsBase64(file);
				const dataUrl = toVSCloneImageDataUrl({ mimeType: file.type, base64Data });
				this.pendingImages.push({ mimeType: file.type, base64Data, dataUrl });
			} catch {
				// Skip files that fail to read
			}
		}
		this.renderImageStrip();
	}

	private readFileAsBase64(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = reader.result as string;
				const base64 = result.split(',')[1];
				resolve(base64);
			};
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	/**
	 * Composer previews need browser-safe data URLs, but history persists base64 payloads so the
	 * same attachment metadata can round-trip through storage and API replay.
	 */
	private toPendingImages(images: readonly IVSCloneImageAttachment[] | undefined): IPendingImageAttachment[] {
		if (!images || images.length === 0) {
			return [];
		}

		return images.map(image => ({
			...image,
			dataUrl: toVSCloneImageDataUrl(image),
		}));
	}

	private renderImageStrip(): void {
		if (!this.composerImageStrip) {
			return;
		}
		this.composerImageStrip.replaceChildren();
		if (this.pendingImages.length === 0) {
			this.composerImageStrip.classList.add('hidden');
			return;
		}
		this.composerImageStrip.classList.remove('hidden');

		for (let i = 0; i < this.pendingImages.length; i++) {
			const img = this.pendingImages[i];
			const thumb = document.createElement('div');
			thumb.className = 'vsclone-composer-image-thumb';

			const preview = document.createElement('img');
			preview.src = img.dataUrl;
			preview.alt = localize("vsclone.composer.imageAttachment", "Image attachment");
			preview.className = 'vsclone-composer-image-thumb-img';
			preview.addEventListener(EventType.CLICK, () => {
				this.showImagePreviewOverlay(img.dataUrl);
			});

			const removeBtn = document.createElement('button');
			removeBtn.type = 'button';
			removeBtn.className = 'vsclone-composer-image-thumb-remove';
			removeBtn.setAttribute('aria-label', localize("vsclone.composer.removeImage", "Remove image"));
			const removeIcon = document.createElement('span');
			removeIcon.className = 'codicon codicon-close';
			removeIcon.setAttribute('aria-hidden', 'true');
			removeBtn.appendChild(removeIcon);
			const index = i;
			removeBtn.addEventListener(EventType.CLICK, e => {
				e.stopPropagation();
				this.pendingImages.splice(index, 1);
				this.renderImageStrip();
			});

			thumb.appendChild(preview);
			thumb.appendChild(removeBtn);
			this.composerImageStrip.appendChild(thumb);
		}
	}

	private showImagePreviewOverlay(dataUrl: string): void {
		// Resolve the owning workbench window so the preview attaches to the same document as the
		// clicked thumbnail. Using the global `document` breaks when this view is hosted in a
		// secondary window.
		const targetWindow = this.rootContainer ? getWindow(this.rootContainer) : getActiveWindow();
		const targetDocument = targetWindow.document;
		const overlay = targetDocument.createElement('div');
		overlay.className = 'vsclone-image-preview-overlay';
		const closeBtn = targetDocument.createElement('button');
		closeBtn.type = 'button';
		closeBtn.className = 'vsclone-image-preview-close';
		closeBtn.setAttribute('aria-label', localize("vsclone.imagePreview.close", "Close preview"));
		const closeIcon = targetDocument.createElement('span');
		closeIcon.className = 'codicon codicon-close';
		closeIcon.setAttribute('aria-hidden', 'true');
		closeBtn.appendChild(closeIcon);
		const img = targetDocument.createElement('img');
		img.src = dataUrl;
		img.className = 'vsclone-image-preview-overlay-img';
		overlay.appendChild(closeBtn);
		overlay.appendChild(img);
		const close = () => overlay.remove();
		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) {
				close();
			}
		});
		closeBtn.addEventListener('click', close);
		overlay.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				close();
			}
		});
		overlay.tabIndex = 0;
		targetWindow.document.body.appendChild(overlay);
		overlay.focus();
	}

	private applyResponsiveLayout(width: number): void {
		const compact = width > 0 && width < compactRailBreakpoint;
		this.isCompactLayout = compact;
		this.rootContainer?.classList.toggle("compact-layout", compact);
	}

	private async reloadHistory(): Promise<void> {
		if (!this.rootContainer) {
			return;
		}

		this.rail.setLoading();
		try {
			await this.planModeService.initialize();
			this.catalogReady = true;
			this.refreshThreadCatalogFromRuntime();
			this.refreshRailRows();
			if (!this.activeThreadId) {
				// Default to composer mode when opening VSClone with no active thread.
				this.railVisible = false;
				this.applyRailLayout();
			}
			const runtimeState = this.activeThreadId
				? this.threadRuntimeService?.getState?.(this.activeThreadId)
				: undefined;
			if (this.activeThreadId && !runtimeState) {
				// If the previously selected thread is gone from runtime, drop back to a new composer.
				this.showComposerForNewChat();
				return;
			}
			this.refreshConversation();
		} catch {
			this.catalogReady = false;
			this.rail.setError(
				localize(
					"vsclone.rail.load.error",
					"Failed to load chat threads. Please try again.",
				),
			);
		}
	}

	private refreshRailRows(): void {
		if (!this.catalogReady) {
			return;
		}

		this.refreshThreadCatalogFromRuntime();
		const filterState = this.rail.getFilterState();
		const threads = this.getFilteredThreadCatalog(
			toVSCloneHistoryQuery(filterState.query, filterState.tab),
		);

		const previousActiveThreadId = this.activeThreadId;
		if (this.activeThreadId && !this.resolveThreadById(this.activeThreadId)) {
			this.activeThreadId = undefined;
		}
		// Normalize external thread removal back to the fresh composer state.
		if (previousActiveThreadId && !this.activeThreadId && threads.length === 0) {
			this.showComposerForNewChat();
			return;
		}

		const rows = toVSCloneThreadRailRows(threads, this.activeThreadId, (timestamp) =>
			fromNow(timestamp, true),
		);
		this.rail.setRows(rows);
		if (!this.activeThreadId) {
			this.rail.setSelectedThread(undefined);
		} else {
			this.rail.setSelectedThread(this.activeThreadId);
		}
	}

	private getRuntimeThreadCatalogService(): (IVSCloneThreadRuntimeService & IVSCloneThreadRuntimeCatalogService) | undefined {
		return this.threadRuntimeService as (IVSCloneThreadRuntimeService & IVSCloneThreadRuntimeCatalogService) | undefined;
	}

	private refreshThreadCatalogFromRuntime(): void {
		const runtimeCatalog = this.getRuntimeThreadCatalogService()?.getThreads?.({
			includeArchived: true,
		});
		if (!runtimeCatalog) {
			return;
		}

		const runtimeThreadIds = new Set(runtimeCatalog.map(thread => thread.threadId));
		for (const [threadId] of this.threadsById) {
			if (!runtimeThreadIds.has(threadId)) {
				this.threadsById.delete(threadId);
			}
		}

		for (const thread of runtimeCatalog) {
			const existing = this.threadsById.get(thread.threadId);
			this.threadsById.set(thread.threadId, {
				...existing,
				...thread,
				sessionResource: thread.sessionResource ?? existing?.sessionResource,
				activeModelIdentifier: thread.activeModelIdentifier ?? existing?.activeModelIdentifier,
			});
		}
	}

	private getFilteredThreadCatalog(
		query: IVSCloneThreadRuntimeCatalogQuery,
	): readonly IVSCloneThreadCatalogEntry[] {
		const needle = query.text?.trim().toLocaleLowerCase();
		const entries = [...this.threadsById.values()]
			.filter((thread) => {
				switch (query.tab) {
					case "active":
						return !thread.archived;
					case "archived":
						return thread.archived;
					default:
						return query.includeArchived ? true : !thread.archived;
				}
			})
			.filter((thread) => {
				if (!needle) {
					return true;
				}
				return (
					thread.title.toLocaleLowerCase().includes(needle) ||
					thread.lastTurnPreview.toLocaleLowerCase().includes(needle)
				);
			})
			.sort((left, right) => {
				if (right.updatedAt !== left.updatedAt) {
					return right.updatedAt - left.updatedAt;
				}
				return right.createdAt - left.createdAt;
			});
		return entries;
	}

	private syncThreadCatalogEntryFromRuntime(
		state: IVSCloneThreadRuntimeState,
	): void {
		if (!this.threadRuntimeService.getState(state.threadId)) {
			this.threadsById.delete(state.threadId);
			return;
		}
		const existing = this.threadsById.get(state.threadId);
		const nextEntry = this.buildThreadCatalogEntryFromRuntime(state, existing);
		this.threadsById.set(state.threadId, nextEntry);
	}

	private buildThreadCatalogEntryFromRuntime(
		state: IVSCloneThreadRuntimeState,
		existing: IVSClonePaneThreadCatalogEntry | undefined,
		overrides: Partial<IVSClonePaneThreadCatalogEntry> = {},
	): IVSClonePaneThreadCatalogEntry {
		const createdAt = existing?.createdAt ?? state.messages[0]?.createdAt ?? state.lastUpdatedAt;
		const turnCount = state.messages.filter((message) => message.role === "user").length;
		const title = existing?.title ?? this.summarizeRuntimeCatalogText(
			state.messages.find((message) => message.role === "user")?.content,
			localize("vsclone.rail.threadFallbackTitle", "New chat"),
		);
		const lastTurnPreview = this.summarizeRuntimeCatalogText(
			[...state.messages]
				.reverse()
				.find((message) => message.role === "assistant" || message.role === "user")
				?.content,
			title,
		);
		const sessionResource = overrides.sessionResource
			?? state.catalog.sessionResource
			?? existing?.sessionResource;
		return {
			threadId: state.threadId,
			sessionResource,
			title: overrides.title ?? title,
			activeModelIdentifier: overrides.activeModelIdentifier ?? existing?.activeModelIdentifier,
			createdAt: overrides.createdAt ?? createdAt,
			updatedAt: overrides.updatedAt ?? state.lastUpdatedAt,
			archived: overrides.archived ?? existing?.archived ?? false,
			status: overrides.status ?? this.getThreadCatalogStatusFromRuntime(state, existing),
			turnCount: overrides.turnCount ?? turnCount,
			lastTurnPreview: overrides.lastTurnPreview ?? lastTurnPreview,
		};
	}

	private getThreadCatalogStatusFromRuntime(
		state: IVSCloneThreadRuntimeState,
		existing: IVSClonePaneThreadCatalogEntry | undefined,
	): IVSClonePaneThreadCatalogEntry["status"] {
		if (existing?.archived) {
			return "archived";
		}
		if (state.streamState.kind !== "idle") {
			return "active";
		}
		return existing?.status === "failed" ? "failed" : "completed";
	}

	private summarizeRuntimeCatalogText(
		value: string | undefined,
		fallback: string,
	): string {
		const normalized = value?.replace(/\s+/g, " ").trim();
		if (!normalized) {
			return fallback;
		}
		return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
	}

	private refreshConversation(): void {
		if (!this.conversationList || !this.conversationEmptyState) {
			return;
		}

		const runtimeState = this.getThreadRuntimeState(this.activeThreadId);
		const runtimeNodes = runtimeState
			? this.renderRuntimeConversationNodes(runtimeState)
			: [];
		const hasRuntimeNodes = runtimeNodes.length > 0;
		// Refresh rebuilds the transcript DOM from scratch, so dispose markdown renderers from
		// the previous pass before replacing nodes to avoid leaking listeners.
		this.renderedMarkdownDisposables.clear();
		this.conversationList.replaceChildren();
		this.conversationEmptyState.classList.toggle(
			"hidden",
			hasRuntimeNodes,
		);
		if (hasRuntimeNodes) {
			this.conversationList.append(...runtimeNodes);
		}

		this.updateComposerState();
		this.refreshModelControls();
		this.scheduleScrollToBottom();
	}

	private renderRuntimeConversationNodes(
		state: IVSCloneThreadRuntimeState,
	): HTMLElement[] {
		const nodes: HTMLElement[] = [];

		// Classify each assistant message as intermediate narration (has a tool call somewhere
		// after it) vs. the final answer (nothing but other assistants/checkpoints after it).
		// Intermediate narrations get collapsed into a "Thought briefly" block so the transcript
		// reads as short status lines instead of a wall of planning text between tool calls.
		const isIntermediateAssistant: boolean[] = state.messages.map((message, index) => {
			if (message.role !== 'assistant') {
				return false;
			}
			for (let j = index + 1; j < state.messages.length; j++) {
				if (state.messages[j].role === 'tool') {
					return true;
				}
			}
			return false;
		});

		type IntermediateAssistantMessage = Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>;
		let narrationGroup: IntermediateAssistantMessage[] = [];
		const flushNarration = () => {
			if (narrationGroup.length === 0) {
				return;
			}
			const block = this.renderRuntimeAssistantNarrationBlock(narrationGroup);
			if (block) {
				nodes.push(block);
			}
			narrationGroup = [];
		};

		for (let index = 0; index < state.messages.length; index++) {
			const message = state.messages[index];
			switch (message.role) {
				case 'user':
					flushNarration();
					nodes.push(this.renderRuntimeUserMessage(message));
					break;
				case 'assistant':
					if (isIntermediateAssistant[index]) {
						narrationGroup.push(message as IntermediateAssistantMessage);
					} else {
						flushNarration();
						nodes.push(this.renderRuntimeAssistantMessage(message, state.threadId));
					}
					break;
				case 'tool': {
					flushNarration();
					const toolNode = this.renderRuntimeToolMessage(state.threadId, state, message);
					if (toolNode) {
						nodes.push(toolNode);
					}
					break;
				}
				case 'checkpoint':
					flushNarration();
					nodes.push(
						this.renderRuntimeCheckpointMessage(
							state.threadId,
							message.checkpoint,
							this.isThreadBusy(state.threadId),
						),
					);
					break;
			}
		}
		flushNarration();

		const statusMessage = this.renderRuntimeStatusMessage(state);
		if (statusMessage) {
			nodes.push(statusMessage);
		}
		return nodes;
	}

	private renderRuntimeAssistantNarrationBlock(
		messages: readonly Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>[],
	): HTMLElement | undefined {
		const visibleMessages = messages
			.map(message => ({ message, text: this.stripRuntimeAssistantWorkflowMarkup(message.content).trim() }))
			.filter(entry => entry.text.length > 0);
		if (visibleMessages.length === 0) {
			return undefined;
		}

		const totalChars = visibleMessages.reduce((sum, entry) => sum + entry.text.length, 0);
		const qualifierText = totalChars <= 400
			? localize('vsclone.thread.thought.briefly', 'briefly')
			: totalChars <= 1600
				? localize('vsclone.thread.thought.moment', 'for a moment')
				: localize('vsclone.thread.thought.while', 'for a while');

		const item = document.createElement('div');
		item.className = 'vsclone-thread-message assistant runtime runtime-thought';

		const details = document.createElement('details');
		details.className = 'vsclone-thinking-block';

		const summary = document.createElement('summary');
		summary.className = 'vsclone-thinking-summary';

		const label = document.createElement('span');
		label.className = 'vsclone-thinking-summary-label';

		const verb = document.createElement('strong');
		verb.textContent = localize('vsclone.thread.thought.past', 'Thought');
		label.appendChild(verb);

		const qualifier = document.createElement('span');
		qualifier.className = 'vsclone-thinking-summary-qualifier';
		qualifier.textContent = qualifierText;
		label.appendChild(qualifier);

		summary.appendChild(label);
		details.appendChild(summary);

		const content = document.createElement('div');
		content.className = 'vsclone-thinking-content';
		for (const entry of visibleMessages) {
			this.appendMarkdownSegment(content, entry.text, 'vsclone-thinking-step');
		}
		details.appendChild(content);

		item.appendChild(details);
		return item;
	}

	private renderRuntimeUserMessage(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'user' }>,
	): HTMLElement {
		const item = document.createElement('div');
		item.className = 'vsclone-thread-message user runtime';

		const meta = document.createElement('div');
		meta.className = 'vsclone-thread-message-meta';
		meta.textContent = localize('vsclone.thread.userLabel', 'You');
		item.appendChild(meta);

		const body = document.createElement('div');
		body.className = 'vsclone-thread-message-body';
		if (message.content.trim().length > 0) {
			const promptText = document.createElement('div');
			promptText.className = 'vsclone-thread-message-user-text';
			promptText.textContent = message.content;
			body.appendChild(promptText);
		}
		if (message.imageAttachments && message.imageAttachments.length > 0) {
			body.appendChild(this.renderPromptImageStrip(message.imageAttachments));
		}
		item.appendChild(body);
		return item;
	}

	private renderRuntimeAssistantMessage(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>,
		threadId: string = this.activeThreadId ?? "",
	): HTMLElement {
		const item = document.createElement('div');
		item.className = 'vsclone-thread-message assistant runtime runtime-assistant';

		const meta = document.createElement('div');
		meta.className = 'vsclone-thread-message-meta';
		meta.textContent = localize('vsclone.thread.assistantLabel', 'Assistant');
		item.appendChild(meta);

		const body = document.createElement('div');
		body.className = 'vsclone-thread-message-body';
		const visibleText = this.stripRuntimeAssistantWorkflowMarkup(message.content);
		if (visibleText.trim().length > 0) {
			if (visibleText.includes("<<<<<<< SEARCH") || this.looksLikePartialSearchReplaceBlock(visibleText)) {
				this.renderSearchReplaceAwareText(body, visibleText, false);
			} else {
				this.appendMarkdownSegment(body, visibleText, 'vsclone-thread-message-assistant-text');
			}
		}
		item.appendChild(body);
		if (visibleText.trim().length > 0) {
			const applyTarget = {
				threadId,
				id: message.id,
				responseText: visibleText,
			};
			const assistantApplyState = this.threadRuntimeService
				? this.getAssistantApplyState(applyTarget)
				: undefined;
			const shouldOfferAssistantApply = this.shouldOfferRuntimeAssistantApply(threadId, message);
			if (
				shouldOfferAssistantApply
				|| assistantApplyState
			) {
				// Runtime-owned apply state must stay visible even after the assistant prose changes or
				// runtime later rewrites the assistant prose. Once a message has runtime-owned state,
				// the pane keeps rendering from that state instead of re-parsing transcript text.
				this.appendAssistantApplyControls(item, applyTarget);
			}
		}
		return item;
	}

	private stripRuntimeAssistantWorkflowMarkup(text: string): string {
		return text
			.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
			.replace(/<tool_result\b[\s\S]*?<\/tool_result>/g, '')
			.replace(/<agent_trace\b[\s\S]*?<\/agent_trace>/g, '')
			.trim();
	}

	private getThreadRuntimeState(
		threadId: string | undefined,
	): IVSCloneThreadRuntimeState | undefined {
		if (!threadId) {
			return undefined;
		}
		return this.threadRuntimeService?.getState(threadId);
	}

	private getRuntimeAssistantMessageMode(
		state: IVSCloneThreadRuntimeState,
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>,
	): VSCloneChatMode | undefined {
		return (message as { readonly mode?: VSCloneChatMode }).mode ?? state.mode;
	}

	private shouldOfferRuntimeAssistantApply(
		threadId: string,
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>,
	): boolean {
		if (!this.getRuntimeAssistantEditSuggestion(message)) {
			return false;
		}

		const runtimeState = this.getThreadRuntimeState(threadId);
		const messageMode = runtimeState
			? this.getRuntimeAssistantMessageMode(runtimeState, message)
			: (message as { readonly mode?: VSCloneChatMode }).mode;
		return messageMode !== 'plan';
	}

	private getRuntimeAssistantEditSuggestion(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>,
	): IVSCloneThreadRuntimeAssistantEditSuggestion | undefined {
		// Apply eligibility is resolved by the runtime when the assistant message is stored or
		// restored, so the pane reads the durable signal verbatim instead of scanning prose again.
		return message.metadata?.editSuggestion;
	}

	private isManualOnlyRuntimeAssistantApplyMessage(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>,
	): boolean {
		return this.getRuntimeAssistantEditSuggestion(message)?.applyMode === 'manual';
	}

	private isAutoEligibleRuntimeAssistantApplyMessage(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>,
	): boolean {
		return this.getRuntimeAssistantEditSuggestion(message)?.applyMode === 'auto';
	}

	private getVisibleRuntimeWorkflowMessages(
		messages: readonly IVSCloneThreadRuntimeMessage[],
	): ReadonlyArray<
		Extract<IVSCloneThreadRuntimeMessage, { readonly role: "tool" | "checkpoint" }>
	> {
		const visible: Array<
			Extract<IVSCloneThreadRuntimeMessage, { readonly role: "tool" | "checkpoint" }>
		> = [];
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index];
			if (message.role === "checkpoint") {
				visible.push(message);
				continue;
			}
			if (message.role !== "tool") {
				continue;
			}

			const nextMessage = messages[index + 1];
			// Tool request -> running -> terminal result all arrive as separate runtime messages.
			// The pane collapses those adjacent lifecycle steps so users see the latest material
			// state for one invocation rather than three nearly identical cards in a row.
			if (
				message.type === "tool_request" &&
				this.isSuccessorForSameRuntimeTool(
					message,
					nextMessage,
					"running_now",
				)
			) {
				continue;
			}
			if (
				message.type === "running_now" &&
				this.isSuccessorForSameRuntimeTool(
					message,
					nextMessage,
					"success",
					"tool_error",
					"rejected",
				)
			) {
				continue;
			}
			visible.push(message);
		}
		return visible;
	}

	private isSuccessorForSameRuntimeTool(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: "tool" }>,
		nextMessage: IVSCloneThreadRuntimeMessage | undefined,
		...types: Array<
			Extract<IVSCloneThreadRuntimeMessage, { readonly role: "tool" }>["type"]
		>
	): boolean {
		return (
			nextMessage?.role === "tool" &&
			nextMessage.toolName === message.toolName &&
			nextMessage.type !== undefined &&
			types.includes(nextMessage.type) &&
			this.serializeRuntimeToolParams(nextMessage.params) ===
			this.serializeRuntimeToolParams(message.params)
		);
	}

	private renderRuntimeStatusMessage(
		state: IVSCloneThreadRuntimeState,
	): HTMLElement | undefined {
		let label: string | undefined;
		let statusClass = "running";
		switch (state.streamState.kind) {
			case "llm":
				label = localize(
					"vsclone.thread.runtime.status.llm",
					"Assistant is thinking...",
				);
				break;
			case "awaiting_user":
				statusClass = "awaiting";
				label = state.streamState.approvalType
					? localize(
						"vsclone.thread.runtime.status.awaitingApproval",
						"Approval required for {0} ({1}).",
						state.streamState.toolName,
						state.streamState.approvalType,
					)
					: localize(
						"vsclone.thread.runtime.status.awaitingUser",
						"Approval required for {0}.",
						state.streamState.toolName,
					);
				break;
			case "tool":
				if (this.hasVisibleRunningRuntimeTool(state.messages)) {
					return undefined;
				}
				label = localize(
					"vsclone.thread.runtime.status.tool",
					"Running tool: {0}",
					state.streamState.toolName,
				);
				break;
			default:
				return undefined;
		}

		const status = document.createElement("div");
		status.className = "vsclone-thread-message assistant runtime runtime-status";
		status.classList.add(`status-${statusClass}`);

		const body = document.createElement("div");
		body.className = "vsclone-thread-message-body";
		const badge = document.createElement("div");
		badge.className = "vsclone-runtime-status-badge";
		const icon = document.createElement("span");
		icon.className = "codicon";
		if (statusClass === "awaiting") {
			icon.classList.add("codicon-pass");
		} else {
			icon.classList.add("codicon-loading", "codicon-modifier-spin");
		}
		icon.setAttribute("aria-hidden", "true");
		badge.appendChild(icon);
		const text = document.createElement("span");
		text.textContent = label;
		badge.appendChild(text);
		body.appendChild(badge);
		status.appendChild(body);
		return status;
	}

	private hasVisibleRunningRuntimeTool(
		messages: readonly IVSCloneThreadRuntimeMessage[],
	): boolean {
		return this.getVisibleRuntimeWorkflowMessages(messages).some(
			(message) => message.role === "tool" && message.type === "running_now",
		);
	}

	private renderRuntimeToolMessage(
		threadId: string,
		state: IVSCloneThreadRuntimeState,
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: "tool" }>,
	): HTMLElement | undefined {
		// Read-only tools (read_file, ls_dir, search_for_files) are high-volume and low-signal:
		// every call otherwise renders three cards (pending → running → completed) plus the full
		// tool output. Collapse them to a single italic status line emitted only on the terminal
		// state, and suppress the intermediate transitions entirely.
		if (isCompactRuntimeTool(message.toolName)) {
			if (message.type === "tool_request" || message.type === "running_now") {
				return undefined;
			}
			return this.renderCompactRuntimeToolMessage(message);
		}

		// Live tool_request messages get a Void-style compact approval row: a short prompt with
		// primary/secondary buttons, no nested tool-card chrome. Historical (non-live) tool_requests
		// are suppressed because the following success/rejected/tool_error message (or the inline
		// diff card) already communicates the outcome, so rendering the request card too produces
		// a redundant "Approval requested for ..." row alongside the actual result.
		if (message.type === "tool_request") {
			const livePendingRequest = this.getLatestAwaitingRuntimeToolRequest(state);
			if (livePendingRequest?.id === message.id) {
				return this.renderRuntimeApprovalRequest(threadId, message);
			}
			return undefined;
		}

		// Edit-producing tools: suppress "Running" transitions entirely, render the completed
		// diff as a flat card without the outer tool-card shell, and fall back to a compact
		// status line on rejection or error. The approval request still goes through the
		// normal tool-card path below so Approve/Reject buttons stay attached.
		if (isFlatDiffRuntimeTool(message.toolName)) {
			if (message.type === "running_now") {
				return undefined;
			}
			if (message.type === "success" && message.output) {
				const diffCard = this.renderToolResultDiffCard(message.toolName, message.output);
				if (diffCard) {
					const item = document.createElement("div");
					item.className = "vsclone-thread-message assistant runtime runtime-tool runtime-tool-flat-diff";
					const body = document.createElement("div");
					body.className = "vsclone-thread-message-body";
					body.appendChild(diffCard);
					item.appendChild(body);
					return item;
				}
				// Fall through to the default tool-card path when the diff cannot be parsed.
			}
			if (message.type === "rejected" || message.type === "tool_error") {
				return this.renderCompactRuntimeToolMessage(message);
			}
		}

		// Only terminal/edit result records carry renderer-facing output text. Progress cards
		// reuse the same shell UI but intentionally omit output so the transcript cannot imply a
		// tool has already produced a result before the runtime has one. (tool_request is handled
		// earlier in this method, so it never reaches here.)
		const toolOutput = message.type === "running_now" ? undefined : message.output;
		const item = document.createElement("div");
		item.className = "vsclone-thread-message assistant runtime runtime-tool";

		const body = document.createElement("div");
		body.className = "vsclone-thread-message-body";
		body.appendChild(
			this.renderToolCard(
				message.toolName,
				this.getRuntimeToolDisplayLabel(message),
				this.toRuntimeToolCardStatus(message),
				toolOutput,
				message.type === "success" && toolOutput
					? this.renderToolResultDiffCard(message.toolName, toolOutput)
					: undefined,
				this.renderRuntimeToolActions(threadId, state, message),
			),
		);
		item.appendChild(body);
		return item;
	}

	private renderCompactRuntimeToolMessage(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: "tool" }>,
	): HTMLElement {
		const item = document.createElement("div");
		item.className = "vsclone-thread-message assistant runtime runtime-tool runtime-tool-compact";
		const status = this.toRuntimeToolCardStatus(message);
		item.classList.add(`status-${status}`);

		const line = document.createElement("div");
		line.className = "vsclone-runtime-tool-compact-line";
		line.textContent = this.getCompactRuntimeToolLabel(message);
		item.appendChild(line);
		return item;
	}

	private getCompactRuntimeToolLabel(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: "tool" }>,
	): string {
		const target = this.describeCompactRuntimeToolTarget(message.toolName, message.params);
		const verb = this.getCompactRuntimeToolVerb(message);
		return target ? `${verb} ${target}` : verb;
	}

	private getCompactRuntimeToolVerb(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: "tool" }>,
	): string {
		const action = compactRuntimeToolAction(message.toolName);
		switch (message.type) {
			case "success":
				return action.past;
			case "rejected":
				return localize("vsclone.thread.runtime.tool.compact.rejected", "Rejected {0}", action.gerund.toLowerCase());
			case "tool_error":
				return localize("vsclone.thread.runtime.tool.compact.failed", "Failed to {0}", action.infinitive);
			default:
				return action.gerund;
		}
	}

	private describeCompactRuntimeToolTarget(toolName: string, params: Record<string, string>): string {
		if (toolName === "search_for_files") {
			return params.pattern ?? params.path ?? "";
		}
		return params.path ?? "";
	}

	private renderRuntimeToolActions(
		threadId: string,
		state: IVSCloneThreadRuntimeState,
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: "tool" }>,
	): HTMLElement | undefined {
		const livePendingRequest = this.getLatestAwaitingRuntimeToolRequest(state);
		// Approval controls are only rendered for the live pending request. Older tool_request cards
		// remain historical records and should not be able to mutate the current runtime, even when a
		// later invocation repeats the same tool name and params.
		if (
			message.type !== "tool_request" ||
			livePendingRequest?.id !== message.id
		) {
			return undefined;
		}

		const actions = document.createElement("div");
		actions.className = "vsclone-runtime-tool-actions";

		const approveButton = document.createElement("button");
		approveButton.type = "button";
		approveButton.className = "vsclone-runtime-checkpoint-button";
		approveButton.textContent = localize(
			"vsclone.thread.runtime.tool.approve",
			"Approve",
		);
		approveButton.addEventListener(EventType.CLICK, () => {
			if (!this.threadRuntimeService.approveLatestToolRequest(threadId)) {
				this.notificationService.warn(
					localize(
						"vsclone.thread.runtime.tool.approveMissing",
						"The pending tool request is no longer available.",
					),
				);
			}
		});
		actions.appendChild(approveButton);

		const rejectButton = document.createElement("button");
		rejectButton.type = "button";
		rejectButton.className = "vsclone-runtime-checkpoint-button";
		rejectButton.textContent = localize(
			"vsclone.thread.runtime.tool.reject",
			"Reject",
		);
		rejectButton.addEventListener(EventType.CLICK, () => {
			if (!this.threadRuntimeService.rejectLatestToolRequest(threadId, "Tool request was rejected by the user.")) {
				this.notificationService.warn(
					localize(
						"vsclone.thread.runtime.tool.rejectMissing",
						"The pending tool request is no longer available.",
					),
				);
			}
		});
		actions.appendChild(rejectButton);

		return actions;
	}

	private renderRuntimeApprovalRequest(
		threadId: string,
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: "tool"; readonly type: "tool_request" }>,
	): HTMLElement {
		const item = document.createElement("div");
		item.className = "vsclone-thread-message assistant runtime runtime-tool runtime-tool-approval";

		const row = document.createElement("div");
		row.className = "vsclone-runtime-approval";

		const messageEl = document.createElement("div");
		messageEl.className = "vsclone-runtime-approval-message";
		messageEl.textContent = this.getRuntimeApprovalMessage(message);
		row.appendChild(messageEl);

		const preview = this.renderRuntimeApprovalPreview(message);
		if (preview) {
			row.appendChild(preview);
		}

		const buttons = document.createElement("div");
		buttons.className = "vsclone-runtime-approval-buttons";

		const approveButton = document.createElement("button");
		approveButton.type = "button";
		approveButton.className = "vsclone-runtime-approval-button approve";
		approveButton.textContent = localize(
			"vsclone.thread.runtime.tool.approve",
			"Approve",
		);
		approveButton.addEventListener(EventType.CLICK, () => {
			if (!this.threadRuntimeService.approveLatestToolRequest(threadId)) {
				this.notificationService.warn(
					localize(
						"vsclone.thread.runtime.tool.approveMissing",
						"The pending tool request is no longer available.",
					),
				);
			}
		});
		buttons.appendChild(approveButton);

		const rejectButton = document.createElement("button");
		rejectButton.type = "button";
		rejectButton.className = "vsclone-runtime-approval-button reject";
		rejectButton.textContent = localize(
			"vsclone.thread.runtime.tool.reject",
			"Reject",
		);
		rejectButton.addEventListener(EventType.CLICK, () => {
			if (!this.threadRuntimeService.rejectLatestToolRequest(threadId, "Tool request was rejected by the user.")) {
				this.notificationService.warn(
					localize(
						"vsclone.thread.runtime.tool.rejectMissing",
						"The pending tool request is no longer available.",
					),
				);
			}
		});
		buttons.appendChild(rejectButton);

		row.appendChild(buttons);
		item.appendChild(row);
		return item;
	}

	private renderRuntimeApprovalPreview(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: "tool"; readonly type: "tool_request" }>,
	): HTMLElement | undefined {
		const filePath = message.params.path;
		if (!filePath) {
			return undefined;
		}

		if (message.toolName === "edit_file") {
			const changes = message.params.changes ?? "";
			const blocks = parseApprovalSearchReplaceBlocks(changes);
			if (blocks.length === 0) {
				return undefined;
			}
			const preview = document.createElement("div");
			preview.className = "vsclone-runtime-approval-preview";
			for (const block of blocks) {
				preview.appendChild(
					this.renderSearchReplaceDiffCard(filePath, block.searchText, block.replaceText),
				);
			}
			return preview;
		}

		if (message.toolName === "create_file") {
			const content = message.params.content;
			if (typeof content !== "string" || content.length === 0) {
				return undefined;
			}
			const preview = document.createElement("div");
			preview.className = "vsclone-runtime-approval-preview";
			preview.appendChild(this.renderSearchReplaceDiffCard(filePath, "", content));
			return preview;
		}

		return undefined;
	}

	private getRuntimeApprovalMessage(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: "tool"; readonly type: "tool_request" }>,
	): string {
		const params = message.params;
		if (isFlatDiffRuntimeTool(message.toolName)) {
			const filename = params.path ? (params.path.split("/").pop() ?? params.path) : undefined;
			return filename
				? localize("vsclone.thread.runtime.approval.edit", "Approve edit to {0}?", filename)
				: localize("vsclone.thread.runtime.approval.editGeneric", "Approve file edit?");
		}
		if (message.approvalType === "terminal") {
			const command = params.command;
			return command
				? localize("vsclone.thread.runtime.approval.run", "Approve running `{0}`?", command)
				: localize("vsclone.thread.runtime.approval.terminal", "Approve terminal action?");
		}
		return localize(
			"vsclone.thread.runtime.approval.generic",
			"Approve {0}?",
			message.toolName,
		);
	}

	private getLatestAwaitingRuntimeToolRequest(
		state: Pick<IVSCloneThreadRuntimeState, "messages" | "streamState">,
	): Extract<IVSCloneThreadRuntimeMessage, { readonly role: "tool"; readonly type: "tool_request" }> | undefined {
		if (state.streamState.kind !== "awaiting_user") {
			return undefined;
		}

		for (let index = state.messages.length - 1; index >= 0; index--) {
			const message = state.messages[index];
			if (message.role === "tool" && message.type === "tool_request") {
				return message;
			}
		}

		return undefined;
	}

	private getRuntimeToolDisplayLabel(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: "tool" }>,
	): string {
		const detail = this.describeRuntimeToolParams(message.params);
		switch (message.type) {
			case "tool_request":
				return message.approvalType
					? localize(
						"vsclone.thread.runtime.tool.requestWithApproval",
						"Approval requested for {0} ({1}){2}",
						message.toolName,
						message.approvalType,
						detail,
					)
					: localize(
						"vsclone.thread.runtime.tool.request",
						"Preparing {0}{1}",
						message.toolName,
						detail,
					);
			case "running_now":
				return localize(
					"vsclone.thread.runtime.tool.running",
					"Running {0}{1}",
					message.toolName,
					detail,
				);
			case "success":
				return localize(
					"vsclone.thread.runtime.tool.success",
					"Completed {0}{1}",
					message.toolName,
					detail,
				);
			case "rejected":
				return localize(
					"vsclone.thread.runtime.tool.rejected",
					"Rejected {0}{1}",
					message.toolName,
					detail,
				);
			default:
				return localize(
					"vsclone.thread.runtime.tool.error",
					"Failed {0}{1}",
					message.toolName,
					detail,
				);
		}
	}

	private describeRuntimeToolParams(params: Record<string, string>): string {
		const detailKeys = ["path", "command", "query", "dir", "directory"];
		for (const key of detailKeys) {
			const value = params[key];
			if (value) {
				return ` (${value})`;
			}
		}
		return "";
	}

	private serializeRuntimeToolParams(params: Record<string, string>): string {
		return JSON.stringify(
			Object.keys(params)
				.sort((left, right) => left.localeCompare(right))
				.map((key) => [key, params[key]]),
		);
	}

	private toRuntimeToolCardStatus(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: "tool" }>,
	): "running" | "complete" | "success" | "error" {
		switch (message.type) {
			case "tool_request":
				return "complete";
			case "running_now":
				return "running";
			case "success":
				return "success";
			case "rejected":
			case "tool_error":
				return "error";
		}
	}

	private renderRuntimeCheckpointMessage(
		threadId: string,
		checkpoint: IVSCloneThreadRuntimeCheckpoint,
		threadIsRunning: boolean,
	): HTMLElement {
		const item = document.createElement("div");
		item.className = "vsclone-thread-message assistant runtime runtime-checkpoint";

		const body = document.createElement("div");
		body.className = "vsclone-thread-message-body";

		const card = document.createElement("div");
		card.className = "vsclone-runtime-checkpoint-card";

		const summary = document.createElement("div");
		summary.className = "vsclone-runtime-checkpoint-summary";
		summary.textContent =
			checkpoint.snapshots.length === 1
				? localize(
					"vsclone.thread.runtime.checkpoint.summary.one",
					"Checkpoint saved after {0} with 1 file snapshot.",
					checkpoint.toolName,
				)
				: localize(
					"vsclone.thread.runtime.checkpoint.summary.many",
					"Checkpoint saved after {0} with {1} file snapshots.",
					checkpoint.toolName,
					checkpoint.snapshots.length.toString(),
				);
		card.appendChild(summary);

		const meta = document.createElement("div");
		meta.className = "vsclone-runtime-checkpoint-meta";
		meta.textContent = localize(
			"vsclone.thread.runtime.checkpoint.meta",
			"Created {0}",
			fromNow(checkpoint.createdAt, true),
		);
		card.appendChild(meta);

		const actions = document.createElement("div");
		actions.className = "vsclone-runtime-checkpoint-actions";
		const rewindButton = document.createElement("button");
		rewindButton.type = "button";
		rewindButton.className = "vsclone-runtime-checkpoint-button";
		rewindButton.textContent = localize(
			"vsclone.thread.runtime.checkpoint.rewind",
			"Rewind to checkpoint",
		);
		const assistantApplyPending = this.hasPendingAssistantApply(threadId);
		// Rewind is intentionally blocked during active execution because applying an older
		// snapshot mid-run or mid-apply would race active mutations and leave the transcript
		// describing a workspace state that no longer exists.
		rewindButton.disabled = threadIsRunning || assistantApplyPending;
		rewindButton.title = threadIsRunning
			? localize(
				"vsclone.thread.runtime.checkpoint.rewindDisabled",
				"Wait for the active run to finish before rewinding.",
			)
			: assistantApplyPending
				? localize(
					"vsclone.thread.runtime.checkpoint.rewindApplyPending",
					"Wait for edit application to finish before rewinding.",
				)
				: localize(
					"vsclone.thread.runtime.checkpoint.rewindTooltip",
					"Restore the files captured in this checkpoint.",
				);
		rewindButton.addEventListener(EventType.CLICK, () => {
			void this.handleCheckpointRewind(threadId, checkpoint, rewindButton);
		});
		actions.appendChild(rewindButton);
		card.appendChild(actions);

		body.appendChild(card);
		item.appendChild(body);
		return item;
	}

	private async handleCheckpointRewind(
		threadId: string,
		checkpoint: IVSCloneThreadRuntimeCheckpoint,
		button: HTMLButtonElement,
	): Promise<void> {
		if (this.isThreadBusy(threadId)) {
			this.notificationService.warn(
				localize(
					"vsclone.thread.runtime.checkpoint.rewindBusy",
					"Wait for the active run to finish before rewinding.",
				),
			);
			return;
		}
		if (this.hasPendingAssistantApply(threadId)) {
			this.notificationService.warn(
				localize(
					"vsclone.thread.runtime.checkpoint.rewindPendingApply",
					"Wait for edit application to finish before rewinding.",
				),
			);
			return;
		}
		button.disabled = true;
		try {
			const restored = await this.threadRuntimeService.rewindToCheckpoint(
				threadId,
				checkpoint.id,
			);
			if (!restored) {
				this.notificationService.warn(
					localize(
						"vsclone.thread.runtime.checkpoint.rewindMissing",
						"That checkpoint is no longer available.",
					),
				);
				return;
			}
			this.notificationService.info(
				localize(
					"vsclone.thread.runtime.checkpoint.rewindSuccess",
					"Restored {0} file snapshot(s) from {1}.",
					checkpoint.snapshots.length,
					checkpoint.toolName,
				),
			);
			this.refreshConversation();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.notificationService.error(
				localize(
					"vsclone.thread.runtime.checkpoint.rewindError",
					"Failed to restore the checkpoint: {0}",
					message,
				),
			);
		} finally {
			const latestState = this.getThreadRuntimeState(threadId);
			if (button.isConnected && !isRuntimeThreadExecuting(latestState)) {
				button.disabled = false;
			}
		}
	}

	/**
	 * User-turn images are rendered from persisted runtime state so restored threads keep showing
	 * the same attachments that were actually sent to the provider.
	 */
	private renderPromptImageStrip(images: readonly IVSCloneImageAttachment[]): HTMLElement {
		const strip = document.createElement('div');
		strip.className = 'vsclone-thread-image-strip';

		for (const image of images) {
			const dataUrl = toVSCloneImageDataUrl(image);
			const thumb = document.createElement('button');
			thumb.type = 'button';
			thumb.className = 'vsclone-thread-image-thumb';
			thumb.setAttribute('aria-label', localize("vsclone.thread.openImage", "Open Attached Image"));

			const preview = document.createElement('img');
			preview.src = dataUrl;
			preview.alt = localize("vsclone.composer.imageAttachment", "Image attachment");
			preview.className = 'vsclone-thread-image-thumb-img';

			thumb.appendChild(preview);
			thumb.addEventListener(EventType.CLICK, () => {
				this.showImagePreviewOverlay(dataUrl);
			});
			strip.appendChild(thumb);
		}

		return strip;
	}

	/**
	 * Renders the post-apply summary card: a one-line header with the file count and an
	 * Undo (or Redo, when the apply has been undone) action, followed by one row per modified
	 * file showing the relative path, +N/-N stats, and a Review action that opens the file.
	 * The card is intentionally compact so it fits inside the chat transcript without dominating
	 * the column. The diff rows stay visible across an undo+redo cycle so the user can always
	 * see exactly which lines were touched.
	 */
	private renderEditApplySummary(
		target: IAssistantApplyTarget,
		state:
			| {
				readonly phase: "applied" | "undone";
				readonly result: IVSCloneEditApplyResult;
			}
			| {
				readonly phase: "partial";
				readonly result: IVSCloneEditApplyResult;
				readonly retryAction: "apply" | "undo";
			},
	): HTMLElement {
		const applyResult = state.result;
		const card = document.createElement("div");
		card.className = "vsclone-edit-apply-summary";
		card.classList.add(`phase-${state.phase}`);

		const header = document.createElement("div");
		header.className = "vsclone-edit-apply-summary-header";
		const fileCountLabel = document.createElement("span");
		fileCountLabel.className = "vsclone-edit-apply-summary-count";
		fileCountLabel.textContent = applyResult.fileChanges.length === 1
			? localize("vsclone.thread.assistant.apply.fileCount.one", "1 file changed")
			: localize(
				"vsclone.thread.assistant.apply.fileCount.many",
				"{0} files changed",
				applyResult.fileChanges.length.toString(),
			);
		header.appendChild(fileCountLabel);

		const actionButton = document.createElement("button");
		actionButton.type = "button";
		actionButton.className = "vsclone-edit-apply-summary-undo";
		const threadBusy = this.isThreadBusy(target.threadId);
		const actionLabel = document.createElement("span");
		const actionIcon = document.createElement("span");
		actionIcon.className = "codicon vsclone-edit-apply-summary-undo-icon";
		actionIcon.setAttribute("aria-hidden", "true");
		if (state.phase === "applied") {
			actionLabel.textContent = localize("vsclone.thread.assistant.apply.undo", "Undo");
			actionIcon.classList.add("codicon-discard");
			actionButton.addEventListener(EventType.CLICK, () => {
				void this.undoAssistantEdits(target, applyResult, actionButton);
			});
		} else if (state.phase === "undone") {
			actionLabel.textContent = localize("vsclone.thread.assistant.apply.redo", "Redo");
			actionIcon.classList.add("codicon-redo");
			actionButton.addEventListener(EventType.CLICK, () => {
				void this.redoAssistantEdits(target, actionButton);
			});
		} else if (state.phase === "partial" && state.retryAction === "undo") {
			actionLabel.textContent = localize("vsclone.thread.assistant.apply.retryUndo", "Retry Undo");
			actionIcon.classList.add("codicon-discard");
			actionButton.addEventListener(EventType.CLICK, () => {
				void this.undoAssistantEdits(target, applyResult, actionButton);
			});
			actionButton.classList.add("partial");
			actionButton.title = localize(
				"vsclone.thread.assistant.apply.partialUndoTooltip",
				"Some changes remain applied. Retry undo for the remaining files.",
			);
		} else {
			actionLabel.textContent = localize("vsclone.thread.assistant.apply.retryApply", "Retry Apply");
			actionIcon.classList.add("codicon-redo");
			actionButton.addEventListener(EventType.CLICK, () => {
				void this.redoAssistantEdits(target, actionButton);
			});
			actionButton.classList.add("partial");
			actionButton.title = localize(
				"vsclone.thread.assistant.apply.partialApplyTooltip",
				"Some edits applied and some failed. Retry apply for the remaining files.",
			);
		}
		if (threadBusy) {
			// Edit actions are intentionally serialized behind the runtime state machine so the pane
			// never mutates workspace files while the assistant is still producing more thread output.
			actionButton.disabled = true;
			actionButton.title = localize(
				"vsclone.thread.assistant.apply.busyActionTooltip",
				"Wait for the assistant to finish before changing applied edits.",
			);
		}
		actionButton.appendChild(actionLabel);
		actionButton.appendChild(actionIcon);
		header.appendChild(actionButton);

		card.appendChild(header);

		for (const change of applyResult.fileChanges) {
			card.appendChild(this.renderEditApplySummaryFileRow(change));
		}

		return card;
	}

	private appendAssistantApplyControls(
		item: HTMLElement,
		target: IAssistantApplyTarget,
	): void {
		const state = this.getAssistantApplyState(target);
		if (state?.phase === "applied" || state?.phase === "undone" || state?.phase === "partial") {
			item.appendChild(this.renderEditApplySummary(target, state));
			return;
		}
		if (state?.phase === "pending") {
			const pendingIndicator = document.createElement("div");
			pendingIndicator.className = "vsclone-thread-message-apply pending";
			pendingIndicator.textContent = localize(
				"vsclone.thread.assistant.apply.applyingAuto",
				"Applying changes...",
			);
			item.appendChild(pendingIndicator);
			return;
		}
		if (state?.phase === "failed") {
			item.appendChild(this.createAssistantApplyButton(target));
			return;
		}
		const runtimeState = this.getThreadRuntimeState(target.threadId);
		const assistantMessage = runtimeState?.messages.find(
			(
				message,
			): message is Extract<
				IVSCloneThreadRuntimeMessage,
				{ readonly role: 'assistant' }
			> => message.role === 'assistant' && message.id === target.id,
		);
		if (assistantMessage && this.isManualOnlyRuntimeAssistantApplyMessage(assistantMessage)) {
			item.appendChild(this.createAssistantApplyButton(target));
		}
	}

	private createAssistantApplyButton(target: IAssistantApplyTarget): HTMLButtonElement {
		const applyButton = document.createElement("button");
		applyButton.type = "button";
		applyButton.className = "vsclone-thread-message-apply";
		applyButton.textContent = localize(
			"vsclone.thread.assistant.apply",
			"Apply Changes",
		);
		if (this.isThreadBusy(target.threadId)) {
			// Imported/manual apply must still render immediately, but the button stays disabled until
			// the runtime goes idle so the assistant cannot race the edit engine mid-run.
			applyButton.disabled = true;
			applyButton.title = localize(
				"vsclone.thread.assistant.apply.busyTooltip",
				"Wait for the assistant to finish before applying changes.",
			);
		}
		applyButton.addEventListener(EventType.CLICK, () => {
			void this.applyAssistantEdits(target, applyButton);
		});
		return applyButton;
	}

	private renderEditApplySummaryFileRow(change: IVSCloneEditFileChange): HTMLElement {
		const row = document.createElement("div");
		row.className = "vsclone-edit-apply-summary-file";

		const pathLabel = document.createElement("span");
		pathLabel.className = "vsclone-edit-apply-summary-file-path";
		pathLabel.textContent = change.displayPath;
		pathLabel.title = change.uri.toString();
		row.appendChild(pathLabel);

		const stats = document.createElement("span");
		stats.className = "vsclone-edit-apply-summary-file-stats";
		const added = document.createElement("span");
		added.className = "vsclone-edit-apply-summary-file-added";
		added.textContent = `+${change.addedLines}`;
		stats.appendChild(added);
		const removed = document.createElement("span");
		removed.className = "vsclone-edit-apply-summary-file-removed";
		removed.textContent = `-${change.removedLines}`;
		stats.appendChild(removed);
		row.appendChild(stats);

		const reviewButton = document.createElement("button");
		reviewButton.type = "button";
		reviewButton.className = "vsclone-edit-apply-summary-review";
		const reviewLabel = document.createElement("span");
		reviewLabel.textContent = localize("vsclone.thread.assistant.apply.review", "Review");
		reviewButton.appendChild(reviewLabel);
		const reviewIcon = document.createElement("span");
		reviewIcon.className = "codicon codicon-arrow-right vsclone-edit-apply-summary-review-icon";
		reviewIcon.setAttribute("aria-hidden", "true");
		reviewButton.appendChild(reviewIcon);
		reviewButton.addEventListener(EventType.CLICK, () => {
			void this.editorService.openEditor({ resource: change.uri });
		});
		row.appendChild(reviewButton);

		return row;
	}

	private async undoAssistantEdits(
		target: IAssistantApplyTarget,
		applyResult: IVSCloneEditApplyResult,
		button: HTMLButtonElement,
	): Promise<void> {
		if (this.refuseBusyAssistantApplyAction(target.threadId, "undo")) {
			return;
		}
		button.disabled = true;
		try {
			const undoResult = await this.editCodeService.undoEditApply(applyResult.fileChanges);
			if (undoResult.failures.length > 0 && undoResult.revertedFiles.length === 0) {
				this.notificationService.warn(
					localize(
						"vsclone.thread.assistant.apply.undo.failed",
						"Could not undo all changes: {0}",
						undoResult.failures[0],
					),
				);
				return;
			}
			if (undoResult.failures.length > 0) {
				// Some files reverted and some did not. Keep the original apply summary visible with a
				// retry-undo action so the pane reflects that the workspace is only partially restored.
				this.setAssistantApplyState(target, { phase: "partial", result: applyResult, retryAction: "undo" });
				this.notificationService.warn(
					localize(
						"vsclone.thread.assistant.apply.undo.partial",
						"Reverted {0} file(s), but some changes could not be undone.",
						undoResult.revertedFiles.length,
					),
				);
				this.refreshConversation();
				return;
			}

			// Keep the same apply result on the state so the diff card stays in place; only the
			// phase flips, which causes the renderer to swap Undo for Redo.
			this.setAssistantApplyState(target, { phase: "undone", result: applyResult });
			this.notificationService.info(
				localize(
					"vsclone.thread.assistant.apply.undo.success",
					"Reverted {0} file(s).",
					undoResult.revertedFiles.length,
				),
			);
			this.refreshConversation();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.notificationService.error(
				localize(
					"vsclone.thread.assistant.apply.undo.error",
					"Failed to undo suggested changes: {0}",
					message,
				),
			);
		} finally {
			if (button.isConnected) {
				button.disabled = false;
			}
		}
	}

	private async redoAssistantEdits(
		target: IAssistantApplyTarget,
		button: HTMLButtonElement,
	): Promise<void> {
		const responseText = target.responseText;
		if (!responseText) {
			return;
		}
		if (this.refuseBusyAssistantApplyAction(target.threadId, "redo")) {
			return;
		}
		button.disabled = true;
		try {
			const applyResult = await this.editCodeService.startApplyingSearchReplaceBlocks(responseText);
			if (applyResult.appliedEdits > 0 && applyResult.failures.length > 0) {
				this.setAssistantApplyState(target, { phase: "partial", result: applyResult, retryAction: "apply" });
				this.notificationService.warn(
					localize(
						"vsclone.thread.assistant.apply.redo.partial",
						"Re-applied {0} edit(s), but some changes still need attention.",
						applyResult.appliedEdits,
					),
				);
				this.refreshConversation();
				return;
			}
			if (applyResult.appliedEdits === 0) {
				const failureDetails = applyResult.failures[0] ?? localize(
					"vsclone.thread.assistant.apply.noChanges.reason",
					"No matching SEARCH block was found.",
				);
				this.notificationService.warn(
					localize(
						"vsclone.thread.assistant.apply.redo.failed",
						"Could not redo changes. {0}",
						failureDetails,
					),
				);
				return;
			}

			this.setAssistantApplyState(target, { phase: "applied", result: applyResult });
			this.notificationService.info(
				localize(
					"vsclone.thread.assistant.apply.redo.success",
					"Re-applied {0} edit(s) across {1} file(s).",
					applyResult.appliedEdits,
					applyResult.modifiedFiles.length,
				),
			);
			this.refreshConversation();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.notificationService.error(
				localize(
					"vsclone.thread.assistant.apply.redo.error",
					"Failed to redo suggested changes: {0}",
					message,
				),
			);
		} finally {
			if (button.isConnected) {
				button.disabled = false;
			}
		}
	}

	/**
	 * Turns transcript text into a whitespace-insensitive comparison key so restored summaries can
	 * be matched even when markdown serialization changed line wrapping between iterations.
	 */
	/**
	 * Renders a tool call and its result as a paired card with an icon, status, and optional
	 * collapsible output or diff card.
	 */
	private renderToolCard(
		toolName: string,
		displayMessage: string,
		status: "running" | "complete" | "success" | "error",
		output: string | undefined,
		diffCard: HTMLElement | undefined,
		actions?: HTMLElement,
	): HTMLElement {
		const card = document.createElement("div");
		card.className = "vsclone-tool-card";
		card.classList.add(`status-${status}`);

		const header = document.createElement("div");
		header.className = "vsclone-tool-card-header";

		const icon = document.createElement("span");
		icon.className = `codicon vsclone-tool-card-icon ${this.getToolIconClass(toolName)}`;
		header.appendChild(icon);

		const label = document.createElement("span");
		label.className = "vsclone-tool-card-label";
		label.textContent = displayMessage;
		header.appendChild(label);

		const statusBadge = document.createElement("span");
		statusBadge.className = "vsclone-tool-card-status";
		switch (status) {
			case "running":
				statusBadge.classList.add(
					"codicon",
					"codicon-loading",
					"codicon-modifier-spin",
				);
				break;
			case "success":
				statusBadge.classList.add("codicon", "codicon-check");
				break;
			case "error":
				statusBadge.classList.add("codicon", "codicon-error");
				break;
			case "complete":
				statusBadge.classList.add("codicon", "codicon-check");
				break;
		}
		header.appendChild(statusBadge);

		card.appendChild(header);

		// Attach diff card if present
		if (diffCard) {
			card.appendChild(diffCard);
		} else if (output?.trim()) {
			// Tool output is frequently the only evidence that a read/list/search step behaved
			// correctly, so render it inline instead of collapsing it to a status-only card.
			this.appendMarkdownSegment(card, output, "vsclone-tool-card-output");
		}
		if (actions) {
			card.appendChild(actions);
		}

		return card;
	}

	/**
	 * Route transcript markdown through the shared renderer so summaries and tool outputs retain
	 * lists, code fences, and links instead of flattening into raw text.
	 */
	private appendMarkdownSegment(
		container: HTMLElement,
		markdownText: string,
		className: string,
	): void {
		if (!markdownText.trim()) {
			return;
		}

		const segment = document.createElement("div");
		segment.className = className;
		container.appendChild(segment);

		if (!this.markdownRendererService) {
			segment.textContent = markdownText;
			return;
		}

		const rendered = this.markdownRendererService.render(
			new MarkdownString(markdownText),
			{
				markedOptions: {
					breaks: true,
					gfm: true,
				},
			},
			segment,
		);
		this.renderedMarkdownDisposables.add(rendered);
	}

	/**
	 * Checks whether the text ends with what looks like the beginning of a search/replace block
	 * that hasn't been completed yet (e.g. a trailing `File: xxx` followed by a partial
	 * `<<<<<<< SEARCH` marker or search content without a closing `>>>>>>> REPLACE`).
	 */
	private looksLikePartialSearchReplaceBlock(text: string): boolean {
		const normalized = text.replace(/\r\n/g, '\n');
		// Look for a File: line near the end followed by partial SEARCH block content
		const trailingPattern = /(?:^|\n)(?:[*-]\s*)?File:\s*.+(?:\n[\s\S]*)?$/;
		const trailingMatch = normalized.match(trailingPattern);
		if (!trailingMatch) {
			return false;
		}
		const trailing = normalized.slice(trailingMatch.index!);
		// Must have at least a File: line and either partial or no SEARCH marker
		return /(?:^|\n)(?:[*-]\s*)?File:\s*.+/i.test(trailing) &&
			(trailing.includes('<') || trailing.includes('<<<<<<< SEARCH')) &&
			!trailing.includes('>>>>>>> REPLACE');
	}

	/**
	 * Renders response text that contains search/replace blocks. Completed blocks
	 * are shown as diff cards; any in-progress block shows an "Editing..." indicator.
	 * Prose text between blocks is rendered as markdown.
	 */
	private renderSearchReplaceAwareText(
		container: HTMLElement,
		text: string,
		streaming: boolean,
	): void {
		const normalized = text.replace(/\r\n/g, '\n');

		// Match complete SEARCH/REPLACE blocks
		const blockPattern = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;

		interface IBlockRegion {
			/** Start of the File: line (or block marker if no File: line found) */
			readonly regionStart: number;
			/** End of the >>>>>>> REPLACE line */
			readonly regionEnd: number;
			readonly filePath: string;
			readonly searchText: string;
			readonly replaceText: string;
		}

		const blocks: IBlockRegion[] = [];
		let match: RegExpExecArray | null;

		while ((match = blockPattern.exec(normalized)) !== null) {
			// Walk backwards from the block start to find the File: line
			let regionStart = match.index;
			const before = normalized.slice(0, match.index);
			const lines = before.split('\n');
			for (let i = lines.length - 1; i >= 0; i--) {
				const line = lines[i].trim();
				if (!line) {
					continue;
				}
				if (/^(?:[*-]\s*)?File:\s*.+$/i.test(line)) {
					regionStart = before.lastIndexOf(lines[i]);
				}
				break;
			}

			// Extract the file path
			const beforeBlock = normalized.slice(regionStart, match.index);
			const fileMatch = beforeBlock.match(/(?:^|\n)(?:[*-]\s*)?File:\s*(.+?)[\t ]*(?:\n|$)/i);
			const filePath = fileMatch?.[1]?.trim() ?? '';

			blocks.push({
				regionStart,
				regionEnd: match.index + match[0].length,
				filePath,
				searchText: match[1],
				replaceText: match[2],
			});
		}

		// Build interleaved segments
		let cursor = 0;
		for (const block of blocks) {
			const prose = normalized.slice(cursor, block.regionStart).trim();
			if (prose) {
				this.appendMarkdownSegment(container, prose, "vsclone-thread-message-text-segment");
			}
			container.appendChild(
				this.renderSearchReplaceDiffCard(block.filePath, block.searchText, block.replaceText),
			);
			cursor = block.regionEnd;
		}

		// Handle remaining text after the last complete block
		const remaining = normalized.slice(cursor);

		if (streaming) {
			// Detect trailing partial block (File: line + incomplete SEARCH block)
			const partialPattern = /(?:^|\n)((?:[*-]\s*)?File:\s*(.+?)[\t ]*)\n(?:(?:<{1,7}[\s\S]*)|(?:<<<<<<< SEARCH[\s\S]*))$/;
			const partialMatch = remaining.match(partialPattern);
			if (partialMatch && !remaining.slice(remaining.indexOf(partialMatch[0])).includes('>>>>>>> REPLACE')) {
				const proseBeforePartial = remaining.slice(0, partialMatch.index! + (remaining[partialMatch.index!] === '\n' ? 1 : 0)).trim();
				if (proseBeforePartial) {
					this.appendMarkdownSegment(container, proseBeforePartial, "vsclone-thread-message-text-segment");
				}

				const fileName = partialMatch[2]?.trim();
				const indicator = document.createElement("div");
				indicator.className = "vsclone-streaming-edit-indicator";

				const icon = document.createElement("span");
				icon.className = "codicon codicon-loading codicon-modifier-spin";
				indicator.appendChild(icon);

				const label = document.createElement("span");
				label.textContent = fileName
					? localize("vsclone.thread.assistant.editingFile", "Editing {0}...", fileName)
					: localize("vsclone.thread.assistant.editing", "Editing...");
				indicator.appendChild(label);

				container.appendChild(indicator);
				return;
			}
		}

		// Render any remaining prose (strip stray File: lines that aren't followed by blocks)
		const strippedRemaining = remaining.replace(/(?:^|\n)(?:[*-]\s*)?File:\s*.+[\t ]*(?:\n|$)/gi, '\n').trim();
		if (strippedRemaining) {
			this.appendMarkdownSegment(container, strippedRemaining, "vsclone-thread-message-text-segment");
		}
	}

	/**
	 * Renders a search/replace block as a compact diff card showing removed and added lines.
	 */
	private renderSearchReplaceDiffCard(
		filePath: string,
		searchText: string,
		replaceText: string,
	): HTMLElement {
		const card = document.createElement("div");
		card.className = "vsclone-tool-diff-card";

		// Title bar
		const titleBar = document.createElement("div");
		titleBar.className = "vsclone-tool-diff-title";

		const filename = filePath.split('/').pop() ?? filePath;
		const langLabel = this.getLanguageLabelFromFilename(filename);
		const langTag = document.createElement("span");
		langTag.className = "vsclone-tool-diff-title-lang-tag";
		const langColorClass = LANG_TAG_COLOR_CLASS[langLabel];
		if (langColorClass) {
			langTag.classList.add(langColorClass);
		}
		langTag.textContent = langLabel;
		titleBar.appendChild(langTag);

		const fileLabel = document.createElement("span");
		fileLabel.className = "vsclone-tool-diff-title-filename";
		fileLabel.textContent = filename;
		fileLabel.title = filePath;
		titleBar.appendChild(fileLabel);

		card.appendChild(titleBar);

		// Diff body
		const body = document.createElement("div");
		body.className = "vsclone-tool-diff-body";

		const searchLines = searchText.split('\n');
		const replaceLines = replaceText.split('\n');

		for (const line of searchLines) {
			const lineEl = document.createElement("div");
			lineEl.className = "vsclone-tool-diff-line removed";

			const content = document.createElement("span");
			content.textContent = line;
			lineEl.appendChild(content);

			body.appendChild(lineEl);
		}

		for (const line of replaceLines) {
			const lineEl = document.createElement("div");
			lineEl.className = "vsclone-tool-diff-line added";

			const content = document.createElement("span");
			content.textContent = line;
			lineEl.appendChild(content);

			body.appendChild(lineEl);
		}

		card.appendChild(body);
		return card;
	}

	private getToolIconClass(toolName: string): string {
		const lower = toolName.toLowerCase();
		if (lower.includes("read") || lower.includes("Read")) {
			return "codicon-file";
		}
		if (
			lower.includes("edit") ||
			lower.includes("Edit") ||
			lower.includes("write") ||
			lower.includes("Write")
		) {
			return "codicon-edit";
		}
		if (lower.includes("create") || lower.includes("Create")) {
			return "codicon-new-file";
		}
		if (
			lower.includes("run") ||
			lower.includes("exec") ||
			lower.includes("command") ||
			lower.includes("terminal")
		) {
			return "codicon-terminal";
		}
		if (
			lower.includes("search") ||
			lower.includes("grep") ||
			lower.includes("find")
		) {
			return "codicon-search";
		}
		if (lower.includes("completion") || lower.includes("attempt")) {
			return "codicon-sparkle";
		}
		if (lower.includes("delete") || lower.includes("remove")) {
			return "codicon-trash";
		}
		if (lower.includes("list") || lower.includes("ls")) {
			return "codicon-list-tree";
		}
		return "codicon-tools";
	}

	/**
	 * Extracts a filename from diff content by looking for `---` and `+++` header lines.
	 */
	private extractFilenameFromDiff(diff: string): string | undefined {
		for (const line of diff.split("\n")) {
			if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
				const path = line.slice(4).trim();
				// Strip leading a/ or b/ prefix from git diffs
				return path.replace(/^[ab]\//, "");
			}
		}
		return undefined;
	}

	/**
	 * Guesses a file's language from its extension for use in the title bar label.
	 */
	private getLanguageLabelFromFilename(filename: string): string {
		const ext = filename.split(".").pop()?.toLowerCase() ?? "";
		const languageMap: Record<string, string> = {
			ts: "TS",
			tsx: "TSX",
			js: "JS",
			jsx: "JSX",
			css: "CSS",
			scss: "SCSS",
			html: "HTML",
			json: "JSON",
			md: "MD",
			py: "PY",
			rs: "RS",
			go: "GO",
			java: "JAVA",
			c: "C",
			cpp: "C++",
			h: "H",
			cs: "C#",
			rb: "RB",
			yaml: "YAML",
			yml: "YAML",
			toml: "TOML",
			xml: "XML",
			svg: "SVG",
			sh: "SH",
			bash: "SH",
			zsh: "SH",
			sql: "SQL",
			vue: "VUE",
			svelte: "SVELTE",
		};
		return languageMap[ext] ?? ext.toUpperCase();
	}

	/**
	 * Applies basic syntax highlighting to a code string by wrapping recognized tokens
	 * in spans with appropriate CSS classes.
	 */
	private syntaxHighlightLine(code: string): HTMLSpanElement {
		const container = document.createElement("span");
		// Strip leading +/- diff prefix for highlighting purposes, but preserve it visually
		let prefix = "";
		let strippedCode = code;
		if (code.startsWith("+") && !code.startsWith("+++")) {
			prefix = "+";
			strippedCode = code.slice(1);
		} else if (code.startsWith("-") && !code.startsWith("---")) {
			prefix = "-";
			strippedCode = code.slice(1);
		}

		if (prefix) {
			const prefixSpan = document.createElement("span");
			prefixSpan.textContent = prefix;
			container.appendChild(prefixSpan);
		}

		// Tokenize using regex patterns
		const tokenRules: Array<{ pattern: RegExp; tokenClass: string }> = [
			{ pattern: /\/\/.*$/gm, tokenClass: "vsclone-token-comment" },
			{ pattern: /\/\*[\s\S]*?\*\//g, tokenClass: "vsclone-token-comment" },
			{ pattern: /#.*$/gm, tokenClass: "vsclone-token-comment" },
			{
				pattern: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
				tokenClass: "vsclone-token-string",
			},
			{
				pattern:
					/\b(?:import|export|from|const|let|var|function|return|if|else|for|while|class|extends|interface|type|enum|async|await|new|this|super|typeof|instanceof|in|of|try|catch|throw|finally|switch|case|default|break|continue|yield|do|void|delete|with|as|is|readonly|declare|abstract|implements|namespace|module|require|public|private|protected|static|get|set|constructor)\b/g,
				tokenClass: "vsclone-token-keyword",
			},
			{
				pattern: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
				tokenClass: "vsclone-token-number",
			},
			{
				pattern: /\b(?:true|false|null|undefined|NaN|Infinity)\b/g,
				tokenClass: "vsclone-token-keyword",
			},
			{ pattern: /[{}()[\];,.:]/g, tokenClass: "vsclone-token-punctuation" },
			{ pattern: /[+\-*/%=<>!&|^~?@]/g, tokenClass: "vsclone-token-operator" },
		];

		// Build a combined regex that captures each token type
		type TokenMatch = {
			index: number;
			length: number;
			text: string;
			tokenClass: string;
		};
		const matches: TokenMatch[] = [];
		for (const rule of tokenRules) {
			const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
			let match: RegExpExecArray | null;
			while ((match = regex.exec(strippedCode)) !== null) {
				matches.push({
					index: match.index,
					length: match[0].length,
					text: match[0],
					tokenClass: rule.tokenClass,
				});
			}
		}

		// Sort by position and remove overlapping matches (earlier/longer wins)
		matches.sort((a, b) => a.index - b.index || b.length - a.length);
		const filtered: TokenMatch[] = [];
		let lastEnd = 0;
		for (const m of matches) {
			if (m.index >= lastEnd) {
				filtered.push(m);
				lastEnd = m.index + m.length;
			}
		}

		// Render tokens
		let cursor = 0;
		for (const m of filtered) {
			if (m.index > cursor) {
				container.appendChild(
					document.createTextNode(strippedCode.slice(cursor, m.index)),
				);
			}
			const tokenSpan = document.createElement("span");
			tokenSpan.className = m.tokenClass;
			tokenSpan.textContent = m.text;
			container.appendChild(tokenSpan);
			cursor = m.index + m.length;
		}
		if (cursor < strippedCode.length) {
			container.appendChild(
				document.createTextNode(strippedCode.slice(cursor)),
			);
		}

		return container;
	}

	/**
	 * Extracts a file:// URI from the tool result summary text.
	 */
	private extractFileUriFromSummary(summary: string): string | undefined {
		// Allow dots within the path (e.g., styles.css) but strip a trailing dot
		// that is likely sentence punctuation rather than part of the filename.
		const match = /file:\/\/\/[^\s,)]+/.exec(summary);
		if (!match) {
			return undefined;
		}
		// Remove trailing period if it looks like end-of-sentence punctuation
		return match[0].replace(/\.$/, "");
	}

	/**
	 * Unified hunk headers carry the modified-side line numbers that the transcript uses for
	 * both display and navigation. If the tool output predates that metadata, we skip line UI
	 * instead of guessing and sending the user to the wrong place.
	 */
	private parseUnifiedDiffHunkHeader(
		line: string,
	): IUnifiedDiffHunkHeader | undefined {
		const match = /^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/.exec(
			line,
		);
		if (!match) {
			return undefined;
		}

		return {
			originalStartLineNumber: parseInt(match[1], 10),
			originalLineCount: parseInt(match[2] ?? "1", 10),
			modifiedStartLineNumber: parseInt(match[3], 10),
			modifiedLineCount: parseInt(match[4] ?? "1", 10),
		};
	}

	/**
	 * The transcript only needs lightweight diff semantics: enough to paint the hunk and to map
	 * visible rows back to the modified file. Removed rows intentionally point at the nearest
	 * surviving modified line because that is where the user lands after the edit has applied.
	 */
	private buildRenderedDiffLines(diff: string): {
		readonly lines: readonly IRenderedToolDiffLine[];
		readonly titleNavigation: IDiffLineNavigationState;
	} {
		const renderedLines: IRenderedToolDiffLine[] = [];
		let originalLineNumber: number | undefined;
		let modifiedLineNumber: number | undefined;
		const titleNavigation: IDiffLineNavigationState = {};
		const diffLines = diff.split("\n");

		for (
			let sourceLineIndex = 0;
			sourceLineIndex < diffLines.length;
			sourceLineIndex++
		) {
			const rawLine = diffLines[sourceLineIndex];
			if (rawLine.startsWith("@@")) {
				const hunkHeader = this.parseUnifiedDiffHunkHeader(rawLine);
				originalLineNumber = hunkHeader?.originalStartLineNumber;
				modifiedLineNumber = hunkHeader?.modifiedStartLineNumber;
				if (hunkHeader) {
					titleNavigation.startLineNumber ??=
						hunkHeader.modifiedStartLineNumber;
					const hunkEndLineNumber =
						hunkHeader.modifiedStartLineNumber +
						Math.max(1, hunkHeader.modifiedLineCount) -
						1;
					titleNavigation.endLineNumber =
						titleNavigation.endLineNumber !== undefined
							? Math.max(titleNavigation.endLineNumber, hunkEndLineNumber)
							: hunkEndLineNumber;
				}
				renderedLines.push({
					sourceLineIndex,
					rawText: rawLine,
					kind: "hunk",
					navigationLineNumber: hunkHeader?.modifiedStartLineNumber,
				});
				continue;
			}

			if (rawLine.startsWith("---") || rawLine.startsWith("+++")) {
				renderedLines.push({ sourceLineIndex, rawText: rawLine, kind: "file" });
				continue;
			}

			if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
				const navigationLineNumber = modifiedLineNumber;
				titleNavigation.startLineNumber ??= navigationLineNumber;
				if (navigationLineNumber !== undefined) {
					titleNavigation.endLineNumber =
						titleNavigation.endLineNumber !== undefined
							? Math.max(titleNavigation.endLineNumber, navigationLineNumber)
							: navigationLineNumber;
				}
				renderedLines.push({
					sourceLineIndex,
					rawText: rawLine,
					kind: "added",
					navigationLineNumber,
				});
				if (modifiedLineNumber !== undefined) {
					modifiedLineNumber += 1;
				}
				continue;
			}

			if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
				renderedLines.push({
					sourceLineIndex,
					rawText: rawLine,
					kind: "removed",
					navigationLineNumber: modifiedLineNumber,
				});
				if (originalLineNumber !== undefined) {
					originalLineNumber += 1;
				}
				continue;
			}

			const navigationLineNumber = modifiedLineNumber;
			titleNavigation.startLineNumber ??= navigationLineNumber;
			if (navigationLineNumber !== undefined) {
				titleNavigation.endLineNumber =
					titleNavigation.endLineNumber !== undefined
						? Math.max(titleNavigation.endLineNumber, navigationLineNumber)
						: navigationLineNumber;
			}
			renderedLines.push({
				sourceLineIndex,
				rawText: rawLine,
				kind: "context",
				navigationLineNumber,
			});
			if (originalLineNumber !== undefined) {
				originalLineNumber += 1;
			}
			if (modifiedLineNumber !== undefined) {
				modifiedLineNumber += 1;
			}
		}

		return { lines: renderedLines, titleNavigation };
	}

	private openDiffTarget(
		fileUri: string,
		navigation: IDiffLineNavigationState,
	): void {
		const resource = URI.parse(fileUri);
		const sanitizedStartLineNumber =
			navigation.startLineNumber !== undefined
				? Math.max(1, navigation.startLineNumber)
				: undefined;
		const sanitizedEndLineNumber =
			navigation.endLineNumber !== undefined
				? Math.max(sanitizedStartLineNumber ?? 1, navigation.endLineNumber)
				: sanitizedStartLineNumber;
		this.editorService
			.openEditor({
				resource,
				options: sanitizedStartLineNumber
					? {
						selection: {
							startLineNumber: sanitizedStartLineNumber,
							startColumn: 1,
							endLineNumber:
								sanitizedEndLineNumber ?? sanitizedStartLineNumber,
							endColumn: 1,
						},
					}
					: undefined,
			})
			.catch(() => {
				/* ignore */
			});
	}

	private renderToolResultDiffCard(
		toolName: string,
		output: string,
	): HTMLElement | undefined {
		const parsedDiff = parseToolResultDiff(output);
		if (!parsedDiff) {
			return undefined;
		}

		const card = document.createElement("div");
		card.className = "vsclone-tool-diff-card";

		const titleBar = document.createElement("div");
		titleBar.className = "vsclone-tool-diff-title";

		const filename = this.extractFilenameFromDiff(parsedDiff.diff);
		const fileUri = parsedDiff.summary
			? this.extractFileUriFromSummary(parsedDiff.summary)
			: undefined;
		const renderedDiff = this.buildRenderedDiffLines(parsedDiff.diff);
		const titleNavigation: IDiffLineNavigationState = {
			...renderedDiff.titleNavigation,
		};

		let addedCount = 0;
		let removedCount = 0;
		for (const renderedLine of renderedDiff.lines) {
			if (renderedLine.kind === "added") { addedCount++; }
			else if (renderedLine.kind === "removed") { removedCount++; }
		}

		if (filename) {
			const langLabel = this.getLanguageLabelFromFilename(filename);
			const langTag = document.createElement("span");
			langTag.className = "vsclone-tool-diff-title-lang-tag";
			const langColorClass = LANG_TAG_COLOR_CLASS[langLabel];
			if (langColorClass) {
				langTag.classList.add(langColorClass);
			}
			langTag.textContent = langLabel;
			titleBar.appendChild(langTag);

			// Make the filename a clickable link that opens the file
			const fileLabel = document.createElement("a");
			fileLabel.className = "vsclone-tool-diff-title-filename";
			fileLabel.textContent = filename;
			fileLabel.title =
				titleNavigation.startLineNumber !== undefined
					? localize(
						"vsclone.thread.toolDiff.openAtLineTitle",
						"Open {0} at line {1}",
						filename,
						titleNavigation.startLineNumber.toString(),
					)
					: (fileUri ?? filename);
			if (fileUri) {
				fileLabel.href = "#";
				fileLabel.addEventListener("click", (e) => {
					e.preventDefault();
					this.openDiffTarget(fileUri, titleNavigation);
				});
				fileLabel.style.cursor = "pointer";
			}
			titleBar.appendChild(fileLabel);

			if (addedCount > 0 || removedCount > 0) {
				const stats = document.createElement("span");
				stats.className = "vsclone-tool-diff-title-stats";
				if (addedCount > 0) {
					const added = document.createElement("span");
					added.className = "vsclone-tool-diff-title-stats-added";
					added.textContent = `+${addedCount}`;
					stats.appendChild(added);
				}
				if (removedCount > 0) {
					const removed = document.createElement("span");
					removed.className = "vsclone-tool-diff-title-stats-removed";
					removed.textContent = `-${removedCount}`;
					stats.appendChild(removed);
				}
				titleBar.appendChild(stats);
			}
		} else {
			const label = document.createElement("span");
			label.className = "vsclone-tool-diff-title-filename";
			switch (toolName) {
				case "edit_file":
					label.textContent = localize(
						"vsclone.thread.toolDiff.editedTitle",
						"Applied file edits",
					);
					break;
				case "create_file":
					label.textContent = localize(
						"vsclone.thread.toolDiff.createdTitle",
						"Created file",
					);
					break;
				default:
					label.textContent = localize(
						"vsclone.thread.toolDiff.genericTitle",
						"Applied workspace change",
					);
					break;
			}
			titleBar.appendChild(label);
		}

		card.appendChild(titleBar);

		const body = document.createElement("div");
		body.className = "vsclone-tool-diff-body";
		for (const diffLine of renderedDiff.lines) {
			const line = document.createElement("div");
			line.className = "vsclone-tool-diff-line";
			const lineNavigation: IDiffLineNavigationState = {
				startLineNumber: diffLine.navigationLineNumber,
				endLineNumber: diffLine.navigationLineNumber,
			};
			if (
				diffLine.kind === "added" ||
				diffLine.kind === "removed" ||
				diffLine.kind === "hunk" ||
				diffLine.kind === "file"
			) {
				line.classList.add(diffLine.kind);
			}

			// Syntax-highlighted content keeps the diff prefix visible; the line gutter has been
			// removed from the flat diff card to match the Codex-style inline preview.
			if (diffLine.kind !== "file") {
				line.appendChild(this.syntaxHighlightLine(diffLine.rawText));
			}

			if (fileUri && diffLine.kind !== "hunk" && diffLine.kind !== "file") {
				if (lineNavigation.startLineNumber !== undefined) {
					line.classList.add("clickable");
					line.title = localize(
						"vsclone.thread.toolDiff.openChangedLineTitle",
						"Open changed line {0}",
						lineNavigation.startLineNumber.toString(),
					);
				}
				line.addEventListener("click", () => {
					if (lineNavigation.startLineNumber !== undefined) {
						this.openDiffTarget(fileUri, lineNavigation);
					}
				});
			}

			body.appendChild(line);
		}
		card.appendChild(body);
		return card;
	}

	/**
	 * Durable assistant-apply summaries are runtime-owned and keyed by assistant message id. The
	 * pane reads that branch-aware state through the public runtime API. `pending` is mirrored both
	 * locally and durably so a reload can distinguish "interrupted while applying" from "never
	 * started", while the local set still prevents duplicate work in the current browser session.
	 */
	private getAssistantApplyState(
		target: IAssistantApplyTarget,
	): EditApplyState | undefined {
		if (this.pendingAssistantApplyMessageIds.has(target.id)) {
			return { phase: "pending" };
		}
		const runtimeState = this.getThreadRuntimeState(target.threadId);
		const directState = this.threadRuntimeService?.getAssistantEditApplicationState?.(target.threadId, target.id);
		if (directState) {
			return directState as EditApplyState;
		}
		const listedState = runtimeState?.assistantEditApplications?.find(entry => entry.messageId === target.id)?.state;
		return listedState as EditApplyState | undefined;
	}

	private setAssistantApplyState(
		target: IAssistantApplyTarget,
		state: EditApplyState,
	): void {
		if (state.phase === "pending") {
			this.pendingAssistantApplyMessageIds.add(target.id);
		} else {
			this.pendingAssistantApplyMessageIds.delete(target.id);
		}
		this.threadRuntimeService.setAssistantEditApplicationState?.(
			target.threadId,
			target.id,
			state as never,
		);
	}

	/**
	 * Active edit application is runtime-owned. The pane only consumes the durable assistant
	 * edit-suggestion metadata stamped onto runtime messages, so SEARCH/REPLACE eligibility is not
	 * re-derived from rendered transcript text on every refresh. Plan-mode messages stay
	 * non-applicable because the runtime encoded that mode before the pane ever renders them.
	 */
	private maybeAutoApplyRuntimeAssistantMessages(state: IVSCloneThreadRuntimeState): void {
		if (this.isThreadBusy(state.threadId)) {
			return;
		}
		for (const message of state.messages) {
			if (message.role !== "assistant") {
				continue;
			}
			if (!this.isAutoEligibleRuntimeAssistantApplyMessage(message)) {
				continue;
			}
			const visibleText = this.stripRuntimeAssistantWorkflowMarkup(message.content);
			if (!visibleText) {
				continue;
			}
			const target = {
				threadId: state.threadId,
				id: message.id,
				responseText: visibleText,
			};
			if (this.pendingAssistantApplyMessageIds.has(message.id) || this.getAssistantApplyState(target)) {
				continue;
			}

			this.setAssistantApplyState(target, { phase: "pending" });
			void this.runAutoApply(target, visibleText);
		}
	}

	private async runAutoApply(target: IAssistantApplyTarget, responseText: string): Promise<void> {
		try {
			const applyResult = await this.editCodeService.startApplyingSearchReplaceBlocks(responseText);
			if (applyResult.appliedEdits > 0 && applyResult.failures.length > 0) {
				// Auto-apply can leave the workspace in a mixed state if some SEARCH/REPLACE blocks land
				// and later ones fail. Persist that partial phase so the retry summary stays visible.
				this.setAssistantApplyState(target, { phase: "partial", result: applyResult, retryAction: "apply" });
				this.notificationService.warn(
					localize(
						"vsclone.thread.assistant.apply.autoPartial",
						"Applied {0} edit(s), but some changes still need attention.",
						applyResult.appliedEdits,
					),
				);
			} else if (applyResult.appliedEdits > 0) {
				this.setAssistantApplyState(target, { phase: "applied", result: applyResult });
				this.notificationService.info(
					localize(
						"vsclone.thread.assistant.apply.autoSuccess",
						"Auto-applied {0} edit(s) across {1} file(s).",
						applyResult.appliedEdits,
						applyResult.modifiedFiles.length,
					),
				);
			} else {
				this.setAssistantApplyState(target, { phase: "failed" });
				const failureDetails = applyResult.failures[0] ?? localize(
					"vsclone.thread.assistant.apply.noChanges.reason",
					"No matching SEARCH block was found.",
				);
				this.notificationService.warn(
					localize(
						"vsclone.thread.assistant.apply.autoFailed",
						"Could not auto-apply changes. {0}",
						failureDetails,
					),
				);
			}
		} catch (error) {
			this.setAssistantApplyState(target, { phase: "failed" });
			const message = error instanceof Error ? error.message : String(error);
			this.notificationService.error(
				localize(
					"vsclone.thread.assistant.apply.error",
					"Failed to apply suggested changes: {0}",
					message,
				),
			);
		} finally {
			this.refreshConversation();
		}
	}

	/**
	 * Manual fallback path used when auto-apply ended in `failed` and the user wants to retry.
	 * Mirrors the auto-apply path but disables the clicked button while it runs so the user
	 * gets immediate visual feedback.
	 */
	private async applyAssistantEdits(
		target: IAssistantApplyTarget,
		button: HTMLButtonElement,
	): Promise<void> {
		const responseText = target.responseText;
		if (!responseText) {
			return;
		}
		if (this.refuseBusyAssistantApplyAction(target.threadId, "apply")) {
			return;
		}

		const defaultButtonLabel = localize(
			"vsclone.thread.assistant.apply",
			"Apply Changes",
		);
		button.disabled = true;
		button.textContent = localize(
			"vsclone.thread.assistant.apply.pending",
			"Applying...",
		);
		this.setAssistantApplyState(target, { phase: "pending" });

		try {
			await this.runAutoApply(target, responseText);
		} finally {
			if (button.isConnected) {
				button.disabled = false;
				button.textContent = defaultButtonLabel;
			}
		}
	}

	private refuseBusyAssistantApplyAction(
		threadId: string,
		action: "apply" | "undo" | "redo",
	): boolean {
		if (!this.isThreadBusy(threadId)) {
			return false;
		}

		const message = action === "apply"
			? localize(
				"vsclone.thread.assistant.apply.busyApplyWarning",
				"Wait for the assistant to finish before applying changes.",
			)
			: localize(
				"vsclone.thread.assistant.apply.busyActionWarning",
				"Wait for the assistant to finish before changing applied edits.",
			);
		this.notificationService.warn(message);
		return true;
	}

	private updateComposerMetrics(): void {
		if (!this.composerInput) {
			return;
		}

		// Force auto height first so scrollHeight reflects the current value after deletions.
		this.composerInput.style.height = "0px";
		const nextHeight = Math.max(
			40,
			Math.min(132, this.composerInput.scrollHeight),
		);
		this.composerInput.style.height = `${nextHeight}px`;
	}

	private updateComposerState(): void {
		if (!this.composerInput || !this.composerSendButton) {
			return;
		}

		const hasText = this.composerInput.value.trim().length > 0;
		const busyThreadId = this.getBusyThreadId();
		const modelRunBusy = !!busyThreadId;
		const pendingAssistantApply = this.activeThreadId
			? this.hasPendingAssistantApply(this.activeThreadId)
			: false;
		const composerBusy = modelRunBusy || pendingAssistantApply || this.submittingPrompt;
		const hasSelectedModel = !!this.getCurrentComposerModelSelection(
			this.activeThreadId,
		);
		// Once a response is in flight, the primary action must stay enabled so the user can abort
		// the active generation without waiting for transport or history updates to settle first.
		const disabled = modelRunBusy
			? false
			: !hasText || composerBusy || !hasSelectedModel;
		if (modelRunBusy) {
			this.composerSendButton.textContent = localize(
				"vsclone.composer.stop",
				"Stop",
			);
			this.composerSendButton.classList.add("stop-mode");
			this.composerSendButton.setAttribute(
				"aria-label",
				localize(
					"vsclone.composer.stopTooltip",
					"Stop response generation",
				),
			);
			this.composerSendButton.title = localize(
				"vsclone.composer.stopTooltip",
				"Stop response generation",
			);
		} else {
			const sendIcon = document.createElement("span");
			sendIcon.className = "codicon codicon-send";
			sendIcon.setAttribute("aria-hidden", "true");
			this.composerSendButton.replaceChildren(sendIcon);
			this.composerSendButton.classList.remove("stop-mode");
			this.composerSendButton.setAttribute(
				"aria-label",
				localize("vsclone.composer.send", "Send message"),
			);
			this.composerSendButton.title = localize(
				"vsclone.composer.sendTooltip",
				"Send message",
			);
		}
		this.composerSendButton.disabled = disabled;
		this.composerInput.disabled = composerBusy;
		if (this.reasoningEffortSelect) {
			const reasoningControlHidden =
				this.reasoningEffortContainer?.classList.contains("hidden") ?? true;
			this.reasoningEffortSelect.disabled =
				composerBusy || reasoningControlHidden;
		}
		this.refreshPlanModeControl(composerBusy);
		if (modelRunBusy || this.submittingPrompt) {
			this.composerInput.placeholder = localize(
				"vsclone.composer.waiting",
				"Waiting for response...",
			);
		} else if (pendingAssistantApply) {
			this.composerInput.placeholder = localize(
				"vsclone.composer.applyPending",
				"Wait for edit application to finish...",
			);
		} else if (!hasSelectedModel) {
			// VSClone always needs a concrete provider/model pair before it can send a prompt.
			this.composerInput.placeholder = localize(
				"vsclone.composer.signInRequired",
				"Sign in to a provider and choose a model to start chatting...",
			);
		} else if (this.getCurrentComposerMode() === "plan") {
			this.composerInput.placeholder = localize(
				"vsclone.composer.planPlaceholder",
				"Type your prompt here...",
			);
		} else {
			this.composerInput.placeholder = localize(
				"vsclone.composer.placeholder",
				"Type your prompt here...",
			);
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
		const runtimeState = this.getThreadRuntimeState(threadId);
		if (runtimeState) {
			return runtimeState.streamState.kind !== "idle";
		}
		return false;
	}

	private applyRailLayout(): void {
		if (!this.rootContainer || !this.railContainer || !this.railResizeHandle) {
			return;
		}

		this.rootContainer.classList.toggle("rail-hidden", !this.railVisible);
		this.rootContainer.classList.toggle("thread-rail-screen", this.railVisible);
		this.railContainer.style.width = this.railVisible ? "100%" : "0px";
		this.railResizeHandle.style.display = "none";
		if (this.conversationContainer) {
			this.conversationContainer.style.display = this.railVisible ? "none" : "";
		}
	}

	private installRailResizer(handle: HTMLElement): void {
		this._register(
			addDisposableListener(
				handle,
				EventType.MOUSE_DOWN,
				(startEvent: MouseEvent) => {
					if (this.isCompactLayout) {
						return;
					}

					startEvent.preventDefault();
					startEvent.stopPropagation();

					const startWidth = this.railWidth;
					const startX = startEvent.clientX;
					const targetWindow = getWindow(handle);

					const moveDisposable = addDisposableListener(
						targetWindow.document,
						EventType.MOUSE_MOVE,
						(moveEvent: MouseEvent) => {
							const delta = moveEvent.clientX - startX;
							const width = Math.min(
								railMaxWidth,
								Math.max(railMinWidth, startWidth + delta),
							);
							if (width === this.railWidth) {
								return;
							}
							this.railWidth = width;
							this.applyRailLayout();
						},
					);

					const upDisposable = addDisposableListener(
						targetWindow.document,
						EventType.MOUSE_UP,
						() => {
							moveDisposable.dispose();
							upDisposable.dispose();
							void this.configurationService.updateValue(
								railWidthSetting,
								this.railWidth,
							);
						},
					);
				},
			),
		);
	}

	private refreshModelControls(): void {
		this.modelSwitcher?.refresh();
		this.refreshPlanModeControl();
		this.refreshReasoningEffortControl();
	}

	private getCurrentComposerMode(): VSCloneChatMode {
		return this.planModeService.getModeForThread(this.activeThreadId);
	}

	private refreshPlanModeControl(composerBusy?: boolean): void {
		if (!this.planModeContainer || !this.planModeSwitchButton) {
			return;
		}

		const busy =
			composerBusy ??
			((this.activeThreadId ? this.isThreadBusy(this.activeThreadId) : false) ||
				this.submittingPrompt);
		const mode = this.getCurrentComposerMode();
		this.planModeSwitchButton.classList.toggle('checked', mode === 'plan');
		this.planModeSwitchButton.disabled = busy;
		this.planModeSwitchButton.setAttribute(
			'aria-checked',
			mode === 'plan' ? 'true' : 'false',
		);
		if (this.addContextMenuToggle) {
			this.addContextMenuToggle.classList.toggle('active', mode === 'plan');
		}
	}

	private async updatePlanModeSelection(mode: VSCloneChatMode): Promise<void> {
		const threadBusy = this.activeThreadId
			? this.isThreadBusy(this.activeThreadId)
			: false;
		if (
			threadBusy ||
			this.submittingPrompt ||
			this.getCurrentComposerMode() === mode
		) {
			return;
		}

		await this.planModeService.setModeForThread(this.activeThreadId, mode);
		this.refreshPlanModeControl();
		this.updateComposerState();
	}

	private getCurrentComposerModelSelection(
		threadId: string | undefined,
	): IVSCloneModelSelection | undefined {
		const selectedModel =
			this.settingsService.getCurrentSelectionForFeature(
				threadId ?? "",
				"chat",
			);
		if (!selectedModel) {
			return undefined;
		}

		const selectedModelDescriptor = this.settingsService.getModel(
			selectedModel.modelIdentifier,
		);
		const supportedReasoningLevels =
			selectedModelDescriptor?.reasoningEffortLevels;
		if (!supportedReasoningLevels || supportedReasoningLevels.length === 0) {
			return {
				...selectedModel,
				threadId: threadId ?? undefined,
				reasoningEffort: undefined,
			};
		}

		// Read directly from the visible select so a quick Send click right after changing the dropdown
		// uses the new value even before storage/event propagation catches up.
		const selectedFromControl = this.reasoningEffortSelect?.value as
			| VSCloneReasoningEffortLevel
			| undefined;
		const resolvedReasoningEffort =
			selectedFromControl &&
				supportedReasoningLevels.includes(selectedFromControl)
				? selectedFromControl
				: selectedModel.reasoningEffort &&
					supportedReasoningLevels.includes(selectedModel.reasoningEffort)
					? selectedModel.reasoningEffort
					: (selectedModelDescriptor.defaultReasoningEffort ??
						supportedReasoningLevels[0]);

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

		const selectedModel =
			this.settingsService.getCurrentSelectionForFeature(
				this.activeThreadId ?? "",
				"chat",
			);
		const selectedModelDescriptor = selectedModel
			? this.settingsService.getModel(selectedModel.modelIdentifier)
			: undefined;
		const supportedReasoningLevels =
			selectedModelDescriptor?.reasoningEffortLevels;
		if (
			!selectedModel ||
			!supportedReasoningLevels ||
			supportedReasoningLevels.length === 0
		) {
			this.reasoningEffortContainer.classList.add("hidden");
			this.reasoningEffortSelect.replaceChildren();
			this.updateComposerState();
			return;
		}

		const selectedReasoningEffort =
			selectedModel.reasoningEffort &&
				supportedReasoningLevels.includes(selectedModel.reasoningEffort)
				? selectedModel.reasoningEffort
				: (selectedModelDescriptor.defaultReasoningEffort ??
					supportedReasoningLevels[0]);

		this.reasoningEffortSelect.replaceChildren(
			...supportedReasoningLevels.map((level) => {
				const option = document.createElement("option");
				option.value = level;
				option.textContent = this.toReasoningEffortLabel(level);
				return option;
			}),
		);
		this.reasoningEffortSelect.value = selectedReasoningEffort;
		this.reasoningEffortContainer.classList.remove("hidden");
		this.updateComposerState();
	}

	private async updateReasoningEffortSelection(): Promise<void> {
		if (!this.reasoningEffortSelect) {
			return;
		}

		const selectedModel =
			this.settingsService.getCurrentSelectionForFeature(
				this.activeThreadId ?? "",
				"chat",
			);
		const selectedModelDescriptor = selectedModel
			? this.settingsService.getModel(selectedModel.modelIdentifier)
			: undefined;
		const supportedReasoningLevels =
			selectedModelDescriptor?.reasoningEffortLevels;
		if (
			!selectedModel ||
			!supportedReasoningLevels ||
			supportedReasoningLevels.length === 0
		) {
			return;
		}

		const nextReasoningEffort = this.reasoningEffortSelect
			.value as VSCloneReasoningEffortLevel;
		if (
			!supportedReasoningLevels.includes(nextReasoningEffort) ||
			selectedModel.reasoningEffort === nextReasoningEffort
		) {
			return;
		}

		await this.settingsService.setSelectionForFeature(
			this.activeThreadId ?? "",
			{
				...selectedModel,
				threadId: this.activeThreadId,
				location: "chat",
				reasoningEffort: nextReasoningEffort,
				selectedAt: Date.now(),
			},
		);
	}

	private toReasoningEffortLabel(level: VSCloneReasoningEffortLevel): string {
		switch (level) {
			case "xhigh":
				return localize("vsclone.composer.reasoningEffort.xhigh", "Xhigh");
			case "max":
				return localize("vsclone.composer.reasoningEffort.max", "Max");
			case "high":
				return localize("vsclone.composer.reasoningEffort.high", "High");
			case "medium":
				return localize("vsclone.composer.reasoningEffort.medium", "Medium");
			case "standard":
				return localize(
					"vsclone.composer.reasoningEffort.standard",
					"Standard",
				);
			case "low":
				return localize("vsclone.composer.reasoningEffort.low", "Low");
			case "minimal":
				return localize("vsclone.composer.reasoningEffort.minimal", "Minimal");
			case "lite":
				return localize("vsclone.composer.reasoningEffort.lite", "Lite");
			case "none":
				return localize("vsclone.composer.reasoningEffort.none", "None");
		}
	}

	private getLatestConversationPrompt(threadId?: string): {
		content: string;
		imageAttachments?: readonly IVSCloneImageAttachment[];
	} | undefined {
		const candidateThreadId =
			threadId ?? this.activeThreadId ?? this.rail.getSelectedThread();
		if (!candidateThreadId) {
			return undefined;
		}

		const runtimeState = this.threadRuntimeService?.getState(candidateThreadId);
		if (runtimeState) {
			for (let index = runtimeState.messages.length - 1; index >= 0; index--) {
				const message = runtimeState.messages[index];
				if (message.role === "user") {
					return {
						content: message.content,
						imageAttachments: message.imageAttachments,
					};
				}
			}
			return undefined;
		}
		return undefined;
	}

	private getLatestConversationResponse(threadId?: string): {
		content: string;
	} | undefined {
		const candidateThreadId =
			threadId ?? this.activeThreadId ?? this.rail.getSelectedThread();
		if (!candidateThreadId) {
			return undefined;
		}

		const runtimeState = this.threadRuntimeService?.getState(candidateThreadId);
		if (runtimeState) {
			for (let index = runtimeState.messages.length - 1; index >= 0; index--) {
				const message = runtimeState.messages[index];
				if (message.role === "assistant") {
					return {
						content: this.stripRuntimeAssistantWorkflowMarkup(message.content),
					};
				}
			}
			return undefined;
		}
		return undefined;
	}

	private hasPendingAssistantApply(
		threadId: string,
		runtimeState: IVSCloneThreadRuntimeState | undefined = this.getThreadRuntimeState(threadId),
	): boolean {
		if (!runtimeState) {
			return false;
		}
		if (runtimeState.assistantEditApplications?.some(entry => entry.state.phase === 'pending')) {
			return true;
		}
		const assistantMessageIds = new Set(
			(runtimeState.messages ?? [])
				.filter((message): message is Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }> => message.role === 'assistant')
				.map(message => message.id),
		);
		for (const messageId of this.pendingAssistantApplyMessageIds ?? []) {
			if (assistantMessageIds.has(messageId)) {
				return true;
			}
		}
		return false;
	}

	private resolveThreadById(
		threadId: string,
	): IVSClonePaneThreadCatalogEntry | undefined {
		return this.threadsById.get(threadId);
	}

	private resolveThreadByIdForLifecycleAction(
		threadId: string,
	): IVSClonePaneThreadCatalogEntry | undefined {
		const runtimeState = this.threadRuntimeService.getState?.(threadId);
		if (runtimeState) {
			// Lifecycle actions must honor the live runtime branch even if the pane cache is stale.
			// Without this sync, a stale cache entry can cause incorrect delete/archive behavior.
			this.syncThreadCatalogEntryFromRuntime(runtimeState);
		}
		return this.threadsById.get(threadId);
	}

	private getModelSwitcherContext(): {
		threadId: string;
		location: IVSCloneChatLocation;
	} {
		return {
			threadId: this.activeThreadId ?? "",
			location: "chat",
		};
	}

	private async deleteThread(threadId: string): Promise<void> {
		const existing = this.resolveThreadByIdForLifecycleAction(threadId);
		try {
			if (!existing) {
				throw new Error("Thread delete requires a runtime catalog entry.");
			}

			const deletedByRuntime = await this.chatThreadService.deleteThread(threadId);
			if (!deletedByRuntime) {
				throw new Error("Thread delete was rejected by the runtime catalog.");
			}
		} catch {
			this.notificationService.error(
				localize(
					"vsclone.rail.delete.error",
					"Failed to delete the chat. Please try again.",
				),
			);
			return;
		}
		this.threadsById.delete(threadId);

		if (this.activeThreadId === threadId) {
			this.showComposerForNewChat();
		}

		this.refreshRailRows();
		this.refreshModelControls();
		this.refreshConversation();
	}

	private async setThreadArchived(
		threadId: string,
		archived: boolean,
	): Promise<void> {
		const existing = this.resolveThreadByIdForLifecycleAction(threadId);
		const optimisticUpdatedAt = Date.now();
		if (existing) {
			this.threadsById.set(threadId, {
				...existing,
				archived,
				status: archived ? "archived" : existing.status === "archived" ? "completed" : existing.status,
				updatedAt: optimisticUpdatedAt,
			});
		}

		try {
			const runtimeCatalog = this.getRuntimeThreadCatalogService();
			if (!runtimeCatalog || !runtimeCatalog.archiveThread || !existing) {
				throw new Error("Thread archive requires a runtime catalog entry.");
			}

			const archivedInRuntime = await runtimeCatalog.archiveThread(threadId, archived);
			if (archivedInRuntime === false) {
				throw new Error("Thread archive was rejected by the runtime catalog.");
			}
		} catch (error) {
			if (existing) {
				this.threadsById.set(threadId, existing);
			} else {
				this.threadsById.delete(threadId);
			}
			this.refreshRailRows();
			this.notificationService.error(
				localize(
					archived
						? "vsclone.rail.archive.error"
						: "vsclone.rail.unarchive.error",
					archived
						? "Failed to archive the chat. Please try again."
						: "Failed to move the chat back to active. Please try again.",
				),
			);
			return;
		}

		this.refreshRailRows();
	}

	private showComposerForNewChat(): void {
		this.activeThreadId = undefined;
		this.rail.setSelectedThread(undefined);
		this.refreshPlanModeControl();
		this.refreshModelControls();
		this.refreshConversation();
		this.railVisible = false;
		this.applyRailLayout();
		this.focusInput();
	}
}

function isRuntimeThreadExecuting(state: IVSCloneThreadRuntimeState | undefined): boolean {
	// Awaiting approval is still a non-idle stream state, but UI affordances such as rewind should
	// only stay disabled while the runtime is actively streaming or running a tool.
	return state?.streamState.kind === "llm" || state?.streamState.kind === "tool";
}
