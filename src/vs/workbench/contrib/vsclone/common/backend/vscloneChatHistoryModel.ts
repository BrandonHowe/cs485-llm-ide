/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { fromNow } from '../../../../../base/common/date.js';
import { hash } from '../../../../../base/common/hash.js';
import type { IVSCloneChatHistoryQuery, IVSCloneChatHistorySnapshot, IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn } from '../vscloneChatHistoryTypes.js';
import { allVSCloneChatLocations, type IVSCloneChatLocation, type IVSCloneModelSelection, type IVSCloneUnifiedChatSelectionState } from '../vscloneModelSelectionTypes.js';
import { type IVSCloneUnifiedChatPlanModeState, isVSCloneChatMode, type VSCloneChatMode } from '../vsclonePlanModeTypes.js';

export function deriveThreadId(sessionResource: string): string {
	// Use a stable hash of the session resource so VSClone IDs stay deterministic without native chat URI helpers.
	return `thread-${Math.abs(hash(sessionResource)).toString(16)}`;
}

export class VSCloneChatHistoryModel {
	private readonly threads = new Map<string, IVSCloneChatHistoryThread>();
	private readonly turnsByThreadId = new Map<string, readonly IVSCloneChatHistoryTurn[]>();
	private readonly threadIdsBySessionResource = new Map<string, string>();
	private readonly searchTextByThreadId = new Map<string, string>();
	private readonly modeByThread = new Map<string, VSCloneChatMode>();
	private readonly selectedByThread = new Map<string, IVSCloneModelSelection>();
	private readonly selectedByLocation = new Map<IVSCloneChatLocation, IVSCloneModelSelection>();
	private recentModelIdentifiers: string[] = [];
	// Set during `initialize` whenever the loaded snapshot contained streaming/pending turns from a
	// previous session that we rewrote to `failed`. The unified backend reads this to know whether
	// it should persist the recovered state immediately so subsequent restarts skip the rewrite.
	private _recoveredInterruptedTurns = false;

	get hasRecoveredInterruptedTurns(): boolean {
		return this._recoveredInterruptedTurns;
	}

