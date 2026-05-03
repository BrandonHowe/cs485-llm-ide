/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import type { IVSCloneChatTransportConversationMessage } from './vscloneChatTransportTypes.js';
import type { IVSCloneContextSelection } from './vscloneContextSelectionTypes.js';
import type { IVSCloneImageAttachment } from './vscloneImageAttachmentTypes.js';
import type { IVSCloneLLMMessageReasoningBlock, IVSCloneTokenUsage } from './vscloneLLMMessageTypes.js';
import type { VSCloneReasoningEffortLevel } from './vscloneModelCapabilities.js';
import type { VSCloneModelVendor } from './vscloneOAuthTypes.js';
import type { VSCloneChatMode } from './vsclonePlanModeTypes.js';
import type { IVSCloneToolDefinition, VSCloneToolApprovalType } from './vscloneToolDefinitions.js';

export type VSCloneThreadRuntimeCatalogStatus = 'active' | 'completed' | 'failed' | 'archived';
export type VSCloneThreadRuntimeCatalogTab = 'all' | 'active' | 'archived';

/**
 * Rail-facing metadata for a runtime thread. The runtime catalog is stored alongside the thread
 * state so archive/delete/clear operate on a single source of truth instead of cross-syncing a
 * separate thread registry.
 */
export interface IVSCloneThreadRuntimeCatalogEntry {
	readonly threadId: string;
	/**
	 * A thread created before the session resource became part of the catalog may persist without
	 * one. Keep that unknown state explicit so thread reuse code never treats a missing value as
	 * authoritative.
	 */
	readonly sessionResource?: string;
	readonly title: string;
	readonly activeModelIdentifier?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly status: VSCloneThreadRuntimeCatalogStatus;
	readonly archived: boolean;
	readonly turnCount: number;
	readonly lastTurnPreview: string;
}

export interface IVSCloneThreadRuntimeCatalogQuery {
	readonly text?: string;
	readonly tab?: VSCloneThreadRuntimeCatalogTab;
	readonly includeArchived?: boolean;
	readonly limit?: number;
}

export type VSCloneThreadStreamState =
	| { readonly kind: 'idle' }
	| { readonly kind: 'llm' }
	| { readonly kind: 'tool'; readonly toolName: string }
	| { readonly kind: 'awaiting_user'; readonly toolName: string; readonly approvalType?: VSCloneToolApprovalType };

/**
 * Tool approval is modeled as an explicit decision so the runtime can pause on approval-required
 * calls and later resume or reject them without inventing another transport path.
 */
export type VSCloneThreadToolApprovalDecision =
	| { readonly kind: 'approved' }
	| { readonly kind: 'rejected'; readonly reason?: string }
	| { readonly kind: 'answered'; readonly output: string };

/**
 * Checkpoints deliberately store full pre-edit file contents and directory existence because
 * VSClone does not yet have Void's more granular edit-zone history model. That keeps rewind
 * reliable while the rest of the workflow core is being replaced.
 */
export interface IVSCloneThreadRuntimeSnapshot {
	readonly uri: URI;
	readonly existed: boolean;
	readonly content: string | undefined;
	readonly isDirectory: boolean;
}

export interface IVSCloneThreadRuntimeCheckpoint {
	readonly id: string;
	readonly createdAt: number;
	readonly type: 'tool_edit';
	readonly toolName: string;
	readonly snapshots: readonly IVSCloneThreadRuntimeSnapshot[];
}

/**
 * Assistant edit application lives in runtime state so that branch truncation, reload, and pane
 * rendering see the same durable result. The apply summary uses URI-based data that survives
 * serialization and is pruned automatically when its assistant message drops off the active branch.
 */
export interface IVSCloneThreadRuntimeEditFileChange {
	readonly uri: URI;
	readonly displayPath: string;
	readonly addedLines: number;
	readonly removedLines: number;
	readonly action: 'create' | 'modify';
	readonly originalContent?: string;
}

export interface IVSCloneThreadRuntimeEditApplyResult {
	readonly attemptedEdits: number;
	readonly appliedEdits: number;
	readonly modifiedFiles: readonly URI[];
	readonly failures: readonly string[];
	readonly fileChanges: readonly IVSCloneThreadRuntimeEditFileChange[];
}

/**
 * `pending` means the bridge has started applying edits but has not yet produced a durable
 * result. Reload cannot safely assume those edits completed, so restore normalizes `pending`
 * to `failed` instead of leaving the UI wedged in an in-flight phase forever.
 * `partial` keeps mixed applied+failed outcomes distinct from full success so reload and branch
 * operations do not flatten a partial engine result into a misleading "everything applied" state.
 */
