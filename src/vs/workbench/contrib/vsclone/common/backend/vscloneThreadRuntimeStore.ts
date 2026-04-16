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
		const indexRaw = this.storageService.get(INDEX_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!indexRaw) {
			return [];
		}

		let index;
		try {
			index = this.serializer.deserializeIndex(indexRaw);
		} catch (error) {
			// Rebuilding from the per-thread keys keeps one bad index write from orphaning every
			// persisted runtime. The thread payloads are the durable source of truth.
			this.logService.warn('[VSCloneThreadRuntimeStore] Failed to read runtime index; rebuilding from thread keys.', error);
			index = {
				threadIds: this.storageService
					.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE)
					.filter(key => key.startsWith(THREAD_STORAGE_KEY_PREFIX))
					.map(key => decodeURIComponent(key.slice(THREAD_STORAGE_KEY_PREFIX.length))),
			};
		}
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
		const threadIds = new Set<string>(this.getIndexedThreadIds());
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
				value: this.serializer.serializeIndex(this.workspaceContextService.getWorkspace().id, state.lastUpdatedAt, [...threadIds]),
				scope: StorageScope.WORKSPACE,
				target: StorageTarget.MACHINE,
			},
		];
		this.storageService.storeAll(entries, false);
	}

	deleteState(threadId: string): void {
		this.storageService.remove(this.getThreadStorageKey(threadId), StorageScope.WORKSPACE);
		const threadIds = this.getIndexedThreadIds().filter(id => id !== threadId);
		if (threadIds.length === 0) {
			this.storageService.remove(INDEX_STORAGE_KEY, StorageScope.WORKSPACE);
			return;
		}

		this.storageService.store(
			INDEX_STORAGE_KEY,
			this.serializer.serializeIndex(this.workspaceContextService.getWorkspace().id, Date.now(), threadIds),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
	}

	private getIndexedThreadIds(): string[] {
		const indexRaw = this.storageService.get(INDEX_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!indexRaw) {
			return [];
		}

		try {
			return this.serializer.deserializeIndex(indexRaw).threadIds;
		} catch (error) {
			this.logService.warn('[VSCloneThreadRuntimeStore] Failed to read runtime index; rebuilding from thread keys.', error);
			return this.storageService
				.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE)
				.filter(key => key.startsWith(THREAD_STORAGE_KEY_PREFIX))
				.map(key => decodeURIComponent(key.slice(THREAD_STORAGE_KEY_PREFIX.length)));
		}
	}

	private getThreadStorageKey(threadId: string): string {
		return `${THREAD_STORAGE_KEY_PREFIX}${encodeThreadId(threadId)}`;
	}
}

if (_util.getServiceDependencies(VSCloneThreadRuntimeStore).length === 0) {
	IStorageService(VSCloneThreadRuntimeStore, undefined, 0);
	IWorkspaceContextService(VSCloneThreadRuntimeStore, undefined, 1);
	ILogService(VSCloneThreadRuntimeStore, undefined, 2);
}