	initialize(snapshot: IVSCloneChatHistorySnapshot): void {
		this.threads.clear();
		this.turnsByThreadId.clear();
		this.threadIdsBySessionResource.clear();
		this.searchTextByThreadId.clear();
		this.modeByThread.clear();
		this.selectedByThread.clear();
		this.selectedByLocation.clear();
		this.recentModelIdentifiers = [...snapshot.recentModelIdentifiers];
		this._recoveredInterruptedTurns = false;

		const recoveryTimestamp = Date.now();
		for (const thread of snapshot.threads) {
			const rawTurns = snapshot.turnsByThreadId[thread.threadId] ?? [];
			// Any turn still marked streaming/pending in the snapshot belonged to a previous process
			// that did not finish; its agent loop is gone, so we mark it failed instead of leaving
			// the UI showing a permanently spinning tool card.
			const turns = recoverInterruptedTurns(rawTurns, recoveryTimestamp);
			if (turns !== rawTurns) {
				this._recoveredInterruptedTurns = true;
			}
			this.threads.set(thread.threadId, thread);
			this.threadIdsBySessionResource.set(thread.sessionResource, thread.threadId);
			this.turnsByThreadId.set(thread.threadId, turns);
			this.updateSearchText(thread, turns);
		}

		for (const [threadId, mode] of Object.entries(snapshot.modeByThread)) {
			if (isVSCloneChatMode(mode)) {
				this.modeByThread.set(threadId, mode);
			}
		}

		for (const [threadId, selection] of Object.entries(snapshot.selectedByThread)) {
			this.selectedByThread.set(threadId, { ...selection, threadId: undefined });
		}

		for (const location of allVSCloneChatLocations) {
			const selection = snapshot.selectedByLocation[location];
			if (!selection) {
				continue;
			}
			this.selectedByLocation.set(location, { ...selection, threadId: undefined });
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

		const modeByThread: Record<string, VSCloneChatMode> = {};
		for (const [threadId, mode] of this.modeByThread) {
			modeByThread[threadId] = mode;
		}

		const selectedByThread: Record<string, IVSCloneModelSelection> = {};
		for (const [threadId, selection] of this.selectedByThread) {
			selectedByThread[threadId] = { ...selection, threadId: undefined };
		}

		const selectedByLocation: Partial<Record<IVSCloneChatLocation, IVSCloneModelSelection>> = {};
		for (const [location, selection] of this.selectedByLocation) {
			selectedByLocation[location] = { ...selection, threadId: undefined };
		}

		return {
			updatedAt,
			threads,
			turnsByThreadId,
			modeByThread,
			selectedByThread,
			selectedByLocation,
			recentModelIdentifiers: [...this.recentModelIdentifiers],
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
		this.modeByThread.delete(threadId);
		this.selectedByThread.delete(threadId);
		return thread;
	}

	clear(): void {
		this.threads.clear();
		this.turnsByThreadId.clear();
		this.threadIdsBySessionResource.clear();
		this.searchTextByThreadId.clear();
		this.modeByThread.clear();
		this.selectedByThread.clear();
		this.selectedByLocation.clear();
		this.recentModelIdentifiers = [];
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

	getSelectionState(): IVSCloneUnifiedChatSelectionState {
		const selectedByThread: Record<string, IVSCloneModelSelection> = {};
		for (const [threadId, selection] of this.selectedByThread) {
			selectedByThread[threadId] = { ...selection, threadId: undefined };
		}

		const selectedByLocation: Partial<Record<IVSCloneChatLocation, IVSCloneModelSelection>> = {};
		for (const [location, selection] of this.selectedByLocation) {
			selectedByLocation[location] = { ...selection, threadId: undefined };
		}

		return {
			selectedByThread,
			selectedByLocation,
			recentModelIdentifiers: [...this.recentModelIdentifiers],
		};
	}

	getPlanModeState(): IVSCloneUnifiedChatPlanModeState {
		const modeByThread: Record<string, VSCloneChatMode> = {};
		for (const [threadId, mode] of this.modeByThread) {
			modeByThread[threadId] = mode;
		}

		return { modeByThread };
	}

	/**
	 * Thread mode is replaced atomically for the same reason as model selection: persisted composer
	 * defaults should not drift away from the exact thread ids restored from the backend snapshot.
	 */
	replacePlanModeState(state: IVSCloneUnifiedChatPlanModeState): void {
		this.modeByThread.clear();
		for (const [threadId, mode] of Object.entries(state.modeByThread)) {
			if (isVSCloneChatMode(mode)) {
				this.modeByThread.set(threadId, mode);
			}
		}
	}

	/**
	 * Replacing the full selection state in one shot keeps catalog reconciliation atomic. Without
	 * this, a provider refresh could persist partially-updated defaults and thread bindings.
	 */
	replaceSelectionState(state: IVSCloneUnifiedChatSelectionState): void {
		this.selectedByThread.clear();
		this.selectedByLocation.clear();
		this.recentModelIdentifiers = [...state.recentModelIdentifiers];

		for (const [threadId, selection] of Object.entries(state.selectedByThread)) {
			this.selectedByThread.set(threadId, { ...selection, threadId: undefined });
		}

		for (const location of allVSCloneChatLocations) {
			const selection = state.selectedByLocation[location];
			if (!selection) {
				continue;
			}
			this.selectedByLocation.set(location, { ...selection, threadId: undefined });
		}
	}

	private updateSearchText(thread: IVSCloneChatHistoryThread, turns: readonly IVSCloneChatHistoryTurn[]): void {
		const values: string[] = [thread.title, thread.lastTurnPreview];
		for (const turn of turns) {
			values.push(turn.promptText, turn.responsePlainText, turn.responseMarkdown);
		}

		this.searchTextByThreadId.set(thread.threadId, values.join('\n').toLowerCase());
	}
}

const interruptedTurnNotice = 'This turn was interrupted before it could finish. Send a new prompt to retry.';

/**
 * Snapshots can contain turns whose agent loop never reached a terminal phase, typically because
 * the previous process exited (or hung) mid-tool. The state machine has no notion of liveness, so
 * those turns would otherwise restore as `streaming`/`pending` forever, locking the composer and
 * showing a perpetual spinner. We rewrite them to a clean `failed` state at restore time so the
 * chat is always usable after a restart.
 */
function recoverInterruptedTurns(turns: readonly IVSCloneChatHistoryTurn[], recoveryTimestamp: number): readonly IVSCloneChatHistoryTurn[] {
	let mutated = false;
	const recovered: IVSCloneChatHistoryTurn[] = [];
	for (const turn of turns) {
		if (turn.status !== 'pending' && turn.status !== 'streaming') {
			recovered.push(turn);
			continue;
		}

		mutated = true;
		const trailingNotice = turn.responsePlainText.trim().length > 0
			? `${turn.responsePlainText.replace(/\s+$/, '')}\n\n${interruptedTurnNotice}`
			: interruptedTurnNotice;
		const trailingMarkdown = turn.responseMarkdown.trim().length > 0
			? `${turn.responseMarkdown.replace(/\s+$/, '')}\n\n${interruptedTurnNotice}`
			: interruptedTurnNotice;
		recovered.push({
			...turn,
			status: 'failed',
			errorCode: turn.errorCode ?? 'interrupted',
			completedAt: turn.completedAt ?? recoveryTimestamp,
			responsePlainText: trailingNotice,
			responseMarkdown: trailingMarkdown,
		});
	}
	return mutated ? recovered : turns;
}
