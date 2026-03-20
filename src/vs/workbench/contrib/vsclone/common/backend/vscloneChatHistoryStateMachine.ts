/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn, IVSCloneChatTurnUpdate } from '../vscloneChatHistoryTypes.js';

export interface IVSCloneHistoryTransitionOptions {
	sessionResource: string;
	maxTurnsPerThread: number;
}

export interface IVSCloneHistoryTransitionResult {
	thread: IVSCloneChatHistoryThread;
	turns: readonly IVSCloneChatHistoryTurn[];
}

const previewLength = 120;

function trimPreview(value: string): string {
	if (value.length <= previewLength) {
		return value;
	}
	return `${value.slice(0, previewLength - 1)}…`;
}

function normalizeThreadStatus(thread: IVSCloneChatHistoryThread, turns: readonly IVSCloneChatHistoryTurn[]): IVSCloneChatHistoryThread['status'] {
	if (thread.archived) {
		return 'archived';
	}

	const latest = turns.at(-1);
	if (!latest) {
		return 'active';
	}

	switch (latest.status) {
		case 'failed':
			return 'failed';
		case 'completed':
		case 'cancelled':
			return 'completed';
		default:
			return 'active';
	}
}

function deriveLastTurnPreview(turn: IVSCloneChatHistoryTurn | undefined): string {
	if (!turn) {
		return '';
	}

	const plain = turn.responsePlainText.trim();
	if (plain.length > 0) {
		return trimPreview(plain);
	}

	return trimPreview(turn.promptText.trim());
}

function toSortedTurns(turns: readonly IVSCloneChatHistoryTurn[]): IVSCloneChatHistoryTurn[] {
	return [...turns].sort((a, b) => {
		if (a.sequence === b.sequence) {
			return a.startedAt - b.startedAt;
		}
		return a.sequence - b.sequence;
	});
}

function mergeDelta(existing: string, delta: string | undefined, replace: string | undefined): string {
	if (typeof replace === 'string') {
		return replace;
	}

	if (!delta) {
		return existing;
	}
	return `${existing}${delta}`;
}

