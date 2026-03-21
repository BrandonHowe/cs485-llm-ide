/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chat mode stays deliberately small because it is persisted into thread metadata and each turn.
 * Keeping the contract as a string union avoids migration work when restoring older snapshots.
 */
export type VSCloneChatMode = 'act' | 'plan';

/**
 * Thread-scoped mode persistence is kept alongside the unified chat snapshot so reopening an
 * existing thread restores the same Plan/Act state that was active when the user last used it.
 */
export interface IVSCloneUnifiedChatPlanModeState {
	modeByThread: Record<string, VSCloneChatMode>;
}

export function isVSCloneChatMode(value: unknown): value is VSCloneChatMode {
	return value === 'act' || value === 'plan';
}

