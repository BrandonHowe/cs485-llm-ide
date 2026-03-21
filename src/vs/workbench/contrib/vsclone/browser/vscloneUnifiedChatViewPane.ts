/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/vscloneUnifiedChatViewPane.css';
import {
	addDisposableListener,
	EventType,
	getWindow,
} from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Action } from '../../../../base/common/actions.js';
import { fromNow } from '../../../../base/common/date.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import {
	DisposableStore,
	MutableDisposable,
	toDisposable,
} from '../../../../base/common/lifecycle.js';
import { splitLines } from '../../../../base/common/strings.js';
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
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import {
	IViewPaneOptions,
	ViewPane,
} from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import {
	IVSCloneChatHistoryQuery,
	IVSCloneChatHistoryThread,
	IVSCloneChatHistoryTurn,
	IVSCloneChatHistoryService,
} from '../common/backend/vscloneChatHistoryService.js';
import {
	IVSCloneModelCatalogService,
	type VSCloneReasoningEffortLevel,
} from '../common/vscloneModelCatalogService.js';
import { IVSClonePlanModeService } from '../common/vsclonePlanModeService.js';
import { type VSCloneChatMode } from '../common/vsclonePlanModeTypes.js';
import {
	IVSCloneChatLocation,
	IVSCloneThreadModelSelectionService,
	type IVSCloneModelSelection,
} from '../common/backend/vscloneThreadModelSelectionService.js';
import { parseToolCalls } from '../common/vscloneToolCallParser.js';
import {
	VSCloneChatHistoryRail,
	VSCloneRailTab,
} from './vscloneChatHistoryRail.js';
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

