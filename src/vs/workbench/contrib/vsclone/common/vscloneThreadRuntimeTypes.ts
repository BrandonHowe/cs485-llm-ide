/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import type { IVSCloneApiConversationMessage } from './vscloneChatApiAdapters.js';
import type { IVSCloneImageAttachment } from './vscloneImageAttachmentTypes.js';
import type { VSCloneReasoningEffortLevel } from './vscloneModelCatalogService.js';
import type { VSCloneModelVendor } from './vscloneOAuthTypes.js';
import type { VSCloneChatMode } from './vsclonePlanModeTypes.js';
import type { VSCloneToolApprovalType } from './vscloneToolRuntimeTypes.js';

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
	| { readonly kind: 'rejected'; readonly reason?: string };

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
 * Assistant edit application now lives in runtime state instead of a pane-local storage blob.
 * The runtime owns branch truncation and reload normalization, so the apply summary has to use
 * URI-based data that survives serialization and can be pruned when its assistant message drops
 * off the active branch.
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
	readonly systemMessage?: string;
	readonly imageAttachments?: readonly IVSCloneImageAttachment[];
}

export interface IVSCloneThreadRuntimePausedApproval {
	readonly requestedAt: number;
	readonly toolName: string;
	readonly params: Record<string, string>;
	readonly approvalType?: VSCloneToolApprovalType;
	readonly snapshots: readonly IVSCloneThreadRuntimeSnapshot[];
	readonly run: IVSCloneThreadRuntimeRunContext;
}

export type VSCloneThreadToolMessageType =
	| 'tool_request'
	| 'running_now'
	| 'success'
	| 'tool_error'
	| 'rejected';

/**
 * History hydration is now an explicit one-time import into runtime state. Persisting that
 * provenance on each imported conversation message lets restored runtime threads keep the same
 * semantics without consulting legacy history again after reload.
 */
export interface IVSCloneThreadRuntimeConversationMessageMetadata {
	readonly importedFromHistory?: boolean;
}

export type IVSCloneThreadRuntimeMessage =
	| {
		readonly id: string;
		readonly role: 'user';
		readonly mode: VSCloneChatMode;
		readonly metadata?: IVSCloneThreadRuntimeConversationMessageMetadata;
		readonly createdAt: number;
		readonly content: string;
		readonly imageAttachments?: readonly IVSCloneImageAttachment[];
	}
	| {
		readonly id: string;
		readonly role: 'assistant';
		readonly mode: VSCloneChatMode;
		readonly metadata?: IVSCloneThreadRuntimeConversationMessageMetadata;
		readonly createdAt: number;
		readonly content: string;
	}
	| {
		readonly id: string;
		readonly role: 'tool';
		readonly createdAt: number;
		readonly type: VSCloneThreadToolMessageType;
		readonly toolName: string;
		readonly approvalType?: VSCloneToolApprovalType;
		readonly params: Record<string, string>;
		readonly output?: string;
		readonly success?: boolean;
	}
	| {
		readonly id: string;
		readonly role: 'checkpoint';
		readonly createdAt: number;
		readonly checkpoint: IVSCloneThreadRuntimeCheckpoint;
	};

export interface IVSCloneThreadRuntimeState {
	readonly threadId: string;
	readonly turnId?: string;
	readonly mode?: VSCloneChatMode;
	readonly streamState: VSCloneThreadStreamState;
	readonly messages: readonly IVSCloneThreadRuntimeMessage[];
	readonly assistantEditApplications?: readonly IVSCloneThreadRuntimeAssistantEditApplication[];
	readonly checkpoints: readonly IVSCloneThreadRuntimeCheckpoint[];
	readonly currentCheckpointId?: string;
	readonly branchHeadMessageId?: string;
	readonly pausedApproval?: IVSCloneThreadRuntimePausedApproval;
	readonly isRunning: boolean;
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
	readonly previousTurns?: readonly IVSCloneApiConversationMessage[];
	readonly systemMessage?: string;
	readonly imageAttachments?: readonly IVSCloneImageAttachment[];
	readonly recordPromptMessage?: boolean;
}
