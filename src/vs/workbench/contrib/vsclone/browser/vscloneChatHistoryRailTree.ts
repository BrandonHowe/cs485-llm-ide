/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VSCloneChatThreadStatus } from '../common/vscloneChatHistoryTypes.js';

/**
 * The rail only needs presentation metadata, so it accepts any runtime/history-backed catalog
 * entry that can answer these fields instead of tying the renderer to the legacy history model.
 */
export interface IVSCloneThreadCatalogEntry {
	threadId: string;
	title: string;
	lastTurnPreview: string;
	updatedAt: number;
	archived: boolean;
	turnCount: number;
	status: VSCloneChatThreadStatus;
}

export interface IVSCloneChatHistoryRailRow {
	threadId: string;
	title: string;
	preview: string;
	updatedLabel: string;
	archived: boolean;
	turnCount: number;
	status: VSCloneChatThreadStatus;
	selected: boolean;
}

export function toVSCloneRailRows(
	threads: readonly IVSCloneThreadCatalogEntry[],
	selectedThreadId: string | undefined,
	formatRelativeTime: (timestamp: number) => string,
): readonly IVSCloneChatHistoryRailRow[] {
	return threads.map(thread => ({
		threadId: thread.threadId,
		title: thread.title,
		preview: thread.lastTurnPreview,
		updatedLabel: formatRelativeTime(thread.updatedAt),
		archived: thread.archived,
		turnCount: thread.turnCount,
		status: thread.status,
		selected: thread.threadId === selectedThreadId,
	}));
}