export function toVSCloneHistoryQuery(
	query: string,
	tab: VSCloneRailTab,
): IVSCloneChatHistoryQuery {
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

interface IUnifiedDiffHunkHeader {
	readonly originalStartLineNumber: number;
	readonly originalLineCount: number;
	readonly modifiedStartLineNumber: number;
	readonly modifiedLineCount: number;
}

interface IRenderedToolDiffLine {
	readonly sourceLineIndex: number;
	readonly rawText: string;
	readonly kind: 'file' | 'hunk' | 'context' | 'added' | 'removed';
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
			success: match[2] === 'true',
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
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, '\'')
		.replace(/&amp;/g, '&');
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
	private planModePlanButton: HTMLButtonElement | undefined;
	private planModeActButton: HTMLButtonElement | undefined;
	private reasoningEffortContainer: HTMLElement | undefined;
	private reasoningEffortSelect: HTMLSelectElement | undefined;

	private readonly rail = this._register(
		this.instantiationService.createInstance(VSCloneChatHistoryRail),
	);
	private readonly threadsById = new Map<string, IVSCloneChatHistoryThread>();
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
		await this.clipboardService.writeText(
			latestTurn.responsePlainText || latestTurn.responseMarkdown,
		);
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
		historyButton.textContent = localize(
			'vsclone.thread.actions.history',
			'Chat History',
		);
		// Mirror tooltip text into an accessible name so screen readers announce this icon-like action clearly.
		const historyButtonLabel = localize(
			'vsclone.thread.actions.history.tooltip',
			'Show chat history',
		);
		historyButton.title = historyButtonLabel;
		historyButton.setAttribute('aria-label', historyButtonLabel);
		actions.appendChild(historyButton);

		const overflowButton = document.createElement('button');
		overflowButton.type = 'button';
		overflowButton.className = 'vsclone-thread-action-overflow';
		overflowButton.textContent = '\u22ef';
		const overflowButtonLabel = localize(
			'vsclone.thread.actions.more',
			'More actions',
		);
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
		messages.setAttribute(
			'aria-label',
			localize('vsclone.thread.messages', 'Conversation messages'),
		);
		this.conversationList = messages;

		const emptyState = document.createElement('div');
		emptyState.className = 'vsclone-thread-empty-state';
		emptyState.textContent = localize(
			'vsclone.thread.empty',
			'Start a new chat from the composer below.',
		);
		this.conversationEmptyState = emptyState;

		const composer = document.createElement('div');
		composer.className = 'vsclone-thread-composer';

		const input = document.createElement('textarea');
		input.className = 'vsclone-thread-composer-input';
		input.rows = 1;
		input.placeholder = localize(
			'vsclone.composer.placeholder',
			'Ask a follow-up question...',
		);
		input.setAttribute(
			'aria-label',
			localize('vsclone.composer.inputLabel', 'Chat message'),
		);
		this.composerInput = input;

		const send = document.createElement('button');
		send.type = 'button';
		send.className = 'vsclone-thread-composer-send';
		send.textContent = localize('vsclone.composer.send', 'Send');
		this.composerSendButton = send;

		const controls = document.createElement('div');
		controls.className = 'vsclone-thread-composer-controls';
		this.planModeContainer = undefined;
		this.planModePlanButton = undefined;
		this.planModeActButton = undefined;
		this.reasoningEffortContainer = undefined;
		this.reasoningEffortSelect = undefined;

		const modelSwitcherEnabled =
			this.configurationService.getValue<boolean>(
				modelSwitcherEnabledSetting,
			) ?? true;
		if (modelSwitcherEnabled) {
			const modelSwitcherHost = document.createElement('div');
			modelSwitcherHost.className = 'vsclone-thread-model-switcher';
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

			const reasoningEffortHost = document.createElement('div');
			reasoningEffortHost.className = 'vsclone-thread-reasoning-level hidden';
			const reasoningEffortSelect = document.createElement('select');
			reasoningEffortSelect.className = 'vsclone-thread-reasoning-level-select';
			reasoningEffortSelect.setAttribute(
				'aria-label',
				localize('vsclone.composer.reasoningEffort', 'Reasoning level'),
			);
			reasoningEffortHost.appendChild(reasoningEffortSelect);
			controls.appendChild(reasoningEffortHost);
			this.reasoningEffortContainer = reasoningEffortHost;
			this.reasoningEffortSelect = reasoningEffortSelect;
		}

		// Keep execution mode explicit in the composer so users can swap between planning and acting
		// without coupling that choice to provider/model switches for the same thread.
		const planModeHost = document.createElement('div');
		planModeHost.className = 'vsclone-plan-mode-toggle';
		planModeHost.setAttribute('role', 'group');
		planModeHost.setAttribute(
			'aria-label',
			localize('vsclone.composer.mode', 'Chat mode'),
		);
		const planButton = document.createElement('button');
		planButton.type = 'button';
		planButton.className = 'vsclone-plan-mode-button';
		planButton.textContent = localize('vsclone.composer.mode.plan', 'Plan');
		const actButton = document.createElement('button');
		actButton.type = 'button';
		actButton.className = 'vsclone-plan-mode-button';
		actButton.textContent = localize('vsclone.composer.mode.act', 'Act');
		planModeHost.appendChild(planButton);
		planModeHost.appendChild(actButton);
		controls.appendChild(planModeHost);
		this.planModeContainer = planModeHost;
		this.planModePlanButton = planButton;
		this.planModeActButton = actButton;

		const hint = document.createElement('div');
		hint.className = 'vsclone-thread-composer-hint';
		hint.textContent = localize(
			'vsclone.composer.hint',
			'Press Enter to send, Shift+Enter for new line',
		);
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
					this.contextMenuService.showContextMenu({
						getAnchor: () => ({ x: event.clientX, y: event.clientY }),
						getActions: () => [
							new Action(
								'vsclone.chatHistory.copyPrompt',
								localize('vsclone.thread.actions.copyPrompt', 'Copy Prompt'),
								undefined,
								true,
								() => this.copyPrompt(),
							),
							new Action(
								'vsclone.chatHistory.copyResponse',
								localize(
									'vsclone.thread.actions.copyResponse',
									'Copy Response',
								),
								undefined,
								true,
								() => this.copyResponse(),
							),
							new Action(
								'vsclone.chatHistory.reusePrompt',
								localize('vsclone.thread.actions.reusePrompt', 'Reuse Prompt'),
								undefined,
								true,
								() => this.reusePrompt(),
							),
							new Action(
								'vsclone.chatHistory.deleteThread',
								localize(
									'vsclone.thread.actions.deleteThread',
									'Delete Thread',
								),
								undefined,
								true,
								() => this.deleteActiveThread(),
							),
						],
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
						event.key !== 'Enter' ||
						event.shiftKey ||
						event.altKey ||
						event.ctrlKey ||
						event.metaKey
					) {
						return;
					}
					event.preventDefault();
					void this.submitPrompt();
				},
			),
		);

		this._register(
			addDisposableListener(send, EventType.CLICK, () => {
				void this.submitPrompt();
			}),
		);
		if (this.planModePlanButton && this.planModeActButton) {
			this._register(
				addDisposableListener(this.planModePlanButton, EventType.CLICK, () => {
					void this.updatePlanModeSelection('plan');
				}),
			);
			this._register(
				addDisposableListener(this.planModeActButton, EventType.CLICK, () => {
					void this.updatePlanModeSelection('act');
				}),
			);
		}
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

		const fallback = document.createElement('div');
		fallback.className = 'vsclone-thread-empty-state';
		fallback.textContent = localize(
			'vsclone.thread.renderError',
			'Failed to render the chat UI. Reload the window and try again.',
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

		const selectedModel = this.getCurrentComposerModelSelection(activeThreadId);
		const existingThread = activeThreadId
			? this.resolveThreadById(activeThreadId)
			: undefined;
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
				await this.modelSelectionService.setSelectionForThread(
					submission.threadId,
					{
						...selectedModel,
						threadId: submission.threadId,
						location: 'chat',
						selectedAt: Date.now(),
					},
				);
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
			await this.planModeService.initialize();
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
			this.rail.setError(
				localize(
					'vsclone.rail.load.error',
					'Failed to load chat history. Please try again.',
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

		if (this.activeThreadId && !this.threadsById.has(this.activeThreadId)) {
			this.activeThreadId = undefined;
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

		const turns = this.activeThreadId
			? this.historyService.getTurns(this.activeThreadId)
			: [];
		const hasTurns = turns.length > 0;
		// Refresh rebuilds the transcript DOM from scratch, so dispose markdown renderers from
		// the previous pass before replacing nodes to avoid leaking listeners.
		this.renderedMarkdownDisposables.clear();
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
			if (
				text.includes('<tool_call>') ||
				text.includes('<tool_result') ||
				text.includes('<agent_trace')
			) {
				this.renderToolAwareAssistantText(
					body,
					text,
					turn.status === 'streaming',
				);
			} else {
				this.appendMarkdownSegment(
					body,
					text,
					'vsclone-thread-message-text-segment',
				);
			}
		} else if (turn.status === 'pending' || turn.status === 'streaming') {
			body.textContent = localize(
				'vsclone.thread.assistant.pending',
				'Thinking...',
			);
			item.classList.add('streaming');
		} else if (turn.status === 'cancelled') {
			body.textContent = localize(
				'vsclone.thread.assistant.cancelled',
				'Response generation was cancelled.',
			);
		} else if (turn.status === 'failed') {
			body.textContent = localize(
				'vsclone.thread.assistant.failed',
				'Something went wrong while generating the response.',
			);
		}
		item.appendChild(body);

		// Plan-mode turns stay intentionally non-mutating even if the model emits executable-looking
		// SEARCH/REPLACE blocks in plain text. That closes the last mutation path outside tool calls.
		if (
			turn.executionMode !== 'plan' &&
			turn.status === 'completed' &&
			text.trim().length > 0 &&
			this.editApplicationService.hasSearchReplaceBlocks(text)
		) {
			const applyButton = document.createElement('button');
			applyButton.type = 'button';
			applyButton.className = 'vsclone-thread-message-apply';
			applyButton.textContent = localize(
				'vsclone.thread.assistant.apply',
				'Apply Changes',
			);
			applyButton.addEventListener(EventType.CLICK, () => {
				void this.applyAssistantEdits(turn, applyButton);
			});
			item.appendChild(applyButton);
		}

		return item;
	}

	private renderToolAwareAssistantText(
		container: HTMLElement,
		text: string,
		streaming: boolean,
	): void {
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

		const callBlocks = parseToolCalls(text).toolCalls.map<ParsedBlock>(
			(call) => ({
				kind: 'tool_call',
				startOffset: call.startOffset,
				endOffset: call.endOffset,
				rawXml: call.rawXml,
				toolName: call.name,
			}),
		);
		const resultBlocks = parseToolResultBlocks(text).map<ParsedBlock>(
			(result) => ({
				kind: 'tool_result',
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
				kind: 'trace',
				startOffset: trace.startOffset,
				endOffset: trace.endOffset,
				rawXml: trace.rawXml,
				toolName: '',
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
			.filter((result) => result.toolName === 'attempt_completion')
			.map((result) =>
				this.normalizeTranscriptComparisonText(result.output ?? ''),
			)
			.filter((value): value is string => value.length > 0);
		const firstCompletionStartOffset = resultBlocks
			.filter((result) => result.toolName === 'attempt_completion')
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
			| { readonly kind: 'thinking'; readonly message: string }
			| {
				readonly kind: 'tool';
				readonly toolName: string;
				readonly displayMessage: string;
				readonly status: 'running' | 'complete' | 'success' | 'error';
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
			status: 'running' | 'complete' | 'success' | 'error',
			output?: string,
			diffCard?: HTMLElement,
		) => {
			pendingActivity.push({
				kind: 'tool',
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
				pendingToolTraceName !== '\x00completion'
			) {
				addTool(
					pendingToolTraceName,
					pendingToolTraceMessage ?? pendingToolTraceName,
					streaming ? 'running' : 'complete',
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

			if (block.kind === 'tool_call') {
				if (!hasTraceBlocks) {
					flushPendingTool();
					addTool(
						block.toolName,
						block.toolName,
						streaming ? 'running' : 'complete',
					);
				}
			} else if (block.kind === 'tool_result') {
				const diffCard =
					block.success && block.output
						? this.renderToolResultDiffCard(block.toolName, block.output)
						: undefined;

				if (
					block.toolName === 'attempt_completion' ||
					pendingToolTraceName === '\x00completion'
				) {
					flushActivity();
					this.appendMarkdownSegment(
						container,
						block.output ?? '',
						'vsclone-thread-message-text-segment',
					);
					pendingToolTraceName = undefined;
					pendingToolTraceMessage = undefined;
				} else if (hasTraceBlocks && pendingToolTraceName !== undefined) {
					addTool(
						pendingToolTraceName,
						pendingToolTraceMessage ?? pendingToolTraceName,
						block.success ? 'success' : 'error',
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
							block.success ? 'success' : 'error',
							block.output,
							diffCard,
						);
					} else if (!hasTraceBlocks && block.output?.trim()) {
						addTool(
							block.toolName,
							block.toolName,
							block.success ? 'success' : 'error',
							block.output,
						);
					} else if (!hasTraceBlocks) {
						addTool(
							block.toolName,
							block.toolName,
							block.success ? 'success' : 'error',
						);
					}
				}
			} else {
				// Agent trace block
				if (block.traceType === 'thinking') {
					flushPendingTool();
					pendingActivity.push({
						kind: 'thinking',
						message: block.traceMessage ?? '',
					});
				} else if (block.traceType === 'tool') {
					const msg = block.traceMessage ?? '';
					const isCompletion =
						msg.toLowerCase().includes('attempt') &&
						msg.toLowerCase().includes('completion');
					if (isCompletion) {
						flushPendingTool();
						pendingToolTraceName = '\x00completion';
						pendingToolTraceMessage = undefined;
					} else {
						flushPendingTool();
						pendingToolTraceName = msg;
						pendingToolTraceMessage = block.traceMessage;
					}
				} else if (block.traceType === 'tool_result') {
					if (pendingToolTraceName === '\x00completion') {
						pendingToolTraceName = undefined;
						pendingToolTraceMessage = undefined;
					} else if (pendingToolTraceName !== undefined) {
						addTool(
							pendingToolTraceName,
							pendingToolTraceMessage ?? pendingToolTraceName,
							block.traceStatus === 'success'
								? 'success'
								: block.traceStatus === 'error'
									? 'error'
									: 'complete',
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
						kind: 'thinking',
						message: block.traceMessage ?? '',
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
		return value.replace(/\s+/g, ' ').trim().toLowerCase();
	}

	/**
	 * The prompt asks the model to emit a single short "Thinking:" line immediately before each
	 * tool call, but streamed output still sometimes collapses multiple thinking lines and trailing
	 * prose into one run. We recover that structure here so the UI remains stable even when the
	 * model omits the expected newlines.
	 */
	private extractPlainAssistantSegments(text: string): ReadonlyArray<{
		readonly kind: 'thinking' | 'text';
		readonly value: string;
	}> {
		const segments: { kind: 'thinking' | 'text'; value: string }[] = [];
		let cursor = 0;
		let searchOffset = 0;

		const pushSegment = (kind: 'thinking' | 'text', value: string) => {
			if (!value.trim()) {
				return;
			}

			const previous =
				segments.length > 0 ? segments[segments.length - 1] : undefined;
			if (kind === 'text' && previous?.kind === kind) {
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

			pushSegment('text', text.slice(cursor, markerOffset));

			const messageStartOffset = markerOffset + 'Thinking:'.length;
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
			pushSegment('thinking', message);
			pushSegment('text', trailingText);

			cursor = messageEndOffset;
			searchOffset = messageEndOffset;
		}

		pushSegment('text', text.slice(cursor));
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
			const markerOffset = text.indexOf('Thinking:', searchOffset);
			if (markerOffset < 0) {
				return -1;
			}

			if (
				markerOffset === 0 ||
				/[\s.!?;:)\]}"'`>-]/.test(text[markerOffset - 1])
			) {
				return markerOffset;
			}

			searchOffset = markerOffset + 'Thinking:'.length;
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
			return { message: '', trailingText: '' };
		}

		const proseBoundary = /([.!?]["')\]]*)(\s*)(?=[A-Z0-9"'`([{])/;
		const boundaryMatch = proseBoundary.exec(trimmed);
		if (!boundaryMatch) {
			return { message: trimmed, trailingText: '' };
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
			const joined = normalLines.join('\n').trim();
			if (joined) {
				this.appendMarkdownSegment(
					container,
					joined,
					'vsclone-thread-message-text-segment',
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
			if (segment.kind === 'thinking') {
				flushNormal();
				thinkingMessages.push(segment.value);
				continue;
			}

			for (const line of segment.value.split('\n')) {
				const trimmed = line.trim();
				if (/^\[Agent iteration \d+\]$/.test(trimmed) || trimmed === '---') {
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
		const details = document.createElement('details');
		details.className = 'vsclone-thinking-block';
		if (streaming) {
			details.open = true;
		}

		const summary = document.createElement('summary');
		summary.className = 'vsclone-thinking-summary';

		const icon = document.createElement('span');
		icon.className = 'codicon codicon-lightbulb vsclone-thinking-icon';
		summary.appendChild(icon);

		const label = document.createElement('span');
		label.textContent = streaming
			? localize('vsclone.thread.thinking.active', 'Thinking...')
			: localize(
				'vsclone.thread.thinking.label',
				'Thinking ({0} steps)',
				messages.length.toString(),
			);
		summary.appendChild(label);

		details.appendChild(summary);

		const content = document.createElement('div');
		content.className = 'vsclone-thinking-content';
		for (const msg of messages) {
			if (msg.trim()) {
				const step = document.createElement('div');
				step.className = 'vsclone-thinking-step';
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
			| { readonly kind: 'thinking'; readonly message: string }
			| {
				readonly kind: 'tool';
				readonly toolName: string;
				readonly displayMessage: string;
				readonly status: 'running' | 'complete' | 'success' | 'error';
				readonly output?: string;
				readonly diffCard?: HTMLElement;
			}
		>,
		streaming: boolean,
	): HTMLElement {
		const toolItems = items.filter(
			(i): i is Extract<typeof i, { kind: 'tool' }> => i.kind === 'tool',
		);
		const thinkingItems = items.filter(
			(i): i is Extract<typeof i, { kind: 'thinking' }> =>
				i.kind === 'thinking',
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
		const details = document.createElement('details');
		details.className = 'vsclone-activity-group';
		if (streaming || hasDiffCards) {
			details.open = true;
		}

		const summaryEl = document.createElement('summary');
		summaryEl.className = 'vsclone-activity-summary';

		const icon = document.createElement('span');
		icon.className = 'codicon codicon-tools vsclone-activity-icon';
		summaryEl.appendChild(icon);

		const label = document.createElement('span');
		const isRunning =
			streaming && toolItems.some((t) => t.status === 'running');
		if (isRunning) {
			label.textContent = localize(
				'vsclone.activity.running',
				'Running tools...',
			);
		} else {
			label.textContent =
				toolItems.length === 1
					? localize('vsclone.activity.single', 'Used 1 tool')
					: localize(
						'vsclone.activity.count',
						'Used {0} tools',
						toolItems.length.toString(),
					);
		}
		summaryEl.appendChild(label);

		details.appendChild(summaryEl);

		const content = document.createElement('div');
		content.className = 'vsclone-activity-content';

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
		status: 'running' | 'complete' | 'success' | 'error',
	): HTMLElement {
		const row = document.createElement('div');
		row.className = 'vsclone-activity-row';
		row.classList.add(`status-${status}`);

		const statusIcon = document.createElement('span');
		statusIcon.className = 'vsclone-activity-row-status';
		switch (status) {
			case 'running':
				statusIcon.classList.add(
					'codicon',
					'codicon-loading',
					'codicon-modifier-spin',
				);
				break;
			case 'success':
				statusIcon.classList.add('codicon', 'codicon-check');
				break;
			case 'error':
				statusIcon.classList.add('codicon', 'codicon-error');
				break;
			default:
				statusIcon.classList.add('codicon', 'codicon-check');
				break;
		}
		row.appendChild(statusIcon);

		const toolIcon = document.createElement('span');
		toolIcon.className = `codicon vsclone-activity-row-icon ${this.getToolIconClass(toolName)}`;
		row.appendChild(toolIcon);

		const labelEl = document.createElement('span');
		labelEl.className = 'vsclone-activity-row-label';
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
		status: 'running' | 'complete' | 'success' | 'error',
		output: string | undefined,
		diffCard: HTMLElement | undefined,
	): HTMLElement {
		const card = document.createElement('div');
		card.className = 'vsclone-tool-card';
		card.classList.add(`status-${status}`);

		const header = document.createElement('div');
		header.className = 'vsclone-tool-card-header';

		const icon = document.createElement('span');
		icon.className = `codicon vsclone-tool-card-icon ${this.getToolIconClass(toolName)}`;
		header.appendChild(icon);

		const label = document.createElement('span');
		label.className = 'vsclone-tool-card-label';
		label.textContent = displayMessage;
		header.appendChild(label);

		const statusBadge = document.createElement('span');
		statusBadge.className = 'vsclone-tool-card-status';
		switch (status) {
			case 'running':
				statusBadge.classList.add(
					'codicon',
					'codicon-loading',
					'codicon-modifier-spin',
				);
				break;
			case 'success':
				statusBadge.classList.add('codicon', 'codicon-check');
				break;
			case 'error':
				statusBadge.classList.add('codicon', 'codicon-error');
				break;
			case 'complete':
				statusBadge.classList.add('codicon', 'codicon-check');
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
			this.appendMarkdownSegment(card, output, 'vsclone-tool-card-output');
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

		const segment = document.createElement('div');
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

	private getToolIconClass(toolName: string): string {
		const lower = toolName.toLowerCase();
		if (lower.includes('read') || lower.includes('Read')) {
			return 'codicon-file';
		}
		if (
			lower.includes('edit') ||
			lower.includes('Edit') ||
			lower.includes('write') ||
			lower.includes('Write')
		) {
			return 'codicon-edit';
		}
		if (lower.includes('create') || lower.includes('Create')) {
			return 'codicon-new-file';
		}
		if (
			lower.includes('run') ||
			lower.includes('exec') ||
			lower.includes('command') ||
			lower.includes('terminal')
		) {
			return 'codicon-terminal';
		}
		if (
			lower.includes('search') ||
			lower.includes('grep') ||
			lower.includes('find')
		) {
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

	/**
	 * Extracts a filename from diff content by looking for `---` and `+++` header lines.
	 */
	private extractFilenameFromDiff(diff: string): string | undefined {
		for (const line of diff.split('\n')) {
			if (line.startsWith('+++ ') && !line.startsWith('+++ /dev/null')) {
				const path = line.slice(4).trim();
				// Strip leading a/ or b/ prefix from git diffs
				return path.replace(/^[ab]\//, '');
			}
		}
		return undefined;
	}

	/**
	 * Guesses a file's language from its extension for use in the title bar label.
	 */
	private getLanguageLabelFromFilename(filename: string): string {
		const ext = filename.split('.').pop()?.toLowerCase() ?? '';
		const languageMap: Record<string, string> = {
			ts: 'TS',
			tsx: 'TSX',
			js: 'JS',
			jsx: 'JSX',
			css: 'CSS',
			scss: 'SCSS',
			html: 'HTML',
			json: 'JSON',
			md: 'MD',
			py: 'PY',
			rs: 'RS',
			go: 'GO',
			java: 'JAVA',
			c: 'C',
			cpp: 'C++',
			h: 'H',
			cs: 'C#',
			rb: 'RB',
			yaml: 'YAML',
			yml: 'YAML',
			toml: 'TOML',
			xml: 'XML',
			svg: 'SVG',
			sh: 'SH',
			bash: 'SH',
			zsh: 'SH',
			sql: 'SQL',
			vue: 'VUE',
			svelte: 'SVELTE',
		};
		return languageMap[ext] ?? ext.toUpperCase();
	}

	/**
	 * Applies basic syntax highlighting to a code string by wrapping recognized tokens
	 * in spans with appropriate CSS classes.
	 */
	private syntaxHighlightLine(code: string): HTMLSpanElement {
		const container = document.createElement('span');
		// Strip leading +/- diff prefix for highlighting purposes, but preserve it visually
		let prefix = '';
		let strippedCode = code;
		if (code.startsWith('+') && !code.startsWith('+++')) {
			prefix = '+';
			strippedCode = code.slice(1);
		} else if (code.startsWith('-') && !code.startsWith('---')) {
			prefix = '-';
			strippedCode = code.slice(1);
		}

		if (prefix) {
			const prefixSpan = document.createElement('span');
			prefixSpan.textContent = prefix;
			container.appendChild(prefixSpan);
		}

		// Tokenize using regex patterns
		const tokenRules: Array<{ pattern: RegExp; tokenClass: string }> = [
			{ pattern: /\/\/.*$/gm, tokenClass: 'vsclone-token-comment' },
			{ pattern: /\/\*[\s\S]*?\*\//g, tokenClass: 'vsclone-token-comment' },
			{ pattern: /#.*$/gm, tokenClass: 'vsclone-token-comment' },
			{
				pattern: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
				tokenClass: 'vsclone-token-string',
			},
			{
				pattern:
					/\b(?:import|export|from|const|let|var|function|return|if|else|for|while|class|extends|interface|type|enum|async|await|new|this|super|typeof|instanceof|in|of|try|catch|throw|finally|switch|case|default|break|continue|yield|do|void|delete|with|as|is|readonly|declare|abstract|implements|namespace|module|require|public|private|protected|static|get|set|constructor)\b/g,
				tokenClass: 'vsclone-token-keyword',
			},
			{
				pattern: /\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
				tokenClass: 'vsclone-token-number',
			},
			{
				pattern: /\b(?:true|false|null|undefined|NaN|Infinity)\b/g,
				tokenClass: 'vsclone-token-keyword',
			},
			{ pattern: /[{}()[\];,.:]/g, tokenClass: 'vsclone-token-punctuation' },
			{ pattern: /[+\-*/%=<>!&|^~?@]/g, tokenClass: 'vsclone-token-operator' },
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
			const tokenSpan = document.createElement('span');
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
		return match[0].replace(/\.$/, '');
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
			originalLineCount: parseInt(match[2] ?? '1', 10),
			modifiedStartLineNumber: parseInt(match[3], 10),
			modifiedLineCount: parseInt(match[4] ?? '1', 10),
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
		const diffLines = diff.split('\n');

		for (
			let sourceLineIndex = 0;
			sourceLineIndex < diffLines.length;
			sourceLineIndex++
		) {
			const rawLine = diffLines[sourceLineIndex];
			if (rawLine.startsWith('@@')) {
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
					kind: 'hunk',
					navigationLineNumber: hunkHeader?.modifiedStartLineNumber,
				});
				continue;
			}

			if (rawLine.startsWith('---') || rawLine.startsWith('+++')) {
				renderedLines.push({ sourceLineIndex, rawText: rawLine, kind: 'file' });
				continue;
			}

			if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
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
					kind: 'added',
					navigationLineNumber,
				});
				if (modifiedLineNumber !== undefined) {
					modifiedLineNumber += 1;
				}
				continue;
			}

			if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
				renderedLines.push({
					sourceLineIndex,
					rawText: rawLine,
					kind: 'removed',
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
				kind: 'context',
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
		const diffLines = diff.split('\n');
		const legacyHunks = this.parseLegacyDiffHunks(diffLines);
		if (legacyHunks.length === 0) {
			return undefined;
		}

		const content = await this.readDiffTargetContents(URI.parse(fileUri));
		if (content === undefined) {
			return undefined;
		}

		const fileLines = splitLines(content).map((line) =>
			line.replace(/\r$/, ''),
		);
		const lineNumbers = new Map<number, number>();
		const titleNavigation: IDiffLineNavigationState = {};
		let searchStartIndex = 0;

		for (const hunk of legacyHunks) {
			const modifiedLines = hunk.lines
				.filter((line) => !line.startsWith('-'))
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
				if (!rawLine.startsWith('-')) {
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

			if (line.startsWith('@@')) {
				if (currentLines.length > 0) {
					hunks.push({ lineIndexes: currentLineIndexes, lines: currentLines });
				}
				currentLineIndexes = undefined;
				currentLines = undefined;
				continue;
			}

			if (line.startsWith('---') || line.startsWith('+++')) {
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
			(line.startsWith('+') && !line.startsWith('+++')) ||
			(line.startsWith('-') && !line.startsWith('---')) ||
			line.startsWith(' ')
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
				'vsclone.thread.toolDiff.lineRange',
				'Ln {0}-{1}',
				navigation.startLineNumber.toString(),
				endLineNumber.toString(),
			)
			: localize(
				'vsclone.thread.toolDiff.lineNumber',
				'Ln {0}',
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

		const card = document.createElement('div');
		card.className = 'vsclone-tool-diff-card';

		const titleBar = document.createElement('div');
		titleBar.className = 'vsclone-tool-diff-title';

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
			const fileIcon = document.createElement('span');
			fileIcon.className = 'codicon codicon-file vsclone-tool-diff-title-icon';
			titleBar.appendChild(fileIcon);

			// Make the filename a clickable link that opens the file
			const fileLabel = document.createElement('a');
			fileLabel.className = 'vsclone-tool-diff-title-filename';
			fileLabel.textContent = `${langLabel} ${filename}`;
			fileLabel.title =
				titleNavigation.startLineNumber !== undefined
					? localize(
						'vsclone.thread.toolDiff.openAtLineTitle',
						'Open {0} at line {1}',
						filename,
						titleNavigation.startLineNumber.toString(),
					)
					: (fileUri ?? filename);
			if (fileUri) {
				fileLabel.href = '#';
				fileLabel.addEventListener('click', (e) => {
					e.preventDefault();
					this.openDiffTarget(fileUri, titleNavigation);
				});
				fileLabel.style.cursor = 'pointer';
			}
			titleBar.appendChild(fileLabel);

			if (fileUri) {
				const anchorLineBadge = document.createElement('a');
				anchorLineBadge.className = 'vsclone-tool-diff-title-line';
				const lineLabel = this.formatDiffLineLabel(titleNavigation);
				anchorLineBadge.hidden = lineLabel === undefined;
				if (
					lineLabel !== undefined &&
					titleNavigation.startLineNumber !== undefined
				) {
					anchorLineBadge.textContent = lineLabel;
					anchorLineBadge.title = localize(
						'vsclone.thread.toolDiff.openLineTitle',
						'Open line {0}',
						titleNavigation.startLineNumber.toString(),
					);
				}
				anchorLineBadge.href = '#';
				anchorLineBadge.addEventListener('click', (e) => {
					e.preventDefault();
					this.openDiffTarget(fileUri, titleNavigation);
				});
				lineBadge = anchorLineBadge;
				titleBar.appendChild(anchorLineBadge);
			} else if (titleNavigation.startLineNumber !== undefined) {
				lineBadge = document.createElement('span');
				lineBadge.className = 'vsclone-tool-diff-title-line';
				lineBadge.textContent = this.formatDiffLineLabel(titleNavigation) ?? '';
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
								'vsclone.thread.toolDiff.openAtLineTitle',
								'Open {0} at line {1}',
								filename,
								titleNavigation.startLineNumber.toString(),
							);
							if (lineBadge) {
								lineBadge.hidden = false;
								lineBadge.textContent =
									this.formatDiffLineLabel(titleNavigation) ?? '';
								lineBadge.title = localize(
									'vsclone.thread.toolDiff.openLineTitle',
									'Open line {0}',
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
								entry.line.classList.add('clickable');
								entry.line.title = localize(
									'vsclone.thread.toolDiff.openChangedLineTitle',
									'Open changed line {0}',
									resolvedLineNumber.toString(),
								);
							}
						}
					},
				);
			}
		} else {
			const label = document.createElement('span');
			label.className = 'vsclone-tool-diff-title-filename';
			switch (toolName) {
				case 'edit_file':
					label.textContent = localize(
						'vsclone.thread.toolDiff.editedTitle',
						'Applied file edits',
					);
					break;
				case 'create_file':
					label.textContent = localize(
						'vsclone.thread.toolDiff.createdTitle',
						'Created file',
					);
					break;
				default:
					label.textContent = localize(
						'vsclone.thread.toolDiff.genericTitle',
						'Applied workspace change',
					);
					break;
			}
			titleBar.appendChild(label);
		}

		card.appendChild(titleBar);

		const body = document.createElement('div');
		body.className = 'vsclone-tool-diff-body';
		for (const diffLine of renderedDiff.lines) {
			const line = document.createElement('div');
			line.className = 'vsclone-tool-diff-line';
			const lineNavigation: IDiffLineNavigationState = {
				startLineNumber: diffLine.navigationLineNumber,
				endLineNumber: diffLine.navigationLineNumber,
			};
			if (
				diffLine.kind === 'added' ||
				diffLine.kind === 'removed' ||
				diffLine.kind === 'hunk' ||
				diffLine.kind === 'file'
			) {
				line.classList.add(diffLine.kind);
			}

			let gutter: HTMLElement | undefined;
			if (diffLine.kind !== 'file' && diffLine.kind !== 'hunk') {
				gutter = document.createElement('span');
				gutter.className = 'vsclone-tool-diff-gutter';
				gutter.textContent =
					lineNavigation.startLineNumber !== undefined
						? lineNavigation.startLineNumber.toString()
						: '';
				line.appendChild(gutter);
			}

			// Syntax-highlighted content keeps the diff prefix visible while the line gutter stays separate.
			if (diffLine.kind !== 'file') {
				line.appendChild(this.syntaxHighlightLine(diffLine.rawText));
			}

			if (fileUri && diffLine.kind !== 'hunk' && diffLine.kind !== 'file') {
				if (lineNavigation.startLineNumber !== undefined) {
					line.classList.add('clickable');
					line.title = localize(
						'vsclone.thread.toolDiff.openChangedLineTitle',
						'Open changed line {0}',
						lineNavigation.startLineNumber.toString(),
					);
				}
				line.addEventListener('click', () => {
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

	private async applyAssistantEdits(
		turn: IVSCloneChatHistoryTurn,
		button: HTMLButtonElement,
	): Promise<void> {
		const responseText = turn.responsePlainText || turn.responseMarkdown;
		if (!responseText) {
			return;
		}

		const defaultButtonLabel = localize(
			'vsclone.thread.assistant.apply',
			'Apply Changes',
		);
		button.disabled = true;
		button.textContent = localize(
			'vsclone.thread.assistant.apply.pending',
			'Applying...',
		);

		try {
			const applyResult =
				await this.editApplicationService.applySearchReplaceBlocks(
					responseText,
				);
			if (applyResult.appliedEdits > 0) {
				this.notificationService.info(
					localize(
						'vsclone.thread.assistant.apply.success',
						'Applied {0} edit(s) across {1} file(s).',
						applyResult.appliedEdits,
						applyResult.modifiedFiles.length,
					),
				);
			} else {
				const failureDetails =
					applyResult.failures[0] ??
					localize(
						'vsclone.thread.assistant.apply.noChanges.reason',
						'No matching SEARCH block was found.',
					);
				this.notificationService.warn(
					localize(
						'vsclone.thread.assistant.apply.noChanges',
						'No changes were applied. {0}',
						failureDetails,
					),
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.notificationService.error(
				localize(
					'vsclone.thread.assistant.apply.error',
					'Failed to apply suggested changes: {0}',
					message,
				),
			);
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
		const threadBusy = this.activeThreadId
			? this.isThreadBusy(this.activeThreadId)
			: false;
		const composerBusy = threadBusy || this.submittingPrompt;
		const hasSelectedModel = !!this.getCurrentComposerModelSelection(
			this.activeThreadId,
		);
		const disabled = !hasText || composerBusy || !hasSelectedModel;
		this.composerSendButton.disabled = disabled;
		this.composerInput.disabled = composerBusy;
		if (this.reasoningEffortSelect) {
			const reasoningControlHidden =
				this.reasoningEffortContainer?.classList.contains('hidden') ?? true;
			this.reasoningEffortSelect.disabled =
				composerBusy || reasoningControlHidden;
		}
		this.refreshPlanModeControl(composerBusy);
		if (this.composerInput.disabled) {
			this.composerInput.placeholder = localize(
				'vsclone.composer.waiting',
				'Waiting for response...',
			);
		} else if (!hasSelectedModel) {
			// VSClone always needs a concrete provider/model pair before it can send a prompt.
			this.composerInput.placeholder = localize(
				'vsclone.composer.signInRequired',
				'Sign in to a provider and choose a model to start chatting...',
			);
		} else if (this.getCurrentComposerMode() === 'plan') {
			this.composerInput.placeholder = localize(
				'vsclone.composer.planPlaceholder',
				'Describe what you want to plan...',
			);
		} else {
			this.composerInput.placeholder = localize(
				'vsclone.composer.placeholder',
				'Ask a follow-up question...',
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
		const latestTurn = this.historyService.getTurns(threadId).at(-1);
		return (
			latestTurn?.status === 'pending' || latestTurn?.status === 'streaming'
		);
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
		if (
			!this.planModeContainer ||
			!this.planModePlanButton ||
			!this.planModeActButton
		) {
			return;
		}

		const busy =
			composerBusy ??
			((this.activeThreadId ? this.isThreadBusy(this.activeThreadId) : false) ||
				this.submittingPrompt);
		const mode = this.getCurrentComposerMode();
		this.planModeContainer.classList.toggle('plan-active', mode === 'plan');
		this.planModeContainer.classList.toggle('act-active', mode === 'act');
		this.planModePlanButton.classList.toggle('active', mode === 'plan');
		this.planModeActButton.classList.toggle('active', mode === 'act');
		this.planModePlanButton.disabled = busy;
		this.planModeActButton.disabled = busy;
		this.planModePlanButton.setAttribute(
			'aria-pressed',
			mode === 'plan' ? 'true' : 'false',
		);
		this.planModeActButton.setAttribute(
			'aria-pressed',
			mode === 'act' ? 'true' : 'false',
		);
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
				threadId ?? '',
				'chat',
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
				this.activeThreadId ?? '',
				'chat',
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
			this.reasoningEffortContainer.classList.add('hidden');
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

		const selectedModel =
			this.modelSelectionService.getCurrentSelectionForThread(
				this.activeThreadId ?? '',
				'chat',
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
			this.activeThreadId ?? '',
			{
				...selectedModel,
				threadId: this.activeThreadId,
				location: 'chat',
				reasoningEffort: nextReasoningEffort,
				selectedAt: Date.now(),
			},
		);
	}

	private toReasoningEffortLabel(level: VSCloneReasoningEffortLevel): string {
		switch (level) {
			case 'xhigh':
				return localize('vsclone.composer.reasoningEffort.xhigh', 'Extra High');
			case 'max':
				return localize('vsclone.composer.reasoningEffort.max', 'Max');
			case 'high':
				return localize('vsclone.composer.reasoningEffort.high', 'High');
			case 'medium':
				return localize('vsclone.composer.reasoningEffort.medium', 'Medium');
			case 'standard':
				return localize(
					'vsclone.composer.reasoningEffort.standard',
					'Standard',
				);
			case 'low':
				return localize('vsclone.composer.reasoningEffort.low', 'Low');
			case 'minimal':
				return localize('vsclone.composer.reasoningEffort.minimal', 'Minimal');
			case 'lite':
				return localize('vsclone.composer.reasoningEffort.lite', 'Lite');
			case 'none':
				return localize('vsclone.composer.reasoningEffort.none', 'None');
		}
	}

	private getLatestTurn(
		threadId?: string,
	): IVSCloneChatHistoryTurn | undefined {
		const candidateThreadId =
			threadId ?? this.activeThreadId ?? this.rail.getSelectedThread();
		if (!candidateThreadId) {
			return undefined;
		}
		const turns = this.historyService.getTurns(candidateThreadId);
		return turns.at(-1);
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
		this.refreshPlanModeControl();
		this.refreshModelControls();
		this.refreshConversation();
		this.railVisible = false;
		this.applyRailLayout();
		this.focusInput();
	}
}
