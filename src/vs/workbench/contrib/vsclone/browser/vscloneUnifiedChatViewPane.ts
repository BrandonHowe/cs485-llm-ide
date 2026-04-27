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
	isHTMLElement,
} from "../../../../base/browser/dom.js";
import { RunOnceScheduler } from "../../../../base/common/async.js";
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
import { IFileService } from "../../../../platform/files/common/files.js";
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
import { VSCloneThreadRail } from "./vscloneThreadRail.js";
import { IVSCloneChatThreadService } from "./vscloneChatThreadService.js";
import { VSCloneModelSwitcherWidget } from "./vscloneModelSwitcherWidget.js";
import { IVSCloneProviderConfigurationBridge } from "./vscloneProviderConfigurationBridge.js";
import { IVSCloneOAuthService } from "../common/vscloneOAuthService.js";
import { defaultOAuthProviderConfig, type IVSCloneOAuthProviderState } from "../common/vscloneOAuthTypes.js";
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
import type { IVSCloneTokenUsage } from "../common/vscloneLLMMessageTypes.js";
import {
	type IVSCloneThreadRuntimeAssistantEditSuggestion,
	type IVSCloneThreadRuntimeCatalogEntry,
	type IVSCloneThreadRuntimeCatalogQuery,
	type IVSCloneThreadRuntimeMessage,
	type IVSCloneThreadRuntimeState,
} from "../common/vscloneThreadRuntimeTypes.js";
import type { IVSCloneContextSelection } from "../common/vscloneContextSelectionTypes.js";
import { IVSCloneMentionSearchService, type IVSCloneMentionResult } from "./vscloneMentionSearchService.js";
import { CancellationTokenSource } from "../../../../base/common/cancellation.js";
import { ILanguageService } from "../../../../editor/common/languages/language.js";
import { ICodeEditorService } from "../../../../editor/browser/services/codeEditorService.js";
import { VSCloneAutocompleteDebounceMsMaximum } from "./vscloneAutocompleteService.js";
import { formatContextSelections } from "../common/vsclonePrompts.js";

const railWidthSetting = VSCloneChatRailWidthSetting;
const modelSwitcherEnabledSetting = "vsclone.modelSwitcher.enabled";
const autocompleteEnabledSetting = "vsclone.autocomplete.enabled";
const autocompleteDebounceMsSetting = "vsclone.autocomplete.debounceMs";
const booleanSettingDefaults: Record<string, boolean> = {
	// Keep settings-page toggles aligned with registered configuration defaults when the
	// configuration service has no explicit profile value yet.
	[modelSwitcherEnabledSetting]: true,
	[autocompleteEnabledSetting]: true,
};
const railMinWidth = 220;
const railMaxWidth = 520;
const compactRailBreakpoint = 900;
const estimatedCharsPerToken = 4;
let contextUsageIdPool = 0;

const modelContextWindowById: readonly [RegExp, number][] = [
	[/gpt-5/i, 400_000],
	[/claude.*4|haiku-4/i, 200_000],
	[/claude-3/i, 200_000],
	[/gemini-3/i, 1_000_000],
	[/gemini-2\.5/i, 1_000_000],
];

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

// Compact relative-time label for the thread rail ("now", "37m ago", "2h ago", "3d ago"). Anything
// past a week falls back to a short "Mon d" label so year-old threads stay readable.
function formatThreadRailRelativeTime(timestamp: number, now: number = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (seconds < 45) {
		return localize("vsclone.rail.time.now", "now");
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return localize("vsclone.rail.time.minutes", "{0}m ago", minutes);
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return localize("vsclone.rail.time.hours", "{0}h ago", hours);
	}
	const days = Math.floor(hours / 24);
	if (days < 7) {
		return localize("vsclone.rail.time.days", "{0}d ago", days);
	}
	const date = new Date(timestamp);
	const month = date.toLocaleString(undefined, { month: "short" });
	return localize("vsclone.rail.time.monthDay", "{0} {1}", month, date.getDate());
}

/**
 * The runtime stores user content with the serialized `---\nSELECTIONS\n...` block so the LLM sees
 * the attached files on every replay. For the transcript we strip that block off because chips
 * already represent the attachment visually, keeping the bubble focused on the typed instructions.
 */