export function reduceThreadTurns(
	thread: IVSCloneChatHistoryThread | undefined,
	turns: readonly IVSCloneChatHistoryTurn[] | undefined,
	update: IVSCloneChatTurnUpdate,
	options: IVSCloneHistoryTransitionOptions,
): IVSCloneHistoryTransitionResult {
	const existingTurns = turns ? [...turns] : [];
	let existingTurnIndex = existingTurns.findIndex(turn => turn.turnId === update.turnId);

	if (existingTurnIndex === -1) {
		existingTurns.push({
			turnId: update.turnId,
			threadId: update.threadId,
			sequence: update.sequence,
			modelIdentifier: update.modelIdentifier,
			providerId: update.providerId,
			promptText: update.promptText ?? '',
			responseMarkdown: '',
			responsePlainText: '',
			startedAt: update.occurredAt,
			status: update.phase === 'error' ? 'failed' : update.phase === 'cancel' ? 'cancelled' : update.phase === 'complete' ? 'completed' : update.phase === 'stream' ? 'streaming' : 'pending',
			errorCode: update.errorCode,
			completedAt: update.phase === 'complete' || update.phase === 'error' || update.phase === 'cancel' ? update.occurredAt : undefined,
			lastEventAt: update.occurredAt,
		});
		existingTurnIndex = existingTurns.length - 1;
	}

	const existingTurn = existingTurns[existingTurnIndex];
	const lastEventAt = existingTurn.lastEventAt ?? existingTurn.startedAt;
	// Stream chunks can legitimately arrive in the same millisecond.
	// Only reject strictly older events so equal-timestamp deltas are preserved.
	if (update.occurredAt < lastEventAt && update.phase !== 'prompt') {
		return {
			thread: thread ?? {
				threadId: update.threadId,
				sessionResource: options.sessionResource,
				title: update.threadTitle?.trim() || 'Untitled Chat',
				activeModelIdentifier: update.modelIdentifier,
				createdAt: existingTurn.startedAt,
				updatedAt: existingTurn.startedAt,
				status: 'active',
				archived: false,
				turnCount: existingTurns.length,
				lastTurnPreview: deriveLastTurnPreview(existingTurns.at(-1)),
			},
			turns: toSortedTurns(existingTurns),
		};
	}

	let nextTurn: IVSCloneChatHistoryTurn = {
		...existingTurn,
		sequence: update.sequence,
		modelIdentifier: update.modelIdentifier ?? existingTurn.modelIdentifier,
		providerId: update.providerId ?? existingTurn.providerId,
		lastEventAt: Math.max(lastEventAt, update.occurredAt),
	};

	switch (update.phase) {
		case 'prompt': {
			nextTurn = {
				...nextTurn,
				promptText: update.promptText ?? nextTurn.promptText,
				status: 'pending',
				errorCode: undefined,
				completedAt: undefined,
			};
			break;
		}
		case 'stream': {
			nextTurn = {
				...nextTurn,
				promptText: update.promptText ?? nextTurn.promptText,
				responseMarkdown: mergeDelta(nextTurn.responseMarkdown, update.responseMarkdownDelta, update.responseMarkdownReplace),
				responsePlainText: mergeDelta(nextTurn.responsePlainText, update.responsePlainTextDelta, update.responsePlainTextReplace),
				status: 'streaming',
				errorCode: undefined,
				completedAt: undefined,
			};
			break;
		}
		case 'complete': {
			nextTurn = {
				...nextTurn,
				promptText: update.promptText ?? nextTurn.promptText,
				responseMarkdown: mergeDelta(nextTurn.responseMarkdown, update.responseMarkdownDelta, update.responseMarkdownReplace),
				responsePlainText: mergeDelta(nextTurn.responsePlainText, update.responsePlainTextDelta, update.responsePlainTextReplace),
				status: 'completed',
				errorCode: undefined,
				completedAt: update.occurredAt,
			};
			break;
		}
		case 'error': {
			nextTurn = {
				...nextTurn,
				responseMarkdown: mergeDelta(nextTurn.responseMarkdown, update.responseMarkdownDelta, update.responseMarkdownReplace),
				responsePlainText: mergeDelta(nextTurn.responsePlainText, update.responsePlainTextDelta, update.responsePlainTextReplace),
				status: 'failed',
				errorCode: update.errorCode,
				completedAt: update.occurredAt,
			};
			break;
		}
		case 'cancel': {
			nextTurn = {
				...nextTurn,
				responseMarkdown: mergeDelta(nextTurn.responseMarkdown, update.responseMarkdownDelta, update.responseMarkdownReplace),
				responsePlainText: mergeDelta(nextTurn.responsePlainText, update.responsePlainTextDelta, update.responsePlainTextReplace),
				status: 'cancelled',
				errorCode: undefined,
				completedAt: update.occurredAt,
			};
			break;
		}
	}

	existingTurns[existingTurnIndex] = nextTurn;
	let normalizedTurns = toSortedTurns(existingTurns);

	if (normalizedTurns.length > options.maxTurnsPerThread) {
		normalizedTurns = normalizedTurns.slice(normalizedTurns.length - options.maxTurnsPerThread);
	}

	const currentThread: IVSCloneChatHistoryThread = thread ? { ...thread } : {
		threadId: update.threadId,
		sessionResource: options.sessionResource,
		title: trimPreview((update.threadTitle ?? update.promptText ?? '').trim()) || 'Untitled Chat',
		activeModelIdentifier: update.modelIdentifier,
		createdAt: update.occurredAt,
		updatedAt: update.occurredAt,
		status: 'active',
		archived: false,
		turnCount: 0,
		lastTurnPreview: '',
	};

	if (!thread && (!currentThread.title || currentThread.title.trim().length === 0)) {
		currentThread.title = 'Untitled Chat';
	}

	if (!thread && update.promptText) {
		currentThread.title = trimPreview(update.promptText.trim());
	}

	if (update.threadTitle && update.threadTitle.trim().length > 0) {
		currentThread.title = trimPreview(update.threadTitle.trim());
	}

	if (!currentThread.title || currentThread.title.trim().length === 0) {
		currentThread.title = 'Untitled Chat';
	}

	const latestTurn = normalizedTurns.at(-1);
	const nextThread: IVSCloneChatHistoryThread = {
		...currentThread,
		activeModelIdentifier: update.modelIdentifier ?? currentThread.activeModelIdentifier,
		updatedAt: Math.max(currentThread.updatedAt, update.occurredAt),
		turnCount: normalizedTurns.length,
		lastTurnPreview: deriveLastTurnPreview(latestTurn),
	};
	if (!thread) {
		nextThread.createdAt = update.occurredAt;
	}
	nextThread.status = normalizeThreadStatus(nextThread, normalizedTurns);

	return {
		thread: nextThread,
		turns: normalizedTurns,
	};
}
