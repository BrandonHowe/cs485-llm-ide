/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VSCloneReasoningEffortLevel } from './vscloneModelCapabilities.js';
import type { VSCloneModelVendor } from './vscloneOAuthTypes.js';

/**
 * VSClone currently routes all sends through the main chat composer, but the location stays part
 * of the contract so persisted selections do not have to change shape when additional entry points
 * start sharing the same backend snapshot.
 */
export type IVSCloneChatLocation = 'chat' | 'editorInline' | 'notebook' | 'terminal';

/**
 * A normalized model selection is the persistence contract between the picker UI, execution path,
 * and the unified backend. Persisting this exact shape keeps restore behavior deterministic.
 */
export interface IVSCloneModelSelection {
	threadId?: string;
	location: IVSCloneChatLocation;
	modelIdentifier: string;
	vendor: VSCloneModelVendor;
	modelId: string;
	modelName: string;
	reasoningEffort?: VSCloneReasoningEffortLevel;
	/**
	 * Mirrors Void's `ModelSelectionOptions.reasoningEnabled`. Persisted on the selection so the
	 * toggle shown next to the model picker survives reloads. Only meaningful for models whose
	 * capability metadata sets `canTurnOffReasoning: true`.
	 */
	reasoningEnabled?: boolean;
	/**
	 * Mirrors Void's `ModelSelectionOptions.reasoningBudget`. Persisted alongside `reasoningEffort`
	 * so any future budget-slider provider can remember the chosen token budget. Current Anthropic
	 * and Gemini chat selections use presets instead of this raw value.
	 */
	reasoningBudget?: number;
	selectedAt: number;
}

/**
 * Thread-bound selections stay location-scoped so a future chat thread can retain distinct chat,
 * inline, notebook, and terminal picks without overwriting the previously persisted entry.
 */
export type IVSCloneThreadSelectionMap = Partial<Record<IVSCloneChatLocation, IVSCloneModelSelection>>;

export interface IVSCloneModelSelectionChangeEvent {
	threadId?: string;
	previous: IVSCloneModelSelection | undefined;
	current: IVSCloneModelSelection | undefined;
	reason: 'user' | 'restore' | 'fallback' | 'reset';
}

/**
 * The backend keeps the full selection state together so thread-scoped restores and location
 * defaults cannot drift apart in memory or on disk.
 */
export interface IVSCloneUnifiedChatSelectionState {
	selectedByThread: Record<string, IVSCloneThreadSelectionMap>;
	selectedByLocation: Partial<Record<IVSCloneChatLocation, IVSCloneModelSelection>>;
	recentModelIdentifiers: readonly string[];
}

export const allVSCloneChatLocations: readonly IVSCloneChatLocation[] = ['chat', 'editorInline', 'notebook', 'terminal'];

export function normalizeVSCloneThreadId(threadId: string): string | undefined {
	const normalized = threadId.trim();
	return normalized.length > 0 ? normalized : undefined;
}
