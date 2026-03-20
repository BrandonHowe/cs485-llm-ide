/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVSCloneChatHistoryThread } from '../common/backend/vscloneChatHistoryService.js';

export interface IVSCloneChatHistoryRailRow {
	threadId: string;
	title: string;
	preview: string;
	updatedLabel: string;
	archived: boolean;
	turnCount: number;
	status: IVSCloneChatHistoryThread['status'];
	selected: boolean;
}

export function toVSCloneRailRows(
	threads: readonly IVSCloneChatHistoryThread[],
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
