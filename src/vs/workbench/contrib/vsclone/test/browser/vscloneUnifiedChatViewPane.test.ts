/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
// This DOM-heavy suite uses prototype-only panes and partial workbench service mocks so it can pin
// rendering behavior without constructing the full VS Code workbench dependency graph.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { VSCloneUnifiedChatViewPane } from '../../browser/vscloneUnifiedChatViewPane.js';
import type { VSCloneEditApplyResult } from '../../browser/vscloneEditCodeServiceInterface.js';
import type { IVSCloneContextSelection } from '../../common/vscloneContextSelectionTypes.js';
import type { IVSCloneModelSelection } from '../../common/vscloneModelSelectionTypes.js';
import type {
	IVSCloneThreadRuntimeMessage,
	IVSCloneThreadRuntimeRunContext,
	IVSCloneThreadRuntimeState,
	IVSCloneThreadRuntimeToolRequestMessage,
} from '../../common/vscloneThreadRuntimeTypes.js';
import { createEmptyVSCloneFeatureDefaults, createEmptyVSCloneModelSelectionOfFeature, type IVSCloneSettingsState } from '../../common/vscloneSettingsTypes.js';

interface IVSCloneUnifiedChatViewPaneHarness {
	threadRuntimeService: {
		approveLatestToolRequest(threadId: string): boolean;
		rejectLatestToolRequest(threadId: string, reason?: string): boolean;
	};
	notificationService: {
		warn(message: string): void;
	};
	renderRuntimeToolActions(
		threadId: string,
		state: IVSCloneThreadRuntimeState,
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'tool' }>,
	): HTMLElement | undefined;
}

interface IStreamingMarkdownHarness {
	streamedAssistantTextByMessageId: Map<string, string>;
	appendRuntimeAssistantMarkdownSegment(
		container: HTMLElement,
		messageId: string,
		markdownText: string,
		streaming: boolean,
	): void;
}

interface IRuntimeEntranceHarness {
	enteredRuntimeElementKeys: Set<string>;
	currentRuntimeElementKeys: Set<string>;
	markRuntimeElementEntrance(element: HTMLElement, key: string): void;
	pruneEnteredRuntimeElementKeys(): void;
}

interface ISettingsHarness {
	pane: VSCloneUnifiedChatViewPane;
	host: HTMLElement;
	settingsContainer: HTMLElement;
	configurationWrites: Array<{ key: string; value: unknown }>;
	oauthCalls: string[];
}

interface IContextUsageHarness {
	pane: VSCloneUnifiedChatViewPane;
	button: HTMLButtonElement;
	popover: HTMLElement;
	progress: SVGCircleElement;
	input: HTMLTextAreaElement;
}

interface IContextUsagePaneInternals {
	activeThreadId?: string;
	composerInput?: HTMLTextAreaElement;
	composerContextUsageButton?: HTMLButtonElement;
	composerContextUsageProgressPath?: SVGCircleElement;
	composerContextUsagePopover?: HTMLElement;
	composerContextUsagePopoverPinned: boolean;
	pendingContextSelections: IVSCloneContextSelection[];
	pendingContextSelectionsCharacterKey: string;
	pendingContextSelectionsCharacters: number;
	pendingContextSelectionsCharacterVersion: number;
	pendingImages: unknown[];
	fileService: IFileService;
	threadRuntimeService: {
		getState(threadId: string): IVSCloneThreadRuntimeState | undefined;
	};
	getCurrentComposerModelSelection(threadId: string | undefined): IVSCloneModelSelection | undefined;
	updateContextUsageIndicator(): void;
	setContextUsagePopoverVisible(visible: boolean): void;
	countCurrentContextLocally(): { readonly characters: number };
	refreshPendingContextSelectionCharacterCount(): void;
}

interface IComposerAttachmentMentionHarness {
	activeThreadId?: string;
	rootContainer?: HTMLElement;
	composerInput?: HTMLTextAreaElement;
	composerImageStrip?: HTMLElement;
	composerContextStrip?: HTMLElement;
	mentionMenuRoot?: HTMLElement;
	mentionMenuList?: HTMLElement;
	mentionMenuHeaderQuery?: HTMLElement;
	mentionMenuOpen: boolean;
	mentionMenuQuery: string;
	mentionMenuItems: Array<{ kind: 'file' | 'folder'; uri: URI; label: string; relativePath: string }>;
	mentionMenuActiveIndex: number;
	mentionMenuTriggerStart: number;
	pendingImages: Array<{ mimeType: string; base64Data: string; dataUrl: string }>;
	pendingContextSelections: IVSCloneContextSelection[];
	pendingContextSelectionsCharacterKey: string;
	pendingContextSelectionsCharacters: number;
	pendingContextSelectionsCharacterVersion: number;
	settingsService: { getModel(identifier: string): { supportsImages: boolean } | undefined };
	notificationService: { warn(message: string): void; info(message: string): void };
	mentionSearchService: { search(query: string, limit: number, token: unknown): Promise<Array<{ kind: 'file' | 'folder'; uri: URI; label: string; relativePath: string }>> };
	languageService: { guessLanguageIdByFilepathOrFirstLine(uri: URI): string | undefined };
	fileService: IFileService;
	getCurrentComposerModelSelection(threadId: string | undefined): IVSCloneModelSelection | undefined;
	handleImageFiles(files: File[]): Promise<void>;
	toPendingImages(images: readonly { mimeType: string; base64Data: string }[] | undefined): Array<{ mimeType: string; base64Data: string; dataUrl: string }>;
	renderImageStrip(): void;
	handleMentionInput(): void;
	runMentionSearch(query: string): Promise<void>;
	moveMentionActiveIndex(delta: number): void;
	acceptActiveMention(): void;
	closeMentionMenu(): void;
	renderMentionMenu(): void;
	addContextSelection(selection: IVSCloneContextSelection): void;
	renderContextChipStrip(): void;
	addActiveEditorCodeSelectionAsContext(): void;
	toPendingContextSelections(selections: readonly IVSCloneContextSelection[] | undefined): IVSCloneContextSelection[];
	showImagePreviewOverlay(dataUrl: string): void;
	updateContextUsageIndicator(): void;
	updateComposerMetrics(): void;
	updateComposerState(): void;
}

interface IRuntimeConversationHarness {
	enteredRuntimeElementKeys: Set<string>;
	currentRuntimeElementKeys: Set<string>;
	threadRuntimeService: {
		getState(threadId: string): IVSCloneThreadRuntimeState | undefined;
		getAssistantEditApplicationState(threadId: string, messageId: string): unknown;
	};
	renderRuntimeConversationNodes(state: IVSCloneThreadRuntimeState): HTMLElement[];
}

interface IConversationSurfaceHarness {
	id: string;
	settingsVisible: boolean;
	conversationHasContent: boolean;
	railVisible: boolean;
	bodyWidth: number;
	settingsService: { refreshState(): Promise<void>; getState(): IVSCloneSettingsState };
	providerConfigurationBridge: object;
	configurationService: { getValue<T>(key: string): T | undefined };
	oauthService: object;
	threadRuntimeService: { isAutoApproveEdits(): boolean };
	_register<T>(value: T): T;
	composerFocusDisposable: { value: unknown };
	renderConversationSurface(parent: HTMLElement): void;
	showComposerForNewChat(): void;
	applyRailLayout(): void;
	updateComposerMetrics(): void;
	updateComposerState(): void;
	updateContextUsageIndicator(): void;
	handleMentionInput(): void;
	handleComposerPrimaryAction(): Promise<void>;
	handleImageFiles(files: Iterable<File>): Promise<void>;
	addActiveEditorCodeSelectionAsContext(): void;
	closeMentionMenu(): void;
	getCurrentComposerMode(): 'act' | 'plan';
	updatePlanModeSelection(mode: 'act' | 'plan'): Promise<void>;
	updateReasoningEffortSelection(): Promise<void>;
	updateReasoningEnabledSelection(): Promise<void>;
	updateReasoningBudgetSelection(): Promise<void>;
	updateReasoningBudgetValueLabelFromInput(): void;
	refreshPlanModeControl(composerBusy?: boolean): void;
	refreshReasoningEffortControl(): void;
	refreshReasoningEnabledControl(): void;
	refreshReasoningBudgetControl(): void;
	refreshModelControls(): void;
	focusInput(): void;
}

interface IRuntimeRenderingHelperHarness {
	enteredRuntimeElementKeys: Set<string>;
	currentRuntimeElementKeys: Set<string>;
	renderRuntimeUserMessage(message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'user' }>): HTMLElement;
	renderSearchReplaceAwareText(container: HTMLElement, text: string, streaming: boolean): void;
	looksLikePartialSearchReplaceBlock(text: string): boolean;
	buildRenderedDiffLines(diff: string): {
		readonly lines: readonly {
			readonly rawText: string;
			readonly kind: string;
			readonly navigationLineNumber?: number;
		}[];
		readonly titleNavigation: {
			readonly startLineNumber?: number;
			readonly endLineNumber?: number;
		};
	};
}