export type IVSCloneThreadRuntimeAssistantEditApplicationState =
	| { readonly phase: 'pending' }
	| { readonly phase: 'failed' }
	| { readonly phase: 'partial'; readonly result: IVSCloneThreadRuntimeEditApplyResult }
	| { readonly phase: 'applied'; readonly result: IVSCloneThreadRuntimeEditApplyResult }
	| { readonly phase: 'undone'; readonly result: IVSCloneThreadRuntimeEditApplyResult };

export interface IVSCloneThreadRuntimeAssistantEditApplication {
	readonly messageId: string;
	readonly state: IVSCloneThreadRuntimeAssistantEditApplicationState;
}

export type VSCloneThreadRuntimeAssistantEditSuggestionApplyMode = 'manual' | 'auto';

/**
 * Assistant edit suggestions stay inline in assistant prose for now, but the decision that a
 * message is applicable must live in runtime state so reload, rewind, and pane rendering all see
 * the same durable answer without re-parsing visible transcript text in the UI layer.
 */
export interface IVSCloneThreadRuntimeAssistantEditSuggestion {
	readonly kind: 'search_replace';
	readonly applyMode: VSCloneThreadRuntimeAssistantEditSuggestionApplyMode;
}

/**
 * The pane ultimately needs both "is this assistant message applicable?" and "what apply state
 * is it currently in?" keyed by the same runtime-owned message id. Bundling those fields into one
 * contract lets UI consumers stop inferring applicability from transcript text or hand-joining it
 * with the separate durable application-state list.
 */
export interface IVSCloneThreadRuntimeAssistantEditStatus {
	readonly messageId: string;
	readonly suggestion: IVSCloneThreadRuntimeAssistantEditSuggestion;
	readonly application?: IVSCloneThreadRuntimeAssistantEditApplicationState;
}

/**
 * Paused approvals must carry enough execution metadata to continue the active branch after a
 * reload. The persisted runtime already owns the message stream, so the run context only stores
 * the provider/model/session details needed to resume the loop from the current branch head.
 */
export interface IVSCloneThreadRuntimeRunContext {
	readonly turnId: string;
	readonly sequence: number;
	readonly sessionResource: string;
	readonly mode: VSCloneChatMode;
	readonly vendor: VSCloneModelVendor;
	readonly modelId: string;
	readonly modelIdentifier: string;
	readonly reasoningEffort?: VSCloneReasoningEffortLevel;
	readonly reasoningEnabled?: boolean;
	readonly reasoningBudget?: number;
	readonly systemMessage?: string;
	readonly toolDefinitions?: readonly IVSCloneToolDefinition[];
	readonly imageAttachments?: readonly IVSCloneImageAttachment[];
	readonly contextSelections?: readonly IVSCloneContextSelection[];
}

export type VSCloneThreadToolMessageType =
	| 'tool_request'
	| 'running_now'
	| 'success'
	| 'tool_error'
	| 'rejected';

/**
 * Assistant edit applicability is persisted alongside the message so the pane can render/apply
 * from runtime-owned metadata instead of inferring eligibility from rendered transcript text.
 */
export interface IVSCloneThreadRuntimeConversationMessageMetadata {
	readonly editSuggestion?: IVSCloneThreadRuntimeAssistantEditSuggestion;
}

/**
 * Approval-required tools now persist their resumable execution payload directly on the
 * `tool_request` message instead of duplicating that state in a parallel `pausedApproval` field.
 * That keeps restore/resume anchored to the message stream, which is the only canonical runtime
 * transcript after the Void-shaped loop port.
 */
export interface IVSCloneThreadRuntimeToolRequestMessage {
	readonly id: string;
	readonly role: 'tool';
	readonly createdAt: number;
	readonly type: 'tool_request';
	readonly toolName: string;
	readonly approvalType?: VSCloneToolApprovalType;
	readonly params: Record<string, string>;
	readonly requestedAt: number;
	readonly snapshots: readonly IVSCloneThreadRuntimeSnapshot[];
	readonly run: IVSCloneThreadRuntimeRunContext;
}

export interface IVSCloneThreadRuntimeToolProgressMessage {
	readonly id: string;
	readonly role: 'tool';
	readonly createdAt: number;
	readonly type: 'running_now';
	readonly toolName: string;
	readonly approvalType?: VSCloneToolApprovalType;
	readonly params: Record<string, string>;
}

export interface IVSCloneThreadRuntimeToolResultMessage {
	readonly id: string;
	readonly role: 'tool';
	readonly createdAt: number;
	readonly type: Exclude<VSCloneThreadToolMessageType, 'tool_request' | 'running_now'>;
	readonly toolName: string;
	readonly approvalType?: VSCloneToolApprovalType;
	readonly params: Record<string, string>;
	readonly output?: string;
	readonly success?: boolean;
}

