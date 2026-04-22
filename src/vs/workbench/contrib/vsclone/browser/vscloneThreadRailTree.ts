/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VSCloneThreadStreamState } from '../common/vscloneThreadRuntimeTypes.js';

export type VSCloneThreadStreamStateKind = VSCloneThreadStreamState['kind'];

/**
 * The rail only needs presentation metadata, so it accepts any runtime catalog entry that can
 * answer these fields. `streamStateKind` is undefined when the thread has no active stream
 * so the rail mirrors Void's behavior of showing a spinner only for threads that are actually
 * running (including the `idle` step of an active stream).
 */
export interface IVSCloneThreadCatalogEntry {
	threadId: string;
	title: string;
	updatedAt: number;
	streamStateKind: VSCloneThreadStreamStateKind | undefined;
}

export interface IVSCloneThreadRailRow {
	threadId: string;
	title: string;
	updatedLabel: string;
	streamStateKind: VSCloneThreadStreamStateKind | undefined;
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
		updatedLabel: formatRelativeTime(thread.updatedAt),
		streamStateKind: thread.streamStateKind,
		selected: thread.threadId === selectedThreadId,
	}));
}
