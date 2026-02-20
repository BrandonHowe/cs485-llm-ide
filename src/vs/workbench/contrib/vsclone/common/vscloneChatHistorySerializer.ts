/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn } from './vscloneChatHistoryService.js';

const threadStatuses = new Set<IVSCloneChatHistoryThread['status']>(['active', 'completed', 'failed', 'archived']);
const turnStatuses = new Set<IVSCloneChatHistoryTurn['status']>(['pending', 'streaming', 'completed', 'failed', 'cancelled']);

export interface IVSCloneChatHistoryIndexFile {
	schemaVersion: 1;
	workspaceId: string;
	updatedAt: number;
	threads: IVSCloneChatHistoryThread[];
}

export interface IVSCloneChatHistoryThreadFile {
	schemaVersion: 1;
	threadId: string;
	sessionResource: string;
	turns: IVSCloneChatHistoryTurn[];
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object';
}

function isThread(value: unknown): value is IVSCloneChatHistoryThread {
	if (!isObject(value)) {
		return false;
	}

	return typeof value.threadId === 'string'
		&& typeof value.sessionResource === 'string'
		&& typeof value.title === 'string'
		&& (value.activeModelIdentifier === undefined || typeof value.activeModelIdentifier === 'string')
		&& typeof value.createdAt === 'number'
		&& typeof value.updatedAt === 'number'
		&& typeof value.archived === 'boolean'
		&& typeof value.turnCount === 'number'
		&& typeof value.lastTurnPreview === 'string'
		&& threadStatuses.has(value.status as IVSCloneChatHistoryThread['status']);
}

function isTurn(value: unknown): value is IVSCloneChatHistoryTurn {
	if (!isObject(value)) {
		return false;
	}

	return typeof value.turnId === 'string'
		&& typeof value.threadId === 'string'
		&& typeof value.sequence === 'number'
		&& (value.modelIdentifier === undefined || typeof value.modelIdentifier === 'string')
		&& (value.providerId === undefined || typeof value.providerId === 'string')
		&& typeof value.promptText === 'string'
		&& typeof value.responseMarkdown === 'string'
		&& typeof value.responsePlainText === 'string'
		&& typeof value.startedAt === 'number'
		&& (value.completedAt === undefined || typeof value.completedAt === 'number')
		&& (value.errorCode === undefined || typeof value.errorCode === 'string')
		&& turnStatuses.has(value.status as IVSCloneChatHistoryTurn['status']);
}

function sortThreads(threads: readonly IVSCloneChatHistoryThread[]): IVSCloneChatHistoryThread[] {
	return [...threads].sort((a, b) => {
		if (a.updatedAt === b.updatedAt) {
			return a.threadId.localeCompare(b.threadId);
		}
		return b.updatedAt - a.updatedAt;
	});
}

function sortTurns(turns: readonly IVSCloneChatHistoryTurn[]): IVSCloneChatHistoryTurn[] {
	return [...turns].sort((a, b) => {
		if (a.sequence === b.sequence) {
			return a.startedAt - b.startedAt;
		}
		return a.sequence - b.sequence;
	});
}

export class VSCloneChatHistorySerializer {
	serializeIndex(workspaceId: string, updatedAt: number, threads: readonly IVSCloneChatHistoryThread[]): string {
		const payload: IVSCloneChatHistoryIndexFile = {
			schemaVersion: 1,
			workspaceId,
			updatedAt,
			threads: sortThreads(threads),
		};
		return JSON.stringify(payload, undefined, 2);
	}

	serializeThread(threadId: string, sessionResource: string, turns: readonly IVSCloneChatHistoryTurn[]): string {
		const payload: IVSCloneChatHistoryThreadFile = {
			schemaVersion: 1,
			threadId,
			sessionResource,
			turns: sortTurns(turns),
		};
		return JSON.stringify(payload, undefined, 2);
	}

	deserializeIndex(raw: string): IVSCloneChatHistoryIndexFile {
		const parsed = JSON.parse(raw) as unknown;
		if (!isObject(parsed)) {
			throw new Error('History index is not an object');
		}

		if (parsed.schemaVersion !== 1) {
			throw new Error(`Unsupported history index version: ${String(parsed.schemaVersion)}`);
		}

		if (typeof parsed.workspaceId !== 'string' || typeof parsed.updatedAt !== 'number' || !Array.isArray(parsed.threads)) {
			throw new Error('History index is malformed');
		}

		if (!parsed.threads.every(isThread)) {
			throw new Error('History index has malformed thread entries');
		}

		return {
			schemaVersion: 1,
			workspaceId: parsed.workspaceId,
			updatedAt: parsed.updatedAt,
			threads: sortThreads(parsed.threads),
		};
	}

	deserializeThread(raw: string): IVSCloneChatHistoryThreadFile {
		const parsed = JSON.parse(raw) as unknown;
		if (!isObject(parsed)) {
			throw new Error('History thread file is not an object');
		}

		if (parsed.schemaVersion !== 1) {
			throw new Error(`Unsupported history thread version: ${String(parsed.schemaVersion)}`);
		}

		if (typeof parsed.threadId !== 'string' || typeof parsed.sessionResource !== 'string' || !Array.isArray(parsed.turns)) {
			throw new Error('History thread file is malformed');
		}

		if (!parsed.turns.every(isTurn)) {
			throw new Error('History thread file has malformed turn entries');
		}

		return {
			schemaVersion: 1,
			threadId: parsed.threadId,
			sessionResource: parsed.sessionResource,
			turns: sortTurns(parsed.turns),
		};
	}
}
