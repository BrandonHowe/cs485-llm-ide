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
import { splitLines } from "../../../../base/common/strings.js";
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
import { IFileService } from "../../../../platform/files/common/files.js";
import { IMarkdownRendererService } from "../../../../platform/markdown/browser/markdownRenderer.js";
import { IThemeService } from "../../../../platform/theme/common/themeService.js";
import {
	IViewPaneOptions,
	ViewPane,
} from "../../../browser/parts/views/viewPane.js";
import { IViewDescriptorService } from "../../../common/views.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import { URI } from "../../../../base/common/uri.js";
import { IModelService } from "../../../../editor/common/services/model.js";
import {
	IVSCloneChatHistoryQuery,
	IVSCloneChatHistoryThread,
	IVSCloneChatHistoryTurn,
	IVSCloneChatHistoryService,
} from "../common/backend/vscloneChatHistoryService.js";
import {
	IVSCloneModelCatalogService,
	type VSCloneReasoningEffortLevel,
} from "../common/vscloneModelCatalogService.js";
import { IVSClonePlanModeService } from "../common/vsclonePlanModeService.js";
import { type VSCloneChatMode } from "../common/vsclonePlanModeTypes.js";
import {
	IVSCloneChatLocation,
	IVSCloneThreadModelSelectionService,
	type IVSCloneModelSelection,
} from "../common/backend/vscloneThreadModelSelectionService.js";
import { parseToolCalls } from "../common/vscloneToolCallParser.js";
import {
	VSCloneChatHistoryRail,
	VSCloneRailTab,
} from "./vscloneChatHistoryRail.js";
import { IVSCloneChatSessionService } from "./vscloneChatSessionService.js";
import { VSCloneModelSwitcherWidget } from "./vscloneModelSwitcherWidget.js";
import { IVSCloneProviderConfigurationBridge } from "./vscloneProviderConfigurationBridge.js";
import { IVSCloneThreadRuntimeService } from "./vscloneThreadRuntimeService.js";
import { toVSCloneRailRows } from "./vscloneChatHistoryRailTree.js";
import {
	IVSCloneEditApplicationService,
	type IVSCloneEditApplyResult,
	type IVSCloneEditFileChange,
} from "./vscloneEditApplicationService.js";
import { parseToolResultDiff } from "../common/vscloneToolResultDiff.js";
import {
	toVSCloneImageDataUrl,
	type IVSCloneImageAttachment,
} from "../common/vscloneImageAttachmentTypes.js";
import {
	type IVSCloneThreadRuntimeCheckpoint,
	type IVSCloneThreadRuntimeMessage,
	type IVSCloneThreadRuntimeState,
} from "../common/vscloneThreadRuntimeTypes.js";

const railWidthSetting = "vsclone.chatHistory.railWidth";
const modelSwitcherEnabledSetting = "vsclone.modelSwitcher.enabled";
const railMinWidth = 220;
const railMaxWidth = 520;
const compactRailBreakpoint = 900;

interface IPendingImageAttachment extends IVSCloneImageAttachment {
	readonly dataUrl: string;
}

export function toVSCloneHistoryQuery(
	query: string,
	tab: VSCloneRailTab,
): IVSCloneChatHistoryQuery {
	return {
		text: query,
		tab,
		includeArchived: tab === "all",
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

interface ILegacyDiffHunk {
	readonly lineIndexes: readonly number[];
	readonly lines: readonly string[];
}

function parseToolResultBlocks(
	text: string,
): readonly IParsedToolResultBlock[] {
	const blocks: IParsedToolResultBlock[] = [];
	const pattern =
		/<tool_result\s+tool_name="([^"]+)"\s+success="(true|false)">([\s\S]*?)<\/tool_result>/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		blocks.push({
			toolName: match[1],
			success: match[2] === "true",
			output: match[3].trim(),
			rawXml: match[0],
			startOffset: match.index,
			endOffset: match.index + match[0].length,
		});
	}
	return blocks;
}

