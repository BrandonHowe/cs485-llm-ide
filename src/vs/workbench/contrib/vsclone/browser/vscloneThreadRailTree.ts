/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VSCloneThreadRuntimeCatalogStatus } from '../common/vscloneThreadRuntimeTypes.js';

/**
 * The rail only needs presentation metadata, so it accepts any runtime catalog entry that can
 * answer these fields.
 */
export interface IVSCloneThreadCatalogEntry {
	threadId: string;
	title: string;
	lastTurnPreview: string;
	updatedAt: number;
	archived: boolean;
	turnCount: number;
	status: VSCloneThreadRuntimeCatalogStatus;
}

export interface IVSCloneThreadRailRow {
	threadId: string;
	title: string;
	preview: string;
	updatedLabel: string;
	archived: boolean;
	turnCount: number;
	status: VSCloneThreadRuntimeCatalogStatus;
	selected: boolean;
}

export function toVSCloneThreadRailRows(
	threads: readonly IVSCloneThreadCatalogEntry[],
	selectedThreadId: string | undefined,
	formatRelativeTime: (timestamp: number) => string,
): readonly IVSCloneThreadRailRow[] {
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
