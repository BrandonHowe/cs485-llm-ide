/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../../base/common/event.js';
import {
	type IVSCloneChatHistoryChangeEvent,
	type IVSCloneChatHistoryQuery,
	type IVSCloneChatHistorySnapshot,
	type IVSCloneChatHistoryThread,
	type IVSCloneChatHistoryTurn,
	type IVSCloneChatTurnUpdate,
	type VSCloneChatTurnPhase,
	type VSCloneChatHistoryScope,
	type VSCloneChatHistoryTab,
	type VSCloneChatThreadStatus,
	type VSCloneChatTurnStatus,
} from '../vscloneChatHistoryTypes.js';
import {
	VSCloneChatHistoryEnabledSetting,
	VSCloneChatHistoryMaxThreadsSetting,
	VSCloneChatHistoryMaxTurnsPerThreadSetting,
	VSCloneChatHistoryPersistScopeSetting,
	VSCloneChatHistoryRailWidthSetting,
	VSCloneChatHistoryRedactSecretsSetting,
	VSCloneChatHistoryRetentionDaysSetting,
} from '../vscloneChatHistorySettings.js';
import { IVSCloneUnifiedChatBackendService } from './vscloneUnifiedChatBackendService.js';

export const IVSCloneChatHistoryService = createDecorator<IVSCloneChatHistoryService>('vscloneChatHistoryService');

export type {
	IVSCloneChatHistoryChangeEvent,
	IVSCloneChatHistoryQuery,
	IVSCloneChatHistorySnapshot,
	IVSCloneChatHistoryThread,
	IVSCloneChatHistoryTurn,
	IVSCloneChatTurnUpdate,
	VSCloneChatTurnPhase,
	VSCloneChatHistoryScope,
	VSCloneChatHistoryTab,
	VSCloneChatThreadStatus,
	VSCloneChatTurnStatus,
};

export {
	VSCloneChatHistoryEnabledSetting,
	VSCloneChatHistoryMaxThreadsSetting,
	VSCloneChatHistoryMaxTurnsPerThreadSetting,
	VSCloneChatHistoryPersistScopeSetting,
	VSCloneChatHistoryRailWidthSetting,
	VSCloneChatHistoryRedactSecretsSetting,
	VSCloneChatHistoryRetentionDaysSetting,
};

export interface IVSCloneChatHistoryService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<IVSCloneChatHistoryChangeEvent>;
	initialize(): Promise<void>;
	getThreads(query?: IVSCloneChatHistoryQuery): readonly IVSCloneChatHistoryThread[];
	getTurns(threadId: string): readonly IVSCloneChatHistoryTurn[];
	applyTurnUpdate(update: IVSCloneChatTurnUpdate): void;
	archiveThread(threadId: string, archived: boolean): Promise<void>;
	deleteThread(threadId: string): Promise<void>;
	clearAll(scope: VSCloneChatHistoryScope): Promise<void>;
}

/**
 * History remains a separate service id for existing UI code, but the facade now delegates to the
 * unified backend so thread restore and model restore come from one canonical owner.
 */
export class VSCloneChatHistoryService implements IVSCloneChatHistoryService {
	declare readonly _serviceBrand: undefined;

	readonly onDidChange = this.backendService.onDidChange;

	constructor(
		@IVSCloneUnifiedChatBackendService private readonly backendService: IVSCloneUnifiedChatBackendService,
	) { }

	initialize(): Promise<void> {
		return this.backendService.initialize();
	}

	getThreads(query?: IVSCloneChatHistoryQuery): readonly IVSCloneChatHistoryThread[] {
		return this.backendService.getThreads(query);
	}

	getTurns(threadId: string): readonly IVSCloneChatHistoryTurn[] {
		return this.backendService.getTurns(threadId);
	}

	applyTurnUpdate(update: IVSCloneChatTurnUpdate): void {
		this.backendService.applyTurnUpdate(update);
	}

	archiveThread(threadId: string, archived: boolean): Promise<void> {
		return this.backendService.archiveThread(threadId, archived);
	}

	deleteThread(threadId: string): Promise<void> {
		return this.backendService.deleteThread(threadId);
	}

	clearAll(scope: VSCloneChatHistoryScope): Promise<void> {
		return this.backendService.clearAll(scope);
	}
}
