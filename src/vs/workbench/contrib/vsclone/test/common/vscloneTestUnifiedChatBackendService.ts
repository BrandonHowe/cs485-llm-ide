/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import type { IVSCloneUnifiedChatBackendService } from '../../common/backend/vscloneUnifiedChatBackendService.js';
import type { IVSCloneChatHistoryQuery, IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn, IVSCloneChatTurnUpdate, VSCloneChatHistoryScope } from '../../common/backend/vscloneChatHistoryService.js';
import type { IVSCloneUnifiedChatSelectionState } from '../../common/vscloneModelSelectionTypes.js';

function cloneSelectionState(state: IVSCloneUnifiedChatSelectionState): IVSCloneUnifiedChatSelectionState {
	return {
		selectedByThread: Object.fromEntries(Object.entries(state.selectedByThread).map(([threadId, selection]) => [threadId, { ...selection, threadId: undefined }])),
		selectedByLocation: Object.fromEntries(Object.entries(state.selectedByLocation).map(([location, selection]) => [location, selection ? { ...selection, threadId: undefined } : undefined])),
		recentModelIdentifiers: [...state.recentModelIdentifiers],
	};
}

export class TestVSCloneUnifiedChatBackendService implements IVSCloneUnifiedChatBackendService {
	declare readonly _serviceBrand: undefined;

	readonly onDidChange = Event.None;
	readonly threads: IVSCloneChatHistoryThread[] = [];
	readonly turnsByThread = new Map<string, readonly IVSCloneChatHistoryTurn[]>();
	private selectionState: IVSCloneUnifiedChatSelectionState = {
		selectedByThread: {},
		selectedByLocation: {},
		recentModelIdentifiers: [],
	};

	async initialize(): Promise<void> { }

	getThreads(_query?: IVSCloneChatHistoryQuery): readonly IVSCloneChatHistoryThread[] {
		return this.threads;
	}

	getTurns(threadId: string): readonly IVSCloneChatHistoryTurn[] {
		return this.turnsByThread.get(threadId) ?? [];
	}

	applyTurnUpdate(_update: IVSCloneChatTurnUpdate): void { }

	async archiveThread(_threadId: string, _archived: boolean): Promise<void> { }

	async deleteThread(threadId: string): Promise<void> {
		delete this.selectionState.selectedByThread[threadId];
	}

	async clearAll(_scope: VSCloneChatHistoryScope): Promise<void> {
		this.selectionState = {
			selectedByThread: {},
			selectedByLocation: {},
			recentModelIdentifiers: [],
		};
	}

	getSelectionState(): IVSCloneUnifiedChatSelectionState {
		return cloneSelectionState(this.selectionState);
	}

	async replaceSelectionState(state: IVSCloneUnifiedChatSelectionState): Promise<void> {
		this.selectionState = cloneSelectionState(state);
	}
}