function parseAgentTraceBlocks(
	text: string,
): readonly IParsedAgentTraceBlock[] {
	const blocks: IParsedAgentTraceBlock[] = [];
	const pattern =
		/<agent_trace\s+type="([^"]+)"(?:\s+status="([^"]+)")?>([\s\S]*?)<\/agent_trace>/g;
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
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
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
		this.instantiationService.createInstance(VSCloneChatHistoryRail),
	);
	private readonly threadsById = new Map<string, IVSCloneChatHistoryThread>();
	// Durable apply summaries now live on the runtime branch via the assistant-edit application API.
	// The pane only keeps a transient pending set so repeated refreshes do not launch duplicate
	// browser-local apply work while the engine bridge is still running.
	private readonly pendingAssistantApplyMessageIds = new Set<string>();
	// Some runtime services may emit state changes while hydration is still unwinding, so imports
	// mark the thread as transiently guarded until the imported runtime snapshot has settled.
	private readonly importingRuntimeThreadIds = new Set<string>();
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
		@IVSCloneChatHistoryService
		private readonly historyService: IVSCloneChatHistoryService,
		@IVSCloneChatSessionService
		private readonly sessionService: IVSCloneChatSessionService,
		@IVSCloneThreadModelSelectionService
		private readonly modelSelectionService: IVSCloneThreadModelSelectionService,
		@IVSClonePlanModeService
		private readonly planModeService: IVSClonePlanModeService,
		@IVSCloneModelCatalogService
		private readonly modelCatalogService: IVSCloneModelCatalogService,
		@IVSCloneProviderConfigurationBridge
		private readonly providerConfigurationBridge: IVSCloneProviderConfigurationBridge,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IVSCloneEditApplicationService
		private readonly editApplicationService: IVSCloneEditApplicationService,
		@IVSCloneThreadRuntimeService
		private readonly threadRuntimeService: IVSCloneThreadRuntimeService,
		@INotificationService
		private readonly notificationService: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
		@IModelService private readonly modelService: IModelService,
		@IFileService private readonly fileService: IFileService,
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
						void this.historyService.archiveThread(
							event.threadId,
							!!event.archived,
						);
						break;
				}
			}),
		);

		this._register(
			this.historyService.onDidChange((event) => {
				if (!this.historyReady) {
					return;
				}

				const affectsActiveThread =
					!this.activeThreadId || event.threadIds.includes(this.activeThreadId);
				if (event.reason === "turnUpdate") {
					if (affectsActiveThread) {
						this.importActiveThreadRuntimeState();
						this.refreshConversationScheduler.schedule(24);
						// Trigger auto-apply on the same event the streaming completes so the user
						// never has to click the apply button on the happy path.
						this.maybeAutoApplyCompletedTurns();
					}
					this.refreshRailScheduler.schedule();
					return;
				}

				if (affectsActiveThread || event.reason === "clear") {
					this.importActiveThreadRuntimeState();
					this.refreshConversationScheduler.schedule(0);
				}
				this.refreshRailScheduler.schedule(0);
			}),
		);
		this._register(
			this.threadRuntimeService.onDidChangeState((state) => {
				if (state.threadId !== this.activeThreadId) {
					return;
				}
				// Runtime-only workflow state currently exists outside persisted turn history, so the
				// pane has to listen to both channels until the thread runtime becomes the sole source
				// of truth. Refreshing through the same scheduler keeps tool/checkpoint cards aligned
				// with the existing transcript rebuild cadence.
				this.refreshConversationScheduler.schedule(0);
				this.maybeAutoApplyRuntimeAssistantMessages(state);
				this.updateComposerState();
				this.refreshPlanModeControl();
			}),
		);

		this._register(
			this.modelSelectionService.onDidChangeSelection(() => {
				this.refreshModelControls();
			}),
		);
		this._register(
			this.planModeService.onDidChangeMode(() => {
				this.refreshPlanModeControl();
				this.updateComposerState();
			}),
		);
		this._register(
			this.modelCatalogService.onDidChangeCatalog(() => {
				this.refreshModelControls();
			}),
		);

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
		await this.modelSelectionService.resetSelectionForThread(
			this.activeThreadId,
		);
		this.refreshModelControls();
	}

	async switchToNextModel(): Promise<void> {
		const context = this.getModelSwitcherContext();
		await this.modelSelectionService.switchToNextModel(
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

		const importedRuntimeState = this.importRuntimeThreadState(targetThreadId);
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
		this.importRuntimeThreadState(
			threadId ?? this.activeThreadId ?? this.rail.getSelectedThread(),
		);
		const latestPrompt = this.getLatestConversationPrompt(threadId);
		if (!latestPrompt) {
			return;
		}
		await this.clipboardService.writeText(latestPrompt.content);
	}

	async copyResponse(threadId?: string): Promise<void> {
		this.importRuntimeThreadState(
			threadId ?? this.activeThreadId ?? this.rail.getSelectedThread(),
		);
		const latestResponse = this.getLatestConversationResponse(threadId);
		if (!latestResponse) {
			return;
		}
		await this.clipboardService.writeText(latestResponse.content);
	}

	reusePrompt(threadId?: string): void {
		this.importRuntimeThreadState(
			threadId ?? this.activeThreadId ?? this.rail.getSelectedThread(),
		);
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

		const historyButton = document.createElement("button");
		historyButton.type = "button";
		historyButton.className = "vsclone-thread-action-button";
		historyButton.textContent = localize(
			"vsclone.thread.actions.history",
			"Chat History",
		);
		// Mirror tooltip text into an accessible name so screen readers announce this icon-like action clearly.
		const historyButtonLabel = localize(
			"vsclone.thread.actions.history.tooltip",
			"Show chat history",
		);
		historyButton.title = historyButtonLabel;
		historyButton.setAttribute("aria-label", historyButtonLabel);
		actions.appendChild(historyButton);

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
						this.modelCatalogService,
						this.modelSelectionService,
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
			addDisposableListener(historyButton, EventType.CLICK, () => {
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
							"vsclone.chatHistory.copyPrompt",
							localize("vsclone.thread.actions.copyPrompt", "Copy Prompt"),
							undefined,
							true,
							() => this.copyPrompt(),
						)),
						menuActions.add(new Action(
							"vsclone.chatHistory.copyResponse",
							localize(
								"vsclone.thread.actions.copyResponse",
								"Copy Response",
							),
							undefined,
							true,
							() => this.copyResponse(),
						)),
						menuActions.add(new Action(
							"vsclone.chatHistory.reusePrompt",
							localize("vsclone.thread.actions.reusePrompt", "Reuse Prompt"),
							undefined,
							true,
							() => this.reusePrompt(),
						)),
						menuActions.add(new Action(
							"vsclone.chatHistory.deleteThread",
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
			void this.modelCatalogService.refreshCatalog();
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
		await this.modelSelectionService.initialize();
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
			const submission = await this.sessionService.submitPrompt(promptText, {
				threadId: activeThreadId,
				sessionResource: existingThread?.sessionResource,
				modelSelection: selectedModel,
				imageAttachments,
			});
			if (!submission) {
				return;
			}

			if (!activeThreadId && selectedModel) {
				await this.modelSelectionService.setSelectionForThread(
					submission.threadId,
					{
						...selectedModel,
						threadId: submission.threadId,
						location: "chat",
						selectedAt: Date.now(),
					},
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
			this.sessionService.cancelThread(busyThreadId);
			this.updateComposerState();
			return;
		}

		await this.submitPrompt();
	}

	private async handleImageFiles(files: FileList | File[]): Promise<void> {
		const selectedModel = this.getCurrentComposerModelSelection(this.activeThreadId);
		if (selectedModel) {
			const modelDescriptor = this.modelCatalogService.getModel(selectedModel.modelIdentifier);
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
			await this.historyService.initialize();
			await this.planModeService.initialize();
			this.historyReady = true;
			this.refreshRailRows();
			if (!this.activeThreadId) {
				// Default to composer mode when opening VSClone with no active thread.
				this.railVisible = false;
				this.applyRailLayout();
			}
			this.importActiveThreadRuntimeState();
			this.refreshConversation();
		} catch {
			this.historyReady = false;
			this.rail.setError(
				localize(
					"vsclone.rail.load.error",
					"Failed to load chat history. Please try again.",
				),
			);
		}
	}

	private refreshRailRows(): void {
		if (!this.historyReady) {
			return;
		}

		const filterState = this.rail.getFilterState();
		const threads = this.historyService.getThreads(
			toVSCloneHistoryQuery(filterState.query, filterState.tab),
		);
		this.threadsById.clear();
		for (const thread of threads) {
			this.threadsById.set(thread.threadId, thread);
		}

		const previousActiveThreadId = this.activeThreadId;
		if (this.activeThreadId && !this.threadsById.has(this.activeThreadId)) {
			this.activeThreadId = undefined;
		}
		// Clearing history through the backend removes the active thread before the pane gets an
		// explicit UI callback, so normalize that backend-only path back to the fresh composer state.
		if (previousActiveThreadId && !this.activeThreadId && threads.length === 0) {
			this.showComposerForNewChat();
			return;
		}

		const rows = toVSCloneRailRows(threads, this.activeThreadId, (timestamp) =>
			fromNow(timestamp, true),
		);
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
		for (const message of state.messages) {
			switch (message.role) {
				case 'user':
					nodes.push(this.renderRuntimeUserMessage(message));
					break;
				case 'assistant':
					nodes.push(this.renderRuntimeAssistantMessage(message, state.threadId));
					break;
				case 'tool':
					nodes.push(this.renderRuntimeToolMessage(state.threadId, state, message));
					break;
				case 'checkpoint':
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

		const statusMessage = this.renderRuntimeStatusMessage(state);
		if (statusMessage) {
			nodes.push(statusMessage);
		}
		return nodes;
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
		item.className = 'vsclone-thread-message assistant runtime';

		const meta = document.createElement('div');
		meta.className = 'vsclone-thread-message-meta';
		meta.textContent = localize('vsclone.thread.assistantLabel', 'Assistant');
		item.appendChild(meta);

		const body = document.createElement('div');
		body.className = 'vsclone-thread-message-body';
		const visibleText = this.stripRuntimeAssistantWorkflowMarkup(message.content);
		if (visibleText.trim().length > 0) {
			if (visibleText.includes("<<<<<<< SEARCH") || this.looksLikePartialSearchReplaceBlock(visibleText)) {
				// Runtime assistant text still carries edit suggestions inline, but workflow XML is
				// rendered from the dedicated runtime tool/checkpoint messages instead of duplicated
				// inside the prose bubble.
				this.renderSearchReplaceAwareText(body, visibleText, false);
			} else {
				this.appendMarkdownSegment(body, visibleText, 'vsclone-thread-message-assistant-text');
			}
		}
		item.appendChild(body);
		if (
			visibleText.trim().length > 0 &&
			this.shouldOfferRuntimeAssistantApply(threadId, message, visibleText)
		) {
			this.appendAssistantApplyControls(item, {
				threadId,
				id: message.id,
				responseText: visibleText,
			});
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

	private getImportingRuntimeThreadIds(): Set<string> {
		const target = this as unknown as {
			importingRuntimeThreadIds?: Set<string>;
		};
		target.importingRuntimeThreadIds ??= new Set();
		return target.importingRuntimeThreadIds;
	}

	private importRuntimeThreadState(
		threadId: string | undefined,
	): IVSCloneThreadRuntimeState | undefined {
		if (!threadId) {
			return undefined;
		}
		const runtimeState = this.threadRuntimeService?.getState(threadId);
		if (runtimeState) {
			return runtimeState;
		}

		// Active transcript rendering only reads runtime state. If a thread still exists solely in
		// legacy history we import that transcript into runtime first through explicit UI/session
		// entrypoints, then later reads/rendering consume runtime state directly.
		const importingRuntimeThreadIds = this.getImportingRuntimeThreadIds();
		importingRuntimeThreadIds.add(threadId);
		try {
			const importedState = this.threadRuntimeService?.ensureHydratedFromHistory(
				threadId,
				this.historyService.getTurns(threadId),
			);
			return importedState;
		} finally {
			importingRuntimeThreadIds.delete(threadId);
		}
	}

	private importActiveThreadRuntimeState(): IVSCloneThreadRuntimeState | undefined {
		return this.importRuntimeThreadState(this.activeThreadId);
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
		visibleText: string,
	): boolean {
		if (!(this.editApplicationService?.hasSearchReplaceBlocks(visibleText) ?? false)) {
			return false;
		}

		const runtimeState = this.getThreadRuntimeState(threadId);
		const messageMode = runtimeState
			? this.getRuntimeAssistantMessageMode(runtimeState, message)
			: (message as { readonly mode?: VSCloneChatMode }).mode;
		return messageMode !== 'plan';
	}

	private isManualOnlyRuntimeAssistantApplyMessage(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>,
	): boolean {
		// The durable import marker is persisted inside runtime message metadata. Reading that field
		// directly keeps imported SEARCH/REPLACE suggestions manual-only even after a full reload.
		return message.metadata?.importedFromHistory === true;
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
	): HTMLElement {
		const item = document.createElement("div");
		item.className = "vsclone-thread-message assistant runtime runtime-tool";

		const body = document.createElement("div");
		body.className = "vsclone-thread-message-body";
		body.appendChild(
			this.renderToolCard(
				message.toolName,
				this.getRuntimeToolDisplayLabel(message),
				this.toRuntimeToolCardStatus(message),
				message.output,
				message.type === "success" && message.output
					? this.renderToolResultDiffCard(message.toolName, message.output)
					: undefined,
				this.renderRuntimeToolActions(threadId, state, message),
			),
		);
		item.appendChild(body);
		return item;
	}

	private renderRuntimeToolActions(
		threadId: string,
		state: IVSCloneThreadRuntimeState,
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: "tool" }>,
	): HTMLElement | undefined {
		const latestRuntimeTool = state.messages.at(-1);
		const latestRuntimeToolParams = latestRuntimeTool?.role === "tool"
			? latestRuntimeTool.params
			: {};
		// Approval controls are only rendered for the live pending request. Older tool_request cards
		// remain historical records and should not be able to mutate the current runtime.
		if (
			message.type !== "tool_request" ||
			state.streamState.kind !== "awaiting_user" ||
			state.streamState.toolName !== message.toolName ||
			this.serializeRuntimeToolParams(latestRuntimeToolParams) !==
				this.serializeRuntimeToolParams(message.params)
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
			if (button.isConnected && !(latestState?.isRunning)) {
				button.disabled = false;
			}
		}
	}

	private renderUserMessage(turn: IVSCloneChatHistoryTurn): HTMLElement {
		const item = document.createElement("div");
		item.className = "vsclone-thread-message user";

		const meta = document.createElement("div");
		meta.className = "vsclone-thread-message-meta";
		meta.textContent = localize("vsclone.thread.userLabel", "You");
		item.appendChild(meta);

		const body = document.createElement("div");
		body.className = "vsclone-thread-message-body";
		if (turn.promptText.trim().length > 0) {
			const promptText = document.createElement("div");
			promptText.className = "vsclone-thread-message-user-text";
			promptText.textContent = turn.promptText;
			body.appendChild(promptText);
		}
		if (turn.promptImages && turn.promptImages.length > 0) {
			body.appendChild(this.renderPromptImageStrip(turn.promptImages));
		}
		item.appendChild(body);

		return item;
	}

	/**
	 * User-turn images are rendered from persisted turn state so restored threads keep showing the
	 * same attachments that were actually sent to the provider.
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

	private renderAssistantMessage(turn: IVSCloneChatHistoryTurn): HTMLElement {
		const item = document.createElement("div");
		item.className = "vsclone-thread-message assistant";
		item.classList.toggle("error", turn.status === "failed");

		const meta = document.createElement("div");
		meta.className = "vsclone-thread-message-meta";
		meta.textContent = localize("vsclone.thread.assistantLabel", "Assistant");
		item.appendChild(meta);

		const body = document.createElement("div");
		body.className = "vsclone-thread-message-body";
		const text = turn.responsePlainText || turn.responseMarkdown;
		const isStreaming = turn.status === "streaming";
		if (text.trim().length > 0) {
			if (
				text.includes("<tool_call>") ||
				text.includes("<tool_result") ||
				text.includes("<agent_trace")
			) {
				this.renderToolAwareAssistantText(
					body,
					text,
					isStreaming,
				);
			} else if (text.includes("<<<<<<< SEARCH") || (isStreaming && this.looksLikePartialSearchReplaceBlock(text))) {
				this.renderSearchReplaceAwareText(body, text, isStreaming);
			} else {
				this.appendMarkdownSegment(
					body,
					text,
					"vsclone-thread-message-text-segment",
				);
			}
		} else if (turn.status === "pending" || turn.status === "streaming") {
			body.textContent = localize(
				"vsclone.thread.assistant.pending",
				"Thinking...",
			);
			item.classList.add("streaming");
		} else if (turn.status === "cancelled") {
			body.textContent = localize(
				"vsclone.thread.assistant.cancelled",
				"Response generation was cancelled.",
			);
		} else if (turn.status === "failed") {
			body.textContent = localize(
				"vsclone.thread.assistant.failed",
				"Something went wrong while generating the response.",
			);
		}
		item.appendChild(body);

		// Plan-mode turns stay intentionally non-mutating even if the model emits executable-looking
		// SEARCH/REPLACE blocks in plain text. That closes the last mutation path outside tool calls.
		if (
			turn.executionMode !== "plan" &&
			turn.status === "completed" &&
			text.trim().length > 0 &&
			this.editApplicationService.hasSearchReplaceBlocks(text)
		) {
			this.appendAssistantApplyControls(item, {
				threadId: turn.threadId,
				id: turn.turnId,
				responseText: text,
			});
		}

		return item;
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
		} else if (state.retryAction === "undo") {
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
			const undoResult = await this.editApplicationService.undoEditApply(applyResult.fileChanges);
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
			const applyResult = await this.editApplicationService.startApplyingSearchReplaceBlocks(responseText);
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

	private renderToolAwareAssistantText(
		container: HTMLElement,
		text: string,
		streaming: boolean,
	): void {
		type ParsedBlock = {
			readonly kind: "tool_call" | "tool_result" | "trace";
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

		const callBlocks = parseToolCalls(text).toolCalls.map<ParsedBlock>(
			(call) => ({
				kind: "tool_call",
				startOffset: call.startOffset,
				endOffset: call.endOffset,
				rawXml: call.rawXml,
				toolName: call.name,
			}),
		);
		const resultBlocks = parseToolResultBlocks(text).map<ParsedBlock>(
			(result) => ({
				kind: "tool_result",
				startOffset: result.startOffset,
				endOffset: result.endOffset,
				rawXml: result.rawXml,
				toolName: result.toolName,
				success: result.success,
				output: result.output,
			}),
		);
		const traceBlocks = parseAgentTraceBlocks(text).map<ParsedBlock>(
			(trace) => ({
				kind: "trace",
				startOffset: trace.startOffset,
				endOffset: trace.endOffset,
				rawXml: trace.rawXml,
				toolName: "",
				traceType: trace.type,
				traceStatus: trace.status,
				traceMessage: trace.message,
			}),
		);
		const hasTraceBlocks = traceBlocks.length > 0;
		// The attempt_completion tool result is the canonical final summary for a tool-driven turn.
		// Some models still emit the same prose before the exploratory tool call, which makes
		// restored transcripts look duplicated and out of order once the tool card is inserted
		// between both copies. We keep the structured completion copy and suppress the earlier
		// provisional text only when it is materially the same long-form content.
		const completionSummaries = resultBlocks
			.filter((result) => result.toolName === "attempt_completion")
			.map((result) =>
				this.normalizeTranscriptComparisonText(result.output ?? ""),
			)
			.filter((value): value is string => value.length > 0);
		const firstCompletionStartOffset = resultBlocks
			.filter((result) => result.toolName === "attempt_completion")
			.reduce<
				number | undefined
			>((earliest, result) => (earliest === undefined ? result.startOffset : Math.min(earliest, result.startOffset)), undefined);

		const blocks = [...callBlocks, ...resultBlocks, ...traceBlocks].sort(
			(left, right) => left.startOffset - right.startOffset,
		);
		if (blocks.length === 0) {
			container.textContent = text;
			return;
		}

		// Collect consecutive tool calls and thinking traces into activity groups
		// that render as a single collapsible block instead of individual cards.
		type ActivityItem =
			| { readonly kind: "thinking"; readonly message: string }
			| {
				readonly kind: "tool";
				readonly toolName: string;
				readonly displayMessage: string;
				readonly status: "running" | "complete" | "success" | "error";
				readonly output?: string;
				readonly diffCard?: HTMLElement;
			};

		let cursor = 0;
		let pendingActivity: ActivityItem[] = [];
		let pendingToolTraceName: string | undefined;
		let pendingToolTraceMessage: string | undefined;

		const addTool = (
			toolName: string,
			displayMessage: string,
			status: "running" | "complete" | "success" | "error",
			output?: string,
			diffCard?: HTMLElement,
		) => {
			pendingActivity.push({
				kind: "tool",
				toolName,
				displayMessage,
				status,
				output,
				diffCard,
			});
		};

		const flushPendingTool = () => {
			if (
				pendingToolTraceName !== undefined &&
				pendingToolTraceName !== "\x00completion"
			) {
				addTool(
					pendingToolTraceName,
					pendingToolTraceMessage ?? pendingToolTraceName,
					streaming ? "running" : "complete",
				);
				pendingToolTraceName = undefined;
				pendingToolTraceMessage = undefined;
			}
		};

		const flushActivity = () => {
			flushPendingTool();
			if (pendingActivity.length > 0) {
				container.appendChild(
					this.renderActivityGroup(pendingActivity, streaming),
				);
				pendingActivity = [];
			}
		};

		for (const block of blocks) {
			if (block.startOffset > cursor) {
				const segment = text.slice(cursor, block.startOffset);
				if (segment.trim().length > 0) {
					flushActivity();
					if (
						!this.shouldSuppressProvisionalCompletionSegment(
							segment,
							block.startOffset,
							firstCompletionStartOffset,
							completionSummaries,
						)
					) {
						this.appendPlainAssistantTextSegment(container, segment);
					}
				}
			}

			if (block.kind === "tool_call") {
				if (!hasTraceBlocks) {
					flushPendingTool();
					addTool(
						block.toolName,
						block.toolName,
						streaming ? "running" : "complete",
					);
				}
			} else if (block.kind === "tool_result") {
				const diffCard =
					block.success && block.output
						? this.renderToolResultDiffCard(block.toolName, block.output)
						: undefined;

				if (
					block.toolName === "attempt_completion" ||
					pendingToolTraceName === "\x00completion"
				) {
					flushActivity();
					this.appendMarkdownSegment(
						container,
						block.output ?? "",
						"vsclone-thread-message-text-segment",
					);
					pendingToolTraceName = undefined;
					pendingToolTraceMessage = undefined;
				} else if (hasTraceBlocks && pendingToolTraceName !== undefined) {
					addTool(
						pendingToolTraceName,
						pendingToolTraceMessage ?? pendingToolTraceName,
						block.success ? "success" : "error",
						block.output,
						diffCard ?? undefined,
					);
					pendingToolTraceName = undefined;
					pendingToolTraceMessage = undefined;
				} else {
					flushPendingTool();
					if (diffCard) {
						addTool(
							block.toolName,
							block.toolName,
							block.success ? "success" : "error",
							block.output,
							diffCard,
						);
					} else if (!hasTraceBlocks && block.output?.trim()) {
						addTool(
							block.toolName,
							block.toolName,
							block.success ? "success" : "error",
							block.output,
						);
					} else if (!hasTraceBlocks) {
						addTool(
							block.toolName,
							block.toolName,
							block.success ? "success" : "error",
						);
					}
				}
			} else {
				// Agent trace block
				if (block.traceType === "thinking") {
					flushPendingTool();
					pendingActivity.push({
						kind: "thinking",
						message: block.traceMessage ?? "",
					});
				} else if (block.traceType === "tool") {
					const msg = block.traceMessage ?? "";
					const isCompletion =
						msg.toLowerCase().includes("attempt") &&
						msg.toLowerCase().includes("completion");
					if (isCompletion) {
						flushPendingTool();
						pendingToolTraceName = "\x00completion";
						pendingToolTraceMessage = undefined;
					} else {
						flushPendingTool();
						pendingToolTraceName = msg;
						pendingToolTraceMessage = block.traceMessage;
					}
				} else if (block.traceType === "tool_result") {
					if (pendingToolTraceName === "\x00completion") {
						pendingToolTraceName = undefined;
						pendingToolTraceMessage = undefined;
					} else if (pendingToolTraceName !== undefined) {
						addTool(
							pendingToolTraceName,
							pendingToolTraceMessage ?? pendingToolTraceName,
							block.traceStatus === "success"
								? "success"
								: block.traceStatus === "error"
									? "error"
									: "complete",
							block.traceMessage,
						);
						pendingToolTraceName = undefined;
						pendingToolTraceMessage = undefined;
					} else {
						// Orphan tool_result trace - its tool was already paired via a
						// structured <tool_result> block. Silently discard the duplicate.
					}
				} else {
					flushPendingTool();
					pendingActivity.push({
						kind: "thinking",
						message: block.traceMessage ?? "",
					});
				}
			}
			cursor = block.endOffset;
		}

		flushActivity();

		if (cursor < text.length) {
			this.appendPlainAssistantTextSegment(container, text.slice(cursor));
		}
	}

	/**
	 * Turns transcript text into a whitespace-insensitive comparison key so restored summaries can
	 * be matched even when markdown serialization changed line wrapping between iterations.
	 */
	private normalizeTranscriptComparisonText(value: string): string {
		return value.replace(/\s+/g, " ").trim().toLowerCase();
	}

	/**
	 * The prompt asks the model to emit a single short "Thinking:" line immediately before each
	 * tool call, but streamed output still sometimes collapses multiple thinking lines and trailing
	 * prose into one run. We recover that structure here so the UI remains stable even when the
	 * model omits the expected newlines.
	 */
	private extractPlainAssistantSegments(text: string): ReadonlyArray<{
		readonly kind: "thinking" | "text";
		readonly value: string;
	}> {
		const segments: { kind: "thinking" | "text"; value: string }[] = [];
		let cursor = 0;
		let searchOffset = 0;

		const pushSegment = (kind: "thinking" | "text", value: string) => {
			if (!value.trim()) {
				return;
			}

			const previous =
				segments.length > 0 ? segments[segments.length - 1] : undefined;
			if (kind === "text" && previous?.kind === kind) {
				previous.value = `${previous.value}\n${value.trim()}`;
				return;
			}

			segments.push({ kind, value: value.trim() });
		};

		while (true) {
			const markerOffset = this.findNextPlainThinkingMarker(text, searchOffset);
			if (markerOffset < 0) {
				break;
			}

			pushSegment("text", text.slice(cursor, markerOffset));

			const messageStartOffset = markerOffset + "Thinking:".length;
			const nextMarkerOffset = this.findNextPlainThinkingMarker(
				text,
				messageStartOffset,
			);
			const messageEndOffset =
				nextMarkerOffset >= 0 ? nextMarkerOffset : text.length;
			const { message, trailingText } =
				this.splitThinkingMessageAndTrailingText(
					text.slice(messageStartOffset, messageEndOffset),
				);
			pushSegment("thinking", message);
			pushSegment("text", trailingText);

			cursor = messageEndOffset;
			searchOffset = messageEndOffset;
		}

		pushSegment("text", text.slice(cursor));
		return segments;
	}

	/**
	 * Plain-text thinking markers are only considered structural when they start a new sentence or
	 * line. This prevents normal prose like `The label "Thinking:"` from being misclassified.
	 */
	private findNextPlainThinkingMarker(
		text: string,
		fromOffset: number,
	): number {
		let searchOffset = fromOffset;
		while (true) {
			const markerOffset = text.indexOf("Thinking:", searchOffset);
			if (markerOffset < 0) {
				return -1;
			}

			if (
				markerOffset === 0 ||
				/[\s.!?;:)\]}"'`>-]/.test(text[markerOffset - 1])
			) {
				return markerOffset;
			}

			searchOffset = markerOffset + "Thinking:".length;
		}
	}

	/**
	 * Recover user-facing prose that the model occasionally appends to the same line as a thinking
	 * sentence. Because the prompt contract is "one short sentence", the first clear sentence break
	 * is the safest place to split the planning note from the visible answer text.
	 */
	private splitThinkingMessageAndTrailingText(value: string): {
		readonly message: string;
		readonly trailingText: string;
	} {
		const trimmed = value.trim();
		if (!trimmed) {
			return { message: "", trailingText: "" };
		}

		const proseBoundary = /([.!?]["')\]]*)(\s*)(?=[A-Z0-9"'`([{])/;
		const boundaryMatch = proseBoundary.exec(trimmed);
		if (!boundaryMatch) {
			return { message: trimmed, trailingText: "" };
		}

		const messageEndOffset = boundaryMatch.index + boundaryMatch[1].length;
		return {
			message: trimmed.slice(0, messageEndOffset).trim(),
			trailingText: trimmed
				.slice(boundaryMatch.index + boundaryMatch[0].length)
				.trim(),
		};
	}

	/**
	 * The model occasionally emits a draft summary before exploratory tool calls and then repeats
	 * the same content through attempt_completion once it has finished. Keeping both copies makes a
	 * restored thread look like the final summary rendered before the tool card. We only suppress
	 * long duplicate prose that occurs before the first completion result so short shared phrases
	 * such as "Task complete" are never hidden accidentally.
	 */
	private shouldSuppressProvisionalCompletionSegment(
		segment: string,
		segmentEndOffset: number,
		firstCompletionStartOffset: number | undefined,
		completionSummaries: readonly string[],
	): boolean {
		if (
			firstCompletionStartOffset === undefined ||
			segmentEndOffset > firstCompletionStartOffset ||
			completionSummaries.length === 0
		) {
			return false;
		}

		const normalizedSegment = this.normalizeTranscriptComparisonText(segment);
		if (normalizedSegment.length < 40) {
			return false;
		}

		return completionSummaries.some(
			(summary) =>
				summary === normalizedSegment ||
				summary.includes(normalizedSegment) ||
				normalizedSegment.includes(summary),
		);
	}

	private appendPlainAssistantTextSegment(
		container: HTMLElement,
		text: string,
	): void {
		if (!text || text.trim().length === 0) {
			return;
		}

		let normalLines: string[] = [];
		let thinkingMessages: string[] = [];

		const flushNormal = () => {
			const joined = normalLines.join("\n").trim();
			if (joined) {
				this.appendMarkdownSegment(
					container,
					joined,
					"vsclone-thread-message-text-segment",
				);
			}
			normalLines = [];
		};

		const flushThinking = () => {
			if (thinkingMessages.length > 0) {
				container.appendChild(
					this.renderCollapsibleThinkingBlock(thinkingMessages, false),
				);
				thinkingMessages = [];
			}
		};

		for (const segment of this.extractPlainAssistantSegments(text)) {
			if (segment.kind === "thinking") {
				flushNormal();
				thinkingMessages.push(segment.value);
				continue;
			}

			for (const line of segment.value.split("\n")) {
				const trimmed = line.trim();
				if (/^\[Agent iteration \d+\]$/.test(trimmed) || trimmed === "---") {
					// Internal agent loop markers: suppress them from the UI.
					continue;
				}

				flushThinking();
				normalLines.push(line);
			}
		}

		flushThinking();
		flushNormal();
	}

	/**
	 * Renders consecutive thinking traces as a collapsible disclosure block.
	 * While streaming, the block is expanded; once complete, it collapses to a single summary line.
	 */
	private renderCollapsibleThinkingBlock(
		messages: string[],
		streaming: boolean,
	): HTMLElement {
		const details = document.createElement("details");
		details.className = "vsclone-thinking-block";
		if (streaming) {
			details.open = true;
		}

		const summary = document.createElement("summary");
		summary.className = "vsclone-thinking-summary";

		const icon = document.createElement("span");
		icon.className = "codicon codicon-lightbulb vsclone-thinking-icon";
		summary.appendChild(icon);

		const label = document.createElement("span");
		label.textContent = streaming
			? localize("vsclone.thread.thinking.active", "Thinking...")
			: localize(
				"vsclone.thread.thinking.label",
				"Thinking ({0} steps)",
				messages.length.toString(),
			);
		summary.appendChild(label);

		details.appendChild(summary);

		const content = document.createElement("div");
		content.className = "vsclone-thinking-content";
		for (const msg of messages) {
			if (msg.trim()) {
				const step = document.createElement("div");
				step.className = "vsclone-thinking-step";
				step.textContent = msg;
				content.appendChild(step);
			}
		}
		details.appendChild(content);

		return details;
	}

	/**
	 * Renders a group of consecutive activity items (tool calls and thinking traces)
	 * as a single collapsible block instead of individual cards.
	 */
	private renderActivityGroup(
		items: ReadonlyArray<
			| { readonly kind: "thinking"; readonly message: string }
			| {
				readonly kind: "tool";
				readonly toolName: string;
				readonly displayMessage: string;
				readonly status: "running" | "complete" | "success" | "error";
				readonly output?: string;
				readonly diffCard?: HTMLElement;
			}
		>,
		streaming: boolean,
	): HTMLElement {
		const toolItems = items.filter(
			(i): i is Extract<typeof i, { kind: "tool" }> => i.kind === "tool",
		);
		const thinkingItems = items.filter(
			(i): i is Extract<typeof i, { kind: "thinking" }> =>
				i.kind === "thinking",
		);
		const hasDiffCards = toolItems.some((t) => t.diffCard);

		// Single tool with no thinking -> keep the existing card presentation so a lone tool call
		// does not get wrapped in a heavier grouped container.
		if (toolItems.length === 1 && thinkingItems.length === 0) {
			const t = toolItems[0];
			return this.renderToolCard(
				t.toolName,
				t.displayMessage,
				t.status,
				t.output,
				t.diffCard,
			);
		}

		// Thinking-only output should continue using the dedicated collapsible block because
		// that presentation already matches the intent of streamed reasoning content.
		if (toolItems.length === 0 && thinkingItems.length > 0) {
			return this.renderCollapsibleThinkingBlock(
				thinkingItems.map((t) => t.message),
				streaming,
			);
		}

		// Mixed or multi-item activity is grouped so the transcript stays compact while still
		// making the detailed timeline available on demand.
		const details = document.createElement("details");
		details.className = "vsclone-activity-group";
		if (streaming || hasDiffCards) {
			details.open = true;
		}

		const summaryEl = document.createElement("summary");
		summaryEl.className = "vsclone-activity-summary";

		const icon = document.createElement("span");
		icon.className = "codicon codicon-tools vsclone-activity-icon";
		summaryEl.appendChild(icon);

		const label = document.createElement("span");
		const isRunning =
			streaming && toolItems.some((t) => t.status === "running");
		if (isRunning) {
			label.textContent = localize(
				"vsclone.activity.running",
				"Running tools...",
			);
		} else {
			label.textContent =
				toolItems.length === 1
					? localize("vsclone.activity.single", "Used 1 tool")
					: localize(
						"vsclone.activity.count",
						"Used {0} tools",
						toolItems.length.toString(),
					);
		}
		summaryEl.appendChild(label);

		details.appendChild(summaryEl);

		const content = document.createElement("div");
		content.className = "vsclone-activity-content";

		// Render thinking as a nested collapsible if present
		if (thinkingItems.length > 0) {
			content.appendChild(
				this.renderCollapsibleThinkingBlock(
					thinkingItems.map((t) => t.message),
					streaming,
				),
			);
		}

		// Render compact tool rows
		for (const tool of toolItems) {
			content.appendChild(
				this.renderCompactToolRow(
					tool.toolName,
					tool.displayMessage,
					tool.status,
				),
			);
			if (tool.diffCard) {
				content.appendChild(tool.diffCard);
			}
		}

		details.appendChild(content);
		return details;
	}

	/**
	 * Renders a single tool call as a compact one-line row with status icon, tool icon, and label.
	 */
	private renderCompactToolRow(
		toolName: string,
		displayMessage: string,
		status: "running" | "complete" | "success" | "error",
	): HTMLElement {
		const row = document.createElement("div");
		row.className = "vsclone-activity-row";
		row.classList.add(`status-${status}`);

		const statusIcon = document.createElement("span");
		statusIcon.className = "vsclone-activity-row-status";
		switch (status) {
			case "running":
				statusIcon.classList.add(
					"codicon",
					"codicon-loading",
					"codicon-modifier-spin",
				);
				break;
			case "success":
				statusIcon.classList.add("codicon", "codicon-check");
				break;
			case "error":
				statusIcon.classList.add("codicon", "codicon-error");
				break;
			default:
				statusIcon.classList.add("codicon", "codicon-check");
				break;
		}
		row.appendChild(statusIcon);

		const toolIcon = document.createElement("span");
		toolIcon.className = `codicon vsclone-activity-row-icon ${this.getToolIconClass(toolName)}`;
		row.appendChild(toolIcon);

		const labelEl = document.createElement("span");
		labelEl.className = "vsclone-activity-row-label";
		labelEl.textContent = displayMessage;
		row.appendChild(labelEl);

		return row;
	}

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

		const fileIcon = document.createElement("span");
		fileIcon.className = "codicon codicon-file vsclone-tool-diff-title-icon";
		titleBar.appendChild(fileIcon);

		const filename = filePath.split('/').pop() ?? filePath;
		const langLabel = this.getLanguageLabelFromFilename(filename);
		const fileLabel = document.createElement("span");
		fileLabel.className = "vsclone-tool-diff-title-filename";
		fileLabel.textContent = `${langLabel} ${filename}`;
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

			const gutter = document.createElement("span");
			gutter.className = "vsclone-tool-diff-gutter";
			gutter.textContent = "-";
			lineEl.appendChild(gutter);

			const content = document.createElement("span");
			content.textContent = line;
			lineEl.appendChild(content);

			body.appendChild(lineEl);
		}

		for (const line of replaceLines) {
			const lineEl = document.createElement("div");
			lineEl.className = "vsclone-tool-diff-line added";

			const gutter = document.createElement("span");
			gutter.className = "vsclone-tool-diff-gutter";
			gutter.textContent = "+";
			lineEl.appendChild(gutter);

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

	/**
	 * Legacy tool results used `@@ change N @@` markers that described hunk order but not the
	 * actual file location. To keep older transcript cards useful after we switched formats, the
	 * renderer rehydrates a best-effort line mapping by matching the modified hunk text against
	 * the current file contents.
	 */
	private async resolveLegacyDiffNavigation(
		fileUri: string,
		diff: string,
	): Promise<
		| {
			readonly titleNavigation: IDiffLineNavigationState;
			readonly lineNumbers: Map<number, number>;
		}
		| undefined
	> {
		const diffLines = diff.split("\n");
		const legacyHunks = this.parseLegacyDiffHunks(diffLines);
		if (legacyHunks.length === 0) {
			return undefined;
		}

		const content = await this.readDiffTargetContents(URI.parse(fileUri));
		if (content === undefined) {
			return undefined;
		}

		const fileLines = splitLines(content).map((line) =>
			line.replace(/\r$/, ""),
		);
		const lineNumbers = new Map<number, number>();
		const titleNavigation: IDiffLineNavigationState = {};
		let searchStartIndex = 0;

		for (const hunk of legacyHunks) {
			const modifiedLines = hunk.lines
				.filter((line) => !line.startsWith("-"))
				.map((line) => this.stripDiffLinePrefix(line));
			const startIndex = this.findLegacyDiffStartIndex(
				fileLines,
				modifiedLines,
				searchStartIndex,
			);
			if (startIndex === undefined) {
				continue;
			}

			let currentLineNumber = startIndex + 1;
			titleNavigation.startLineNumber ??= currentLineNumber;
			for (let index = 0; index < hunk.lines.length; index++) {
				const rawLine = hunk.lines[index];
				lineNumbers.set(hunk.lineIndexes[index], currentLineNumber);
				if (!rawLine.startsWith("-")) {
					titleNavigation.endLineNumber =
						titleNavigation.endLineNumber !== undefined
							? Math.max(titleNavigation.endLineNumber, currentLineNumber)
							: currentLineNumber;
					currentLineNumber += 1;
				}
			}

			searchStartIndex = Math.max(searchStartIndex, currentLineNumber - 1);
		}

		if (
			titleNavigation.startLineNumber !== undefined &&
			titleNavigation.endLineNumber === undefined
		) {
			titleNavigation.endLineNumber = titleNavigation.startLineNumber;
		}

		return lineNumbers.size > 0 ? { titleNavigation, lineNumbers } : undefined;
	}

	private parseLegacyDiffHunks(
		diffLines: readonly string[],
	): readonly ILegacyDiffHunk[] {
		const hunks: ILegacyDiffHunk[] = [];
		let currentLineIndexes: number[] | undefined;
		let currentLines: string[] | undefined;

		for (let index = 0; index < diffLines.length; index++) {
			const line = diffLines[index];
			if (/^@@\s*change\s+\d+\s*@@$/.test(line)) {
				if (currentLineIndexes && currentLines && currentLines.length > 0) {
					hunks.push({ lineIndexes: currentLineIndexes, lines: currentLines });
				}
				currentLineIndexes = [];
				currentLines = [];
				continue;
			}

			if (!currentLineIndexes || !currentLines) {
				continue;
			}

			if (line.startsWith("@@")) {
				if (currentLines.length > 0) {
					hunks.push({ lineIndexes: currentLineIndexes, lines: currentLines });
				}
				currentLineIndexes = undefined;
				currentLines = undefined;
				continue;
			}

			if (line.startsWith("---") || line.startsWith("+++")) {
				continue;
			}

			currentLineIndexes.push(index);
			currentLines.push(line);
		}

		if (currentLineIndexes && currentLines && currentLines.length > 0) {
			hunks.push({ lineIndexes: currentLineIndexes, lines: currentLines });
		}

		return hunks;
	}

	private async readDiffTargetContents(
		resource: URI,
	): Promise<string | undefined> {
		const modelService = this.modelService as IModelService | undefined;
		const fileService = this.fileService as IFileService | undefined;
		const openModel = modelService?.getModel(resource);
		if (openModel) {
			return openModel.getValue();
		}

		if (!fileService) {
			return undefined;
		}

		try {
			const fileContents = await fileService.readFile(resource);
			return fileContents.value.toString();
		} catch {
			return undefined;
		}
	}

	private findLegacyDiffStartIndex(
		fileLines: readonly string[],
		modifiedLines: readonly string[],
		searchStartIndex: number,
	): number | undefined {
		const exactMatch = this.findLegacyDiffStartIndexWithComparator(
			fileLines,
			modifiedLines,
			searchStartIndex,
			(left, right) => left === right,
		);
		if (exactMatch !== undefined) {
			return exactMatch;
		}

		return this.findLegacyDiffStartIndexWithComparator(
			fileLines,
			modifiedLines,
			searchStartIndex,
			(left, right) => left.trim() === right.trim(),
		);
	}

	private findLegacyDiffStartIndexWithComparator(
		fileLines: readonly string[],
		modifiedLines: readonly string[],
		searchStartIndex: number,
		equals: (left: string, right: string) => boolean,
	): number | undefined {
		if (modifiedLines.length === 0) {
			return undefined;
		}

		for (
			let blockLength = modifiedLines.length;
			blockLength >= 1;
			blockLength--
		) {
			for (
				let offset = 0;
				offset <= modifiedLines.length - blockLength;
				offset++
			) {
				const block = modifiedLines.slice(offset, offset + blockLength);
				const matchIndex = this.findContiguousLineBlock(
					fileLines,
					block,
					searchStartIndex,
					equals,
				);
				if (matchIndex !== undefined) {
					return Math.max(searchStartIndex, matchIndex - offset);
				}
			}
		}

		return undefined;
	}

	private findContiguousLineBlock(
		fileLines: readonly string[],
		block: readonly string[],
		searchStartIndex: number,
		equals: (left: string, right: string) => boolean,
	): number | undefined {
		if (block.length === 0 || fileLines.length < block.length) {
			return undefined;
		}

		for (
			let index = searchStartIndex;
			index <= fileLines.length - block.length;
			index++
		) {
			let matches = true;
			for (let blockIndex = 0; blockIndex < block.length; blockIndex++) {
				if (!equals(fileLines[index + blockIndex], block[blockIndex])) {
					matches = false;
					break;
				}
			}
			if (matches) {
				return index;
			}
		}

		return undefined;
	}

	private stripDiffLinePrefix(line: string): string {
		if (
			(line.startsWith("+") && !line.startsWith("+++")) ||
			(line.startsWith("-") && !line.startsWith("---")) ||
			line.startsWith(" ")
		) {
			return line.slice(1);
		}

		return line;
	}

	private formatDiffLineLabel(
		navigation: IDiffLineNavigationState,
	): string | undefined {
		if (navigation.startLineNumber === undefined) {
			return undefined;
		}

		const endLineNumber =
			navigation.endLineNumber ?? navigation.startLineNumber;
		return endLineNumber > navigation.startLineNumber
			? localize(
				"vsclone.thread.toolDiff.lineRange",
				"Ln {0}-{1}",
				navigation.startLineNumber.toString(),
				endLineNumber.toString(),
			)
			: localize(
				"vsclone.thread.toolDiff.lineNumber",
				"Ln {0}",
				navigation.startLineNumber.toString(),
			);
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
		let lineBadge: HTMLAnchorElement | HTMLSpanElement | undefined;
		const renderedLineEntries: Array<{
			readonly sourceLineIndex: number;
			readonly state: IDiffLineNavigationState;
			readonly line: HTMLElement;
			readonly gutter?: HTMLElement;
		}> = [];

		if (filename) {
			const langLabel = this.getLanguageLabelFromFilename(filename);
			const fileIcon = document.createElement("span");
			fileIcon.className = "codicon codicon-file vsclone-tool-diff-title-icon";
			titleBar.appendChild(fileIcon);

			// Make the filename a clickable link that opens the file
			const fileLabel = document.createElement("a");
			fileLabel.className = "vsclone-tool-diff-title-filename";
			fileLabel.textContent = `${langLabel} ${filename}`;
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

			if (fileUri) {
				const anchorLineBadge = document.createElement("a");
				anchorLineBadge.className = "vsclone-tool-diff-title-line";
				const lineLabel = this.formatDiffLineLabel(titleNavigation);
				anchorLineBadge.hidden = lineLabel === undefined;
				if (
					lineLabel !== undefined &&
					titleNavigation.startLineNumber !== undefined
				) {
					anchorLineBadge.textContent = lineLabel;
					anchorLineBadge.title = localize(
						"vsclone.thread.toolDiff.openLineTitle",
						"Open line {0}",
						titleNavigation.startLineNumber.toString(),
					);
				}
				anchorLineBadge.href = "#";
				anchorLineBadge.addEventListener("click", (e) => {
					e.preventDefault();
					this.openDiffTarget(fileUri, titleNavigation);
				});
				lineBadge = anchorLineBadge;
				titleBar.appendChild(anchorLineBadge);
			} else if (titleNavigation.startLineNumber !== undefined) {
				lineBadge = document.createElement("span");
				lineBadge.className = "vsclone-tool-diff-title-line";
				lineBadge.textContent = this.formatDiffLineLabel(titleNavigation) ?? "";
				titleBar.appendChild(lineBadge);
			}

			if (
				fileUri &&
				titleNavigation.startLineNumber === undefined &&
				/^@@\s*change\s+\d+\s*@@/m.test(parsedDiff.diff)
			) {
				void this.resolveLegacyDiffNavigation(fileUri, parsedDiff.diff).then(
					(resolvedNavigation) => {
						if (!resolvedNavigation) {
							return;
						}

						titleNavigation.startLineNumber =
							resolvedNavigation.titleNavigation.startLineNumber;
						titleNavigation.endLineNumber =
							resolvedNavigation.titleNavigation.endLineNumber;
						if (titleNavigation.startLineNumber !== undefined) {
							fileLabel.title = localize(
								"vsclone.thread.toolDiff.openAtLineTitle",
								"Open {0} at line {1}",
								filename,
								titleNavigation.startLineNumber.toString(),
							);
							if (lineBadge) {
								lineBadge.hidden = false;
								lineBadge.textContent =
									this.formatDiffLineLabel(titleNavigation) ?? "";
								lineBadge.title = localize(
									"vsclone.thread.toolDiff.openLineTitle",
									"Open line {0}",
									titleNavigation.startLineNumber.toString(),
								);
							}
						}

						for (const entry of renderedLineEntries) {
							const resolvedLineNumber = resolvedNavigation.lineNumbers.get(
								entry.sourceLineIndex,
							);
							if (resolvedLineNumber !== undefined) {
								entry.state.startLineNumber = resolvedLineNumber;
								entry.state.endLineNumber = resolvedLineNumber;
								if (entry.gutter) {
									entry.gutter.textContent = resolvedLineNumber.toString();
								}
								entry.line.classList.add("clickable");
								entry.line.title = localize(
									"vsclone.thread.toolDiff.openChangedLineTitle",
									"Open changed line {0}",
									resolvedLineNumber.toString(),
								);
							}
						}
					},
				);
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

			let gutter: HTMLElement | undefined;
			if (diffLine.kind !== "file" && diffLine.kind !== "hunk") {
				gutter = document.createElement("span");
				gutter.className = "vsclone-tool-diff-gutter";
				gutter.textContent =
					lineNavigation.startLineNumber !== undefined
						? lineNavigation.startLineNumber.toString()
						: "";
				line.appendChild(gutter);
			}

			// Syntax-highlighted content keeps the diff prefix visible while the line gutter stays separate.
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
			renderedLineEntries.push({
				sourceLineIndex: diffLine.sourceLineIndex,
				state: lineNavigation,
				line,
				gutter,
			});

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
		const directState = this.threadRuntimeService.getAssistantEditApplicationState?.(target.threadId, target.id);
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
	 * Active edit application is runtime-owned now. Once a thread has runtime state we stop
	 * scanning legacy history turns and only auto-apply runtime assistant messages from the
	 * active branch. History-imported assistant edits remain manual-only so opening an old thread
	 * never mutates the workspace just because the pane hydrated runtime from archived turns.
	 * Auto-apply is additionally gated on the runtime being idle so file edits cannot race an
	 * in-flight assistant/tool run.
	 */
	private maybeAutoApplyCompletedTurns(): void {
		if (!this.activeThreadId) {
			return;
		}
		const runtimeState = this.getThreadRuntimeState(this.activeThreadId);
		if (!runtimeState) {
			return;
		}
		this.maybeAutoApplyRuntimeAssistantMessages(runtimeState);
	}

	private maybeAutoApplyRuntimeAssistantMessages(state: IVSCloneThreadRuntimeState): void {
		if (this.getImportingRuntimeThreadIds().has(state.threadId)) {
			return;
		}
		if (this.isThreadBusy(state.threadId)) {
			return;
		}
		for (const message of state.messages) {
			if (message.role !== "assistant") {
				continue;
			}
			if (this.getRuntimeAssistantMessageMode(state, message) === "plan") {
				continue;
			}
			const visibleText = this.stripRuntimeAssistantWorkflowMarkup(message.content);
			if (!visibleText || !(this.editApplicationService?.hasSearchReplaceBlocks(visibleText) ?? false)) {
				continue;
			}
			const target = {
				threadId: state.threadId,
				id: message.id,
				responseText: visibleText,
			};
			if (this.isManualOnlyRuntimeAssistantApplyMessage(message)) {
				continue;
			}
			if (this.pendingAssistantApplyMessageIds.has(message.id) || this.getAssistantApplyState(target)) {
				continue;
			}

			this.setAssistantApplyState(target, { phase: "pending" });
			void this.runAutoApply(target, visibleText);
		}
	}

	private async runAutoApply(target: IAssistantApplyTarget, responseText: string): Promise<void> {
		try {
			const applyResult = await this.editApplicationService.startApplyingSearchReplaceBlocks(responseText);
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
			return runtimeState.isRunning || runtimeState.streamState.kind !== "idle";
		}
		return false;
	}

	private applyRailLayout(): void {
		if (!this.rootContainer || !this.railContainer || !this.railResizeHandle) {
			return;
		}

		this.rootContainer.classList.toggle("rail-hidden", !this.railVisible);
		this.rootContainer.classList.toggle("history-screen", this.railVisible);
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
			this.modelSelectionService.getCurrentSelectionForThread(
				threadId ?? "",
				"chat",
			);
		if (!selectedModel) {
			return undefined;
		}

		const selectedModelDescriptor = this.modelCatalogService.getModel(
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
			this.modelSelectionService.getCurrentSelectionForThread(
				this.activeThreadId ?? "",
				"chat",
			);
		const selectedModelDescriptor = selectedModel
			? this.modelCatalogService.getModel(selectedModel.modelIdentifier)
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
			this.modelSelectionService.getCurrentSelectionForThread(
				this.activeThreadId ?? "",
				"chat",
			);
		const selectedModelDescriptor = selectedModel
			? this.modelCatalogService.getModel(selectedModel.modelIdentifier)
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

		await this.modelSelectionService.setSelectionForThread(
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

		const runtimeState = this.getThreadRuntimeState(candidateThreadId);
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

		const runtimeState = this.getThreadRuntimeState(candidateThreadId);
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
	): IVSCloneChatHistoryThread | undefined {
		const cached = this.threadsById.get(threadId);
		if (cached) {
			return cached;
		}

		return this.historyService
			.getThreads({ includeArchived: true })
			.find((thread) => thread.threadId === threadId);
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
		this.refreshPlanModeControl();
		this.refreshModelControls();
		this.refreshConversation();
		this.railVisible = false;
		this.applyRailLayout();
		this.focusInput();
	}
}
