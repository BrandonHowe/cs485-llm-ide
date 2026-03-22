/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn } from '../vscloneChatHistoryTypes.js';
import { allVSCloneChatLocations, type IVSCloneChatLocation, type IVSCloneModelSelection } from '../vscloneModelSelectionTypes.js';
import { isVSCloneChatMode, type VSCloneChatMode } from '../vsclonePlanModeTypes.js';
import type { IVSCloneImageAttachment } from '../vscloneImageAttachmentTypes.js';

const threadStatuses = new Set<IVSCloneChatHistoryThread['status']>(['active', 'completed', 'failed', 'archived']);
const turnStatuses = new Set<IVSCloneChatHistoryTurn['status']>(['pending', 'streaming', 'completed', 'failed', 'cancelled']);

export interface IVSCloneChatHistoryIndexPayload {
	schemaVersion: 2;
	workspaceId: string;
	updatedAt: number;
	threads: IVSCloneChatHistoryThread[];
	modeByThread?: Record<string, VSCloneChatMode>;
	selectedByLocation: Partial<Record<IVSCloneChatLocation, IVSCloneModelSelection>>;
	recentModelIdentifiers: string[];
}

export interface IVSCloneChatHistoryThreadPayload {
	schemaVersion: 2;
	threadId: string;
	sessionResource: string;
	turns: IVSCloneChatHistoryTurn[];
	selection?: IVSCloneModelSelection;
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

function isImageAttachment(value: unknown): value is IVSCloneImageAttachment {
	if (!isObject(value)) {
		return false;
	}

	return typeof value.mimeType === 'string'
		&& typeof value.base64Data === 'string';
}

function isTurn(value: unknown): value is IVSCloneChatHistoryTurn {
	if (!isObject(value)) {
		return false;
	}

	return typeof value.turnId === 'string'
		&& typeof value.threadId === 'string'
		&& typeof value.sequence === 'number'
		&& (value.executionMode === undefined || isVSCloneChatMode(value.executionMode))
		&& (value.modelIdentifier === undefined || typeof value.modelIdentifier === 'string')
		&& (value.providerId === undefined || typeof value.providerId === 'string')
		&& typeof value.promptText === 'string'
		&& (value.promptImages === undefined || (Array.isArray(value.promptImages) && value.promptImages.every(isImageAttachment)))
		&& typeof value.responseMarkdown === 'string'
		&& typeof value.responsePlainText === 'string'
		&& typeof value.startedAt === 'number'
		&& (value.completedAt === undefined || typeof value.completedAt === 'number')
		&& (value.errorCode === undefined || typeof value.errorCode === 'string')
		&& turnStatuses.has(value.status as IVSCloneChatHistoryTurn['status']);
}

function isSelection(value: unknown): value is IVSCloneModelSelection {
	if (!isObject(value)) {
		return false;
	}

	return allVSCloneChatLocations.includes(value.location as IVSCloneChatLocation)
		&& typeof value.modelIdentifier === 'string'
		&& typeof value.vendor === 'string'
		&& typeof value.modelId === 'string'
		&& typeof value.modelName === 'string'
		&& (value.reasoningEffort === undefined || typeof value.reasoningEffort === 'string')
		&& typeof value.selectedAt === 'number';
}

function isPlanModeState(value: unknown): value is Record<string, VSCloneChatMode> {
	if (!isObject(value)) {
		return false;
	}

	return Object.values(value).every(entry => isVSCloneChatMode(entry));
}

function sortRecentModelIdentifiers(recentModelIdentifiers: readonly string[]): string[] {
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const identifier of recentModelIdentifiers) {
		if (typeof identifier !== 'string' || seen.has(identifier)) {
			continue;
		}
		seen.add(identifier);
		deduped.push(identifier);
	}
	return deduped;
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
	serializeIndex(
		workspaceId: string,
		updatedAt: number,
		threads: readonly IVSCloneChatHistoryThread[],
		modeByThread: Record<string, VSCloneChatMode>,
		selectedByLocation: Partial<Record<IVSCloneChatLocation, IVSCloneModelSelection>>,
		recentModelIdentifiers: readonly string[],
	): string {
		const payload: IVSCloneChatHistoryIndexPayload = {
			schemaVersion: 2,
			workspaceId,
			updatedAt,
			threads: sortThreads(threads),
			modeByThread,
			selectedByLocation,
			recentModelIdentifiers: sortRecentModelIdentifiers(recentModelIdentifiers),
		};
		return JSON.stringify(payload, undefined, 2);
	}

	serializeThread(
		threadId: string,
		sessionResource: string,
		turns: readonly IVSCloneChatHistoryTurn[],
		selection: IVSCloneModelSelection | undefined,
	): string {
		const payload: IVSCloneChatHistoryThreadPayload = {
			schemaVersion: 2,
			threadId,
			sessionResource,
			turns: sortTurns(turns),
			selection,
		};
		return JSON.stringify(payload, undefined, 2);
	}

	deserializeIndex(raw: string): IVSCloneChatHistoryIndexPayload {
		const parsed = JSON.parse(raw) as unknown;
		if (!isObject(parsed)) {
			throw new Error('History index is not an object');
		}

		if (parsed.schemaVersion !== 2) {
			throw new Error(`Unsupported history index version: ${String(parsed.schemaVersion)}`);
		}

		if (
			typeof parsed.workspaceId !== 'string'
			|| typeof parsed.updatedAt !== 'number'
			|| !Array.isArray(parsed.threads)
			|| (parsed.modeByThread !== undefined && !isPlanModeState(parsed.modeByThread))
			|| !isObject(parsed.selectedByLocation)
			|| !Array.isArray(parsed.recentModelIdentifiers)
		) {
			throw new Error('History index is malformed');
		}

		if (!parsed.threads.every(isThread)) {
			throw new Error('History index has malformed thread entries');
		}

		for (const location of allVSCloneChatLocations) {
			const selection = parsed.selectedByLocation[location];
			if (selection !== undefined && !isSelection(selection)) {
				throw new Error('History index has malformed location selections');
			}
		}

		return {
			schemaVersion: 2,
			workspaceId: parsed.workspaceId,
			updatedAt: parsed.updatedAt,
			threads: sortThreads(parsed.threads),
			modeByThread: parsed.modeByThread ?? {},
			selectedByLocation: parsed.selectedByLocation,
			recentModelIdentifiers: sortRecentModelIdentifiers(parsed.recentModelIdentifiers),
		};
	}

	deserializeThread(raw: string): IVSCloneChatHistoryThreadPayload {
		const parsed = JSON.parse(raw) as unknown;
		if (!isObject(parsed)) {
			throw new Error('History thread payload is not an object');
		}

		if (parsed.schemaVersion !== 2) {
			throw new Error(`Unsupported history thread version: ${String(parsed.schemaVersion)}`);
		}

		if (typeof parsed.threadId !== 'string' || typeof parsed.sessionResource !== 'string' || !Array.isArray(parsed.turns)) {
			throw new Error('History thread payload is malformed');
		}

		if (!parsed.turns.every(isTurn)) {
			throw new Error('History thread payload has malformed turn entries');
		}

		if (parsed.selection !== undefined && !isSelection(parsed.selection)) {
			throw new Error('History thread payload has malformed selection');
		}

		return {
			schemaVersion: 2,
			threadId: parsed.threadId,
			sessionResource: parsed.sessionResource,
			turns: sortTurns(parsed.turns),
			selection: parsed.selection,
		};
	}
}
