/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fromNow } from '../../../../base/common/date.js';
import { hash } from '../../../../base/common/hash.js';
import type { IVSCloneChatHistoryQuery, IVSCloneChatHistorySnapshot, IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn } from './vscloneChatHistoryService.js';

export function deriveThreadId(sessionResource: string): string {
	// Use a stable hash of the session resource so VSClone IDs stay deterministic without native chat URI helpers.
	return `thread-${Math.abs(hash(sessionResource)).toString(16)}`;
}

export class VSCloneChatHistoryModel {
	private readonly threads = new Map<string, IVSCloneChatHistoryThread>();
	private readonly turnsByThreadId = new Map<string, readonly IVSCloneChatHistoryTurn[]>();
	private readonly threadIdsBySessionResource = new Map<string, string>();
	private readonly searchTextByThreadId = new Map<string, string>();

	initialize(snapshot: IVSCloneChatHistorySnapshot): void {
		this.threads.clear();
		this.turnsByThreadId.clear();
		this.threadIdsBySessionResource.clear();
		this.searchTextByThreadId.clear();

		for (const thread of snapshot.threads) {
			const turns = snapshot.turnsByThreadId[thread.threadId] ?? [];
			this.threads.set(thread.threadId, thread);
			this.threadIdsBySessionResource.set(thread.sessionResource, thread.threadId);
			this.turnsByThreadId.set(thread.threadId, turns);
			this.updateSearchText(thread, turns);
		}
	}

	toSnapshot(updatedAt: number): IVSCloneChatHistorySnapshot {
		const threads = [...this.threads.values()].sort((a, b) => {
			if (a.updatedAt === b.updatedAt) {
				return a.threadId.localeCompare(b.threadId);
			}
			return b.updatedAt - a.updatedAt;
		});

		const turnsByThreadId: Record<string, readonly IVSCloneChatHistoryTurn[]> = {};
		for (const [threadId, turns] of this.turnsByThreadId) {
			turnsByThreadId[threadId] = turns;
		}

		return {
			updatedAt,
			threads,
			turnsByThreadId,
		};
	}

	getThread(threadId: string): IVSCloneChatHistoryThread | undefined {
		return this.threads.get(threadId);
	}

	getThreadBySessionResource(sessionResource: string): IVSCloneChatHistoryThread | undefined {
		const threadId = this.threadIdsBySessionResource.get(sessionResource);
		if (!threadId) {
			return undefined;
		}
		return this.threads.get(threadId);
	}

	getThreadState(threadId: string): { thread: IVSCloneChatHistoryThread | undefined; turns: readonly IVSCloneChatHistoryTurn[] | undefined } {
		return {
			thread: this.threads.get(threadId),
			turns: this.turnsByThreadId.get(threadId),
		};
	}

	getThreadIdBySessionResource(sessionResource: string): string | undefined {
		return this.threadIdsBySessionResource.get(sessionResource);
	}

	setThreadState(thread: IVSCloneChatHistoryThread, turns: readonly IVSCloneChatHistoryTurn[]): void {
		this.threads.set(thread.threadId, thread);
		this.turnsByThreadId.set(thread.threadId, turns);
		this.threadIdsBySessionResource.set(thread.sessionResource, thread.threadId);
		this.updateSearchText(thread, turns);
	}

	archiveThread(threadId: string, archived: boolean): IVSCloneChatHistoryThread | undefined {
		const current = this.threads.get(threadId);
		if (!current) {
			return undefined;
		}

		const nextThread: IVSCloneChatHistoryThread = {
			...current,
			archived,
			status: archived ? 'archived' : 'active',
			updatedAt: Date.now(),
		};
		this.threads.set(threadId, nextThread);
		return nextThread;
	}

	deleteThread(threadId: string): IVSCloneChatHistoryThread | undefined {
		const thread = this.threads.get(threadId);
		if (!thread) {
			return undefined;
		}

		this.threads.delete(threadId);
		this.turnsByThreadId.delete(threadId);
		this.threadIdsBySessionResource.delete(thread.sessionResource);
		this.searchTextByThreadId.delete(threadId);
		return thread;
	}

	clear(): void {
		this.threads.clear();
		this.turnsByThreadId.clear();
		this.threadIdsBySessionResource.clear();
		this.searchTextByThreadId.clear();
	}

	getTurns(threadId: string): readonly IVSCloneChatHistoryTurn[] {
		return this.turnsByThreadId.get(threadId) ?? [];
	}

	getThreads(query: IVSCloneChatHistoryQuery = {}): readonly IVSCloneChatHistoryThread[] {
		let threads = [...this.threads.values()].sort((a, b) => {
			if (a.updatedAt === b.updatedAt) {
				return a.threadId.localeCompare(b.threadId);
			}
			return b.updatedAt - a.updatedAt;
		});

		switch (query.tab) {
			case 'archived':
				threads = threads.filter(thread => thread.archived);
				break;
			case 'active':
				threads = threads.filter(thread => !thread.archived && thread.status === 'active');
				break;
			case 'all':
				break;
			default:
				if (!query.includeArchived) {
					threads = threads.filter(thread => !thread.archived);
				}
				break;
		}

		if (typeof query.fromTimestamp === 'number') {
			threads = threads.filter(thread => thread.updatedAt >= query.fromTimestamp!);
		}

		if (typeof query.toTimestamp === 'number') {
			threads = threads.filter(thread => thread.updatedAt <= query.toTimestamp!);
		}

		if (query.text && query.text.trim().length > 0) {
			const normalized = query.text.trim().toLowerCase();
			threads = threads.filter(thread => {
				const searchText = this.searchTextByThreadId.get(thread.threadId) ?? '';
				return searchText.includes(normalized);
			});
		}

		if (typeof query.limit === 'number' && query.limit >= 0) {
			threads = threads.slice(0, query.limit);
		}

		return threads;
	}

	applyRetention(maxThreads: number, retentionDays: number, now: number): { deletedThreadIds: string[] } {
		const deletedThreadIds: string[] = [];
		const cutoff = now - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;

		for (const [threadId, thread] of this.threads) {
			if (thread.updatedAt < cutoff) {
				deletedThreadIds.push(threadId);
			}
		}

		if (deletedThreadIds.length > 0) {
			for (const threadId of deletedThreadIds) {
				this.deleteThread(threadId);
			}
		}

		const allThreads = [...this.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
		if (allThreads.length > maxThreads) {
			const extras = allThreads.slice(maxThreads);
			for (const extra of extras) {
				if (!deletedThreadIds.includes(extra.threadId)) {
					deletedThreadIds.push(extra.threadId);
				}
				this.deleteThread(extra.threadId);
			}
		}

		return { deletedThreadIds };
	}

	formatRelativeTimestamp(timestamp: number): string {
		return fromNow(timestamp, true);
	}

	private updateSearchText(thread: IVSCloneChatHistoryThread, turns: readonly IVSCloneChatHistoryTurn[]): void {
		const values: string[] = [thread.title, thread.lastTurnPreview];
		for (const turn of turns) {
			values.push(turn.promptText, turn.responsePlainText, turn.responseMarkdown);
		}

		this.searchTextByThreadId.set(thread.threadId, values.join('\n').toLowerCase());
	}
}