export type IVSCloneThreadRuntimeMessage =
	| {
		readonly id: string;
		readonly role: 'user';
		readonly mode: VSCloneChatMode;
		readonly createdAt: number;
		readonly content: string;
		readonly imageAttachments?: readonly IVSCloneImageAttachment[];
		readonly contextSelections?: readonly IVSCloneContextSelection[];
	}
	| {
		readonly id: string;
		readonly role: 'assistant';
		readonly mode: VSCloneChatMode;
		readonly metadata?: IVSCloneThreadRuntimeConversationMessageMetadata;
		readonly createdAt: number;
		readonly content: string;
		/**
		 * Mirrors Void's `reasoning: string` on the assistant chat turn. Persisted so reload can
		 * restore the collapsible "Thinking..." section without rerunning the model, and so that
		 * `fullReasoning` deltas from the LLM transport survive the runtime-owned message stream.
		 */
		readonly reasoning?: string;
		/**
		 * Mirrors Void's `anthropicReasoning: AnthropicReasoning[] | null`. These blocks carry the
		 * server-issued `signature` string and must be replayed verbatim when the assistant turn is
		 * sent back to Anthropic on a subsequent tool-chain iteration. Keep the field optional so
		 * existing persisted turns without reasoning deserialize cleanly.
		 */
		readonly anthropicReasoning?: readonly IVSCloneLLMMessageReasoningBlock[] | null;
		/**
		 * Google-specific function-call thought signature. Stored on the assistant turn because the
		 * following tool result replays that assistant turn as a Gemini model functionCall part.
		 */
		readonly googleThoughtSignature?: string;
		/**
		 * Wall-clock timestamps (ms since epoch) bracketing the reasoning stream.
		 * `reasoningStartedAt` is set on the first reasoning delta; `reasoningEndedAt` is updated on
		 * every subsequent delta, so the difference is the model's thinking duration. Both are
		 * optional so persisted turns from before this field shipped deserialize cleanly -- the
		 * renderer falls back to a heuristic qualifier when they're absent.
		 */
		readonly reasoningStartedAt?: number;
		readonly reasoningEndedAt?: number;
	}
	| IVSCloneThreadRuntimeToolRequestMessage
	| IVSCloneThreadRuntimeToolProgressMessage
	| IVSCloneThreadRuntimeToolResultMessage
	| {
		readonly id: string;
		readonly role: 'checkpoint';
		readonly createdAt: number;
		readonly checkpoint: IVSCloneThreadRuntimeCheckpoint;
	};

export interface IVSCloneThreadRuntimeState {
	readonly threadId: string;
	readonly catalog: IVSCloneThreadRuntimeCatalogEntry;
	readonly turnId?: string;
	readonly mode?: VSCloneChatMode;
	readonly streamState: VSCloneThreadStreamState;
	readonly messages: readonly IVSCloneThreadRuntimeMessage[];
	/**
	 * Latest runtime-owned context usage for the active branch. Provider usage is recorded only after
	 * a completed request because those SDK counters describe what was actually accepted/generated;
	 * composer preflight estimates stay local to the UI and are intentionally not persisted here.
	 */
	readonly tokenUsage?: IVSCloneTokenUsage;
	readonly assistantEditApplications?: readonly IVSCloneThreadRuntimeAssistantEditApplication[];
	readonly checkpoints: readonly IVSCloneThreadRuntimeCheckpoint[];
	readonly currentCheckpointId?: string;
	readonly branchHeadMessageId?: string;
	readonly lastUpdatedAt: number;
}

export interface IVSCloneThreadRuntimeRunOptions {
	readonly threadId: string;
	readonly turnId: string;
	readonly sequence: number;
	readonly sessionResource: string;
	readonly promptText: string;
	readonly mode: VSCloneChatMode;
	readonly vendor: VSCloneModelVendor;
	readonly modelId: string;
	readonly modelIdentifier: string;
	readonly reasoningEffort?: VSCloneReasoningEffortLevel;
	/**
	 * Mirrors Void's `ModelSelectionOptions.reasoningEnabled`. Forwarded to the main-process prepared
	 * payload so the provider adapter can honor the user's explicit on/off toggle even when the model
	 * defaults to reasoning-on.
	 */
	readonly reasoningEnabled?: boolean;
	/**
	 * Mirrors Void's `ModelSelectionOptions.reasoningBudget` for raw budget-slider providers. Built-in
	 * Anthropic and Gemini models use preset selections, so normal chat runs should not need it.
	 */
	readonly reasoningBudget?: number;
	readonly previousTurns?: readonly IVSCloneChatTransportConversationMessage[];
	readonly systemMessage?: string;
	readonly toolDefinitions?: readonly IVSCloneToolDefinition[];
	readonly imageAttachments?: readonly IVSCloneImageAttachment[];
	/**
	 * Raw selection metadata for display. The `promptText` sent to the LLM has already been enriched
	 * with serialized file/folder/selection contents before reaching the runtime, so these are only
	 * kept to re-render context chips in the transcript.
	 */
	readonly contextSelections?: readonly IVSCloneContextSelection[];
	readonly recordPromptMessage?: boolean;
}