interface IRuntimeApprovalAndApplyHarness {
	pendingAssistantApplyMessageIds: Set<string>;
	threadRuntimeService: {
		approveLatestToolRequest(threadId: string): boolean;
		rejectLatestToolRequest(threadId: string, reason?: string): boolean;
		answerLatestToolRequest(threadId: string, answer: string): boolean;
		isAutoApproveEdits(): boolean;
		setAutoApproveEdits(value: boolean): void;
		getAssistantEditApplicationState(threadId: string, messageId: string): unknown;
		setAssistantEditApplicationState(threadId: string, messageId: string, state: unknown): void;
	};
	notificationService: { warn(message: string): void; info(message: string): void; error(message: string): void };
	editorService: { openEditor(input: { resource: URI }): Promise<void> };
	editCodeService: {
		undoEditApply(fileChanges: VSCloneEditApplyResult['fileChanges']): Promise<{ revertedFiles: readonly URI[]; failures: readonly string[] }>;
		startApplyingSearchReplaceBlocks(responseText: string): Promise<VSCloneEditApplyResult>;
	};
	renderRuntimeUserQuestionRequest(threadId: string, message: IVSCloneThreadRuntimeToolRequestMessage): HTMLElement;
	renderRuntimeApprovalRequest(threadId: string, message: IVSCloneThreadRuntimeToolRequestMessage): HTMLElement;
	renderEditApplySummary(target: { threadId: string; id: string; responseText: string }, state: unknown): HTMLElement;
	appendAssistantApplyControls(item: HTMLElement, target: { threadId: string; id: string; responseText: string }): void;
	renderToolResultDiffCard(toolName: string, output: string): HTMLElement | undefined;
	getAssistantApplyState(target: { threadId: string; id: string; responseText: string }): unknown;
	setAssistantApplyState(target: { threadId: string; id: string; responseText: string }, state: unknown): void;
	undoAssistantEdits(target: { threadId: string; id: string; responseText: string }, applyResult: VSCloneEditApplyResult, button: HTMLButtonElement): Promise<void>;
	redoAssistantEdits(target: { threadId: string; id: string; responseText: string }, button: HTMLButtonElement): Promise<void>;
	applyAssistantEdits(target: { threadId: string; id: string; responseText: string }, button: HTMLButtonElement): Promise<void>;
	runAutoApply(target: { threadId: string; id: string; responseText: string }, responseText: string): Promise<void>;
	maybeAutoApplyRuntimeAssistantMessages(state: IVSCloneThreadRuntimeState): void;
	isAutoEligibleRuntimeAssistantApplyMessage(message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>): boolean;
	stripRuntimeAssistantWorkflowMarkup(content: string): string;
	isThreadBusy(threadId: string): boolean;
	getThreadRuntimeState(threadId: string): IVSCloneThreadRuntimeState | undefined;
	isManualOnlyRuntimeAssistantApplyMessage(message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>): boolean;
	refreshConversation(): void;
	openDiffTarget(uri: string, navigation: unknown): void;
}

interface IComposerStateHarness {
	activeThreadId?: string;
	composerInput?: HTMLTextAreaElement;
	composerSendButton?: HTMLButtonElement;
	submittingPrompt: boolean;
	getBusyThreadId(): string | undefined;
	hasPendingAssistantApply(threadId: string): boolean;
	getCurrentComposerModelSelection(threadId: string | undefined): IVSCloneModelSelection | undefined;
	getCurrentComposerMode(): 'act' | 'plan';
	refreshPlanModeControl(composerBusy?: boolean): void;
	updateContextUsageIndicator(): void;
	updateComposerState(): void;
}

interface IPlanModeHarness {
	activeThreadId?: string;
	submittingPrompt: boolean;
	planModeContainer?: HTMLElement;
	planModeSwitchButton?: HTMLButtonElement;
	addContextMenuToggle?: HTMLSpanElement;
	planModeService: {
		getModeForThread(threadId: string | undefined): 'act' | 'plan';
	};
	refreshPlanModeControl(composerBusy?: boolean): void;
}

function createRunContext(): IVSCloneThreadRuntimeRunContext {
	return {
		turnId: 'thread-1:turn-1',
		sequence: 1,
		sessionResource: 'vsclone://api/thread-1',
		mode: 'act',
		vendor: 'openai',
		modelId: 'gpt-5.3-codex',
		modelIdentifier: 'openai/gpt-5.3-codex',
	};
}

function createToolRequestMessage(id: string, requestedAt: number): IVSCloneThreadRuntimeToolRequestMessage {
	return {
		id,
		role: 'tool',
		createdAt: requestedAt,
		type: 'tool_request',
		toolName: 'run_terminal_command',
		approvalType: 'terminal',
		params: { command: 'pwd' },
		requestedAt,
		snapshots: [],
		run: createRunContext(),
	};
}

function createHarness(): IVSCloneUnifiedChatViewPaneHarness {
	// The full pane constructor wires a large DOM/service graph that is unrelated to this regression.
	// A prototype-only harness keeps the test pinned to the approval-card gating logic.
	const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as IVSCloneUnifiedChatViewPaneHarness;
	pane.threadRuntimeService = {
		approveLatestToolRequest: () => true,
		rejectLatestToolRequest: () => true,
	};
	pane.notificationService = {
		warn: () => undefined,
	};
	return pane;
}

function createStreamingMarkdownHarness(): IStreamingMarkdownHarness {
	// The streaming regression only needs the markdown append helpers and the per-message text cache.
	// Keep it prototype-backed so the test exercises the real private methods without constructing
	// the full workbench pane graph.
	const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as IStreamingMarkdownHarness;
	pane.streamedAssistantTextByMessageId = new Map<string, string>();
	return pane;
}

function createRuntimeEntranceHarness(): IRuntimeEntranceHarness {
	// Mirrors the pane's constructor-created tracking fields so the regression can exercise the
	// real keying helpers without constructing unrelated workbench services.
	const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as IRuntimeEntranceHarness;
	pane.enteredRuntimeElementKeys = new Set<string>();
	pane.currentRuntimeElementKeys = new Set<string>();
	return pane;
}

function createRuntimeConversationHarness(): IRuntimeConversationHarness {
	// Conversation rendering helpers only need the runtime element key sets and a runtime-state
	// lookup for reasoning/status branches. Keeping the harness prototype-backed covers the real
	// DOM builders without constructing the full workbench pane.
	const states = new Map<string, IVSCloneThreadRuntimeState>();
	const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as IRuntimeConversationHarness;
	pane.enteredRuntimeElementKeys = new Set<string>();
	pane.currentRuntimeElementKeys = new Set<string>();
	// Assistant rows consult the apply-state cache even when the test message is plain prose.
	// Mirror the constructor field so status-rendering tests can exercise the real assistant path.
	(pane as unknown as { pendingAssistantApplyMessageIds: Set<string> }).pendingAssistantApplyMessageIds = new Set();
	(pane as unknown as { streamedAssistantTextByMessageId: Map<string, string> }).streamedAssistantTextByMessageId = new Map();
	(pane as unknown as { reasoningPanelStateByMessageId: Map<string, { userToggled: boolean; open: boolean }> }).reasoningPanelStateByMessageId = new Map();
	(pane as unknown as { renderedMarkdownDisposables: { add<T>(value: T): T } }).renderedMarkdownDisposables = { add: value => value };
	pane.threadRuntimeService = {
		getState: (threadId: string) => states.get(threadId),
		getAssistantEditApplicationState: () => undefined,
	};
	return pane;
}

function createConversationSurfaceHarness(): { pane: IConversationSurfaceHarness; calls: string[]; dispose(): void } {
	const calls: string[] = [];
	const disposables: Array<{ dispose(): void }> = [];
	const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as IConversationSurfaceHarness;
	Object.assign(pane, {
		id: 'vsclone-test-pane',
		settingsVisible: false,
		conversationHasContent: false,
		railVisible: false,
		bodyWidth: 720,
		settingsService: {
			onDidChangeState: () => ({ dispose: () => undefined }),
			getCurrentSelectionForFeature: () => undefined,
			getRecentModelIdentifiers: () => [],
			refreshState: async () => {
				calls.push('refreshState');
			},
			getState: () => createSettingsState(),
		},
		providerConfigurationBridge: {},
		configurationService: {
			getValue: <T,>(_key: string): T | undefined => undefined,
		},
		composerFocusDisposable: { value: undefined },
		oauthService: {
			state: {
				providers: {},
			},
		},
		threadRuntimeService: {
			isAutoApproveEdits: () => false,
		},
		_register: <T,>(value: T): T => {
			if (value && typeof (value as { dispose?: unknown }).dispose === 'function') {
				disposables.push(value as { dispose(): void });
			}
			return value;
		},
		showComposerForNewChat: () => calls.push('newChat'),
		applyRailLayout: () => calls.push('layout'),
		updateComposerMetrics: () => calls.push('metrics'),
		updateComposerState: () => calls.push('composerState'),
		updateContextUsageIndicator: () => calls.push('contextUsage'),
		handleMentionInput: () => calls.push('mentionInput'),
		handleComposerPrimaryAction: async () => { calls.push('primaryAction'); },
		handleImageFiles: async () => { calls.push('images'); },
		addActiveEditorCodeSelectionAsContext: () => calls.push('codeSelection'),
		closeMentionMenu: () => calls.push('closeMention'),
		getCurrentComposerMode: () => 'act' as const,
		updatePlanModeSelection: async mode => { calls.push(`plan:${mode}`); },
		updateReasoningEffortSelection: async () => { calls.push('effort'); },
		updateReasoningEnabledSelection: async () => { calls.push('enabled'); },
		updateReasoningBudgetSelection: async () => { calls.push('budget'); },
		updateReasoningBudgetValueLabelFromInput: () => calls.push('budgetLabel'),
		refreshPlanModeControl: () => calls.push('planControl'),
		refreshReasoningEffortControl: () => calls.push('effortControl'),
		refreshReasoningEnabledControl: () => calls.push('enabledControl'),
		refreshReasoningBudgetControl: () => calls.push('budgetControl'),
		refreshModelControls: () => calls.push('modelControls'),
		focusInput: () => calls.push('focusInput'),
	});
	return {
		pane,
		calls,
		dispose: () => {
			const focusDisposable = pane.composerFocusDisposable.value as { dispose?: () => void } | undefined;
			focusDisposable?.dispose?.();
			for (const disposable of disposables.splice(0).reverse()) {
				disposable.dispose();
			}
		},
	};
}

