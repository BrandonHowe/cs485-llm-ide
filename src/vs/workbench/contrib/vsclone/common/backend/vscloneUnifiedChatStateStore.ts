/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { _util } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IVSCloneModelSelection, IVSCloneThreadSelectionMap, IVSCloneUnifiedChatSelectionState } from '../vscloneModelSelectionTypes.js';
import type { IVSCloneUnifiedChatPlanModeState } from '../vsclonePlanModeTypes.js';

const STORAGE_KEY = 'vsclone.unifiedState.v1';

interface IVSCloneUnifiedChatStateSnapshot {
	readonly updatedAt: number;
	readonly workspaceId: string;
	readonly selectionState: IVSCloneUnifiedChatSelectionState;
	readonly planModeState: IVSCloneUnifiedChatPlanModeState;
}

function createEmptySelectionState(): IVSCloneUnifiedChatSelectionState {
	return {
		selectedByThread: {},
		selectedByLocation: {},
		recentModelIdentifiers: [],
	};
}

function createEmptyPlanModeState(): IVSCloneUnifiedChatPlanModeState {
	return {
		modeByThread: {},
	};
}

function isModelSelection(value: unknown): value is IVSCloneModelSelection {
	const record = typeof value === 'object' && value !== null ? value as Partial<IVSCloneModelSelection> : undefined;
	return !!record && typeof record.location === 'string' && typeof record.modelIdentifier === 'string';
}

function cloneThreadSelectionMap(value: unknown): IVSCloneThreadSelectionMap {
	// Older persisted payloads stored a single selection per thread. Normalizing that legacy shape
	// here lets the settings owner start writing per-location maps without dropping existing users'
	// thread bindings during the first restore after the stabilization refactor.
	if (isModelSelection(value)) {
		return {
			[value.location]: { ...value, threadId: undefined },
		};
	}

	const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
	return Object.fromEntries(
		Object.entries(record).map(([location, selection]) => [location, isModelSelection(selection) ? { ...selection, threadId: undefined } : undefined]),
	) as IVSCloneThreadSelectionMap;
}

function cloneSelectionState(state: IVSCloneUnifiedChatSelectionState): IVSCloneUnifiedChatSelectionState {
	return {
		selectedByThread: Object.fromEntries(
			Object.entries(state.selectedByThread).map(([threadId, selections]) => [threadId, cloneThreadSelectionMap(selections)]),
		),
		selectedByLocation: Object.fromEntries(Object.entries(state.selectedByLocation).map(([location, selection]) => [location, selection ? { ...selection, threadId: undefined } : undefined])),
		recentModelIdentifiers: [...state.recentModelIdentifiers],
	};
}

function clonePlanModeState(state: IVSCloneUnifiedChatPlanModeState): IVSCloneUnifiedChatPlanModeState {
	return {
		modeByThread: { ...state.modeByThread },
	};
}

function normalizeSnapshot(value: unknown): IVSCloneUnifiedChatStateSnapshot {
	const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
	return {
		updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
		workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : '',
		selectionState: cloneSelectionState(record.selectionState as IVSCloneUnifiedChatSelectionState ?? createEmptySelectionState()),
		planModeState: clonePlanModeState(record.planModeState as IVSCloneUnifiedChatPlanModeState ?? createEmptyPlanModeState()),
	};
}

export class VSCloneUnifiedChatStateStore extends Disposable {
	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	load(): IVSCloneUnifiedChatStateSnapshot {
		const raw = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return this.createEmptySnapshot();
		}

		try {
			const snapshot = normalizeSnapshot(JSON.parse(raw));
			const currentWorkspaceId = this.workspaceContextService.getWorkspace().id;
			if (snapshot.workspaceId && snapshot.workspaceId !== currentWorkspaceId) {
				// The state payload is workspace-scoped already, but the explicit workspace id lets us
				// reject stale restores if storage is copied or reused across workspaces during tests.
				this.logService.warn('[VSCloneUnifiedChatStateStore] Dropping unified chat state from a different workspace.', {
					storedWorkspaceId: snapshot.workspaceId,
					currentWorkspaceId,
				});
				this.clear();
				return this.createEmptySnapshot();
			}
			return snapshot;
		} catch (error) {
			// State corruption should not block the chat UI; we discard the unreadable payload and let
			// selection/plan mode rebuild from the current catalog and runtime state.
			this.logService.warn('[VSCloneUnifiedChatStateStore] Failed to read unified chat state; discarding stored payload.', error);
			return this.createEmptySnapshot();
		}
	}

	save(snapshot: { readonly selectionState: IVSCloneUnifiedChatSelectionState; readonly planModeState: IVSCloneUnifiedChatPlanModeState }): void {
		this.storageService.store(
			STORAGE_KEY,
			JSON.stringify({
				updatedAt: Date.now(),
				workspaceId: this.workspaceContextService.getWorkspace().id,
				selectionState: cloneSelectionState(snapshot.selectionState),
				planModeState: clonePlanModeState(snapshot.planModeState),
			}),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
	}

	clear(): void {
		this.storageService.remove(STORAGE_KEY, StorageScope.WORKSPACE);
	}

	private createEmptySnapshot(): IVSCloneUnifiedChatStateSnapshot {
		return {
			updatedAt: Date.now(),
			workspaceId: this.workspaceContextService.getWorkspace().id,
			selectionState: createEmptySelectionState(),
			planModeState: createEmptyPlanModeState(),
		};
	}
}

// Some focused unit tests instantiate this store without the normal decorator emit path, so the
// fallback below defensively seeds the DI metadata on the constructor before services query it.
const vscloneUnifiedChatStateStoreCtor = VSCloneUnifiedChatStateStore as unknown as _util.DI_TARGET_OBJ;

if (_util.getServiceDependencies(vscloneUnifiedChatStateStoreCtor).length === 0) {
	IStorageService(VSCloneUnifiedChatStateStore, undefined, 0);
	IWorkspaceContextService(VSCloneUnifiedChatStateStore, undefined, 1);
	ILogService(VSCloneUnifiedChatStateStore, undefined, 2);
}
