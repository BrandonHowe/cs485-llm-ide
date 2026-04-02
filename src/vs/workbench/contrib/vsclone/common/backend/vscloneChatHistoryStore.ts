/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../../platform/log/common/log.js';
import { _util } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageEntry, IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IVSCloneChatHistorySnapshot, IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn, VSCloneChatHistoryScope } from '../vscloneChatHistoryTypes.js';
import { VSCloneChatHistorySerializer } from './vscloneChatHistorySerializer.js';
import type { IVSCloneModelSelection } from '../vscloneModelSelectionTypes.js';

// VS Code's workspace/profile storage is already backed by SQLite on desktop, so we persist the
// unified history snapshot there instead of maintaining an extra JSON-file database for VSClone.
const STORAGE_PREFIX = 'vsclone.chatHistory.v2';
const INDEX_STORAGE_KEY = `${STORAGE_PREFIX}.index`;
const THREAD_STORAGE_KEY_PREFIX = `${STORAGE_PREFIX}.thread.`;

const secretPatterns: RegExp[] = [
	/(api[_-]?key\s*[:=]\s*)([\w\-]{8,})/gi,
	/(token\s*[:=]\s*)([\w\-]{8,})/gi,
	/(password\s*[:=]\s*)([^\s'"`]+)/gi,
	/(bearer\s+)([a-z0-9\-._~+/]+=*)/gi,
];

function redactText(value: string): string {
	let redacted = value;
	for (const pattern of secretPatterns) {
		redacted = redacted.replace(pattern, (_match, prefix: string) => `${prefix}[REDACTED]`);
	}
	return redacted;
}

function redactThread(thread: IVSCloneChatHistoryThread): IVSCloneChatHistoryThread {
	return {
		...thread,
		title: redactText(thread.title),
		lastTurnPreview: redactText(thread.lastTurnPreview),
	};
}

function redactTurn(turn: IVSCloneChatHistoryTurn): IVSCloneChatHistoryTurn {
	return {
		...turn,
		promptText: redactText(turn.promptText),
		responseMarkdown: redactText(turn.responseMarkdown),
		responsePlainText: redactText(turn.responsePlainText),
	};
}

function encodeThreadId(threadId: string): string {
	return encodeURIComponent(threadId);
}

function toStorageScope(scope: VSCloneChatHistoryScope): StorageScope {
	return scope === 'profile' ? StorageScope.PROFILE : StorageScope.WORKSPACE;
}

export interface IVSCloneChatHistoryStoreSaveOptions {
	redactSecrets: boolean;
}

export class VSCloneChatHistoryStore extends Disposable {
	private readonly serializer = new VSCloneChatHistorySerializer();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async load(scope: VSCloneChatHistoryScope): Promise<IVSCloneChatHistorySnapshot> {
		const storedSnapshot = await this.loadFromStorage(scope);
		return storedSnapshot ?? createEmptySnapshot();
	}

	async save(scope: VSCloneChatHistoryScope, snapshot: IVSCloneChatHistorySnapshot, options: IVSCloneChatHistoryStoreSaveOptions): Promise<void> {
		const storageScope = toStorageScope(scope);
		const threads = options.redactSecrets ? snapshot.threads.map(redactThread) : snapshot.threads;
		const staleThreadKeys = this.getManagedThreadKeys(storageScope);
		const entries: IStorageEntry[] = [];

		for (const thread of threads) {
			const threadStorageKey = this.getThreadStorageKey(thread.threadId);
			staleThreadKeys.delete(threadStorageKey);
			const turns = snapshot.turnsByThreadId[thread.threadId] ?? [];
			const persistedTurns = options.redactSecrets ? turns.map(redactTurn) : turns;
			const selection = snapshot.selectedByThread[thread.threadId];
			const content = this.serializer.serializeThread(thread.threadId, thread.sessionResource, persistedTurns, selection ? cloneSelection(selection) : undefined);
			entries.push({
				key: threadStorageKey,
				value: content,
				scope: storageScope,
				target: StorageTarget.MACHINE,
			});
		}

		for (const staleThreadKey of staleThreadKeys) {
			entries.push({
				key: staleThreadKey,
				value: undefined,
				scope: storageScope,
				target: StorageTarget.MACHINE,
			});
		}

		const indexContent = this.serializer.serializeIndex(
			this.workspaceContextService.getWorkspace().id,
			snapshot.updatedAt,
			threads,
			{ ...snapshot.modeByThread },
			Object.fromEntries(Object.entries(snapshot.selectedByLocation).map(([location, selection]) => [location, selection ? cloneSelection(selection) : undefined])),
			snapshot.recentModelIdentifiers,
		);
		entries.push({
			key: INDEX_STORAGE_KEY,
			value: indexContent,
			scope: storageScope,
			target: StorageTarget.MACHINE,
		});

		this.storageService.storeAll(entries, false);
	}

	async clear(scope: VSCloneChatHistoryScope): Promise<void> {
		const storageScope = toStorageScope(scope);
		for (const key of this.getManagedStorageKeys(storageScope)) {
			this.storageService.remove(key, storageScope);
		}
	}

	private async loadFromStorage(scope: VSCloneChatHistoryScope): Promise<IVSCloneChatHistorySnapshot | undefined> {
		const storageScope = toStorageScope(scope);
		const indexRaw = this.storageService.get(INDEX_STORAGE_KEY, storageScope);
		if (!indexRaw) {
			return undefined;
		}

		const index = this.serializer.deserializeIndex(indexRaw);
		return this.restoreSnapshot(index, async threadId => this.storageService.get(this.getThreadStorageKey(threadId), storageScope));
	}

	private async restoreSnapshot(
		index: ReturnType<VSCloneChatHistorySerializer['deserializeIndex']>,
		readThreadPayload: (threadId: string) => Promise<string | undefined>,
	): Promise<IVSCloneChatHistorySnapshot> {
		const turnsByThreadId: Record<string, readonly IVSCloneChatHistoryTurn[]> = {};
		const threads: IVSCloneChatHistoryThread[] = [];
		const selectedByThread: Record<string, IVSCloneModelSelection> = {};

		for (const thread of index.threads) {
			const raw = await readThreadPayload(thread.threadId);
			if (!raw) {
				threads.push(thread);
				turnsByThreadId[thread.threadId] = [];
				continue;
			}

			try {
				const parsed = this.serializer.deserializeThread(raw);
				threads.push(thread);
				turnsByThreadId[thread.threadId] = parsed.turns;
				if (parsed.selection) {
					selectedByThread[thread.threadId] = cloneSelection(parsed.selection);
				}
			} catch (error) {
				this.logService.warn(`Skipping malformed VSClone history thread '${thread.threadId}'`, error);
				threads.push(thread);
				turnsByThreadId[thread.threadId] = [];
			}
		}

		return {
			updatedAt: index.updatedAt,
			threads,
			turnsByThreadId,
			modeByThread: { ...index.modeByThread },
			selectedByThread,
			selectedByLocation: Object.fromEntries(Object.entries(index.selectedByLocation).map(([location, selection]) => [location, selection ? cloneSelection(selection) : undefined])),
			recentModelIdentifiers: [...index.recentModelIdentifiers],
		};
	}

	private getManagedStorageKeys(scope: StorageScope): Set<string> {
		const keys = [
			...this.storageService.keys(scope, StorageTarget.MACHINE),
			...this.storageService.keys(scope, StorageTarget.USER),
		];

		return new Set(keys.filter(key => key === INDEX_STORAGE_KEY || key.startsWith(THREAD_STORAGE_KEY_PREFIX)));
	}

	private getManagedThreadKeys(scope: StorageScope): Set<string> {
		return new Set([...this.getManagedStorageKeys(scope)].filter(key => key.startsWith(THREAD_STORAGE_KEY_PREFIX)));
	}

	private getThreadStorageKey(threadId: string): string {
		return `${THREAD_STORAGE_KEY_PREFIX}${encodeThreadId(threadId)}`;
	}
}

// Some VSClone-generated outputs currently miss emitted `__param` metadata for this class even
// though other workbench services still use constructor-based DI. Registering the dependencies
// explicitly keeps `createInstance(VSCloneChatHistoryStore)` stable without double-registering
// when the normal decorator metadata is present.
if (_util.getServiceDependencies(VSCloneChatHistoryStore).length === 0) {
	IStorageService(VSCloneChatHistoryStore, undefined, 0);
	IWorkspaceContextService(VSCloneChatHistoryStore, undefined, 1);
	ILogService(VSCloneChatHistoryStore, undefined, 2);
}

function cloneSelection<T extends object>(selection: T): T {
	return { ...selection };
}

function createEmptySnapshot(): IVSCloneChatHistorySnapshot {
	return {
		updatedAt: Date.now(),
		threads: [],
		turnsByThreadId: {},
		modeByThread: {},
		selectedByThread: {},
		selectedByLocation: {},
		recentModelIdentifiers: [],
	};
}