function createRuntimeRenderingHelperHarness(): IRuntimeRenderingHelperHarness {
	// These render helpers are pure DOM builders once the runtime key sets exist, so this keeps the
	// tests focused on transcript transformation and diff bookkeeping instead of workbench services.
	// The real pane receives ILanguageService from DI, but these prototype-only tests skip the
	// constructor; returning undefined keeps diff-card assertions independent from tokenization.
	const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as IRuntimeRenderingHelperHarness;
	pane.enteredRuntimeElementKeys = new Set<string>();
	pane.currentRuntimeElementKeys = new Set<string>();
	pane.languageService = {
		guessLanguageIdByFilepathOrFirstLine: () => undefined,
	};
	return pane;
}

function createPlanModeHarness(mode: 'act' | 'plan'): IPlanModeHarness {
	const planModeSwitchButton = document.createElement('button');
	const addContextMenuToggle = document.createElement('span');
	const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as IPlanModeHarness;
	Object.assign(pane, {
		activeThreadId: 'thread-1',
		submittingPrompt: false,
		planModeContainer: document.createElement('div'),
		planModeSwitchButton,
		addContextMenuToggle,
		planModeService: {
			getModeForThread: () => mode,
		},
	});
	return pane;
}

function createComposerStateHarness(options: {
	busyThreadId?: string;
	selection?: IVSCloneModelSelection;
	mode?: 'act' | 'plan';
	pendingApply?: boolean;
	submittingPrompt?: boolean;
} = {}): IComposerStateHarness {
	const input = document.createElement('textarea');
	const sendButton = document.createElement('button');
	const hasSelectionOverride = Object.prototype.hasOwnProperty.call(options, 'selection');
	const selectedModel = options.selection ?? {
		location: 'chat',
		vendor: 'openai',
		modelIdentifier: 'openai/gpt-5.3-codex',
		modelId: 'gpt-5.3-codex',
		modelName: 'GPT-5.3 Codex',
		selectedAt: 1,
	};
	const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as IComposerStateHarness;
	Object.assign(pane, {
		activeThreadId: 'thread-1',
		composerInput: input,
		composerSendButton: sendButton,
		submittingPrompt: options.submittingPrompt ?? false,
		getBusyThreadId: () => options.busyThreadId,
		hasPendingAssistantApply: () => options.pendingApply ?? false,
		getCurrentComposerModelSelection: () => hasSelectionOverride ? options.selection : selectedModel,
		getCurrentComposerMode: () => options.mode ?? 'act',
		refreshPlanModeControl: () => undefined,
		updateContextUsageIndicator: () => undefined,
	});
	return pane;
}

function createSettingsState(): IVSCloneSettingsState {
	return {
		status: 'ready',
		providers: [{
			vendor: 'openai',
			displayName: 'OpenAI',
			status: 'available',
			modelCount: 2,
			selectableModelCount: 2,
			definedModelCount: 2,
		}],
		models: [{
			identifier: 'openai/gpt-5.3-codex',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelName: 'GPT-5.3 Codex',
			supportsImages: true,
			supportsFIM: false,
			supportedFeatures: ['Chat'],
			selectableFeatures: ['Chat'],
			capabilities: {
				supportsImages: true,
				supportsFIM: false,
				supportedFeatures: ['Chat'],
			},
			isSelectable: true,
		}],
		featureSelections: {},
		modelSelectionOfFeature: createEmptyVSCloneModelSelectionOfFeature(),
		featureDefaults: createEmptyVSCloneFeatureDefaults(),
		threadSelections: {},
		threadSelectionSnapshots: {},
		recentModels: [],
		recentModelIdentifiers: [],
		eligibilityRecords: [],
		ineligibilityRecords: [],
		updatedAt: 1,
	};
}

function createSettingsHarness(configurationValues: Record<string, unknown> = {}): ISettingsHarness {
	const host = document.createElement('div');
	const settingsContainer = document.createElement('div');
	settingsContainer.className = 'vsclone-settings-page hidden';
	const conversationList = document.createElement('div');
	const emptyState = document.createElement('div');
	const composer = document.createElement('div');
	composer.className = 'vsclone-thread-composer';
	const input = document.createElement('textarea');
	composer.appendChild(input);
	host.append(settingsContainer, conversationList, emptyState, composer);
	document.body.appendChild(host);

	const configurationWrites: Array<{ key: string; value: unknown }> = [];
	const oauthCalls: string[] = [];
	// The settings page methods do not require a live ViewPane instance; these collaborators are
	// the narrow service surface they read while rendering and while writing local controls.
	const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
	Object.assign(pane as object, {
		settingsContainer,
		conversationList,
		conversationEmptyState: emptyState,
		composerInput: input,
		conversationHasContent: false,
		settingsVisible: false,
		railVisible: false,
		settingsService: {
			getState: () => createSettingsState(),
			refreshState: async () => undefined,
		},
		oauthService: {
			state: {
				providers: {
					openai: {
						vendor: 'openai',
						displayName: 'OpenAI',
						status: 'signed_out',
						userDisplayName: undefined,
						errorMessage: undefined,
						isReady: false,
					},
					anthropic: {
						vendor: 'anthropic',
						displayName: 'Anthropic',
						status: 'signed_in',
						userDisplayName: 'Claude User',
						errorMessage: undefined,
						isReady: true,
					},
					google: {
						vendor: 'google',
						displayName: 'Google',
						status: 'signed_out',
						userDisplayName: undefined,
						errorMessage: undefined,
						isReady: false,
					},
				},
			},
			signIn: async (vendor: string) => {
				oauthCalls.push(`signIn:${vendor}`);
			},
			signOut: async (vendor: string) => {
				oauthCalls.push(`signOut:${vendor}`);
			},
		},
		threadRuntimeService: {
			isAutoApproveEdits: () => false,
		},
		configurationService: {
			getValue: (key: string) => configurationValues[key],
			updateValue: async (key: string, value: unknown) => {
				configurationWrites.push({ key, value });
			},
		},
		applyRailLayout: () => undefined,
		focusInput: () => {
			input.focus();
		},
		refreshModelCatalog: async () => undefined,
		refreshModelControls: () => undefined,
	});

	return {
		pane,
		host,
		settingsContainer,
		configurationWrites,
		oauthCalls,
	};
}

function createContextUsageHarness(options: {
	selection?: IVSCloneModelSelection;
	runtimeState?: IVSCloneThreadRuntimeState;
	fileContents?: string;
} = {}): IContextUsageHarness {
	const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane & IContextUsagePaneInternals;
	const input = document.createElement('textarea');
	const button = document.createElement('button');
	const popover = document.createElement('div');
	const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	const progress = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
	svg.appendChild(progress);
	svg.setAttribute('role', 'meter');
	svg.setAttribute('aria-valuemin', '0');
	svg.setAttribute('aria-valuemax', '100');
	button.className = 'vsclone-thread-context-usage';
	button.setAttribute('aria-expanded', 'false');
	popover.className = 'vsclone-thread-context-usage-popover hidden';
	popover.setAttribute('role', 'status');

	const selectedModel = options.selection ?? {
		location: 'chat',
		vendor: 'openai',
		modelIdentifier: 'openai/gpt-5.3-codex',
		modelId: 'gpt-5.3-codex',
		modelName: 'GPT-5.3 Codex',
		selectedAt: 1,
	};

	Object.assign(pane, {
		activeThreadId: 'thread-1',
		composerInput: input,
		composerContextUsageButton: button,
		composerContextUsageProgressPath: progress,
		composerContextUsagePopover: popover,
		composerContextUsagePopoverPinned: false,
		pendingContextSelections: [],
		pendingContextSelectionsCharacterKey: '',
		pendingContextSelectionsCharacters: 0,
		pendingContextSelectionsCharacterVersion: 0,
		pendingImages: [],
		fileService: {
			readFile: async () => ({
				value: {
					toString: () => options.fileContents ?? 'serialized file body',
				},
			}),
		} as unknown as IFileService,
		threadRuntimeService: {
			getState: () => options.runtimeState,
		},
		getCurrentComposerModelSelection: () => options.selection === undefined ? selectedModel : options.selection,
	});

	return { pane, button, popover, progress, input };
}

