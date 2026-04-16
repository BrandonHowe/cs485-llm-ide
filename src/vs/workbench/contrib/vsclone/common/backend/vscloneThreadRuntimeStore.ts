/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { _util } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageEntry, IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IVSCloneThreadRuntimeState } from '../vscloneThreadRuntimeTypes.js';
import { VSCloneThreadRuntimeSerializer } from './vscloneThreadRuntimeSerializer.js';

const STORAGE_PREFIX = 'vsclone.threadRuntime.v1';
const INDEX_STORAGE_KEY = `${STORAGE_PREFIX}.index`;
const THREAD_STORAGE_KEY_PREFIX = `${STORAGE_PREFIX}.thread.`;
const DELETED_THREAD_STORAGE_KEY_PREFIX = `${STORAGE_PREFIX}.deleted.`;

function encodeThreadId(threadId: string): string {
	return encodeURIComponent(threadId);
}

export class VSCloneThreadRuntimeStore extends Disposable {
	private readonly serializer = new VSCloneThreadRuntimeSerializer();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	loadAll(): readonly IVSCloneThreadRuntimeState[] {
		const index = this.getIndex();
		const states: IVSCloneThreadRuntimeState[] = [];
		for (const threadId of index.threadIds) {
			const raw = this.storageService.get(this.getThreadStorageKey(threadId), StorageScope.WORKSPACE);
			if (!raw) {
				continue;
			}

			try {
				states.push(this.serializer.deserializeState(raw));
			} catch (error) {
				this.logService.warn(`[VSCloneThreadRuntimeStore] Skipping malformed runtime thread '${threadId}'`, error);
			}
		}
		return states;
	}

	saveState(state: IVSCloneThreadRuntimeState): void {
		const index = this.getIndex();
		const threadIds = new Set<string>(index.threadIds);
		threadIds.add(state.threadId);
		const entries: IStorageEntry[] = [
			{
				key: this.getThreadStorageKey(state.threadId),
				value: this.serializer.serializeState(state),
				scope: StorageScope.WORKSPACE,
				target: StorageTarget.MACHINE,
			},
			{
				key: INDEX_STORAGE_KEY,
				value: this.serializer.serializeIndex(this.workspaceContextService.getWorkspace().id, state.lastUpdatedAt, [...threadIds], index.deletedThreadIds.filter(id => id !== state.threadId)),
				scope: StorageScope.WORKSPACE,
				target: StorageTarget.MACHINE,
			},
		];
		this.storageService.remove(this.getDeletedThreadStorageKey(state.threadId), StorageScope.WORKSPACE);
		this.storageService.storeAll(entries, false);
	}

	deleteState(threadId: string): void {
		this.storageService.remove(this.getThreadStorageKey(threadId), StorageScope.WORKSPACE);
		const index = this.getIndex();
		const threadIds = index.threadIds.filter(id => id !== threadId);
		this.writeIndex(threadIds, index.deletedThreadIds);
	}

	loadDeletedThreadIds(): readonly string[] {
		return this.getIndex().deletedThreadIds;
	}

	markDeletedThread(threadId: string): void {
		this.storageService.remove(this.getThreadStorageKey(threadId), StorageScope.WORKSPACE);
		this.storageService.store(this.getDeletedThreadStorageKey(threadId), '1', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const index = this.getIndex();
		this.writeIndex(
			index.threadIds.filter(id => id !== threadId),
			[...index.deletedThreadIds, threadId],
		);
	}

	clearAll(): void {
		for (const threadId of this.getThreadIdsFromStorage()) {
			this.storageService.remove(this.getThreadStorageKey(threadId), StorageScope.WORKSPACE);
		}
		for (const threadId of this.getDeletedThreadIdsFromStorage()) {
			this.storageService.remove(this.getDeletedThreadStorageKey(threadId), StorageScope.WORKSPACE);
		}
		this.storageService.remove(INDEX_STORAGE_KEY, StorageScope.WORKSPACE);
	}

	private getIndex(): { threadIds: string[]; deletedThreadIds: string[] } {
		const indexRaw = this.storageService.get(INDEX_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!indexRaw) {
			const deletedThreadIds = this.getDeletedThreadIdsFromStorage();
			return {
				threadIds: this.getThreadIdsFromStorage().filter(threadId => !deletedThreadIds.includes(threadId)),
				deletedThreadIds,
			};
		}

		try {
			const index = this.serializer.deserializeIndex(indexRaw);
			const deletedThreadIds = [...new Set([
				...(index.deletedThreadIds ?? []),
				...this.getDeletedThreadIdsFromStorage(),
			])].sort((left, right) => left.localeCompare(right));
			const threadIds = [...new Set([
				...index.threadIds,
				...this.getThreadIdsFromStorage(),
			])]
				.filter(threadId => !deletedThreadIds.includes(threadId))
				.sort((left, right) => left.localeCompare(right));
			return {
				threadIds,
				deletedThreadIds,
			};
		} catch (error) {
			this.logService.warn('[VSCloneThreadRuntimeStore] Failed to read runtime index; rebuilding from thread keys.', error);
			const deletedThreadIds = this.getDeletedThreadIdsFromStorage();
			return {
				threadIds: this.getThreadIdsFromStorage().filter(threadId => !deletedThreadIds.includes(threadId)),
				deletedThreadIds,
			};
		}
	}

	private writeIndex(threadIds: readonly string[], deletedThreadIds: readonly string[]): void {
		if (threadIds.length === 0 && deletedThreadIds.length === 0) {
			this.storageService.remove(INDEX_STORAGE_KEY, StorageScope.WORKSPACE);
			return;
		}

		this.storageService.store(
			INDEX_STORAGE_KEY,
			this.serializer.serializeIndex(this.workspaceContextService.getWorkspace().id, Date.now(), threadIds, deletedThreadIds),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
	}

	private getThreadStorageKey(threadId: string): string {
		return `${THREAD_STORAGE_KEY_PREFIX}${encodeThreadId(threadId)}`;
	}

	private getDeletedThreadStorageKey(threadId: string): string {
		return `${DELETED_THREAD_STORAGE_KEY_PREFIX}${encodeThreadId(threadId)}`;
	}

	private getDeletedThreadIdsFromStorage(): string[] {
		return this.storageService
			.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE)
			.filter(key => key.startsWith(DELETED_THREAD_STORAGE_KEY_PREFIX))
			.map(key => decodeURIComponent(key.slice(DELETED_THREAD_STORAGE_KEY_PREFIX.length)))
			.sort((left, right) => left.localeCompare(right));
	}

	private getThreadIdsFromStorage(): string[] {
		return this.storageService
			.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE)
			.filter(key => key.startsWith(THREAD_STORAGE_KEY_PREFIX))
			.map(key => decodeURIComponent(key.slice(THREAD_STORAGE_KEY_PREFIX.length)))
			.sort((left, right) => left.localeCompare(right));
	}
}

if (_util.getServiceDependencies(VSCloneThreadRuntimeStore).length === 0) {
	IStorageService(VSCloneThreadRuntimeStore, undefined, 0);
	IWorkspaceContextService(VSCloneThreadRuntimeStore, undefined, 1);
	ILogService(VSCloneThreadRuntimeStore, undefined, 2);
}