function stripSelectionsBlock(content: string): string {
	const marker = '\n---\nSELECTIONS\n';
	const markerIndex = content.indexOf(marker);
	if (markerIndex === -1) {
		// Covers the edge case of a turn whose instructions were empty; the serialized block then
		// begins at the very start of the stored content without a preceding newline.
		if (content.startsWith('---\nSELECTIONS\n')) {
			return '';
		}
		return content;
	}
	return content.slice(0, markerIndex);
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

// Heuristic error detection for assistant content produced by `applyLoopError`. The runtime
// stores upstream API failures (e.g. "400 status code (no body)"), tool-approval crashes
// ("Tool approval failed for ..."), and safety-limit terminations as a plain assistant message.
// We detect those shapes so the renderer can surface an error row instead of leaking the raw
// string as prose. Single-line + known-error-prefix keeps false positives low.
const RUNTIME_ERROR_PATTERNS: readonly RegExp[] = [
	/^\d{3}\b.*\bstatus code\b/i,
	/^Request failed\b/i,
	/^Tool approval failed for\b/i,
	/^Agent loop exceeded the safety limit\b/i,
	/^Not signed in to\b/i,
	/^(Bad|Unexpected) status code\b/i,
];

function looksLikeRuntimeErrorContent(content: string): boolean {
	const trimmed = content.trim();
	if (trimmed.length === 0 || trimmed.includes('\n')) {
		return false;
	}
	return RUNTIME_ERROR_PATTERNS.some(pattern => pattern.test(trimmed));
}

function toHumanReadableRuntimeError(raw: string): string {
	const trimmed = raw.trim();
	const statusMatch = /^(\d{3})\b.*\bstatus code\b/i.exec(trimmed);
	if (statusMatch) {
		return localize(
			"vsclone.thread.runtime.error.requestFailed",
			"Request failed ({0})",
			statusMatch[1],
		);
	}
	return trimmed;
}

function formatTokenEstimate(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1)}M`;
	}
	if (tokens >= 1_000) {
		return `${(tokens / 1_000).toFixed(1)}K`;
	}
	return String(tokens);
}

interface IContextUsageDisplay {
	readonly usage: IVSCloneTokenUsage;
	readonly characters?: number;
	readonly percentage: number;
	readonly label: string;
}

// The compact tool row and diff card header share the same truncation rule: show just the
// filename (the only segment a user actually reads in chat) and keep the full path on hover.
// Works for raw paths, file:// URIs, and falls back to the input for glob patterns or text.
function toCompactTargetLabel(rawTarget: string): string {
	if (!rawTarget) {
		return rawTarget;
	}
	let withoutScheme = rawTarget;
	const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\//i.exec(rawTarget);
	if (schemeMatch) {
		withoutScheme = rawTarget.slice(schemeMatch[0].length);
	}
	const stripped = withoutScheme.replace(/\/+$/, '');
	const lastSegment = stripped.split('/').pop();
	return lastSegment && lastSegment.length > 0 ? lastSegment : rawTarget;
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
	deleteThread?(threadId: string): boolean | Promise<boolean>;
}

type IVSClonePaneThreadCatalogEntry = IVSCloneThreadRuntimeCatalogEntry;

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
	private settingsContainer: HTMLElement | undefined;
	private settingsFocusTarget: HTMLElement | undefined;
	private composerInput: HTMLTextAreaElement | undefined;
	private composerSendButton: HTMLButtonElement | undefined;
	private composerContextUsageButton: HTMLButtonElement | undefined;
	private composerContextUsageProgressPath: SVGCircleElement | undefined;
	private composerContextUsagePopover: HTMLElement | undefined;
	private composerContextUsagePopoverPinned = false;
	private modelSwitcher: VSCloneModelSwitcherWidget | undefined;
	private modelSwitcherHost: HTMLElement | undefined;
	private planModeContainer: HTMLElement | undefined;
	private planModeSwitchButton: HTMLButtonElement | undefined;
	private addContextMenuToggle: HTMLSpanElement | undefined;
	private reasoningEffortContainer: HTMLElement | undefined;
	private reasoningEffortSelect: HTMLSelectElement | undefined;
	private reasoningEnabledContainer: HTMLElement | undefined;
	private reasoningEnabledInput: HTMLInputElement | undefined;
	private reasoningBudgetContainer: HTMLElement | undefined;
	private reasoningBudgetInput: HTMLInputElement | undefined;
	private reasoningBudgetValueLabel: HTMLElement | undefined;
	private composerImageStrip: HTMLElement | undefined;
	private pendingImages: IPendingImageAttachment[] = [];
	private composerContextStrip: HTMLElement | undefined;
	private pendingContextSelections: IVSCloneContextSelection[] = [];
	private pendingContextSelectionsCharacterKey = '';
	private pendingContextSelectionsCharacters = 0;
	private pendingContextSelectionsCharacterVersion = 0;
	private mentionMenuRoot: HTMLElement | undefined;
	private mentionMenuList: HTMLElement | undefined;
	private mentionMenuHeaderQuery: HTMLElement | undefined;
	private mentionMenuOpen = false;
	private mentionMenuQuery = '';
	private mentionMenuItems: IVSCloneMentionResult[] = [];
	private mentionMenuActiveIndex = 0;
	private mentionMenuTriggerStart = -1;
	private mentionSearchCts: CancellationTokenSource | undefined;

	private readonly rail = this._register(
		this.instantiationService.createInstance(VSCloneThreadRail),
	);
	private readonly threadsById = new Map<string, IVSClonePaneThreadCatalogEntry>();
	// Durable apply summaries now live on the runtime branch via the assistant-edit application API.
	// The pane only keeps a transient pending set so repeated refreshes do not launch duplicate
	// browser-local apply work while the engine bridge is still running.
	private readonly pendingAssistantApplyMessageIds = new Set<string>();
	private readonly lastSeenAssistantMessageByThread = new Map<string, string>();
	private readonly readBaselineInitializedThreads = new Set<string>();
	/**
	 * Sticky open/closed state for each assistant turn's reasoning dropdown. Mirrors Void's
	 * `ReasoningWrapper` behavior: auto-open while streaming, auto-collapse when the final text
	 * arrives, but respect a manual toggle afterwards. Stored by message id so repeated refresh
	 * passes (which rebuild DOM from scratch) don't reset the user's explicit toggle.
	 */
	private readonly reasoningPanelStateByMessageId = new Map<string, { userToggled: boolean; open: boolean }>();
	// Streaming rows are rebuilt from scratch on every refresh. Keep the last text by assistant id
	// so only the newly appended suffix is animated instead of replaying the whole answer.
	private readonly streamedAssistantTextByMessageId = new Map<string, string>();
	// Runtime transcript nodes are also rebuilt from scratch on refresh. Keep stable element keys so
	// tool rows, approval prompts, status rows, and reasoning panels fade only when they first appear.
	private readonly enteredRuntimeElementKeys = new Set<string>();
	private currentRuntimeElementKeys = new Set<string>();
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
	private settingsVisible = false;
	private conversationHasContent = false;

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
		@IVSCloneOAuthService
		private readonly oauthService: IVSCloneOAuthService,
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
		@IFileService private readonly fileService: IFileService,
		@IVSCloneMentionSearchService
		private readonly mentionSearchService: IVSCloneMentionSearchService,
		@ILanguageService private readonly languageService: ILanguageService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
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

		this.railWidth = this.getConfiguredRailWidth();

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
			this.rail.onDidChangeSearchQuery(() => {
				this.refreshRailRows();
			}),
		);
		this._register(
			this.rail.onDidRequestNewChat(() => {
				this.showComposerForNewChat();
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
				}
			}),
		);

		this._register(
			this.threadRuntimeService.onDidChangeState((state) => {
				this.syncThreadCatalogEntryFromRuntime(state);
				if (state.threadId === this.activeThreadId) {
					this.markLatestAssistantMessageSeen(state.threadId, state);
				}
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
				if (this.settingsVisible) {
					this.renderSettingsPage();
				}
			}),
		);
		this._register(
			this.oauthService.onDidChangeState(() => {
				if (this.settingsVisible) {
					this.renderSettingsPage();
				}
			}),
		);
		this._register(
			this.configurationService.onDidChangeConfiguration((event) => {
				if (!event.affectsConfiguration("vsclone")) {
					return;
				}
				if (event.affectsConfiguration(modelSwitcherEnabledSetting)) {
					this.updateModelSwitcherVisibility();
				}
				if (event.affectsConfiguration(railWidthSetting)) {
					this.updateRailWidthFromConfiguration();
				}
				if (this.settingsVisible) {
					this.renderSettingsPage();
				}
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
		if (this.settingsVisible) {
			// Settings mode hides the composer, so focus must remain on a visible settings control
			// when the workbench asks the view pane to restore focus.
			this.settingsFocusTarget?.focus();
			return;
		}
		this.focusInput();
	}

	// Keep the ViewPane lifecycle overrides protected so the production mangler can preserve the
	// base-class visibility contract while still letting this pane customize layout/rendering.
	protected override layoutBody(height: number, width: number): void {
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
	}

	toggleRail(): void {
		this.railVisible = !this.railVisible;
		this.applyRailLayout();
		if (!this.railVisible) {
			this.focusInput();
		}
	}

	openModelPicker(): void {
		if (!this.isModelSwitcherEnabled()) {
			// The widget may still be constructed so related controls can refresh together, but
			// command entry points must not open UI that configuration has intentionally hidden.
			return;
		}
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
		if (this.settingsVisible) {
			this.renderSettingsPage();
		}
	}

	openSettingsPage(): void {
		this.settingsVisible = true;
		// Settings render inside the conversation region, so close the thread rail first to avoid
		// focusing controls that are still covered by the rail surface.
		this.railVisible = false;
		this.applyRailLayout();
		const focusTarget = this.renderSettingsPage();
		this.updateConversationModeVisibility();
		// Opening settings hides the composer; focus must move with the visible surface so keyboard
		// users and screen readers are not left in hidden composer or menu content.
		focusTarget?.focus();
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
		this.markLatestAssistantMessageSeen(targetThreadId, runtimeState);
		this.railVisible = false;
		// Thread navigation is a return to chat content, so clear the settings surface before
		// focusing the composer to avoid sending focus into UI that remains visually hidden.
		this.settingsVisible = false;
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
		this.pendingContextSelections = this.toPendingContextSelections(latestPrompt.contextSelections);
		this.renderContextChipStrip();
		this.updateComposerMetrics();
		this.focusInput();
	}

	protected override renderBody(parent: HTMLElement): void {
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
		const threadButtonIcon = document.createElement("span");
		threadButtonIcon.className = "codicon codicon-menu";
		threadButtonIcon.setAttribute("aria-hidden", "true");
		const threadButtonText = document.createElement("span");
		threadButtonText.textContent = localize(
			"vsclone.thread.actions.history",
			"Threads",
		);
		threadButton.appendChild(threadButtonIcon);
		threadButton.appendChild(threadButtonText);
		// Mirror tooltip text into an accessible name so screen readers announce this icon-like action clearly.
		const threadButtonLabel = localize(
			"vsclone.thread.actions.history.tooltip",
			"Show threads",
		);
		threadButton.title = threadButtonLabel;
		threadButton.setAttribute("aria-label", threadButtonLabel);
		actions.appendChild(threadButton);

		const spacer = document.createElement("div");
		spacer.className = "vsclone-thread-actions-spacer";
		actions.appendChild(spacer);

		const newChatButton = document.createElement("button");
		newChatButton.type = "button";
		newChatButton.className = "vsclone-thread-action-overflow";
		const newChatButtonLabel = localize(
			"vsclone.thread.actions.newChat",
			"Start new chat",
		);
		newChatButton.title = newChatButtonLabel;
		newChatButton.setAttribute("aria-label", newChatButtonLabel);
		const newChatButtonIcon = document.createElement("span");
		newChatButtonIcon.className = "codicon codicon-add";
		newChatButtonIcon.setAttribute("aria-hidden", "true");
		newChatButton.appendChild(newChatButtonIcon);
		actions.appendChild(newChatButton);

		const settingsButton = document.createElement("button");
		settingsButton.type = "button";
		settingsButton.className = "vsclone-thread-action-overflow";
		const settingsButtonLabel = localize(
			"vsclone.thread.actions.settings",
			"Open settings",
		);
		settingsButton.title = settingsButtonLabel;
		settingsButton.setAttribute("aria-label", settingsButtonLabel);
		const settingsButtonIcon = document.createElement("span");
		settingsButtonIcon.className = "codicon codicon-settings-gear";
		settingsButtonIcon.setAttribute("aria-hidden", "true");
		settingsButton.appendChild(settingsButtonIcon);
		actions.appendChild(settingsButton);

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
		const emptyIcon = document.createElement("div");
		emptyIcon.className = "vsclone-thread-empty-state-icon";
		const emptyIconGlyph = document.createElement("span");
		emptyIconGlyph.className = "codicon codicon-sparkle";
		emptyIconGlyph.setAttribute("aria-hidden", "true");
		emptyIcon.appendChild(emptyIconGlyph);
		const emptyTitle = document.createElement("div");
		emptyTitle.className = "vsclone-thread-empty-state-title";
		emptyTitle.textContent = localize(
			"vsclone.thread.empty.title",
			"Start a new chat",
		);
		const emptyDescription = document.createElement("div");
		emptyDescription.className = "vsclone-thread-empty-state-description";
		emptyDescription.textContent = localize(
			"vsclone.thread.empty.description",
			"Describe a change, ask a question, or pick a suggestion below to get going.",
		);
		emptyState.appendChild(emptyIcon);
		emptyState.appendChild(emptyTitle);
		emptyState.appendChild(emptyDescription);
		const suggestions = document.createElement("div");
		suggestions.className = "vsclone-thread-empty-state-suggestions";
		for (const suggestion of [
			{
				icon: "codicon-search",
				text: localize("vsclone.thread.empty.suggestion.explain", "Explain this codebase"),
			},
			{
				icon: "codicon-symbol-misc",
				text: localize("vsclone.thread.empty.suggestion.refactor", "Refactor the selected file"),
			},
			{
				icon: "codicon-terminal",
				text: localize("vsclone.thread.empty.suggestion.tests", "Run tests and fix what's broken"),
			},
		]) {
			const suggestionButton = document.createElement("button");
			suggestionButton.type = "button";
			suggestionButton.className = "vsclone-thread-empty-state-suggestion";
			const suggestionIcon = document.createElement("span");
			suggestionIcon.className = `codicon ${suggestion.icon}`;
			suggestionIcon.setAttribute("aria-hidden", "true");
			suggestionButton.appendChild(suggestionIcon);
			suggestionButton.appendChild(document.createTextNode(suggestion.text));
			suggestionButton.addEventListener(EventType.CLICK, () => {
				if (!this.composerInput) {
					return;
				}
				this.composerInput.value = suggestion.text;
				this.updateComposerMetrics();
				this.updateComposerState();
				this.focusInput();
			});
			suggestions.appendChild(suggestionButton);
		}
		emptyState.appendChild(suggestions);
		this.conversationEmptyState = emptyState;

		const settings = document.createElement("div");
		settings.className = "vsclone-settings-page hidden";
		this.settingsContainer = settings;

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
		sendIcon.className = 'codicon codicon-arrow-up';
		sendIcon.setAttribute('aria-hidden', 'true');
		send.appendChild(sendIcon);
		this.composerSendButton = send;

		const contextUsageRoot = document.createElement('div');
		contextUsageRoot.className = 'vsclone-thread-context-usage-root';
		const contextUsageButton = document.createElement('button');
		contextUsageButton.type = 'button';
		contextUsageButton.className = 'vsclone-thread-context-usage';
		contextUsageButton.setAttribute('aria-label', localize('vsclone.composer.contextUsage', 'Context window usage'));
		// The usage ring is both a compact meter and a disclosure. Keeping it as an enabled button
		// lets keyboard users open the same details popover that pointer users see on hover.
		const contextUsagePopoverId = `vsclone-context-usage-${++contextUsageIdPool}`;
		contextUsageButton.setAttribute('aria-expanded', 'false');
		contextUsageButton.setAttribute('aria-controls', contextUsagePopoverId);
		contextUsageButton.setAttribute('aria-haspopup', 'dialog');
		const contextUsageSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		contextUsageSvg.setAttribute('viewBox', '0 0 20 20');
		contextUsageSvg.setAttribute('role', 'meter');
		contextUsageSvg.setAttribute('aria-label', localize('vsclone.composer.contextUsageMeter', 'Context usage meter'));
		contextUsageSvg.setAttribute('aria-valuemin', '0');
		contextUsageSvg.setAttribute('aria-valuemax', '100');
		contextUsageSvg.classList.add('vsclone-thread-context-usage-ring');
		const contextUsageTrack = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		contextUsageTrack.setAttribute('cx', '10');
		contextUsageTrack.setAttribute('cy', '10');
		contextUsageTrack.setAttribute('r', '8');
		contextUsageTrack.classList.add('track');
		const contextUsageProgress = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		contextUsageProgress.setAttribute('cx', '10');
		contextUsageProgress.setAttribute('cy', '10');
		contextUsageProgress.setAttribute('r', '8');
		contextUsageProgress.classList.add('progress');
		contextUsageSvg.appendChild(contextUsageTrack);
		contextUsageSvg.appendChild(contextUsageProgress);
		contextUsageButton.appendChild(contextUsageSvg);
		contextUsageRoot.appendChild(contextUsageButton);
		const contextUsagePopover = document.createElement('div');
		contextUsagePopover.id = contextUsagePopoverId;
		contextUsagePopover.className = 'vsclone-thread-context-usage-popover hidden';
		contextUsagePopover.setAttribute('role', 'status');
		contextUsageRoot.appendChild(contextUsagePopover);
		this.composerContextUsageButton = contextUsageButton;
		this.composerContextUsageProgressPath = contextUsageProgress;
		this.composerContextUsagePopover = contextUsagePopover;

		const controls = document.createElement('div');
		controls.className = 'vsclone-thread-composer-controls';
		this.planModeContainer = undefined;
		this.planModeSwitchButton = undefined;
		this.addContextMenuToggle = undefined;
		this.reasoningEffortContainer = undefined;
		this.reasoningEffortSelect = undefined;
		this.reasoningEnabledContainer = undefined;
		this.reasoningEnabledInput = undefined;
		this.reasoningBudgetContainer = undefined;
		this.reasoningBudgetInput = undefined;
		this.reasoningBudgetValueLabel = undefined;
		this.composerContextStrip = undefined;
		this.mentionMenuRoot = undefined;
		this.mentionMenuList = undefined;
		this.mentionMenuHeaderQuery = undefined;
		this.mentionMenuOpen = false;
		this.mentionMenuItems = [];
		this.mentionMenuActiveIndex = 0;
		this.mentionMenuTriggerStart = -1;
		this.modelSwitcherHost = undefined;

		const modelSwitcherHost = document.createElement("div");
		modelSwitcherHost.className = "vsclone-thread-model-switcher";
		this.modelSwitcherHost = modelSwitcherHost;
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
			this.modelSwitcherHost = undefined;
			this.modelSwitcher = undefined;
		}
		this.updateModelSwitcherVisibility();

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

		// Enabled toggle: only visible for models whose capability metadata sets
		// `canTurnOffReasoning: true` AND has no `reasoningSlider`. When a slider exists
		// (budget_slider or effort_slider) it owns the on/off affordance itself. Mirrors the
		// `VoidSwitch` Void renders when reasoning can be explicitly suppressed without a slider.
		const reasoningEnabledHost = document.createElement("div");
		reasoningEnabledHost.className = "vsclone-thread-reasoning-enabled hidden";
		const reasoningEnabledLabel = document.createElement("span");
		reasoningEnabledLabel.className = "vsclone-thread-reasoning-enabled-label";
		reasoningEnabledLabel.textContent = localize("vsclone.composer.reasoningEnabled", "Thinking");
		const reasoningEnabledInput = document.createElement("input");
		reasoningEnabledInput.type = "checkbox";
		reasoningEnabledInput.className = "vsclone-thread-reasoning-enabled-input";
		reasoningEnabledInput.setAttribute(
			"aria-label",
			localize("vsclone.composer.reasoningEnabled.aria", "Toggle reasoning"),
		);
		reasoningEnabledHost.appendChild(reasoningEnabledLabel);
		reasoningEnabledHost.appendChild(reasoningEnabledInput);
		controls.appendChild(reasoningEnabledHost);
		this.reasoningEnabledContainer = reasoningEnabledHost;
		this.reasoningEnabledInput = reasoningEnabledInput;

		// Budget slider: retained for any future provider that exposes a raw token-budget control.
		// Built-in Haiku and Gemini use preset selectors, so this stays hidden for them.
		const reasoningBudgetHost = document.createElement("div");
		reasoningBudgetHost.className = "vsclone-thread-reasoning-budget hidden";
		const reasoningBudgetLabel = document.createElement("span");
		reasoningBudgetLabel.className = "vsclone-thread-reasoning-budget-label";
		reasoningBudgetLabel.textContent = localize("vsclone.composer.reasoningBudget", "Thinking");
		const reasoningBudgetInput = document.createElement("input");
		reasoningBudgetInput.type = "range";
		reasoningBudgetInput.className = "vsclone-thread-reasoning-budget-input";
		reasoningBudgetInput.setAttribute(
			"aria-label",
			localize("vsclone.composer.reasoningBudget.aria", "Reasoning token budget"),
		);
		const reasoningBudgetValue = document.createElement("span");
		reasoningBudgetValue.className = "vsclone-thread-reasoning-budget-value";
		reasoningBudgetHost.appendChild(reasoningBudgetLabel);
		reasoningBudgetHost.appendChild(reasoningBudgetInput);
		reasoningBudgetHost.appendChild(reasoningBudgetValue);
		controls.appendChild(reasoningBudgetHost);
		this.reasoningBudgetContainer = reasoningBudgetHost;
		this.reasoningBudgetInput = reasoningBudgetInput;
		this.reasoningBudgetValueLabel = reasoningBudgetValue;

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

		const addCodeSelectionItem = document.createElement('button');
		addCodeSelectionItem.type = 'button';
		addCodeSelectionItem.className = 'vsclone-add-context-menu-item';
		addCodeSelectionItem.setAttribute('role', 'menuitem');
		const addCodeSelectionIcon = document.createElement('span');
		addCodeSelectionIcon.className = 'codicon codicon-selection';
		addCodeSelectionIcon.setAttribute('aria-hidden', 'true');
		addCodeSelectionItem.appendChild(addCodeSelectionIcon);
		addCodeSelectionItem.appendChild(document.createTextNode(localize("vsclone.composer.addCodeSelection", "Add Code Selection")));

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
		addContextMenu.appendChild(addCodeSelectionItem);
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
		toolbar.appendChild(contextUsageRoot);
		toolbar.appendChild(send);

		const imageStrip = document.createElement('div');
		imageStrip.className = 'vsclone-composer-image-strip hidden';
		this.composerImageStrip = imageStrip;

		const contextStrip = document.createElement('div');
		contextStrip.className = 'vsclone-composer-context-strip hidden';
		this.composerContextStrip = contextStrip;

		const inputWrap = document.createElement('div');
		inputWrap.className = 'vsclone-composer-input-wrap';
		inputWrap.appendChild(input);

		const mentionMenu = document.createElement('div');
		mentionMenu.className = 'vsclone-mention-menu hidden';
		mentionMenu.setAttribute('role', 'listbox');
		const mentionMenuHeader = document.createElement('div');
		mentionMenuHeader.className = 'vsclone-mention-menu-header';
		const mentionMenuHeaderIcon = document.createElement('span');
		mentionMenuHeaderIcon.className = 'codicon codicon-mention vsclone-mention-menu-header-icon';
		mentionMenuHeaderIcon.setAttribute('aria-hidden', 'true');
		const mentionMenuHeaderQuery = document.createElement('span');
		mentionMenuHeaderQuery.className = 'vsclone-mention-menu-header-query';
		mentionMenuHeader.appendChild(mentionMenuHeaderIcon);
		mentionMenuHeader.appendChild(mentionMenuHeaderQuery);
		const mentionMenuList = document.createElement('div');
		mentionMenuList.className = 'vsclone-mention-menu-list';
		mentionMenu.appendChild(mentionMenuHeader);
		mentionMenu.appendChild(mentionMenuList);
		inputWrap.appendChild(mentionMenu);
		this.mentionMenuRoot = mentionMenu;
		this.mentionMenuList = mentionMenuList;
		this.mentionMenuHeaderQuery = mentionMenuHeaderQuery;

		const imageFileInput = document.createElement('input');
		imageFileInput.type = 'file';
		imageFileInput.accept = 'image/png,image/jpeg,image/gif,image/webp';
		imageFileInput.multiple = true;
		imageFileInput.className = 'vsclone-composer-image-file-input';

		// Wrap the textarea and toolbar together so they share a single rounded border. Without this
		// outer card both elements drew their own borders, leaving a faint horizontal seam where
		// the input's border-bottom met the toolbar's border-top.
		const composerCard = document.createElement('div');
		composerCard.className = 'vsclone-thread-composer-card';
		composerCard.appendChild(inputWrap);
		composerCard.appendChild(toolbar);

		composer.appendChild(imageStrip);
		composer.appendChild(contextStrip);
		composer.appendChild(composerCard);
		composer.appendChild(hint);

		parent.appendChild(actions);
		parent.appendChild(settings);
		parent.appendChild(messages);
		parent.appendChild(emptyState);
		parent.appendChild(composer);

		this._register(
			addDisposableListener(threadButton, EventType.CLICK, () => {
				this.railVisible = true;
				this.applyRailLayout();
			}),
		);

		this._register(
			addDisposableListener(newChatButton, EventType.CLICK, () => {
				this.showComposerForNewChat();
			}),
		);

		this._register(
			addDisposableListener(settingsButton, EventType.CLICK, () => {
				this.openSettingsPage();
			}),
		);

		this._register(
			addDisposableListener(input, EventType.INPUT, () => {
				this.updateComposerMetrics();
				this.updateComposerState();
				this.updateContextUsageIndicator();
				this.handleMentionInput();
			}),
		);

		this._register(addDisposableListener(contextUsageRoot, EventType.MOUSE_ENTER, () => this.setContextUsagePopoverVisible(true)));
		this._register(addDisposableListener(contextUsageRoot, EventType.MOUSE_LEAVE, () => {
			if (!this.composerContextUsagePopoverPinned) {
				this.setContextUsagePopoverVisible(false);
			}
		}));
		this._register(addDisposableListener(contextUsageButton, EventType.FOCUS, () => this.setContextUsagePopoverVisible(true)));
		this._register(addDisposableListener(contextUsageButton, EventType.BLUR, () => {
			this.composerContextUsagePopoverPinned = false;
			this.setContextUsagePopoverVisible(false);
		}));
		this._register(addDisposableListener(contextUsageButton, EventType.CLICK, () => {
			this.composerContextUsagePopoverPinned = !this.composerContextUsagePopoverPinned;
			this.setContextUsagePopoverVisible(this.composerContextUsagePopoverPinned);
		}));

		this._register(
			addDisposableListener(
				input,
				EventType.KEY_DOWN,
				(event: KeyboardEvent) => {
					if (this.mentionMenuOpen) {
						if (event.key === 'ArrowDown') {
							event.preventDefault();
							this.moveMentionActiveIndex(1);
							return;
						}
						if (event.key === 'ArrowUp') {
							event.preventDefault();
							this.moveMentionActiveIndex(-1);
							return;
						}
						if (event.key === 'Enter' && !event.shiftKey) {
							event.preventDefault();
							this.acceptActiveMention();
							return;
						}
						if (event.key === 'Escape') {
							event.preventDefault();
							this.closeMentionMenu();
							return;
						}
						if (event.key === 'Tab') {
							event.preventDefault();
							this.acceptActiveMention();
							return;
						}
					}
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
			addDisposableListener(addCodeSelectionItem, EventType.CLICK, () => {
				toggleAddContextMenu(false);
				this.addActiveEditorCodeSelectionAsContext();
			}),
		);
		this._register(
			addDisposableListener(targetWindow.document, EventType.MOUSE_DOWN, (event: MouseEvent) => {
				if (!this.mentionMenuOpen) {
					return;
				}
				const clickTarget = event.target as Node | null;
				if (clickTarget && (inputWrap.contains(clickTarget))) {
					return;
				}
				this.closeMentionMenu();
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
		if (this.reasoningEnabledInput) {
			this._register(
				addDisposableListener(
					this.reasoningEnabledInput,
					EventType.CHANGE,
					() => {
						void this.updateReasoningEnabledSelection();
					},
				),
			);
		}
		if (this.reasoningBudgetInput) {
			this._register(
				addDisposableListener(
					this.reasoningBudgetInput,
					'input',
					() => {
						// Live-update the value label as the user drags before committing persistence on change.
						this.updateReasoningBudgetValueLabelFromInput();
					},
				),
			);
			this._register(
				addDisposableListener(
					this.reasoningBudgetInput,
					EventType.CHANGE,
					() => {
						void this.updateReasoningBudgetSelection();
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
		this.refreshReasoningEnabledControl();
		this.refreshReasoningBudgetControl();
		if (this.modelSwitcher) {
			void this.settingsService.refreshState();
		}
		this.updateConversationModeVisibility();
	}

	private updateConversationModeVisibility(): void {
		this.settingsContainer?.classList.toggle("hidden", !this.settingsVisible);
		// Both the messages list and empty state declare flex: 1, so leaving the empty messages
		// container in the layout would split the vertical space and push the empty state into
		// the lower half of the pane instead of centering it.
		this.conversationList?.classList.toggle("hidden", this.settingsVisible || !this.conversationHasContent);
		// Settings mode temporarily hides chat chrome, but closing it must restore the
		// message-aware empty state instead of showing the placeholder over an existing thread.
		this.conversationEmptyState?.classList.toggle("hidden", this.settingsVisible || this.conversationHasContent);
		this.composerInput?.closest(".vsclone-thread-composer")?.classList.toggle("hidden", this.settingsVisible);
	}

	private updateModelSwitcherVisibility(): void {
		const modelSwitcherEnabled = this.isModelSwitcherEnabled();
		if (!modelSwitcherEnabled) {
			// Closing before hiding clears the switcher's internal open state so re-enabling the
			// setting never resurrects a previously open menu.
			this.modelSwitcher?.close();
		}
		this.modelSwitcherHost?.classList.toggle("hidden", !modelSwitcherEnabled);
		this.refreshReasoningEffortControl();
		this.refreshReasoningEnabledControl();
		this.refreshReasoningBudgetControl();
	}

	private isModelSwitcherEnabled(): boolean {
		return this.configurationService.getValue<boolean>(modelSwitcherEnabledSetting) ?? true;
	}

	private renderSettingsPage(): HTMLElement | undefined {
		const settings = this.settingsContainer;
		if (!settings) {
			this.settingsFocusTarget = undefined;
			return undefined;
		}

		const activeFocusKey = this.getActiveSettingsFocusKey(settings);
		settings.replaceChildren();

		const header = document.createElement("div");
		header.className = "vsclone-settings-header";
		const headerCopy = document.createElement("div");
		const title = document.createElement("h2");
		title.textContent = localize("vsclone.settings.title", "VSClone Settings");
		headerCopy.appendChild(title);
		header.appendChild(headerCopy);

		const closeButton = document.createElement("button");
		closeButton.type = "button";
		closeButton.className = "vsclone-settings-icon-button";
		this.setSettingsFocusKey(closeButton, "settings.close");
		closeButton.title = localize("vsclone.settings.close", "Back to chat");
		closeButton.setAttribute("aria-label", closeButton.title);
		const closeIcon = document.createElement("span");
		closeIcon.className = "codicon codicon-close";
		closeIcon.setAttribute("aria-hidden", "true");
		closeButton.appendChild(closeIcon);
		closeButton.addEventListener(EventType.CLICK, () => {
			this.settingsVisible = false;
			this.updateConversationModeVisibility();
			this.focusInput();
		});
		header.appendChild(closeButton);
		settings.appendChild(header);
		this.settingsFocusTarget = closeButton;

		const grid = document.createElement("div");
		grid.className = "vsclone-settings-grid";
		grid.appendChild(this.createSettingsSection(
			localize("vsclone.settings.providers.title", "Providers"),
			Object.values(defaultOAuthProviderConfig).map(provider => this.createProviderAuthRow(this.oauthService.state.providers[provider.vendor])),
		));
		grid.appendChild(this.createSettingsSection(
			localize("vsclone.settings.experience.title", "Experience"),
			[
				this.createBooleanSettingRow(autocompleteEnabledSetting, localize("vsclone.settings.autocomplete", "Inline autocomplete")),
				this.createNumberSettingRow(autocompleteDebounceMsSetting, localize("vsclone.settings.autocompleteDelay", "Autocomplete delay"), 0, VSCloneAutocompleteDebounceMsMaximum, "ms"),
			],
		));
		settings.appendChild(grid);
		const restoredFocusTarget = activeFocusKey ? this.findSettingsFocusTarget(settings, activeFocusKey) : undefined;
		if (restoredFocusTarget) {
			// Settings updates rebuild the page after configuration/provider changes. The stable key
			// reconnects focus to the equivalent control so keyboard users do not get dropped onto
			// the document body when replaceChildren removes the active element.
			this.settingsFocusTarget = restoredFocusTarget;
			restoredFocusTarget.focus();
		}
		return this.settingsFocusTarget;
	}

	private getActiveSettingsFocusKey(settings: HTMLElement): string | undefined {
		const activeElement = settings.ownerDocument.activeElement;
		if (!isHTMLElement(activeElement) || !settings.contains(activeElement)) {
			return undefined;
		}
		for (let element: HTMLElement | null = activeElement; element && settings.contains(element); element = element.parentElement) {
			const focusKey = element.dataset.vscloneSettingsFocusKey;
			if (focusKey) {
				return focusKey;
			}
		}
		return undefined;
	}

	private setSettingsFocusKey(element: HTMLElement, key: string): void {
		element.dataset.vscloneSettingsFocusKey = key;
	}

	private findSettingsFocusTarget(settings: HTMLElement, key: string): HTMLElement | undefined {
		const visit = (element: HTMLElement): HTMLElement | undefined => {
			if (element.dataset.vscloneSettingsFocusKey === key) {
				return element;
			}
			for (const child of element.children) {
				if (!isHTMLElement(child)) {
					continue;
				}
				const match = visit(child);
				if (match) {
					return match;
				}
			}
			return undefined;
		};
		return visit(settings);
	}

	private createSettingsSection(title: string, rows: readonly HTMLElement[]): HTMLElement {
		const section = document.createElement("section");
		section.className = "vsclone-settings-section";
		const heading = document.createElement("h3");
		heading.textContent = title;
		section.appendChild(heading);
		for (const row of rows) {
			section.appendChild(row);
		}
		return section;
	}

	private createProviderAuthRow(provider: IVSCloneOAuthProviderState): HTMLElement {
		const row = document.createElement("div");
		row.className = "vsclone-settings-row";
		const copy = document.createElement("div");
		copy.className = "vsclone-settings-row-copy";
		const title = document.createElement("div");
		title.className = "vsclone-settings-row-title";
		title.textContent = provider.displayName;
		const detail = document.createElement("div");
		detail.className = "vsclone-settings-row-description";
		detail.textContent = this.getProviderStatusLabel(provider);
		copy.appendChild(title);
		copy.appendChild(detail);

		const button = document.createElement("button");
		button.type = "button";
		button.className = "vsclone-settings-action-button";
		this.setSettingsFocusKey(button, `provider.${provider.vendor}`);
		const signedIn = provider.status === "signed_in" || provider.isReady;
		button.textContent = signedIn
			? localize("vsclone.settings.provider.signOut", "Sign out")
			: localize("vsclone.settings.provider.signIn", "Sign in");
		button.disabled = provider.status === "signing_in" || provider.status === "refreshing";
		button.addEventListener(EventType.CLICK, () => {
			// Refresh the model catalog after auth changes because selectable models are derived
			// from provider readiness rather than a separate enabled-provider setting.
			void (signedIn ? this.oauthService.signOut(provider.vendor) : this.oauthService.signIn(provider.vendor))
				.then(() => this.settingsService.refreshState())
				.then(() => this.refreshModelControls())
				.catch(error => this.notificationService.error(error));
		});

		row.appendChild(copy);
		row.appendChild(button);
		return row;
	}

	private getProviderStatusLabel(provider: IVSCloneOAuthProviderState): string {
		switch (provider.status) {
			case "signed_in":
				return provider.userDisplayName
					? localize("vsclone.settings.provider.signedInAs", "Signed in as {0}", provider.userDisplayName)
					: localize("vsclone.settings.provider.signedIn", "Signed in");
			case "signing_in":
				return localize("vsclone.settings.provider.signingIn", "Signing in...");
			case "refreshing":
				return localize("vsclone.settings.provider.refreshing", "Refreshing...");
			case "error":
				return provider.errorMessage ?? localize("vsclone.settings.provider.error", "Sign-in error");
			case "signed_out":
				return localize("vsclone.settings.provider.signedOut", "Signed out");
		}
	}

	private createBooleanSettingRow(key: string, label: string): HTMLElement {
		return this.createSettingsToggleRow(
			`setting.${key}`,
			label,
			key,
			this.configurationService.getValue<boolean>(key) ?? booleanSettingDefaults[key] ?? false,
			async (enabled) => {
				// Let the configuration service pick the write target so workspace-scoped values are
				// updated in place instead of being shadowed by a forced user-level override.
				await this.configurationService.updateValue(key, enabled);
			},
		);
	}

	private createNumberSettingRow(key: string, label: string, min: number, max: number, suffix: string): HTMLElement {
		const row = document.createElement("div");
		row.className = "vsclone-settings-row";
		const labelContainer = document.createElement("div");
		labelContainer.className = "vsclone-settings-row-copy";
		const title = document.createElement("div");
		title.className = "vsclone-settings-row-title";
		title.textContent = label;
		const description = document.createElement("div");
		description.className = "vsclone-settings-row-description";
		description.textContent = key;
		labelContainer.appendChild(title);
		labelContainer.appendChild(description);

		const control = document.createElement("div");
		control.className = "vsclone-settings-number-control";
		const input = document.createElement("input");
		input.type = "range";
		this.setSettingsFocusKey(input, `setting.${key}`);
		input.setAttribute("aria-label", label);
		input.min = String(min);
		input.max = String(max);
		input.step = "10";
		input.value = String(this.configurationService.getValue<number>(key) ?? min);
		const value = document.createElement("span");
		value.textContent = `${input.value}${suffix}`;
		input.addEventListener(EventType.INPUT, () => {
			value.textContent = `${input.value}${suffix}`;
		});
		input.addEventListener(EventType.CHANGE, () => {
			// Use the effective configuration target here for the same reason as boolean toggles:
			// the custom page should not create a user override when a workspace value is active.
			void this.configurationService.updateValue(key, Number(input.value));
		});
		control.appendChild(input);
		control.appendChild(value);
		row.appendChild(labelContainer);
		row.appendChild(control);
		return row;
	}

	private createSettingsToggleRow(focusKey: string, label: string, description: string, checked: boolean, onChange: (checked: boolean) => Promise<void>): HTMLElement {
		const row = document.createElement("div");
		row.className = "vsclone-settings-row";
		const copy = document.createElement("div");
		copy.className = "vsclone-settings-row-copy";
		const title = document.createElement("div");
		title.className = "vsclone-settings-row-title";
		title.textContent = label;
		const detail = document.createElement("div");
		detail.className = "vsclone-settings-row-description";
		detail.textContent = description;
		copy.appendChild(title);
		copy.appendChild(detail);

		const toggle = document.createElement("input");
		toggle.type = "checkbox";
		toggle.className = "vsclone-settings-toggle";
		this.setSettingsFocusKey(toggle, focusKey);
		toggle.checked = checked;
		toggle.setAttribute("aria-label", label);
		toggle.addEventListener(EventType.CHANGE, () => {
			void onChange(toggle.checked);
		});
		row.appendChild(copy);
		row.appendChild(toggle);
		return row;
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
			const contextSelections = this.pendingContextSelections.length > 0
				? this.pendingContextSelections.map(selection => ({ ...selection }))
				: undefined;
			const submission = await this.chatThreadService.sendMessage(promptText, {
				threadId: activeThreadId,
				sessionResource: existingThread?.sessionResource,
				modelSelection: selectedModel,
				imageAttachments,
				contextSelections,
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
			this.pendingContextSelections = [];
			this.renderContextChipStrip();
			this.closeMentionMenu();
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
		this.updateContextUsageIndicator();
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
				this.updateContextUsageIndicator();
			});

			thumb.appendChild(preview);
			thumb.appendChild(removeBtn);
			this.composerImageStrip.appendChild(thumb);
		}
	}

	private handleMentionInput(): void {
		if (!this.composerInput) {
			return;
		}
		const value = this.composerInput.value;
		const caret = this.composerInput.selectionStart ?? value.length;
		const before = value.slice(0, caret);
		// Match the active `@token` only when it sits at the start of the input or after whitespace.
		// Without that anchor, typing `@` inside an email address would pop the picker open.
		const match = /(?:^|\s)@([\w./-]*)$/.exec(before);
		if (!match) {
			if (this.mentionMenuOpen) {
				this.closeMentionMenu();
			}
			return;
		}
		const queryStartIndex = caret - match[1].length - 1; // position of the `@`
		this.mentionMenuTriggerStart = queryStartIndex;
		this.mentionMenuQuery = match[1];
		this.mentionMenuOpen = true;
		this.renderMentionMenu();
		void this.runMentionSearch(this.mentionMenuQuery);
	}

	private async runMentionSearch(query: string): Promise<void> {
		this.mentionSearchCts?.cancel();
		this.mentionSearchCts?.dispose();
		const cts = new CancellationTokenSource();
		this.mentionSearchCts = cts;
		try {
			const results = await this.mentionSearchService.search(query, 12, cts.token);
			if (cts.token.isCancellationRequested) {
				return;
			}
			this.mentionMenuItems = [...results];
			this.mentionMenuActiveIndex = 0;
			this.renderMentionMenu();
		} catch {
			if (!cts.token.isCancellationRequested) {
				this.mentionMenuItems = [];
				this.renderMentionMenu();
			}
		}
	}

	private moveMentionActiveIndex(delta: number): void {
		if (this.mentionMenuItems.length === 0) {
			return;
		}
		const length = this.mentionMenuItems.length;
		this.mentionMenuActiveIndex = ((this.mentionMenuActiveIndex + delta) % length + length) % length;
		this.renderMentionMenu();
	}

	private acceptActiveMention(): void {
		const item = this.mentionMenuItems[this.mentionMenuActiveIndex];
		if (!item || !this.composerInput) {
			return;
		}
		const value = this.composerInput.value;
		const caret = this.composerInput.selectionStart ?? value.length;
		const start = this.mentionMenuTriggerStart;
		if (start < 0) {
			this.closeMentionMenu();
			return;
		}
		const before = value.slice(0, start);
		const after = value.slice(caret);
		const trimmedBefore = before.length > 0 && !/\s$/.test(before) ? before : before;
		const next = `${trimmedBefore}${after}`;
		this.composerInput.value = next;
		const nextCaret = trimmedBefore.length;
		this.composerInput.setSelectionRange(nextCaret, nextCaret);
		this.addContextSelection(this.mentionResultToSelection(item));
		this.closeMentionMenu();
		this.composerInput.focus();
		this.updateComposerMetrics();
		this.updateComposerState();
	}

	private mentionResultToSelection(result: IVSCloneMentionResult): IVSCloneContextSelection {
		if (result.kind === 'folder') {
			return { kind: 'folder', uri: result.uri };
		}
		const languageId = this.languageService.guessLanguageIdByFilepathOrFirstLine(result.uri) ?? 'plaintext';
		return { kind: 'file', uri: result.uri, languageId };
	}

	private closeMentionMenu(): void {
		if (!this.mentionMenuOpen) {
			return;
		}
		this.mentionMenuOpen = false;
		this.mentionMenuQuery = '';
		this.mentionMenuItems = [];
		this.mentionMenuActiveIndex = 0;
		this.mentionMenuTriggerStart = -1;
		this.mentionSearchCts?.cancel();
		this.mentionSearchCts?.dispose();
		this.mentionSearchCts = undefined;
		this.renderMentionMenu();
	}

	private renderMentionMenu(): void {
		if (!this.mentionMenuRoot || !this.mentionMenuList || !this.mentionMenuHeaderQuery) {
			return;
		}
		this.mentionMenuRoot.classList.toggle('hidden', !this.mentionMenuOpen);
		this.mentionMenuHeaderQuery.textContent = this.mentionMenuQuery.length > 0
			? this.mentionMenuQuery
			: localize("vsclone.mention.menu.hint", "Type to search files and folders");
		this.mentionMenuList.replaceChildren();
		if (!this.mentionMenuOpen) {
			return;
		}
		if (this.mentionMenuItems.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'vsclone-mention-menu-empty';
			empty.textContent = localize("vsclone.mention.menu.empty", "No matches");
			this.mentionMenuList.appendChild(empty);
			return;
		}
		for (let index = 0; index < this.mentionMenuItems.length; index++) {
			const item = this.mentionMenuItems[index];
			const button = document.createElement('button');
			button.type = 'button';
			button.setAttribute('role', 'option');
			button.className = index === this.mentionMenuActiveIndex
				? 'vsclone-mention-menu-item active'
				: 'vsclone-mention-menu-item';
			button.setAttribute('aria-selected', String(index === this.mentionMenuActiveIndex));
			const icon = document.createElement('span');
			icon.className = `codicon ${item.kind === 'folder' ? 'codicon-folder' : 'codicon-file'} vsclone-mention-menu-item-icon`;
			icon.setAttribute('aria-hidden', 'true');
			const label = document.createElement('span');
			label.className = 'vsclone-mention-menu-item-label';
			label.textContent = item.label;
			const detail = document.createElement('span');
			detail.className = 'vsclone-mention-menu-item-detail';
			detail.textContent = item.relativePath;
			button.appendChild(icon);
			button.appendChild(label);
			button.appendChild(detail);
			const itemIndex = index;
			button.addEventListener('mouseenter', () => {
				this.mentionMenuActiveIndex = itemIndex;
				this.renderMentionMenu();
			});
			button.addEventListener('mousedown', event => {
				// `mousedown` fires before the textarea blur so the picker selection lands without losing
				// the caret context that drives `acceptActiveMention`.
				event.preventDefault();
				this.mentionMenuActiveIndex = itemIndex;
				this.acceptActiveMention();
			});
			this.mentionMenuList.appendChild(button);
		}
	}

	private addContextSelection(selection: IVSCloneContextSelection): void {
		this.pendingContextSelections.push(selection);
		this.renderContextChipStrip();
		this.updateContextUsageIndicator();
	}

	private renderContextChipStrip(): void {
		this.refreshPendingContextSelectionCharacterCount();
		if (!this.composerContextStrip) {
			return;
		}
		this.composerContextStrip.replaceChildren();
		if (this.pendingContextSelections.length === 0) {
			this.composerContextStrip.classList.add('hidden');
			return;
		}
		this.composerContextStrip.classList.remove('hidden');
		for (let i = 0; i < this.pendingContextSelections.length; i++) {
			const selection = this.pendingContextSelections[i];
			const chip = document.createElement('div');
			chip.className = `vsclone-composer-context-chip kind-${selection.kind}`;
			const iconClass = selection.kind === 'folder'
				? 'codicon-folder'
				: selection.kind === 'codeSelection'
					? 'codicon-selection'
					: 'codicon-file';
			const icon = document.createElement('span');
			icon.className = `codicon ${iconClass} vsclone-composer-context-chip-icon`;
			icon.setAttribute('aria-hidden', 'true');
			const label = document.createElement('span');
			label.className = 'vsclone-composer-context-chip-label';
			const baseName = selection.uri.path.split('/').pop() || selection.uri.fsPath;
			label.textContent = selection.kind === 'codeSelection'
				? `${baseName}:${selection.startLine}-${selection.endLine}`
				: baseName;
			chip.title = selection.uri.fsPath;
			const removeBtn = document.createElement('button');
			removeBtn.type = 'button';
			removeBtn.className = 'vsclone-composer-context-chip-remove';
			removeBtn.setAttribute('aria-label', localize("vsclone.composer.removeContext", "Remove context"));
			const removeIcon = document.createElement('span');
			removeIcon.className = 'codicon codicon-close';
			removeIcon.setAttribute('aria-hidden', 'true');
			removeBtn.appendChild(removeIcon);
			const index = i;
			removeBtn.addEventListener(EventType.CLICK, event => {
				event.stopPropagation();
				this.pendingContextSelections.splice(index, 1);
				this.renderContextChipStrip();
				this.updateContextUsageIndicator();
			});
			chip.appendChild(icon);
			chip.appendChild(label);
			chip.appendChild(removeBtn);
			this.composerContextStrip.appendChild(chip);
		}
	}

	private refreshPendingContextSelectionCharacterCount(): void {
		const key = this.getPendingContextSelectionsCharacterKey();
		if (key === this.pendingContextSelectionsCharacterKey) {
			return;
		}

		this.pendingContextSelectionsCharacterKey = key;
		const version = ++this.pendingContextSelectionsCharacterVersion;
		if (this.pendingContextSelections.length === 0) {
			this.pendingContextSelectionsCharacters = 0;
			this.updateContextUsageIndicator();
			return;
		}

		// The request path expands @file/@folder/code selections into markdown before sending. Count
		// that same serialized block asynchronously so large attached files do not look like tiny
		// path-only additions in the preflight meter.
		void formatContextSelections(this.pendingContextSelections, this.fileService).then(serializedContext => {
			if (version !== this.pendingContextSelectionsCharacterVersion) {
				return;
			}
			this.pendingContextSelectionsCharacters = serializedContext.length;
			this.updateContextUsageIndicator();
		}, () => {
			if (version !== this.pendingContextSelectionsCharacterVersion) {
				return;
			}
			this.pendingContextSelectionsCharacters = this.pendingContextSelections.reduce((sum, selection) => sum + this.estimateContextSelectionCharacters(selection), 0);
			this.updateContextUsageIndicator();
		});
	}

	private getPendingContextSelectionsCharacterKey(): string {
		return JSON.stringify(this.pendingContextSelections.map(selection => {
			if (selection.kind === 'codeSelection') {
				return [selection.kind, selection.uri.toString(), selection.languageId, selection.startLine, selection.endLine];
			}
			if (selection.kind === 'file') {
				return [selection.kind, selection.uri.toString(), selection.languageId];
			}
			return [selection.kind, selection.uri.toString()];
		}));
	}

	private addActiveEditorCodeSelectionAsContext(): void {
		const editor = this.codeEditorService.getActiveCodeEditor() ?? this.codeEditorService.getFocusedCodeEditor();
		const model = editor?.getModel();
		const selection = editor?.getSelection();
		if (!editor || !model || !selection || selection.isEmpty()) {
			this.notificationService.info(localize("vsclone.composer.codeSelection.empty", "Select some code in the editor first to add it as context."));
			return;
		}
		const languageId = model.getLanguageId();
		this.addContextSelection({
			kind: 'codeSelection',
			uri: model.uri,
			languageId,
			startLine: selection.startLineNumber,
			endLine: selection.endLineNumber,
		});
	}

	private toPendingContextSelections(selections: readonly IVSCloneContextSelection[] | undefined): IVSCloneContextSelection[] {
		if (!selections || selections.length === 0) {
			return [];
		}
		return selections.map(selection => ({ ...selection }));
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
		const threads = this.getSortedThreadCatalog();
		const query = this.rail.getSearchQuery().toLocaleLowerCase();
		const filteredThreads = query
			? threads.filter(thread => (
				thread.title.toLocaleLowerCase().includes(query)
				|| thread.lastTurnPreview.toLocaleLowerCase().includes(query)
			))
			: threads;

		const previousActiveThreadId = this.activeThreadId;
		if (this.activeThreadId && !this.resolveThreadById(this.activeThreadId)) {
			this.activeThreadId = undefined;
		}
		// Normalize external thread removal back to the fresh composer state.
		if (previousActiveThreadId && !this.activeThreadId && threads.length === 0) {
			this.showComposerForNewChat();
			return;
		}

		const catalogEntries: IVSCloneThreadCatalogEntry[] = filteredThreads.map(thread => ({
			threadId: thread.threadId,
			title: thread.title,
			updatedAt: thread.updatedAt,
			// Only surface a spinner while the thread is actively streaming. `streamState.kind`
			// is `'idle'` for completed threads too, so we map those to undefined here.
			streamStateKind: this.resolveActiveStreamStateKind(thread.threadId),
			hasUnreadAgentMessage: this.hasUnreadAgentMessage(thread.threadId),
		}));

		const rows = toVSCloneThreadRailRows(catalogEntries, this.activeThreadId, (timestamp) =>
			formatThreadRailRelativeTime(timestamp),
		);
		this.rail.setRows(rows);
		if (!this.activeThreadId) {
			this.rail.setSelectedThread(undefined);
		} else {
			this.rail.setSelectedThread(this.activeThreadId);
		}
	}

	private resolveActiveStreamStateKind(threadId: string): 'llm' | 'tool' | 'awaiting_user' | undefined {
		const kind = this.threadRuntimeService.getState?.(threadId)?.streamState.kind;
		if (kind === 'llm' || kind === 'tool' || kind === 'awaiting_user') {
			return kind;
		}
		return undefined;
	}

	private getLatestAssistantMessageId(state: IVSCloneThreadRuntimeState | undefined): string | undefined {
		return [...(state?.messages ?? [])].reverse().find((message): message is Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }> =>
			message.role === 'assistant',
		)?.id;
	}

	private markLatestAssistantMessageSeen(threadId: string, state: IVSCloneThreadRuntimeState | undefined = this.threadRuntimeService.getState?.(threadId)): void {
		const latestAssistantMessageId = this.getLatestAssistantMessageId(state);
		this.readBaselineInitializedThreads.add(threadId);
		if (latestAssistantMessageId) {
			this.lastSeenAssistantMessageByThread.set(threadId, latestAssistantMessageId);
		} else {
			this.lastSeenAssistantMessageByThread.delete(threadId);
		}
	}

	private hasUnreadAgentMessage(threadId: string): boolean {
		if (threadId === this.activeThreadId) {
			return false;
		}

		const state = this.threadRuntimeService.getState?.(threadId);
		const latestAssistantMessageId = this.getLatestAssistantMessageId(state);
		if (!this.readBaselineInitializedThreads.has(threadId)) {
			// Restored or first-rendered threads start as read. From that point forward, only a new
			// assistant message observed while the thread is inactive can light the unread marker.
			this.markLatestAssistantMessageSeen(threadId, state);
			return false;
		}
		return !!latestAssistantMessageId && this.lastSeenAssistantMessageByThread.get(threadId) !== latestAssistantMessageId;
	}

	private getRuntimeThreadCatalogService(): (IVSCloneThreadRuntimeService & IVSCloneThreadRuntimeCatalogService) | undefined {
		return this.threadRuntimeService as (IVSCloneThreadRuntimeService & IVSCloneThreadRuntimeCatalogService) | undefined;
	}

	private refreshThreadCatalogFromRuntime(): void {
		const runtimeCatalog = this.getRuntimeThreadCatalogService()?.getThreads?.();
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

	private getSortedThreadCatalog(): readonly IVSClonePaneThreadCatalogEntry[] {
		return [...this.threadsById.values()].sort((left, right) => {
			if (right.updatedAt !== left.updatedAt) {
				return right.updatedAt - left.updatedAt;
			}
			return right.createdAt - left.createdAt;
		});
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
		// Prune the sticky reasoning-panel state map to ids that still exist in the current runtime
		// snapshot. Prevents unbounded growth across long sessions or thread switches.
		this.pruneReasoningPanelStateForRuntime(runtimeState);
		// Refresh rebuilds the transcript DOM from scratch, so dispose markdown renderers from
		// the previous pass before rendering the next pass. Clearing must happen BEFORE the render
		// call so listeners added during render (e.g. the reasoning-toggle listener) are not
		// immediately disposed along with the prior pass.
		this.renderedMarkdownDisposables.clear();
		this.currentRuntimeElementKeys = new Set<string>();
		const runtimeNodes = runtimeState
			? this.renderRuntimeConversationNodes(runtimeState)
			: [];
		this.pruneEnteredRuntimeElementKeys();
		const hasRuntimeNodes = runtimeNodes.length > 0;
		this.conversationHasContent = hasRuntimeNodes;
		this.conversationList.replaceChildren();
		if (hasRuntimeNodes) {
			this.conversationList.append(...runtimeNodes);
		}

		this.updateComposerState();
		this.updateContextUsageIndicator();
		this.refreshModelControls();
		this.scheduleScrollToBottom();
		this.updateConversationModeVisibility();
	}

	private renderRuntimeConversationNodes(
		state: IVSCloneThreadRuntimeState,
	): HTMLElement[] {
		const nodes: HTMLElement[] = [];

		// Classify each assistant message as intermediate narration vs. the final answer of its
		// turn. Intermediate = a tool call appears later in the same turn; final = the turn ends
		// (next user message) without another tool call. The lookahead stops at the next user
		// message so a completed assistant answer doesn't retroactively collapse into a Thought
		// block when the user sends a follow-up that triggers its own tool calls.
		const isIntermediateAssistant: boolean[] = state.messages.map((message, index) => {
			if (message.role !== 'assistant') {
				return false;
			}
			for (let j = index + 1; j < state.messages.length; j++) {
				const next = state.messages[j];
				if (next.role === 'user') {
					return false;
				}
				if (next.role === 'tool') {
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
						nodes.push(this.renderRuntimeAssistantMessage(
							message,
							state.threadId,
							this.isActiveRuntimeAssistantMessage(state, index),
						));
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
					// Checkpoint UI is hidden for now. Runtime still captures snapshots and
					// exposes rewindToCheckpoint so the feature can be re-enabled by restoring
					// this render branch without touching the runtime layer.
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

	private markRuntimeElementEntrance(element: HTMLElement, key: string): void {
		this.currentRuntimeElementKeys.add(key);
		if (this.enteredRuntimeElementKeys.has(key)) {
			return;
		}
		this.enteredRuntimeElementKeys.add(key);
		element.classList.add('vsclone-runtime-enter');
	}

	private pruneEnteredRuntimeElementKeys(): void {
		for (const key of Array.from(this.enteredRuntimeElementKeys)) {
			if (!this.currentRuntimeElementKeys.has(key)) {
				this.enteredRuntimeElementKeys.delete(key);
			}
		}
	}

	private isActiveRuntimeAssistantMessage(
		state: IVSCloneThreadRuntimeState,
		messageIndex: number,
	): boolean {
		if (state.streamState.kind !== 'llm') {
			return false;
		}

		// Only the assistant row currently receiving provider deltas should fade in. Earlier
		// assistant messages in the same thread are stable history and should not pulse on rerender.
		for (let index = messageIndex + 1; index < state.messages.length; index++) {
			if (state.messages[index].role === 'assistant') {
				return false;
			}
		}
		return true;
	}

	private renderRuntimeAssistantNarrationBlock(
		messages: readonly Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>[],
	): HTMLElement | undefined {
		// Void renders `chatMessage.reasoning` for every assistant message. An intermediate
		// assistant turn whose only substance is a think-then-call-tool step still needs its
		// reasoning panel rendered even though its visible text is empty. Classify each message
		// so the final block can include both visible narration and reasoning-only turns.
		type NarrationEntry = {
			readonly message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>;
			readonly text: string;
			readonly reasoning: string;
		};
		const entries: NarrationEntry[] = messages
			.map(message => ({
				message,
				text: this.stripRuntimeAssistantWorkflowMarkup(message.content).trim(),
				reasoning: message.reasoning?.trim() ?? '',
			}))
			.filter(entry => entry.text.length > 0 || entry.reasoning.length > 0);
		if (entries.length === 0) {
			return undefined;
		}

		const visibleMessages = entries.filter(entry => entry.text.length > 0);
		const messagesWithReasoning = entries.filter(entry => entry.reasoning.length > 0);

		const item = document.createElement('div');
		item.className = 'vsclone-thread-message assistant runtime runtime-thought';
		this.markRuntimeElementEntrance(item, `thought:${entries.map(entry => entry.message.id).join(':')}`);

		// Render the reasoning panel for every intermediate assistant message that has reasoning,
		// regardless of whether the same message also has visible text. Mirrors Void, which renders
		// `chatMessage.reasoning` for every assistant message via its `ReasoningWrapper` before the
		// message content, so a thought-then-tool turn and a thought-then-reply turn both surface
		// their thinking. Visible text from these messages still renders once inside the "Thought"
		// details block below, so the reasoning panel is never double-rendered.
		for (const entry of messagesWithReasoning) {
			const reasoningBlock = this.renderAssistantReasoningBlock(entry.message, this.activeThreadId ?? '');
			if (reasoningBlock) {
				item.appendChild(reasoningBlock);
			}
		}

		if (visibleMessages.length > 0) {
			const totalChars = visibleMessages.reduce((sum, entry) => sum + entry.text.length, 0);
			const qualifierText = totalChars <= 400
				? localize('vsclone.thread.thought.briefly', 'briefly')
				: totalChars <= 1600
					? localize('vsclone.thread.thought.moment', 'for a moment')
					: localize('vsclone.thread.thought.while', 'for a while');

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
		}
		return item;
	}

	private renderRuntimeUserMessage(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'user' }>,
	): HTMLElement {
		const item = document.createElement('div');
		item.className = 'vsclone-thread-message user runtime';
		this.markRuntimeElementEntrance(item, `user:${message.id}`);

		const meta = document.createElement('div');
		meta.className = 'vsclone-thread-message-meta';
		meta.textContent = localize('vsclone.thread.userLabel', 'You');
		item.appendChild(meta);

		const body = document.createElement('div');
		body.className = 'vsclone-thread-message-body';
		if (message.contextSelections && message.contextSelections.length > 0) {
			body.appendChild(this.renderTranscriptContextChipStrip(message.contextSelections));
		}
		// The stored content has the serialized SELECTIONS block appended so the LLM sees the full
		// context on replay. The transcript only shows the original instructions because the chips
		// already communicate which files/folders were attached.
		const displayText = stripSelectionsBlock(message.content);
		if (displayText.trim().length > 0) {
			const promptText = document.createElement('div');
			promptText.className = 'vsclone-thread-message-user-text';
			promptText.textContent = displayText;
			body.appendChild(promptText);
		}
		if (message.imageAttachments && message.imageAttachments.length > 0) {
			body.appendChild(this.renderPromptImageStrip(message.imageAttachments));
		}
		item.appendChild(body);
		return item;
	}

	private renderTranscriptContextChipStrip(selections: readonly IVSCloneContextSelection[]): HTMLElement {
		const strip = document.createElement('div');
		strip.className = 'vsclone-composer-context-strip vsclone-transcript-context-strip';
		for (const selection of selections) {
			const chip = document.createElement('div');
			chip.className = `vsclone-composer-context-chip kind-${selection.kind}`;
			chip.title = selection.uri.fsPath;
			const iconClass = selection.kind === 'folder'
				? 'codicon-folder'
				: selection.kind === 'codeSelection'
					? 'codicon-selection'
					: 'codicon-file';
			const icon = document.createElement('span');
			icon.className = `codicon ${iconClass} vsclone-composer-context-chip-icon`;
			icon.setAttribute('aria-hidden', 'true');
			const label = document.createElement('span');
			label.className = 'vsclone-composer-context-chip-label';
			const baseName = selection.uri.path.split('/').pop() || selection.uri.fsPath;
			label.textContent = selection.kind === 'codeSelection'
				? `${baseName}:${selection.startLine}-${selection.endLine}`
				: baseName;
			chip.appendChild(icon);
			chip.appendChild(label);
			strip.appendChild(chip);
		}
		return strip;
	}

	private renderRuntimeAssistantMessage(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>,
		threadId: string = this.activeThreadId ?? "",
		streaming = false,
	): HTMLElement {
		const visibleText = this.stripRuntimeAssistantWorkflowMarkup(message.content);
		// Upstream provider failures (400 status code, auth errors, safety-limit termination) are
		// stored verbatim as assistant content by `applyLoopError`. Those short one-line payloads
		// would otherwise render as plain prose and read as a debug log. Route them through a
		// dedicated error row so the transcript actually shows something went wrong.
		if (looksLikeRuntimeErrorContent(visibleText)) {
			return this.renderRuntimeErrorMessage(visibleText);
		}

		const item = document.createElement('div');
		item.className = 'vsclone-thread-message assistant runtime runtime-assistant';
		this.markRuntimeElementEntrance(item, `assistant:${message.id}`);
		if (streaming) {
			// The imperative runtime renderer bypasses the Preact conversation item's `streaming`
			// class, so mark the active assistant row here to let CSS animate provider deltas.
			item.classList.add('streaming');
		}

		const meta = document.createElement('div');
		meta.className = 'vsclone-thread-message-meta';
		meta.textContent = localize('vsclone.thread.assistantLabel', 'Assistant');
		item.appendChild(meta);

		const body = document.createElement('div');
		body.className = 'vsclone-thread-message-body';
		// Reasoning block renders above the assistant prose so the transcript reads top-to-bottom:
		// "Thought through X, then said Y." Mirrors Void's `ReasoningWrapper` placement inside
		// `AssistantMessageComponent`.
		const reasoningBlock = this.renderAssistantReasoningBlock(message, threadId);
		if (reasoningBlock) {
			body.appendChild(reasoningBlock);
		}
		if (visibleText.trim().length > 0) {
			if (visibleText.includes("<<<<<<< SEARCH") || this.looksLikePartialSearchReplaceBlock(visibleText)) {
				this.renderSearchReplaceAwareText(body, visibleText, streaming);
			} else {
				this.appendRuntimeAssistantMarkdownSegment(body, message.id, visibleText, streaming);
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

	/**
	 * Mirrors Void's `ReasoningWrapper` + `ChatMarkdownRender` stack inside `AssistantMessageComponent`.
	 * While the assistant is still streaming reasoning (no text yet), the panel is open by default so
	 * the user sees the model think in real time. Once final text arrives, the panel collapses to a
	 * compact "Reasoning" summary that stays clickable to re-expand. Manual toggles are sticky across
	 * the re-renders triggered by every streaming delta.
	 */
	private renderAssistantReasoningBlock(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>,
		threadId: string,
	): HTMLElement | undefined {
		const reasoningText = message.reasoning?.trim();
		if (!reasoningText) {
			return undefined;
		}

		const isLastMessage = this.isLastRuntimeMessage(threadId, message.id);
		const isStreaming = isLastMessage && this.isRuntimeStreamingForThread(threadId);
		// Match Void's `isDoneReasoning = !!chatMessage.displayContent`: the model finished thinking
		// the moment a visible text token shows up in the assistant turn.
		const hasVisibleText = this.stripRuntimeAssistantWorkflowMarkup(message.content).trim().length > 0;
		const isWriting = isStreaming && !hasVisibleText;

		// Default open while still writing, collapsed once text or final reasoning is in. Respect an
		// explicit user toggle above either default -- mirrors the `useEffect` + local `isOpen` state
		// inside Void's `ReasoningWrapper` component.
		const existing = this.reasoningPanelStateByMessageId.get(message.id);
		const defaultOpen = isWriting;
		const open = existing?.userToggled ? existing.open : defaultOpen;
		if (!existing || !existing.userToggled) {
			this.reasoningPanelStateByMessageId.set(message.id, { userToggled: false, open: defaultOpen });
		}

		const details = document.createElement('details');
		details.className = 'vsclone-thinking-block vsclone-reasoning-block';
		this.markRuntimeElementEntrance(details, `reasoning:${message.id}`);

		// Attach the toggle listener BEFORE flipping `details.open` programmatically. Setting
		// `details.open = true` queues a `toggle` event; without the guard, that event would fire
		// asynchronously and mark the panel as user-toggled, preventing the intended auto-collapse
		// when final text arrives. The `isProgrammaticToggle` flag lets the first programmatic open
		// pass through without recording a user preference.
		let isProgrammaticToggle = false;
		this.renderedMarkdownDisposables.add(addDisposableListener(details, 'toggle', () => {
			if (isProgrammaticToggle) {
				isProgrammaticToggle = false;
				return;
			}
			this.reasoningPanelStateByMessageId.set(message.id, {
				userToggled: true,
				open: details.open,
			});
		}));
		if (open) {
			isProgrammaticToggle = true;
			details.open = true;
		}

		const summary = document.createElement('summary');
		summary.className = 'vsclone-thinking-summary';

		const label = document.createElement('span');
		label.className = 'vsclone-thinking-summary-label';

		const verb = document.createElement('strong');
		// Mirror Void's `ReasoningWrapper`: the title stays 'Reasoning' at every phase; the spinner
		// appended below is what signals "still writing".
		verb.textContent = localize('vsclone.thread.reasoning.title', 'Reasoning');
		label.appendChild(verb);

		if (isWriting) {
			const spinner = document.createElement('span');
			spinner.className = 'codicon codicon-loading codicon-modifier-spin vsclone-reasoning-summary-spinner';
			spinner.setAttribute('aria-hidden', 'true');
			label.appendChild(spinner);
		}

		summary.appendChild(label);
		details.appendChild(summary);

		const content = document.createElement('div');
		content.className = 'vsclone-thinking-content';
		this.appendRuntimeAssistantMarkdownSegment(content, `reasoning:${message.id}`, reasoningText, isWriting);
		details.appendChild(content);

		return details;
	}

	/**
	 * Drop sticky reasoning-panel state for messages that no longer exist in the current runtime
	 * snapshot (thread switch, runtime reset, etc.). Keeps the map bounded across long sessions.
	 */
	private pruneReasoningPanelStateForRuntime(runtimeState: IVSCloneThreadRuntimeState | undefined): void {
		if (this.reasoningPanelStateByMessageId.size === 0) {
			return;
		}
		if (!runtimeState) {
			this.reasoningPanelStateByMessageId.clear();
			return;
		}
		const liveIds = new Set<string>();
		for (const message of runtimeState.messages) {
			if (message.role === 'assistant') {
				liveIds.add(message.id);
			}
		}
		for (const id of Array.from(this.reasoningPanelStateByMessageId.keys())) {
			if (!liveIds.has(id)) {
				this.reasoningPanelStateByMessageId.delete(id);
			}
		}
	}

	private isRuntimeStreamingForThread(threadId: string): boolean {
		const state = this.getThreadRuntimeState(threadId);
		return state?.streamState.kind !== undefined && state.streamState.kind !== 'idle';
	}

	private isLastRuntimeMessage(threadId: string, messageId: string): boolean {
		const state = this.getThreadRuntimeState(threadId);
		if (!state) {
			return false;
		}
		const last = state.messages.at(-1);
		return last?.id === messageId;
	}

	private renderRuntimeErrorMessage(rawErrorText: string): HTMLElement {
		const item = document.createElement('div');
		item.className = 'vsclone-thread-message assistant runtime runtime-error';
		this.markRuntimeElementEntrance(item, `error:${rawErrorText.trim()}`);

		const row = document.createElement('div');
		row.className = 'vsclone-runtime-error-row';

		const icon = document.createElement('span');
		icon.className = 'codicon codicon-warning vsclone-runtime-error-icon';
		icon.setAttribute('aria-hidden', 'true');
		row.appendChild(icon);

		const label = document.createElement('span');
		label.className = 'vsclone-runtime-error-label';
		label.textContent = toHumanReadableRuntimeError(rawErrorText);
		// Full error surface stays available on hover for debugging, since the humanized label
		// intentionally drops provider-specific detail like "(no body)".
		label.title = rawErrorText.trim();
		row.appendChild(label);

		item.appendChild(row);
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
		const statusClass = "running";
		switch (state.streamState.kind) {
			case "llm":
				label = localize(
					"vsclone.thread.runtime.status.llm",
					"Assistant is thinking...",
				);
				break;
			case "awaiting_user":
				// The inline approval card already communicates the pending tool + Approve/Reject buttons,
				// so the standalone yellow "Approval required" banner would just be a duplicate prompt.
				return undefined;
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
		this.markRuntimeElementEntrance(status, `status:${state.threadId}:${state.streamState.kind}:${state.streamState.kind === 'tool' ? state.streamState.toolName : ''}`);

		const body = document.createElement("div");
		body.className = "vsclone-thread-message-body";
		const badge = document.createElement("div");
		badge.className = "vsclone-runtime-status-badge";
		const icon = document.createElement("span");
		icon.className = "codicon codicon-loading codicon-modifier-spin";
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
		// attempt_completion is the agent's "I'm done" signal, not a real tool call. Cursor/Void
		// allow-any-unicode-next-line
		// don't have an equivalent — their agent loops stop when the model emits no tool call.
		// Rendering the tool card made it look like the agent was still working after its final
		// summary, so we fold the completion text into a final assistant-style row and drop the
		// intermediate request/running transitions. Rejections/errors still surface as compact
		// rows for diagnosability.
		if (message.toolName === "attempt_completion") {
			if (message.type === "tool_request" || message.type === "running_now") {
				return undefined;
			}
			if (message.type === "success") {
				const result = message.output?.trim();
				if (!result) {
					return undefined;
				}
				const item = document.createElement("div");
				item.className = "vsclone-thread-message assistant runtime runtime-assistant";
				this.markRuntimeElementEntrance(item, `assistant-tool-completion:${message.id}`);
				const body = document.createElement("div");
				body.className = "vsclone-thread-message-body";
				this.appendMarkdownSegment(body, result, "vsclone-thread-message-assistant-text");
				item.appendChild(body);
				return item;
			}
			return this.renderCompactRuntimeToolMessage(message);
		}

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
					this.markRuntimeElementEntrance(item, `tool:${message.id}:flat-diff`);
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
		this.markRuntimeElementEntrance(item, `tool:${message.id}:${message.type}`);

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
		this.markRuntimeElementEntrance(item, `tool:${message.id}:compact`);
		const status = this.toRuntimeToolCardStatus(message);
		item.classList.add(`status-${status}`);

		const line = document.createElement("div");
		line.className = "vsclone-runtime-tool-compact-line";

		const icon = document.createElement("span");
		icon.className = `codicon ${this.getToolIconClass(message.toolName)} vsclone-runtime-tool-compact-icon`;
		icon.setAttribute("aria-hidden", "true");
		line.appendChild(icon);

		const verb = document.createElement("span");
		verb.className = "vsclone-runtime-tool-compact-verb";
		verb.textContent = this.getCompactRuntimeToolVerb(message);
		line.appendChild(verb);

		const rawTarget = this.describeCompactRuntimeToolTarget(message.toolName, message.params);
		if (rawTarget) {
			const target = document.createElement("span");
			target.className = "vsclone-runtime-tool-compact-target";
			target.textContent = toCompactTargetLabel(rawTarget);
			// Full original path/pattern stays available on hover so truncation never costs context.
			target.title = rawTarget;
			line.appendChild(target);
		}

		item.appendChild(line);
		return item;
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

	private describeCompactRuntimeToolTarget(toolName: string, params: Readonly<Record<string, unknown>>): string {
		if (toolName === "search_for_files") {
			return this.describeRuntimeToolParamValue(params.pattern) || this.describeRuntimeToolParamValue(params.path);
		}
		return this.describeRuntimeToolParamValue(params.path);
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
		this.markRuntimeElementEntrance(item, `approval:${message.id}`);

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

		// Edits-only: offer a workspace-scoped trust toggle so the user doesn't have to click Approve
		// every time the agent wants to touch a file in a project they already trust. Other approval
		// types (terminal, MCP) still require explicit per-call consent.
		if (message.approvalType === "edits" && !this.threadRuntimeService.isAutoApproveEdits()) {
			const alwaysApproveButton = document.createElement("button");
			alwaysApproveButton.type = "button";
			alwaysApproveButton.className = "vsclone-runtime-approval-button always-approve";
			alwaysApproveButton.textContent = localize(
				"vsclone.thread.runtime.tool.alwaysApproveEdits",
				"Always approve edits in this project",
			);
			alwaysApproveButton.addEventListener(EventType.CLICK, () => {
				this.threadRuntimeService.setAutoApproveEdits(true);
				if (!this.threadRuntimeService.approveLatestToolRequest(threadId)) {
					this.notificationService.warn(
						localize(
							"vsclone.thread.runtime.tool.approveMissing",
							"The pending tool request is no longer available.",
						),
					);
				}
			});
			buttons.appendChild(alwaysApproveButton);
		}

		row.appendChild(buttons);
		item.appendChild(row);
		return item;
	}

	private renderRuntimeApprovalPreview(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: "tool"; readonly type: "tool_request" }>,
	): HTMLElement | undefined {
		if (message.approvalType === "MCP tools") {
			return this.renderRuntimeMcpApprovalPreview(message.params);
		}

		const filePath = this.describeRuntimeToolParamValue(message.params.path);
		if (!filePath) {
			return undefined;
		}

		if (message.toolName === "edit_file") {
			const changes = this.describeRuntimeToolParamValue(message.params.changes);
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

	private renderRuntimeMcpApprovalPreview(params: Readonly<Record<string, unknown>>): HTMLElement {
		const preview = document.createElement("div");
		preview.className = "vsclone-runtime-approval-preview";

		const code = document.createElement("pre");
		code.className = "vsclone-runtime-approval-json";
		// MCP tools can define arbitrary argument names, so the safest preview is a stable JSON
		// summary of the exact params the model asked to send rather than a path/command heuristic.
		code.textContent = this.serializeRuntimeApprovalJson(params);
		preview.appendChild(code);
		return preview;
	}

	private getRuntimeApprovalMessage(
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: "tool"; readonly type: "tool_request" }>,
	): string {
		const params = message.params;
		if (isFlatDiffRuntimeTool(message.toolName)) {
			const filePath = this.describeRuntimeToolParamValue(params.path);
			const filename = filePath ? (filePath.split("/").pop() ?? filePath) : undefined;
			return filename
				? localize("vsclone.thread.runtime.approval.edit", "Approve edit to {0}?", filename)
				: localize("vsclone.thread.runtime.approval.editGeneric", "Approve file edit?");
		}
		if (message.approvalType === "terminal") {
			const command = this.describeRuntimeToolParamValue(params.command);
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

	private describeRuntimeToolParams(params: Readonly<Record<string, unknown>>): string {
		const detailKeys = ["path", "command", "query", "dir", "directory"];
		for (const key of detailKeys) {
			const value = this.describeRuntimeToolParamValue(params[key]);
			if (value) {
				return ` (${value})`;
			}
		}
		return "";
	}

	private serializeRuntimeToolParams(params: Readonly<Record<string, unknown>>): string {
		return JSON.stringify(
			Object.keys(params)
				.sort((left, right) => left.localeCompare(right))
				.map((key) => [key, params[key]]),
		);
	}

	private serializeRuntimeApprovalJson(params: Readonly<Record<string, unknown>>): string {
		const serialized = JSON.stringify(this.toStableRuntimeApprovalJson(params), null, 2) ?? "{}";
		return serialized.length <= 4_000 ? serialized : `${serialized.slice(0, 4_000)}\n...`;
	}

	private toStableRuntimeApprovalJson(value: unknown): unknown {
		if (Array.isArray(value)) {
			return value.map(entry => this.toStableRuntimeApprovalJson(entry));
		}
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value as Readonly<Record<string, unknown>>)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, entry]) => [key, this.toStableRuntimeApprovalJson(entry)]),
			);
		}
		return value;
	}

	private describeRuntimeToolParamValue(value: unknown): string {
		if (typeof value === "string") {
			return value;
		}
		if (value === undefined || value === null) {
			return "";
		}
		return String(value);
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

	private appendRuntimeAssistantMarkdownSegment(
		container: HTMLElement,
		messageId: string,
		markdownText: string,
		streaming: boolean,
	): void {
		if (!streaming) {
			this.streamedAssistantTextByMessageId.delete(messageId);
			this.appendMarkdownSegment(container, markdownText, "vsclone-thread-message-assistant-text");
			return;
		}

		const previousText = this.streamedAssistantTextByMessageId.get(messageId);
		this.streamedAssistantTextByMessageId.set(messageId, markdownText);

		if (previousText === markdownText) {
			this.appendMarkdownSegment(container, markdownText, "vsclone-thread-message-assistant-text");
			return;
		}

		if (previousText && !markdownText.startsWith(previousText)) {
			// Provider/tool rewrites can replace earlier text instead of appending to it. In that case
			// there is no stable prefix to preserve, so render normally rather than refading old words.
			this.appendMarkdownSegment(container, markdownText, "vsclone-thread-message-assistant-text");
			return;
		}

		const stablePrefix = previousText ?? "";
		const appendedText = markdownText.slice(stablePrefix.length);
		if (!appendedText) {
			this.appendMarkdownSegment(container, markdownText, "vsclone-thread-message-assistant-text");
			return;
		}

		const segment = document.createElement("div");
		segment.className = "vsclone-thread-message-assistant-text vsclone-thread-message-streaming-composite";
		container.appendChild(segment);

		// Render the stable prefix as markdown and append only the new provider delta as a fading
		// plain-text fragment. This avoids the full-answer fade caused by rebuilding the DOM.
		this.appendMarkdownSegment(segment, stablePrefix, "vsclone-thread-message-streaming-prefix");
		this.appendFadingStreamedText(segment, appendedText);
	}

	private appendFadingStreamedText(container: HTMLElement, text: string): void {
		const streamedFragment = document.createElement("span");
		streamedFragment.className = "vsclone-streamed-text-fragment";
		container.appendChild(streamedFragment);

		let wordIndex = 0;
		for (const token of text.split(/(\s+)/)) {
			if (!token) {
				continue;
			}
			if (/^\s+$/.test(token)) {
				streamedFragment.appendChild(document.createTextNode(token));
				continue;
			}

			const word = document.createElement("span");
			word.className = "vsclone-streamed-word";
			// Stagger only the new suffix and cap the delay so large provider chunks do not trickle in
			// long after the text is already available to read.
			word.style.animationDelay = `${Math.min(wordIndex, 12) * 14}ms`;
			word.textContent = token;
			streamedFragment.appendChild(word);
			wordIndex++;
		}
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

		const filename = toCompactTargetLabel(filePath);
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
	 * The chat pane only ever surfaces the basename; git-style prefixes and file:// schemes from
	 * upstream tooling would otherwise eat the interesting tail of the path under right-ellipsis.
	 */
	private extractFilenameFromDiff(diff: string): string | undefined {
		for (const line of diff.split("\n")) {
			if (line.startsWith("+++ ") && !line.startsWith("+++ /dev/null")) {
				const rawPath = line.slice(4).trim().replace(/^[ab]\//, "");
				return toCompactTargetLabel(rawPath);
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
			// Full URI stays in the tooltip regardless of line-navigation state so users never lose
			// the path after we switched the label to basename-only.
			fileLabel.title =
				titleNavigation.startLineNumber !== undefined
					? localize(
						"vsclone.thread.toolDiff.openAtLineTitle",
						"Open {0} at line {1}",
						fileUri ?? filename,
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
			32,
			Math.min(104, this.composerInput.scrollHeight),
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
		if (this.reasoningEnabledInput) {
			const reasoningEnabledHidden =
				this.reasoningEnabledContainer?.classList.contains('hidden') ?? true;
			this.reasoningEnabledInput.disabled =
				composerBusy || reasoningEnabledHidden;
		}
		if (this.reasoningBudgetInput) {
			const reasoningBudgetHidden =
				this.reasoningBudgetContainer?.classList.contains('hidden') ?? true;
			this.reasoningBudgetInput.disabled =
				composerBusy || reasoningBudgetHidden;
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
		this.updateContextUsageIndicator();
	}

	private updateContextUsageIndicator(): void {
		if (!this.composerContextUsageButton || !this.composerContextUsageProgressPath || !this.composerContextUsagePopover) {
			return;
		}

		const selectedModel = this.getCurrentComposerModelSelection(this.activeThreadId);
		if (!selectedModel) {
			this.clearContextUsageIndicator();
			return;
		}
		const contextWindow = this.getEstimatedModelContextWindow(selectedModel.modelIdentifier);

		this.composerContextUsageButton.classList.remove('hidden');
		const displayUsage = this.getContextUsageDisplay(contextWindow, selectedModel.modelIdentifier);
		const circumference = 2 * Math.PI * 8;
		this.composerContextUsageProgressPath.style.strokeDasharray = `${circumference}`;
		this.composerContextUsageProgressPath.style.strokeDashoffset = `${circumference * (1 - displayUsage.percentage / 100)}`;
		const meter = this.composerContextUsageProgressPath.ownerSVGElement;
		meter?.setAttribute('aria-valuenow', displayUsage.percentage.toFixed(0));
		meter?.setAttribute('aria-valuetext', localize(
			'vsclone.composer.contextUsage.meterValue',
			'{0} percent of context window used',
			displayUsage.percentage.toFixed(0),
		));
		this.composerContextUsageButton.classList.toggle('warning', displayUsage.percentage >= 75 && displayUsage.percentage < 90);
		this.composerContextUsageButton.classList.toggle('error', displayUsage.percentage >= 90);

		this.renderContextUsagePopover(displayUsage);
	}

	private clearContextUsageIndicator(): void {
		if (!this.composerContextUsageButton || !this.composerContextUsagePopover) {
			return;
		}

		this.composerContextUsagePopoverPinned = false;
		this.composerContextUsageButton.classList.add('hidden');
		this.composerContextUsageButton.classList.remove('warning', 'error');
		this.composerContextUsageButton.setAttribute('aria-expanded', 'false');
		this.composerContextUsageButton.setAttribute('aria-label', localize('vsclone.composer.contextUsageUnavailable', 'Context window usage unavailable'));
		this.composerContextUsagePopover.classList.add('hidden');
		this.composerContextUsagePopover.replaceChildren();
	}

	private setContextUsagePopoverVisible(visible: boolean): void {
		if (!this.composerContextUsageButton || !this.composerContextUsagePopover || this.composerContextUsageButton.classList.contains('hidden')) {
			return;
		}

		this.composerContextUsagePopover.classList.toggle('hidden', !visible);
		this.composerContextUsageButton.setAttribute('aria-expanded', visible ? 'true' : 'false');
	}

	private getContextUsageDisplay(contextWindow: number, modelIdentifier: string): IContextUsageDisplay {
		const runtimeState = this.getThreadRuntimeState(this.activeThreadId);
		const providerUsage = runtimeState?.tokenUsage;
		const hasPendingComposerInput = this.hasPendingComposerContext();
		if (providerUsage?.source === 'provider'
			&& runtimeState?.streamState.kind === 'idle'
			&& !hasPendingComposerInput
			&& (!providerUsage.modelIdentifier || providerUsage.modelIdentifier === modelIdentifier)) {
			const usage = {
				...providerUsage,
				maxTokens: providerUsage.maxTokens ?? contextWindow,
			};
			return {
				usage,
				percentage: Math.max(0, Math.min(100, (usage.usedTokens / (usage.maxTokens ?? contextWindow)) * 100)),
				label: localize('vsclone.composer.contextUsage.providerLabel', 'Provider reported'),
			};
		}

		const localContext = this.countCurrentContextLocally();
		const estimatedPromptTokens = Math.max(0, Math.ceil(localContext.characters / estimatedCharsPerToken));
		const usage: IVSCloneTokenUsage = {
			usedTokens: estimatedPromptTokens,
			maxTokens: contextWindow,
			inputTokens: estimatedPromptTokens,
			source: 'local-preflight',
			modelIdentifier,
		};
		return {
			usage,
			characters: localContext.characters,
			percentage: Math.max(0, Math.min(100, (estimatedPromptTokens / contextWindow) * 100)),
			label: localize('vsclone.composer.contextUsage.preflightLabel', 'Local preflight estimate'),
		};
	}

	private hasPendingComposerContext(): boolean {
		return (this.composerInput?.value.trim().length ?? 0) > 0
			|| this.pendingContextSelections.length > 0
			|| this.pendingImages.length > 0;
	}

	private renderContextUsagePopover(displayUsage: IContextUsageDisplay): void {
		if (!this.composerContextUsageButton || !this.composerContextUsagePopover) {
			return;
		}

		const { usage, percentage } = displayUsage;
		const maxTokens = usage.maxTokens ?? 0;
		this.composerContextUsagePopover.replaceChildren();
		const tokenLine = document.createElement('div');
		tokenLine.className = 'vsclone-thread-context-usage-popover-value';
		tokenLine.textContent = localize(
			'vsclone.composer.contextUsage.tokensValueConcise',
			'{0} / {1} ({2}%)',
			formatTokenEstimate(usage.usedTokens),
			formatTokenEstimate(maxTokens),
			percentage.toFixed(0),
		);
		this.composerContextUsagePopover.append(tokenLine);

		const accessibleLabel = localize(
			'vsclone.composer.contextUsage.accessibleConcise',
			'Context window usage: {0} of {1} tokens, {2} percent. Press to show details.',
			formatTokenEstimate(usage.usedTokens),
			formatTokenEstimate(maxTokens),
			percentage.toFixed(0),
		);
		this.composerContextUsageButton.setAttribute('aria-label', accessibleLabel);
	}

	private countCurrentContextLocally(): { readonly characters: number } {
		const runtimeState = this.getThreadRuntimeState(this.activeThreadId);
		let characters = 0;
		for (const message of runtimeState?.messages ?? []) {
			if (message.role === 'user') {
				// Stored user messages already include the serialized SELECTIONS block in `content`.
				// The metadata only drives transcript chips, so adding it here would double-count
				// context that the LLM sees once on replay.
				characters += message.content.length;
			} else if (message.role === 'assistant') {
				characters += message.content.length;
				characters += message.reasoning?.length ?? 0;
			} else if (message.role === 'tool') {
				// Tool payloads are replayed to the model as compact transcript state, so include
				// names, params, and output while avoiding UI-only checkpoint snapshots.
				characters += message.toolName.length;
				characters += JSON.stringify(message.params).length;
				characters += message.type !== 'tool_request' && message.type !== 'running_now'
					? message.output?.length ?? 0
					: 0;
			}
		}

		characters += this.composerInput?.value.length ?? 0;
		characters += this.pendingContextSelectionsCharacters;
		characters += this.pendingImages.length * 1_000 * estimatedCharsPerToken;
		return { characters: Math.max(0, characters) };
	}

	private estimateContextSelectionCharacters(selection: IVSCloneContextSelection): number {
		const pathLength = selection.uri.toString().length;
		if (selection.kind !== 'codeSelection') {
			return pathLength;
		}
		return pathLength + String(selection.startLine).length + String(selection.endLine).length;
	}

	private getEstimatedModelContextWindow(modelIdentifier: string): number {
		const modelId = modelIdentifier.split('/').slice(1).join('/') || modelIdentifier;
		for (const [pattern, contextWindow] of modelContextWindowById) {
			if (pattern.test(modelId)) {
				return contextWindow;
			}
		}
		// Unknown provider models still need a useful meter; 128k is a conservative modern default
		// that avoids implying unlimited context when the static catalog lacks Void's metadata.
		return 128_000;
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

	private getConfiguredRailWidth(): number {
		return Math.min(
			railMaxWidth,
			Math.max(
				railMinWidth,
				this.configurationService.getValue<number>(railWidthSetting) ?? 320,
			),
		);
	}

	private updateRailWidthFromConfiguration(): void {
		const width = this.getConfiguredRailWidth();
		if (width === this.railWidth) {
			return;
		}
		this.railWidth = width;
		// The settings slider writes configuration outside the drag path, so apply the layout here
		// to keep any currently visible rail in sync with the stored width immediately.
		this.applyRailLayout();
	}

	private applyRailLayout(): void {
		if (!this.rootContainer || !this.railContainer || !this.railResizeHandle) {
			return;
		}

		this.rootContainer.classList.toggle("rail-hidden", !this.railVisible);
		this.rootContainer.classList.toggle("thread-rail-screen", this.railVisible && this.isCompactLayout);
		this.railContainer.style.width = this.railVisible ? `${this.railWidth}px` : "0px";
		this.railResizeHandle.style.display = this.railVisible && !this.isCompactLayout ? "" : "none";
		if (this.conversationContainer) {
			this.conversationContainer.style.display = this.railVisible && this.isCompactLayout ? "none" : "";
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
		this.refreshReasoningEnabledControl();
		this.refreshReasoningBudgetControl();
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
		const reasoningCapabilities = selectedModelDescriptor?.capabilities.reasoningCapabilities || undefined;
		const reasoningSlider = reasoningCapabilities?.reasoningSlider;
		const canTurnOff = reasoningCapabilities?.canTurnOffReasoning === true;

		// Live-read every visible reasoning control (preset select, enabled checkbox, budget range)
		// so a Send click immediately after flipping a knob picks up the new value before storage
		// settle events propagate. Mirrors `ReasoningOptionSlider`'s onChange handlers in Void.
		let resolvedReasoningEffort = selectedModel.reasoningEffort;
		let resolvedReasoningEnabled = selectedModel.reasoningEnabled;
		let resolvedReasoningBudget = selectedModel.reasoningBudget;

		if (reasoningSlider?.type === 'effort_slider') {
			const supportedReasoningLevels = reasoningSlider.values;
			const selectedFromControl =
				this.reasoningEffortContainer && !this.reasoningEffortContainer.classList.contains('hidden')
					? (this.reasoningEffortSelect?.value as VSCloneReasoningEffortLevel | undefined)
					: undefined;
			resolvedReasoningEffort =
				selectedFromControl && supportedReasoningLevels.includes(selectedFromControl)
					? selectedFromControl
					: selectedModel.reasoningEffort && supportedReasoningLevels.includes(selectedModel.reasoningEffort)
						? selectedModel.reasoningEffort
						: reasoningSlider.default;
			// Mirror Void's effort-slider onChange: the `'none'` sentinel in a model that can be
			// turned off means reasoning is disabled, regardless of any previously-persisted
			// `reasoningEnabled` value. Without this the Send path would emit `reasoning: { effort }`
			// for the off selection because the live-read ignored the off semantics.
			if (canTurnOff && resolvedReasoningEffort === 'none') {
				resolvedReasoningEnabled = false;
			} else if (canTurnOff && selectedFromControl !== undefined && selectedFromControl !== 'none') {
				resolvedReasoningEnabled = true;
			}
		} else if (!reasoningSlider) {
			// No slider: effort has no meaning for this model.
			resolvedReasoningEffort = undefined;
		}

		if (canTurnOff && !reasoningSlider
			&& this.reasoningEnabledContainer && !this.reasoningEnabledContainer.classList.contains('hidden')
			&& this.reasoningEnabledInput) {
			resolvedReasoningEnabled = this.reasoningEnabledInput.checked;
		}

		if (reasoningSlider?.type === 'budget_slider'
			&& this.reasoningBudgetContainer && !this.reasoningBudgetContainer.classList.contains('hidden')
			&& this.reasoningBudgetInput) {
			const { min: rawMin, max } = reasoningSlider;
			const stepCount = 8;
			const stepSize = Math.max(1, Math.round((max - rawMin) / stepCount));
			const valueIfOff = rawMin - stepSize;
			const rawValue = Number(this.reasoningBudgetInput.value);
			if (!Number.isNaN(rawValue)) {
				const isOff = canTurnOff && rawValue === valueIfOff;
				// Mirror Void's `ReasoningOptionSlider` onChange: persist the raw slider value even
				// at the off notch, and flip `reasoningEnabled` to reflect on/off. The send-path
				// sendable-info helper treats `reasoningEnabled: false` as off regardless of the
				// stored budget.
				resolvedReasoningEnabled = !isOff;
				resolvedReasoningBudget = rawValue;
			}
		}

		return {
			...selectedModel,
			threadId: threadId ?? undefined,
			reasoningEffort: resolvedReasoningEffort,
			reasoningEnabled: resolvedReasoningEnabled,
			reasoningBudget: resolvedReasoningBudget,
		};
	}

	private refreshReasoningEffortControl(): void {
		if (!this.reasoningEffortContainer || !this.reasoningEffortSelect) {
			return;
		}

		if (!this.isModelSwitcherEnabled()) {
			// The reasoning selector is an extension of composer model selection; hiding it with
			// the picker preserves the prior single-control composer when the switcher is disabled.
			this.reasoningEffortContainer.classList.add("hidden");
			this.reasoningEffortSelect.replaceChildren();
			this.updateComposerState();
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
		// Mirror Void's `ReasoningOptionSlider` branch for `reasoningSlider.type === 'effort_slider'`:
		// the effort picker is visible only when the model exposes an effort-slider capability, and
		// its options come from `reasoningSlider.values` (not the derived `reasoningEffortLevels`
		// union, which also covers budget-slider models via a different control).
		const reasoningCapabilities = selectedModelDescriptor?.capabilities.reasoningCapabilities || undefined;
		const reasoningSlider = reasoningCapabilities?.reasoningSlider;
		if (!selectedModel || !reasoningSlider || reasoningSlider.type !== 'effort_slider') {
			this.reasoningEffortContainer.classList.add("hidden");
			this.reasoningEffortSelect.replaceChildren();
			this.updateComposerState();
			return;
		}

		// Mirror Void's `ReasoningOptionSlider` effort-slider branch: `min = canTurnOffReasoning ? -1 : 0`.
		// The off slot is exposed only when the model supports being turned off AND the catalog lists
		// the `'none'` sentinel among the selectable values. Otherwise the picker only shows real
		// effort levels, and the enabled state stays sticky-on for non-off-capable models.
		const canTurnOff = reasoningCapabilities?.canTurnOffReasoning === true;
		const catalogValues = reasoningSlider.values;
		const exposeOffOption = canTurnOff && catalogValues.includes('none');
		const supportedReasoningLevels = exposeOffOption
			? catalogValues
			: catalogValues.filter((level) => level !== 'none');
		const defaultReasoningEffort = reasoningSlider.default;
		// If reasoning is disabled (`reasoningEnabled: false`) and the off option is available,
		// reflect that state by selecting `'none'`. Mirrors Void's `value = isReasoningEnabled && currentEffort ? indexOf(currentEffort) : valueIfOff`.
		const storedReasoningEnabled = selectedModel.reasoningEnabled;
		const effectiveOff = exposeOffOption && storedReasoningEnabled === false;
		const selectedReasoningEffort = effectiveOff
			? 'none'
			: selectedModel.reasoningEffort &&
				supportedReasoningLevels.includes(selectedModel.reasoningEffort)
				? selectedModel.reasoningEffort
				: supportedReasoningLevels.includes(defaultReasoningEffort)
					? defaultReasoningEffort
					: supportedReasoningLevels[0];

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
		// Mirror `refreshReasoningEffortControl`: only react when the active model owns an effort
		// slider, so we don't persist effort values for budget-slider or toggle-only models.
		const reasoningCapabilities = selectedModelDescriptor?.capabilities.reasoningCapabilities || undefined;
		const reasoningSlider = reasoningCapabilities?.reasoningSlider;
		if (!selectedModel || !reasoningSlider || reasoningSlider.type !== 'effort_slider') {
			return;
		}
		const canTurnOff = reasoningCapabilities?.canTurnOffReasoning === true;
		const supportedReasoningLevels = reasoningSlider.values;

		const nextReasoningEffort = this.reasoningEffortSelect
			.value as VSCloneReasoningEffortLevel;
		if (!supportedReasoningLevels.includes(nextReasoningEffort)) {
			return;
		}

		// Mirror Void's `ReasoningOptionSlider` effort-slider onChange:
		// `{ reasoningEnabled: !isOff, reasoningEffort: values[newVal] ?? undefined }`.
		// VSClone uses the `'none'` sentinel value as the off slot (rather than Void's synthetic -1
		// index), so picking `'none'` with `canTurnOffReasoning` flips the persisted enabled flag to
		// false. That makes `getVSCloneIsReasoningEnabledState` return false, short-circuiting
		// `getVSCloneSendableReasoningInfo` to null so the OpenAI Responses builder omits the
		// `reasoning` field entirely instead of emitting `{ effort: 'minimal' }`.
		const isOff = canTurnOff && nextReasoningEffort === 'none';
		const nextReasoningEnabled = !isOff;
		if (
			selectedModel.reasoningEffort === nextReasoningEffort &&
			(selectedModel.reasoningEnabled ?? true) === nextReasoningEnabled
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
				reasoningEnabled: nextReasoningEnabled,
				selectedAt: Date.now(),
			},
		);
	}

	/**
	 * Mirrors Void's `ReasoningOptionSlider` branch for `canTurnOffReasoning && !reasoningBudgetSlider`:
	 * models that support thinking but cannot expose a budget or effort knob show a simple on/off
	 * toggle next to the model picker. The Chat feature defaults to enabled to match Void, so the
	 * visible checkbox reflects the effective enabled state rather than the stored `reasoningEnabled`
	 * value alone.
	 */
	private refreshReasoningEnabledControl(): void {
		if (!this.reasoningEnabledContainer || !this.reasoningEnabledInput) {
			return;
		}

		if (!this.isModelSwitcherEnabled()) {
			// Reasoning controls are extensions of composer model selection, so hide them with the
			// picker to preserve the configured single-control composer.
			this.reasoningEnabledContainer.classList.add('hidden');
			this.updateComposerState();
			return;
		}

		const selectedModel = this.settingsService.getCurrentSelectionForFeature(
			this.activeThreadId ?? '',
			'chat',
		);
		const selectedModelDescriptor = selectedModel
			? this.settingsService.getModel(selectedModel.modelIdentifier)
			: undefined;
		const reasoningCapabilities = selectedModelDescriptor?.capabilities.reasoningCapabilities || undefined;
		// Only show the toggle when the model can be switched off entirely and there is no slider
		// taking ownership of the enabled state. For budget sliders the leftmost "off" notch doubles
		// as the disable control; for effort sliders the effort value itself includes the off state.
		// This matches Void: `canTurnOffReasoning && !reasoningBudgetSlider` is the standalone-toggle
		// branch in `ReasoningOptionSlider`.
		const canTurnOff = reasoningCapabilities?.canTurnOffReasoning === true;
		const hasSlider = !!reasoningCapabilities?.reasoningSlider;
		if (!selectedModel || !canTurnOff || hasSlider) {
			this.reasoningEnabledContainer.classList.add('hidden');
			this.updateComposerState();
			return;
		}

		// Chat defaults to reasoning-on when the stored option is absent, mirroring Void's
		// `getIsReasoningEnabledState` default branch for the Chat feature.
		const effectiveEnabled = selectedModel.reasoningEnabled ?? true;
		this.reasoningEnabledInput.checked = effectiveEnabled;
		this.reasoningEnabledContainer.classList.remove('hidden');
		this.updateComposerState();
	}

	private async updateReasoningEnabledSelection(): Promise<void> {
		if (!this.reasoningEnabledInput) {
			return;
		}

		const selectedModel = this.settingsService.getCurrentSelectionForFeature(
			this.activeThreadId ?? '',
			'chat',
		);
		if (!selectedModel) {
			return;
		}

		const nextEnabled = this.reasoningEnabledInput.checked;
		if ((selectedModel.reasoningEnabled ?? true) === nextEnabled) {
			return;
		}

		await this.settingsService.setSelectionForFeature(this.activeThreadId ?? '', {
			...selectedModel,
			threadId: this.activeThreadId,
			location: 'chat',
			reasoningEnabled: nextEnabled,
			selectedAt: Date.now(),
		});
	}

	/**
	 * Mirrors Void's `ReasoningOptionSlider` branch for `reasoningBudgetSlider?.type === 'budget_slider'`:
	 * providers with raw token budgets get a range slider whose current value is shown as token count
	 * next to the control. Built-in Haiku and Gemini now use preset selectors instead.
	 */
	private refreshReasoningBudgetControl(): void {
		if (!this.reasoningBudgetContainer || !this.reasoningBudgetInput) {
			return;
		}

		if (!this.isModelSwitcherEnabled()) {
			// Budget sliders belong to model selection just like the picker and effort dropdown.
			this.reasoningBudgetContainer.classList.add('hidden');
			this.updateComposerState();
			return;
		}

		const selectedModel = this.settingsService.getCurrentSelectionForFeature(
			this.activeThreadId ?? '',
			'chat',
		);
		const selectedModelDescriptor = selectedModel
			? this.settingsService.getModel(selectedModel.modelIdentifier)
			: undefined;
		const reasoningCapabilities = selectedModelDescriptor?.capabilities.reasoningCapabilities || undefined;
		const reasoningSlider = reasoningCapabilities?.reasoningSlider;
		if (!selectedModel || !reasoningSlider || reasoningSlider.type !== 'budget_slider') {
			this.reasoningBudgetContainer.classList.add('hidden');
			this.updateComposerState();
			return;
		}

		const canTurnOff = reasoningCapabilities?.canTurnOffReasoning === true;
		const { min: rawMin, max, default: defaultVal } = reasoningSlider;
		// Step size approximated from Void: 8 notches across the configured [min, max] range gives the
		// same coarse-grained control that `VoidSlider` renders next to the picker.
		const stepCount = 8;
		const stepSize = Math.max(1, Math.round((max - rawMin) / stepCount));
		const valueIfOff = rawMin - stepSize;
		const min = canTurnOff ? valueIfOff : rawMin;
		const effectiveEnabled = selectedModel.reasoningEnabled ?? true;
		const storedBudget = selectedModel.reasoningBudget;
		// Mirror Void's `ReasoningOptionSlider`: when enabled, use the stored budget (even if it
		// equals `valueIfOff` from a previous off state) falling back to the default; when disabled,
		// pin to the off notch regardless of the stored value.
		const value = effectiveEnabled
			? (storedBudget ?? defaultVal)
			: valueIfOff;

		this.reasoningBudgetInput.min = String(min);
		this.reasoningBudgetInput.max = String(max);
		this.reasoningBudgetInput.step = String(stepSize);
		this.reasoningBudgetInput.value = String(value);
		this.reasoningBudgetContainer.classList.remove('hidden');
		this.updateReasoningBudgetValueLabel(value, effectiveEnabled);
		this.updateComposerState();
	}

	private async updateReasoningBudgetSelection(): Promise<void> {
		if (!this.reasoningBudgetInput) {
			return;
		}

		const selectedModel = this.settingsService.getCurrentSelectionForFeature(
			this.activeThreadId ?? '',
			'chat',
		);
		const selectedModelDescriptor = selectedModel
			? this.settingsService.getModel(selectedModel.modelIdentifier)
			: undefined;
		const reasoningCapabilities = selectedModelDescriptor?.capabilities.reasoningCapabilities || undefined;
		const reasoningSlider = reasoningCapabilities?.reasoningSlider;
		if (!selectedModel || !reasoningSlider || reasoningSlider.type !== 'budget_slider') {
			return;
		}

		const canTurnOff = reasoningCapabilities?.canTurnOffReasoning === true;
		const { min: rawMin, max } = reasoningSlider;
		const stepCount = 8;
		const stepSize = Math.max(1, Math.round((max - rawMin) / stepCount));
		const valueIfOff = rawMin - stepSize;
		const rawValue = Number(this.reasoningBudgetInput.value);
		if (Number.isNaN(rawValue)) {
			return;
		}

		const isOff = canTurnOff && rawValue === valueIfOff;
		const nextEnabled = !isOff;
		// Mirror Void's `ReasoningOptionSlider` onChange: persist the raw slider value even when it
		// lands on the off notch, and drive the enabled/disabled state via `reasoningEnabled`. The
		// `getVSCloneSendableReasoningInfo` helper + provider send paths treat
		// `reasoningEnabled: false` as off regardless of the stored budget value.
		const nextBudget = rawValue;
		if (
			(selectedModel.reasoningEnabled ?? true) === nextEnabled
			&& selectedModel.reasoningBudget === nextBudget
		) {
			return;
		}

		await this.settingsService.setSelectionForFeature(this.activeThreadId ?? '', {
			...selectedModel,
			threadId: this.activeThreadId,
			location: 'chat',
			reasoningEnabled: nextEnabled,
			reasoningBudget: nextBudget,
			selectedAt: Date.now(),
		});
	}

	/**
	 * Live-update the token count shown next to the budget slider as the user drags. Persistence
	 * still waits for the `change` event so one commit lands per pointer-release.
	 */
	private updateReasoningBudgetValueLabelFromInput(): void {
		if (!this.reasoningBudgetInput) {
			return;
		}
		const selectedModel = this.settingsService.getCurrentSelectionForFeature(
			this.activeThreadId ?? '',
			'chat',
		);
		const selectedModelDescriptor = selectedModel
			? this.settingsService.getModel(selectedModel.modelIdentifier)
			: undefined;
		const reasoningCapabilities = selectedModelDescriptor?.capabilities.reasoningCapabilities || undefined;
		const reasoningSlider = reasoningCapabilities?.reasoningSlider;
		if (!reasoningSlider || reasoningSlider.type !== 'budget_slider') {
			return;
		}
		const canTurnOff = reasoningCapabilities?.canTurnOffReasoning === true;
		const { min: rawMin, max } = reasoningSlider;
		const stepCount = 8;
		const stepSize = Math.max(1, Math.round((max - rawMin) / stepCount));
		const valueIfOff = rawMin - stepSize;
		const rawValue = Number(this.reasoningBudgetInput.value);
		if (Number.isNaN(rawValue)) {
			return;
		}
		const enabled = !(canTurnOff && rawValue === valueIfOff);
		this.updateReasoningBudgetValueLabel(enabled ? rawValue : valueIfOff, enabled);
	}

	private updateReasoningBudgetValueLabel(value: number, enabled: boolean): void {
		if (!this.reasoningBudgetValueLabel) {
			return;
		}
		this.reasoningBudgetValueLabel.textContent = enabled
			? localize('vsclone.composer.reasoningBudget.tokens', '{0} tokens', value)
			: localize('vsclone.composer.reasoningBudget.off', 'Thinking disabled');
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
		contextSelections?: readonly IVSCloneContextSelection[];
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
						contextSelections: message.contextSelections,
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

	private showComposerForNewChat(): void {
		this.activeThreadId = undefined;
		this.rail.setSelectedThread(undefined);
		// New chat starts in composer mode even if the user opened it from settings.
		this.settingsVisible = false;
		this.refreshPlanModeControl();
		this.refreshModelControls();
		this.refreshConversation();
		this.railVisible = false;
		this.applyRailLayout();
		this.focusInput();
	}
}