function createComposerAttachmentMentionHarness(options: { supportsImages?: boolean; activeSelection?: boolean } = {}): { pane: IComposerAttachmentMentionHarness; calls: string[]; host: HTMLElement } {
	const calls: string[] = [];
	const host = document.createElement('div');
	const input = document.createElement('textarea');
	const imageStrip = document.createElement('div');
	const contextStrip = document.createElement('div');
	const mentionMenu = document.createElement('div');
	const mentionHeader = document.createElement('span');
	const mentionList = document.createElement('div');
	mentionMenu.append(mentionHeader, mentionList);
	host.append(input, imageStrip, contextStrip, mentionMenu);
	document.body.appendChild(host);

	const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as IComposerAttachmentMentionHarness;
	Object.assign(pane, {
		activeThreadId: 'thread-1',
		rootContainer: host,
		composerInput: input,
		composerImageStrip: imageStrip,
		composerContextStrip: contextStrip,
		mentionMenuRoot: mentionMenu,
		mentionMenuList: mentionList,
		mentionMenuHeaderQuery: mentionHeader,
		mentionMenuOpen: false,
		mentionMenuQuery: '',
		mentionMenuItems: [],
		mentionMenuActiveIndex: 0,
		mentionMenuTriggerStart: -1,
		pendingImages: [],
		pendingContextSelections: [],
		pendingContextSelectionsCharacterKey: '',
		pendingContextSelectionsCharacters: 0,
		pendingContextSelectionsCharacterVersion: 0,
		settingsService: {
			getModel: () => ({ supportsImages: options.supportsImages ?? true }),
		},
		notificationService: {
			warn: message => calls.push(`warn:${message}`),
			info: message => calls.push(`info:${message}`),
		},
		mentionSearchService: {
			search: async () => [
				{ kind: 'file', uri: URI.file('/workspace/src/app.ts'), label: 'app.ts', relativePath: 'src/app.ts' },
				{ kind: 'folder', uri: URI.file('/workspace/src'), label: 'src', relativePath: 'src' },
			],
		},
		languageService: {
			guessLanguageIdByFilepathOrFirstLine: () => 'typescript',
		},
		fileService: {
			readFile: async () => ({ value: { toString: () => 'file context' } }),
		} as unknown as IFileService,
		getCurrentComposerModelSelection: () => options.activeSelection === false
			? undefined
			: {
				location: 'chat',
				vendor: 'openai',
				modelIdentifier: 'openai/gpt-5.3-codex',
				modelId: 'gpt-5.3-codex',
				modelName: 'GPT-5.3 Codex',
				selectedAt: 1,
			},
		updateContextUsageIndicator: () => calls.push('contextUsage'),
		updateComposerMetrics: () => calls.push('metrics'),
		updateComposerState: () => calls.push('composerState'),
	});
	return { pane, calls, host };
}

function createRuntimeState(messages: readonly IVSCloneThreadRuntimeMessage[]): IVSCloneThreadRuntimeState {
	return {
		threadId: 'thread-1',
		catalog: {
			threadId: 'thread-1',
			title: 'Context test',
			createdAt: 1,
			updatedAt: 1,
			status: 'completed',
			archived: false,
			turnCount: 1,
			lastTurnPreview: 'Context test',
		},
		streamState: { kind: 'idle' },
		messages,
		checkpoints: [],
		lastUpdatedAt: 1,
	};
}

function createEditApplyResult(uri = URI.file('/workspace/src/app.ts')): VSCloneEditApplyResult {
	return {
		attemptedEdits: 1,
		appliedEdits: 1,
		modifiedFiles: [uri],
		failures: [],
		fileChanges: [{
			uri,
			displayPath: 'src/app.ts',
			addedLines: 2,
			removedLines: 1,
			action: 'modify',
			originalContent: 'const before = true;\n',
		}],
	};
}

function createRuntimeApprovalAndApplyHarness(options: { busy?: boolean; applyState?: unknown; applyResult?: VSCloneEditApplyResult } = {}): { pane: IRuntimeApprovalAndApplyHarness; calls: string[] } {
	const calls: string[] = [];
	const applyResult = options.applyResult ?? createEditApplyResult();
	const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as IRuntimeApprovalAndApplyHarness;
	const state = createRuntimeState([{
		id: 'assistant-apply',
		role: 'assistant',
		mode: 'act',
		createdAt: 1,
		content: 'manual edit',
		editSuggestion: { kind: 'manual' },
	} as Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }>]);
	Object.assign(pane, {
		pendingAssistantApplyMessageIds: new Set<string>(),
		threadRuntimeService: {
			approveLatestToolRequest: (threadId: string) => { calls.push(`approve:${threadId}`); return true; },
			rejectLatestToolRequest: (threadId: string, reason?: string) => { calls.push(`reject:${threadId}:${reason ?? ''}`); return true; },
			answerLatestToolRequest: (threadId: string, answer: string) => { calls.push(`answer:${threadId}:${answer}`); return true; },
			isAutoApproveEdits: () => false,
			setAutoApproveEdits: (value: boolean) => { calls.push(`auto:${value}`); },
			getAssistantEditApplicationState: () => options.applyState,
			setAssistantEditApplicationState: (_threadId: string, _messageId: string, nextState: unknown) => { calls.push(`state:${(nextState as { phase?: string }).phase}`); },
		},
		notificationService: {
			warn: (message: string) => calls.push(`warn:${message}`),
			info: (message: string) => calls.push(`info:${message}`),
			error: (message: string) => calls.push(`error:${message}`),
		},
		editorService: {
			openEditor: async (input: { resource: URI; options?: unknown }) => { calls.push(`open:${input.resource.toString()}:${JSON.stringify(input.options ?? {})}`); },
		},
		editCodeService: {
			undoEditApply: async () => ({ revertedFiles: applyResult.modifiedFiles, failures: [] }),
			startApplyingSearchReplaceBlocks: async () => applyResult,
		},
		currentRuntimeElementKeys: new Set<string>(),
		enteredRuntimeElementKeys: new Set<string>(),
		languageService: {
			// Approval previews render the same compact diff cards as assistant text; the real view
			// gets this service from DI, while this helper intentionally constructs only the fields
			// needed by the approval/apply controls under test.
			guessLanguageIdByFilepathOrFirstLine: () => undefined,
		},
		getThreadRuntimeState: () => state,
		isThreadBusy: () => options.busy === true,
		isManualOnlyRuntimeAssistantApplyMessage: () => true,
		markRuntimeElementEntrance: () => undefined,
		refreshConversation: () => calls.push('refresh'),
	});
	return { pane, calls };
}

function createAssistantMessage(content: string): Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'assistant' }> {
	return {
		id: `assistant-${content.length}`,
		role: 'assistant',
		mode: 'act',
		createdAt: 1,
		content,
	};
}

function createUserMessage(content: string): Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'user' }> {
	return {
		id: `user-${content.length}`,
		role: 'user',
		mode: 'act',
		createdAt: 1,
		content,
	};
}

