/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVSCloneUnifiedChatSelectionState } from './vscloneModelSelectionTypes.js';
import type { IVSCloneUnifiedChatPlanModeState, VSCloneChatMode } from './vsclonePlanModeTypes.js';
import type { IVSCloneImageAttachment } from './vscloneImageAttachmentTypes.js';

export type VSCloneChatHistoryScope = 'workspace' | 'profile';

export type VSCloneChatThreadStatus = 'active' | 'completed' | 'failed' | 'archived';
export type VSCloneChatTurnStatus = 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';

export interface IVSCloneChatHistoryThread {
	threadId: string;
	sessionResource: string;
	title: string;
	activeModelIdentifier?: string;
	createdAt: number;
	updatedAt: number;
	status: VSCloneChatThreadStatus;
	archived: boolean;
	turnCount: number;
	lastTurnPreview: string;
}

export interface IVSCloneChatHistoryTurn {
	turnId: string;
	threadId: string;
	sequence: number;
	executionMode?: VSCloneChatMode;
	modelIdentifier?: string;
	providerId?: string;
	promptText: string;
	promptImages?: readonly IVSCloneImageAttachment[];
	responseMarkdown: string;
	responsePlainText: string;
	startedAt: number;
	completedAt?: number;
	status: VSCloneChatTurnStatus;
	errorCode?: string;
	lastEventAt?: number;
	// Persist the last applied wire-event fingerprint so replayed stream chunks with the same
	// timestamp can be ignored without dropping distinct chunks that happened within one millisecond.
	lastEventFingerprint?: string;
}

/**
 * The snapshot now carries both turn history and persisted model-selection state so thread restore
 * and send execution read from the same durable source of truth.
 */
export interface IVSCloneChatHistorySnapshot extends IVSCloneUnifiedChatSelectionState, IVSCloneUnifiedChatPlanModeState {
	updatedAt: number;
	threads: readonly IVSCloneChatHistoryThread[];
	turnsByThreadId: Record<string, readonly IVSCloneChatHistoryTurn[]>;
}

export type VSCloneChatHistoryTab = 'all' | 'active' | 'archived';

export interface IVSCloneChatHistoryQuery {
	text?: string;
	tab?: VSCloneChatHistoryTab;
	includeArchived?: boolean;
	fromTimestamp?: number;
	toTimestamp?: number;
	limit?: number;
}

export type VSCloneChatTurnPhase = 'prompt' | 'stream' | 'complete' | 'error' | 'cancel';

export interface IVSCloneChatTurnUpdate {
	threadId: string;
	turnId: string;
	sequence: number;
	sessionResource: string;
	phase: VSCloneChatTurnPhase;
	occurredAt: number;
	promptText?: string;
	threadTitle?: string;
	executionMode?: VSCloneChatMode;
	modelIdentifier?: string;
	providerId?: string;
	promptImages?: readonly IVSCloneImageAttachment[];
	responseMarkdownDelta?: string;
	responsePlainTextDelta?: string;
	responseMarkdownReplace?: string;
	responsePlainTextReplace?: string;
	errorCode?: string;
}

export interface IVSCloneChatHistoryChangeEvent {
	reason: 'initialize' | 'turnUpdate' | 'archive' | 'delete' | 'clear' | 'error';
	scope: VSCloneChatHistoryScope;
	threadIds: readonly string[];
	error?: Error;
}