suite('VSCloneUnifiedChatViewPane', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('builds the conversation surface and wires composer controls', async () => {
		const { pane, calls, dispose } = createConversationSurfaceHarness();
		const parent = document.createElement('div');
		try {
			pane.renderConversationSurface(parent);

			assert.ok(parent.querySelector('.vsclone-thread-actions'));
			assert.ok(parent.querySelector('.vsclone-thread-messages[role="log"]'));
			assert.ok(parent.querySelector('.vsclone-thread-empty-state-suggestion'));
			assert.ok(parent.querySelector('.vsclone-thread-composer-input'));
			assert.ok(parent.querySelector('.vsclone-thread-context-usage[aria-haspopup="dialog"]'));
			assert.ok(parent.querySelector('.vsclone-add-context-menu[role="menu"]'));
			assert.ok(parent.querySelector('.vsclone-mention-menu[role="listbox"]'));
			assert.ok(parent.querySelector('.vsclone-thread-reasoning-level-select'));
			assert.ok(parent.querySelector('.vsclone-thread-reasoning-enabled-input'));
			assert.ok(parent.querySelector('.vsclone-thread-reasoning-budget-input'));
			await Promise.resolve();
			assert.ok(calls.includes('refreshState'));

			const suggestion = parent.querySelector<HTMLButtonElement>('.vsclone-thread-empty-state-suggestion');
			suggestion?.click();
			assert.ok(calls.includes('focusInput'));
			assert.ok(calls.includes('composerState'));

			const contextButton = parent.querySelector<HTMLButtonElement>('.vsclone-add-context-button');
			contextButton?.click();
			assert.strictEqual(parent.querySelector('.vsclone-add-context-menu')?.classList.contains('hidden'), false);
			const planModeItem = parent.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]');
			planModeItem?.click();
			await Promise.resolve();
			assert.ok(calls.includes('plan:plan'));

			const codeSelectionItem = Array.from(parent.querySelectorAll<HTMLButtonElement>('.vsclone-add-context-menu-item'))
				.find(button => button.textContent === 'Add Code Selection');
			codeSelectionItem?.click();
			assert.ok(calls.includes('codeSelection'));

			const input = parent.querySelector<HTMLTextAreaElement>('.vsclone-thread-composer-input');
			input!.value = 'hello';
			input!.dispatchEvent(new Event('input', { bubbles: true }));
			assert.ok(calls.includes('metrics'));
			assert.ok(calls.includes('mentionInput'));

			const send = parent.querySelector<HTMLButtonElement>('.vsclone-thread-composer-send');
			send?.click();
			await Promise.resolve();
			assert.ok(calls.includes('primaryAction'));
		} finally {
			dispose();
		}
	});

	test('renders approval controls only for the latest awaiting tool request', () => {
		const harness = createHarness();
		const firstRequest = createToolRequestMessage('tool-request-1', 1);
		const repeatedRequest = createToolRequestMessage('tool-request-2', 2);
		const state: IVSCloneThreadRuntimeState = {
			threadId: 'thread-1',
			catalog: {
				threadId: 'thread-1',
				title: 'Existing thread',
				createdAt: 1,
				updatedAt: 2,
				status: 'active',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Need approval',
			},
			streamState: { kind: 'awaiting_user', toolName: 'run_terminal_command', approvalType: 'terminal' },
			messages: [firstRequest, repeatedRequest],
			checkpoints: [],
			lastUpdatedAt: 2,
		};

		assert.strictEqual(harness.renderRuntimeToolActions('thread-1', state, firstRequest), undefined);
		assert.ok(harness.renderRuntimeToolActions('thread-1', state, repeatedRequest));
	});

	test('streaming assistant text fades only newly appended words', () => {
		const harness = createStreamingMarkdownHarness();
		const firstContainer = document.createElement('div');
		const secondContainer = document.createElement('div');

		harness.appendRuntimeAssistantMarkdownSegment(firstContainer, 'assistant-1', 'Hello world', true);
		harness.appendRuntimeAssistantMarkdownSegment(secondContainer, 'assistant-1', 'Hello world again now', true);

		const secondPrefix = secondContainer.querySelector('.vsclone-thread-message-streaming-prefix');
		const secondWords = Array.from(secondContainer.querySelectorAll<HTMLElement>('.vsclone-streamed-word'));

		assert.strictEqual(secondPrefix?.textContent, 'Hello world');
		assert.deepStrictEqual(secondWords.map(word => word.textContent), ['again', 'now']);
		assert.strictEqual(secondPrefix?.querySelector('.vsclone-streamed-word'), null);
	});

	test('runtime entrance animation is keyed so refreshed rows do not fade again', () => {
		const harness = createRuntimeEntranceHarness();
		const firstRow = document.createElement('div');
		const refreshedRow = document.createElement('div');

		harness.markRuntimeElementEntrance(firstRow, 'tool:read-file-1:compact');
		harness.currentRuntimeElementKeys = new Set<string>();
		harness.markRuntimeElementEntrance(refreshedRow, 'tool:read-file-1:compact');

		assert.strictEqual(firstRow.classList.contains('vsclone-runtime-enter'), true);
		assert.strictEqual(refreshedRow.classList.contains('vsclone-runtime-enter'), false);

		harness.currentRuntimeElementKeys = new Set<string>();
		harness.pruneEnteredRuntimeElementKeys();
		harness.markRuntimeElementEntrance(refreshedRow, 'tool:read-file-1:compact');

		assert.strictEqual(refreshedRow.classList.contains('vsclone-runtime-enter'), true);
	});

	test('renders no runtime nodes for an idle empty thread', () => {
		const harness = createRuntimeConversationHarness();
		const nodes = harness.renderRuntimeConversationNodes(createRuntimeState([]));

		assert.deepStrictEqual(nodes, []);
	});

	test('renders standalone runtime status rows for active empty states', () => {
		const harness = createRuntimeConversationHarness();
		const llmState: IVSCloneThreadRuntimeState = {
			...createRuntimeState([]),
			streamState: { kind: 'llm' },
		};
		const toolState: IVSCloneThreadRuntimeState = {
			...createRuntimeState([]),
			streamState: { kind: 'tool', toolName: 'read_file' },
		};

		const llmNodes = harness.renderRuntimeConversationNodes(llmState);
		const toolNodes = harness.renderRuntimeConversationNodes(toolState);

		assert.strictEqual(llmNodes.length, 1);
		assert.strictEqual(llmNodes[0].classList.contains('runtime-status'), true);
		assert.strictEqual(llmNodes[0].classList.contains('runtime-tool-compact'), true);
		assert.strictEqual(llmNodes[0].textContent?.includes('Thinking...'), true);
		assert.strictEqual(toolNodes.length, 1);
		assert.strictEqual(toolNodes[0].classList.contains('runtime-status'), true);
		assert.strictEqual(toolNodes[0].textContent?.includes('Running tool: read_file'), true);
	});

	test('removes llm thinking status once assistant text starts streaming', () => {
		const harness = createRuntimeConversationHarness();
		const state: IVSCloneThreadRuntimeState = {
			...createRuntimeState([createAssistantMessage('first token')]),
			streamState: { kind: 'llm' },
		};

		const nodes = harness.renderRuntimeConversationNodes(state);

		assert.strictEqual(nodes.some(node => node.classList.contains('runtime-status')), false);
		assert.strictEqual(nodes.some(node => node.textContent?.includes('first token')), true);
	});

	test('keeps llm thinking status before tokens on later turns', () => {
		const harness = createRuntimeConversationHarness();
		const state: IVSCloneThreadRuntimeState = {
			...createRuntimeState([
				createUserMessage('first question'),
				createAssistantMessage('previous answer'),
				createUserMessage('second question'),
			]),
			streamState: { kind: 'llm' },
		};

		const nodes = harness.renderRuntimeConversationNodes(state);

		const statusNode = nodes.find(node => node.classList.contains('runtime-status'));
		assert.ok(statusNode);
		assert.strictEqual(statusNode.textContent?.includes('Thinking...'), true);
		assert.strictEqual(statusNode.classList.contains('runtime-tool-compact'), true);
	});

	test('suppresses duplicate status rows while awaiting user approval', () => {
		const harness = createRuntimeConversationHarness();
		const state: IVSCloneThreadRuntimeState = {
			...createRuntimeState([]),
			streamState: { kind: 'awaiting_user', toolName: 'run_terminal_command', approvalType: 'terminal' },
		};

		assert.deepStrictEqual(harness.renderRuntimeConversationNodes(state), []);
	});

	test('renders provider runtime errors as structured warning cards', () => {
		const harness = createRuntimeConversationHarness();
		const state = createRuntimeState([
			createAssistantMessage('got status: 503 Service Unavailable. {"error":{"message":"provider overloaded"}}'),
		]);

		const nodes = harness.renderRuntimeConversationNodes(state);
		const errorCard = nodes[0];

		assert.strictEqual(nodes.length, 1);
		assert.strictEqual(errorCard.classList.contains('runtime-error'), true);
		assert.strictEqual(errorCard.classList.contains('severity-warning'), true);
		assert.strictEqual(errorCard.querySelector('.vsclone-runtime-error-title')?.textContent, 'Service Unavailable');
		assert.strictEqual(errorCard.querySelector('.vsclone-runtime-error-status-badge')?.textContent, '503');
		assert.strictEqual(errorCard.querySelector('.vsclone-runtime-error-message')?.textContent, 'provider overloaded');
		assert.ok(errorCard.querySelector('.vsclone-runtime-error-details'));
	});

	test('renders mixed runtime transcript message variants', () => {
		const harness = createRuntimeConversationHarness();
		const uri = URI.file('/workspace/src/app.ts');
		const state: IVSCloneThreadRuntimeState = {
			...createRuntimeState([
				{
					id: 'user-rich',
					role: 'user',
					mode: 'plan',
					createdAt: 1,
					content: 'Please inspect this file.',
					imageAttachments: [{ id: 'img-1', name: 'screen.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,abc', size: 3 }],
					contextSelections: [{ kind: 'file', uri, label: 'src/app.ts', characterCount: 123 }],
				},
				{
					id: 'assistant-rich',
					role: 'assistant',
					mode: 'act',
					createdAt: 2,
					content: ['<<<<<<< SEARCH', 'old', '=======', 'new', '>>>>>>> REPLACE'].join('\n'),
					reasoning: 'I inspected the selected file before suggesting the edit.',
					anthropicReasoning: [{ type: 'thinking', thinking: 'signed thought', signature: 'sig-1' }],
					metadata: { editSuggestion: { kind: 'search_replace', applyMode: 'manual' } },
				},
				{
					id: 'checkpoint-1',
					role: 'checkpoint',
					createdAt: 3,
					checkpoint: {
						id: 'cp-1',
						createdAt: 3,
						type: 'tool_edit',
						toolName: 'edit_file',
						snapshots: [{ uri, existed: true, content: 'old', isDirectory: false }],
					},
				},
				{
					id: 'tool-running',
					role: 'tool',
					createdAt: 4,
					type: 'running_now',
					toolName: 'run_terminal_command',
					approvalType: 'terminal',
					params: { command: 'npm test' },
				},
				{
					id: 'tool-success',
					role: 'tool',
					createdAt: 5,
					type: 'success',
					toolName: 'read_file',
					params: { path: 'src/app.ts' },
					output: 'file contents',
					success: true,
				},
				{
					id: 'tool-error',
					role: 'tool',
					createdAt: 6,
					type: 'tool_error',
					toolName: 'edit_file',
					approvalType: 'edits',
					params: { path: 'src/app.ts' },
					output: 'patch failed',
					success: false,
				},
				{
					id: 'tool-rejected',
					role: 'tool',
					createdAt: 7,
					type: 'rejected',
					toolName: 'ask_user',
					approvalType: 'user input',
					params: { questions: '[]' },
					output: 'User declined',
					success: false,
				},
			]),
			assistantEditApplications: [{
				messageId: 'assistant-rich',
				state: {
					phase: 'partial',
					result: {
						attemptedEdits: 2,
						appliedEdits: 1,
						modifiedFiles: [uri],
						failures: ['second block did not match'],
						fileChanges: [{ uri, displayPath: 'src/app.ts', addedLines: 1, removedLines: 1, action: 'modify', originalContent: 'old' }],
					},
				},
			}],
			tokenUsage: { usedTokens: 42, maxTokens: 100, inputTokens: 30, outputTokens: 12, source: 'provider' },
		};

		const nodes = harness.renderRuntimeConversationNodes(state);

		assert.ok(nodes.length >= 4);
	});

	test('runtime user transcript strips serialized selections while keeping context chips', () => {
		const harness = createRuntimeRenderingHelperHarness();
		const message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'user' }> = {
			id: 'user-with-serialized-context',
			role: 'user',
			mode: 'act',
			createdAt: 1,
			content: 'Review this file\n---\nSELECTIONS\n/workspace/src/app.ts:\n```ts\nconst value = 1;\n```',
			contextSelections: [{
				kind: 'codeSelection',
				uri: URI.file('/workspace/src/app.ts'),
				startLine: 4,
				endLine: 8,
				label: 'src/app.ts',
				characterCount: 25,
			}],
		};

		const node = harness.renderRuntimeUserMessage(message);

		assert.strictEqual(node.querySelector('.vsclone-thread-message-user-text')?.textContent, 'Review this file');
		assert.strictEqual(node.textContent?.includes('SELECTIONS'), false);
		assert.strictEqual(node.querySelector('.vsclone-composer-context-chip-label')?.textContent, 'app.ts:4-8');
	});

	test('runtime user transcript handles selection-only prompts without empty prompt text', () => {
		const harness = createRuntimeRenderingHelperHarness();
		const message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'user' }> = {
			id: 'user-selection-only',
			role: 'user',
			mode: 'act',
			createdAt: 1,
			content: '---\nSELECTIONS\n/workspace/src/app.ts:\n```ts\nconst value = 1;\n```',
			contextSelections: [{
				kind: 'file',
				uri: URI.file('/workspace/src/app.ts'),
				label: 'src/app.ts',
				characterCount: 25,
			}],
		};

		const node = harness.renderRuntimeUserMessage(message);

		assert.strictEqual(node.querySelector('.vsclone-thread-message-user-text'), null);
		assert.strictEqual(node.querySelector('.vsclone-composer-context-chip-label')?.textContent, 'app.ts');
	});

	test('search replace renderer turns completed blocks into compact diff cards', () => {
		const harness = createRuntimeRenderingHelperHarness();
		const container = document.createElement('div');
		const text = [
			'Here is the change:',
			'',
			'File: file:///workspace/src/app.ts',
			'<<<<<<< SEARCH',
			'const value = 1;',
			'=======',
			'const value = 2;',
			'>>>>>>> REPLACE',
			'',
			'Done.',
		].join('\n');

		harness.renderSearchReplaceAwareText(container, text, false);

		const diffCard = container.querySelector('.vsclone-tool-diff-card');
		assert.ok(diffCard);
		assert.strictEqual(diffCard.querySelector('.vsclone-tool-diff-title-lang-tag')?.textContent, 'TS');
		assert.strictEqual(diffCard.querySelector('.vsclone-tool-diff-title-filename')?.textContent, 'app.ts');
		assert.deepStrictEqual(
			Array.from(diffCard.querySelectorAll('.vsclone-tool-diff-line')).map(line => line.textContent),
			['const value = 1;', 'const value = 2;'],
		);
		assert.strictEqual(container.textContent?.includes('Here is the change:'), true);
		assert.strictEqual(container.textContent?.includes('Done.'), true);
		assert.strictEqual(container.textContent?.includes('File: file:///workspace/src/app.ts'), false);
	});

	test('streaming search replace renderer shows partial edit indicator', () => {
		const harness = createRuntimeRenderingHelperHarness();
		const container = document.createElement('div');
		const partial = [
			'I will patch this next.',
			'',
			'File: src/app.ts',
			'<<<<<<< SEARCH',
			'const value =',
		].join('\n');

		assert.strictEqual(harness.looksLikePartialSearchReplaceBlock(partial), true);
		harness.renderSearchReplaceAwareText(container, partial, true);

		const streamingCard = container.querySelector('.vsclone-tool-diff-card.streaming');
		assert.ok(streamingCard);
		assert.strictEqual(streamingCard.querySelector('.vsclone-tool-diff-title-filename')?.textContent, 'app.ts');
		assert.ok(streamingCard.querySelector('.vsclone-tool-diff-title-streaming'));
		assert.strictEqual(container.textContent?.includes('I will patch this next.'), true);
		assert.strictEqual(container.textContent?.includes('<<<<<<< SEARCH'), false);
	});

	test('rendered unified diff lines carry modified-file navigation targets', () => {
		const harness = createRuntimeRenderingHelperHarness();
		const diff = [
			'--- a/src/app.ts',
			'+++ b/src/app.ts',
			'@@ -10,3 +20,4 @@',
			' context',
			'-old',
			'+new',
			'+extra',
		].join('\n');

		const rendered = harness.buildRenderedDiffLines(diff);

		assert.deepStrictEqual(rendered.titleNavigation, { startLineNumber: 20, endLineNumber: 23 });
		assert.deepStrictEqual(rendered.lines.map(line => line.kind), ['file', 'file', 'hunk', 'context', 'removed', 'added', 'added']);
		assert.deepStrictEqual(rendered.lines.map(line => line.navigationLineNumber), [undefined, undefined, 20, 20, 21, 21, 22]);
	});

	test('updates plan mode switch semantics and add-context active state', () => {
		const planHarness = createPlanModeHarness('plan');
		planHarness.refreshPlanModeControl(false);

		assert.strictEqual(planHarness.planModeSwitchButton?.classList.contains('checked'), true);
		assert.strictEqual(planHarness.planModeSwitchButton?.getAttribute('aria-checked'), 'true');
		assert.strictEqual(planHarness.planModeSwitchButton?.disabled, false);
		assert.strictEqual(planHarness.addContextMenuToggle?.classList.contains('active'), true);

		const actHarness = createPlanModeHarness('act');
		actHarness.refreshPlanModeControl(true);

		assert.strictEqual(actHarness.planModeSwitchButton?.classList.contains('checked'), false);
		assert.strictEqual(actHarness.planModeSwitchButton?.getAttribute('aria-checked'), 'false');
		assert.strictEqual(actHarness.planModeSwitchButton?.disabled, true);
		assert.strictEqual(actHarness.addContextMenuToggle?.classList.contains('active'), false);
	});

	test('composer send control enters stop mode while runtime is busy', () => {
		const harness = createComposerStateHarness({ busyThreadId: 'thread-1' });
		harness.composerInput!.value = 'interrupt this run';

		harness.updateComposerState();

		assert.strictEqual(harness.composerSendButton?.textContent, 'Stop');
		assert.strictEqual(harness.composerSendButton?.classList.contains('stop-mode'), true);
		assert.strictEqual(harness.composerSendButton?.disabled, false);
		assert.strictEqual(harness.composerSendButton?.getAttribute('aria-label'), 'Stop response generation');
		assert.strictEqual(harness.composerInput?.disabled, true);
		assert.strictEqual(harness.composerInput?.placeholder, 'Waiting for response...');
	});

	test('composer send control reflects missing model and pending apply blockers', () => {
		const missingModelHarness = createComposerStateHarness({ selection: undefined });
		missingModelHarness.composerInput!.value = 'hello';
		missingModelHarness.updateComposerState();

		assert.strictEqual(missingModelHarness.composerSendButton?.disabled, true);
		assert.strictEqual(missingModelHarness.composerSendButton?.classList.contains('stop-mode'), false);
		assert.strictEqual(missingModelHarness.composerInput?.disabled, false);
		assert.strictEqual(missingModelHarness.composerInput?.placeholder, 'Sign in to a provider and choose a model to start chatting...');

		const pendingApplyHarness = createComposerStateHarness({ pendingApply: true });
		pendingApplyHarness.composerInput!.value = 'follow up';
		pendingApplyHarness.updateComposerState();

		assert.strictEqual(pendingApplyHarness.composerSendButton?.disabled, true);
		assert.strictEqual(pendingApplyHarness.composerInput?.disabled, true);
		assert.strictEqual(pendingApplyHarness.composerInput?.placeholder, 'Wait for edit application to finish...');
	});

	test('opens settings into the conversation surface and closes back to the composer', () => {
		const harness = createSettingsHarness();
		try {
			harness.pane.openSettingsPage();

			assert.strictEqual(harness.settingsContainer.classList.contains('hidden'), false);
			assert.ok(harness.settingsContainer.querySelector('.vsclone-settings-header'));
			const closeButton = harness.settingsContainer.querySelector('.vsclone-settings-icon-button') as HTMLButtonElement | null;
			assert.ok(closeButton);
			assert.strictEqual(document.activeElement, closeButton);

			closeButton.click();

			assert.strictEqual(harness.settingsContainer.classList.contains('hidden'), true);
			assert.strictEqual(document.activeElement, harness.host.querySelector('textarea'));
		} finally {
			harness.host.remove();
		}
	});

	test('writes settings controls through the configuration service', () => {
		const harness = createSettingsHarness({
			'vsclone.modelSwitcher.enabled': true,
			'vsclone.autocomplete.enabled': true,
			'vsclone.autocomplete.debounceMs': 120,
		});
		try {
			harness.pane.openSettingsPage();

			const autocompleteToggle = Array.from(harness.settingsContainer.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
				.find(input => input.getAttribute('aria-label') === 'Inline autocomplete');
			assert.ok(autocompleteToggle);
			autocompleteToggle.checked = false;
			autocompleteToggle.dispatchEvent(new Event('change'));

			const debounceSlider = Array.from(harness.settingsContainer.querySelectorAll<HTMLInputElement>('input[type="range"]'))
				.find(input => input.getAttribute('aria-label') === 'Autocomplete delay');
			assert.ok(debounceSlider);
			debounceSlider.value = '240';
			debounceSlider.dispatchEvent(new Event('change'));

			assert.deepStrictEqual(harness.configurationWrites, [
				{ key: 'vsclone.autocomplete.enabled', value: false },
				{ key: 'vsclone.autocomplete.debounceMs', value: 240 },
			]);
		} finally {
			harness.host.remove();
		}
	});

	test('renders context usage as an enabled disclosure with meter state', () => {
		const harness = createContextUsageHarness({
			runtimeState: createRuntimeState([{
				id: 'user-1',
				role: 'user',
				mode: 'act',
				createdAt: 1,
				content: 'hello',
			}]),
		});
		const pane = harness.pane as unknown as IContextUsagePaneInternals;

		pane.updateContextUsageIndicator();
		pane.setContextUsagePopoverVisible(true);

		assert.strictEqual(harness.button.classList.contains('hidden'), false);
		assert.strictEqual(harness.button.hasAttribute('aria-disabled'), false);
		assert.strictEqual(harness.button.getAttribute('aria-expanded'), 'true');
		assert.ok(harness.button.getAttribute('aria-label')?.includes('Press to show details'));
		assert.strictEqual(harness.progress.ownerSVGElement?.getAttribute('role'), 'meter');
		assert.strictEqual(harness.progress.ownerSVGElement?.getAttribute('aria-valuemin'), '0');
		assert.strictEqual(harness.progress.ownerSVGElement?.getAttribute('aria-valuemax'), '100');
		assert.ok(harness.progress.ownerSVGElement?.hasAttribute('aria-valuenow'));
		assert.strictEqual(harness.popover.getAttribute('role'), 'status');
		assert.strictEqual(harness.popover.classList.contains('hidden'), false);
	});

	test('hides and clears context usage details when the selected model disappears', () => {
		const harness = createContextUsageHarness({ selection: undefined });
		const pane = harness.pane as unknown as IContextUsagePaneInternals;
		harness.button.classList.add('warning');
		harness.button.setAttribute('aria-expanded', 'true');
		harness.popover.classList.remove('hidden');
		harness.popover.textContent = 'stale usage';

		Object.assign(pane, {
			getCurrentComposerModelSelection: () => undefined,
		});
		pane.updateContextUsageIndicator();

		assert.strictEqual(harness.button.classList.contains('hidden'), true);
		assert.strictEqual(harness.button.classList.contains('warning'), false);
		assert.strictEqual(harness.button.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(harness.popover.classList.contains('hidden'), true);
		assert.strictEqual(harness.popover.textContent, '');
	});

	test('counts serialized pending context and does not double count stored context selections', async () => {
		const storedSelection: IVSCloneContextSelection = {
			kind: 'file',
			uri: URI.file('/workspace/stored-context.ts'),
			languageId: 'typescript',
		};
		const storedContent = 'please review\n---\nSELECTIONS\nalready serialized file body';
		const harness = createContextUsageHarness({
			fileContents: 'const pendingContext = true;',
			runtimeState: createRuntimeState([{
				id: 'user-1',
				role: 'user',
				mode: 'act',
				createdAt: 1,
				content: storedContent,
				contextSelections: [storedSelection],
			}]),
		});
		const pane = harness.pane as unknown as IContextUsagePaneInternals;
		const pendingSelection: IVSCloneContextSelection = {
			kind: 'file',
			uri: URI.file('/workspace/pending-context.ts'),
			languageId: 'typescript',
		};
		pane.pendingContextSelections = [pendingSelection];
		harness.input.value = 'draft';

		pane.refreshPendingContextSelectionCharacterCount();
		await new Promise(resolve => setTimeout(resolve, 0));

		const serializedPendingLength = '/workspace/pending-context.ts:\n```typescript\nconst pendingContext = true;\n```'.length;
		assert.strictEqual(pane.pendingContextSelectionsCharacters, serializedPendingLength);
		assert.deepStrictEqual(pane.countCurrentContextLocally(), {
			characters: storedContent.length + harness.input.value.length + serializedPendingLength,
		});
	});

	test('renders provider sign-in and sign-out actions', async () => {
		const harness = createSettingsHarness();
		try {
			harness.pane.openSettingsPage();

			assert.strictEqual(harness.settingsContainer.textContent?.includes('Choose model'), false);
			const providerButtons = Array.from(harness.settingsContainer.querySelectorAll<HTMLButtonElement>('.vsclone-settings-action-button'));
			const openAiButton = providerButtons.find(button => button.textContent === 'Sign in' && button.closest('.vsclone-settings-row')?.textContent?.includes('OpenAI'));
			const anthropicButton = providerButtons.find(button => button.textContent === 'Sign out' && button.closest('.vsclone-settings-row')?.textContent?.includes('Anthropic'));
			assert.ok(openAiButton);
			assert.ok(anthropicButton);

			openAiButton.click();
			anthropicButton.click();
			await Promise.resolve();
			await Promise.resolve();

			assert.deepStrictEqual(harness.oauthCalls, ['signIn:openai', 'signOut:anthropic']);
		} finally {
			harness.host.remove();
		}
	});

	test('manages image attachments, mention search, context chips, and image preview overlay', async () => {
		const unsupported = createComposerAttachmentMentionHarness({ supportsImages: false });
		try {
			await unsupported.pane.handleImageFiles([new File(['abc'], 'screen.png', { type: 'image/png' })]);
			assert.ok(unsupported.calls.some(call => call.startsWith('warn:')));
			assert.deepStrictEqual(unsupported.pane.pendingImages, []);
		} finally {
			unsupported.host.remove();
		}

		const { pane, calls, host } = createComposerAttachmentMentionHarness();
		try {
			await pane.handleImageFiles([
				new File(['abc'], 'screen.png', { type: 'image/png' }),
				new File(['not-image'], 'notes.txt', { type: 'text/plain' }),
			]);
			assert.strictEqual(pane.pendingImages.length, 1);
			assert.strictEqual(pane.composerImageStrip?.classList.contains('hidden'), false);
			assert.strictEqual(pane.composerImageStrip?.querySelectorAll('.vsclone-composer-image-thumb').length, 1);

			pane.composerImageStrip?.querySelector<HTMLImageElement>('img')?.click();
			assert.ok(document.body.querySelector('.vsclone-image-preview-overlay'));
			document.body.querySelector<HTMLButtonElement>('.vsclone-image-preview-close')?.click();
			assert.strictEqual(document.body.querySelector('.vsclone-image-preview-overlay'), null);

			pane.composerImageStrip?.querySelector<HTMLButtonElement>('.vsclone-composer-image-thumb-remove')?.click();
			assert.strictEqual(pane.pendingImages.length, 0);
			assert.strictEqual(pane.composerImageStrip?.classList.contains('hidden'), true);

			assert.deepStrictEqual(pane.toPendingImages([{ mimeType: 'image/gif', base64Data: 'Z2lm' }]), [{
				mimeType: 'image/gif',
				base64Data: 'Z2lm',
				dataUrl: 'data:image/gif;base64,Z2lm',
			}]);
			assert.deepStrictEqual(pane.toPendingImages(undefined), []);

			pane.composerInput!.value = 'Open @app';
			pane.composerInput!.setSelectionRange(pane.composerInput!.value.length, pane.composerInput!.value.length);
			pane.handleMentionInput();
			await Promise.resolve();
			await Promise.resolve();
			assert.strictEqual(pane.mentionMenuOpen, true);
			assert.strictEqual(pane.mentionMenuHeaderQuery?.textContent, 'app');
			assert.strictEqual(pane.mentionMenuList?.querySelectorAll('[role="option"]').length, 2);

			pane.moveMentionActiveIndex(1);
			assert.strictEqual(pane.mentionMenuActiveIndex, 1);
			pane.moveMentionActiveIndex(-1);
			assert.strictEqual(pane.mentionMenuActiveIndex, 0);
			pane.acceptActiveMention();
			assert.strictEqual(pane.mentionMenuOpen, false);
			assert.strictEqual(pane.pendingContextSelections.length, 1);
			assert.strictEqual(pane.composerContextStrip?.classList.contains('hidden'), false);
			assert.strictEqual(pane.composerContextStrip?.querySelector('.vsclone-composer-context-chip-label')?.textContent, 'app.ts');
			assert.ok(calls.includes('metrics'));
			assert.ok(calls.includes('composerState'));

			pane.composerContextStrip?.querySelector<HTMLButtonElement>('.vsclone-composer-context-chip-remove')?.click();
			assert.strictEqual(pane.pendingContextSelections.length, 0);
			assert.strictEqual(pane.composerContextStrip?.classList.contains('hidden'), true);

			pane.addContextSelection({ kind: 'folder', uri: URI.file('/workspace/src') });
			assert.strictEqual(pane.pendingContextSelections[0]?.kind, 'folder');
			assert.deepStrictEqual(pane.toPendingContextSelections(pane.pendingContextSelections), pane.pendingContextSelections);
			pane.closeMentionMenu();
		} finally {
			host.remove();
			document.body.querySelector('.vsclone-image-preview-overlay')?.remove();
		}
	});

	test('renders runtime approval, user-question, diff, and apply controls', async () => {
		const { pane, calls } = createRuntimeApprovalAndApplyHarness();
		const editRequest: IVSCloneThreadRuntimeToolRequestMessage = {
			id: 'tool-edit',
			role: 'tool',
			createdAt: 1,
			type: 'tool_request',
			toolName: 'edit_file',
			approvalType: 'edits',
			params: {
				path: '/workspace/src/app.ts',
				changes: '<<<<<<< SEARCH\nconst before = true;\n=======\nconst after = true;\n>>>>>>> REPLACE',
			},
			requestedAt: 1,
			snapshots: [],
			run: createRunContext(),
		};

		const approval = pane.renderRuntimeApprovalRequest('thread-1', editRequest);
		assert.ok(approval.textContent?.includes('Approve edit to app.ts?'));
		assert.strictEqual(approval.querySelectorAll('.vsclone-tool-diff-card').length, 1);
		approval.querySelector<HTMLButtonElement>('.vsclone-runtime-approval-button.approve')?.click();
		approval.querySelector<HTMLButtonElement>('.vsclone-runtime-approval-button.always-approve')?.click();
		approval.querySelector<HTMLButtonElement>('.vsclone-runtime-approval-button.reject')?.click();
		assert.ok(calls.includes('approve:thread-1'));
		assert.ok(calls.includes('auto:true'));
		assert.ok(calls.some(call => call.startsWith('reject:thread-1:Tool request was rejected')));

		const mcpApproval = pane.renderRuntimeApprovalRequest('thread-1', {
			...editRequest,
			id: 'tool-mcp',
			toolName: 'external_tool',
			approvalType: 'MCP tools',
			params: { z: 1, nested: { b: true, a: false } },
		});
		assert.strictEqual(mcpApproval.querySelector('pre')?.textContent?.trim(), '{\n  "nested": {\n    "a": false,\n    "b": true\n  },\n  "z": 1\n}');

		const question = pane.renderRuntimeUserQuestionRequest('thread-1', {
			...editRequest,
			id: 'tool-question',
			toolName: 'ask_user',
			approvalType: undefined,
			params: {
				questions: [{
					id: 'strategy',
					question: 'Choose strategy',
					options: [{ label: 'Fast', description: 'Prioritize speed' }],
					allowFreeResponse: true,
				}],
			},
		});
		question.querySelector<HTMLInputElement>('input[type="radio"]')?.click();
		const note = question.querySelector<HTMLTextAreaElement>('textarea');
		assert.ok(note);
		note.value = 'ship it';
		note.dispatchEvent(new Event('input'));
		question.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
		question.querySelector<HTMLButtonElement>('.vsclone-runtime-approval-button.reject')?.click();
		assert.ok(calls.some(call => call.includes('answer:thread-1:')));
		assert.ok(calls.some(call => call.startsWith('reject:thread-1:User input request was cancelled')));

		const diffOutput = [
			'Updated file:///workspace/src/app.ts.',
			'[VSCLONE_TOOL_DIFF_START]',
			'```diff',
			'--- a/src/app.ts',
			'+++ b/src/app.ts',
			'@@ -1,2 +1,3 @@',
			'-const before = true;',
			'+const after = true;',
			'+const count = 1;',
			' // trailing comment',
			'```',
			'[VSCLONE_TOOL_DIFF_END]',
		].join('\n');
		const diffCard = pane.renderToolResultDiffCard('edit_file', diffOutput);
		assert.ok(diffCard);
		assert.strictEqual(diffCard.querySelector('.vsclone-tool-diff-title-lang-tag')?.textContent, 'TS');
		assert.strictEqual(diffCard.querySelectorAll('.vsclone-tool-diff-line.added').length, 2);
		diffCard.querySelector<HTMLAnchorElement>('.vsclone-tool-diff-title-filename')?.click();
		diffCard.querySelector<HTMLElement>('.vsclone-tool-diff-line.added.clickable')?.click();
		assert.ok(calls.some(call => call.startsWith('open:file:///workspace/src/app.ts')));

		const target = { threadId: 'thread-1', id: 'assistant-apply', responseText: '<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE' };
		const applyResult = createEditApplyResult();
		const applied = pane.renderEditApplySummary(target, { phase: 'applied', result: applyResult });
		assert.ok(applied.textContent?.includes('1 file changed'));
		applied.querySelector<HTMLButtonElement>('.vsclone-edit-apply-summary-review')?.click();
		applied.querySelector<HTMLButtonElement>('.vsclone-edit-apply-summary-undo')?.click();
		await Promise.resolve();
		await Promise.resolve();
		assert.ok(calls.includes('state:undone'));
		assert.ok(calls.includes('refresh'));

		const undone = pane.renderEditApplySummary(target, { phase: 'undone', result: applyResult });
		undone.querySelector<HTMLButtonElement>('.vsclone-edit-apply-summary-undo')?.click();
		await Promise.resolve();
		await Promise.resolve();
		assert.ok(calls.includes('state:applied'));

		const pendingHost = document.createElement('div');
		pane.pendingAssistantApplyMessageIds.add(target.id);
		pane.appendAssistantApplyControls(pendingHost, target);
		assert.ok(pendingHost.textContent?.includes('Applying changes'));
		pane.pendingAssistantApplyMessageIds.clear();

		const failedHost = document.createElement('div');
		Object.assign(pane.threadRuntimeService, {
			getAssistantEditApplicationState: () => ({ phase: 'failed' }),
		});
		pane.appendAssistantApplyControls(failedHost, target);
		const applyButton = failedHost.querySelector<HTMLButtonElement>('.vsclone-thread-message-apply');
		assert.ok(applyButton);
		applyButton.click();
		await Promise.resolve();
		await Promise.resolve();
		assert.ok(calls.includes('state:pending'));
	});

	test('persists assistant auto-apply success, partial, failed, and discovery states', async () => {
		const { pane, calls } = createRuntimeApprovalAndApplyHarness();
		const target = { threadId: 'thread-1', id: 'assistant-auto', responseText: 'edit payload' };
		const successResult = createEditApplyResult();
		pane.editCodeService.startApplyingSearchReplaceBlocks = async () => successResult;

		await pane.runAutoApply(target, target.responseText);
		assert.ok(calls.includes('state:applied'));
		assert.ok(calls.some(call => call.startsWith('info:Auto-applied')));
		assert.ok(calls.includes('refresh'));

		pane.editCodeService.startApplyingSearchReplaceBlocks = async () => ({
			...successResult,
			failures: ['second edit missed'],
		});
		await pane.runAutoApply({ ...target, id: 'assistant-partial' }, target.responseText);
		assert.ok(calls.includes('state:partial'));
		assert.ok(calls.some(call => call.startsWith('warn:Applied 1 edit')));

		pane.editCodeService.startApplyingSearchReplaceBlocks = async () => ({
			...successResult,
			appliedEdits: 0,
			modifiedFiles: [],
			fileChanges: [],
			failures: [],
		});
		await pane.runAutoApply({ ...target, id: 'assistant-failed' }, target.responseText);
		assert.ok(calls.includes('state:failed'));
		assert.ok(calls.some(call => call.includes('No matching SEARCH block was found')));

		pane.editCodeService.startApplyingSearchReplaceBlocks = async () => {
			throw new Error('apply crashed');
		};
		await pane.runAutoApply({ ...target, id: 'assistant-error' }, target.responseText);
		assert.ok(calls.some(call => call.startsWith('error:Failed to apply suggested changes: apply crashed')));

		let startedPayload = '';
		pane.editCodeService.startApplyingSearchReplaceBlocks = async responseText => {
			startedPayload = responseText;
			return successResult;
		};
		Object.assign(pane, {
			isThreadBusy: () => false,
			isAutoEligibleRuntimeAssistantApplyMessage: () => true,
			stripRuntimeAssistantWorkflowMarkup: (content: string) => content.replace('[workflow]', '').trim(),
		});
		pane.maybeAutoApplyRuntimeAssistantMessages({
			...createRuntimeState([{
				id: 'assistant-discovered',
				role: 'assistant',
				mode: 'act',
				createdAt: 1,
				content: '[workflow] discovered edit',
				editSuggestion: { kind: 'search_replace', applyMode: 'auto' },
			}]),
			threadId: 'thread-1',
		});
		await Promise.resolve();
		await Promise.resolve();

		assert.strictEqual(startedPayload, 'discovered edit');
		assert.ok(calls.includes('state:pending'));
	});
});
