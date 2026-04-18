/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import type { IVSCloneUnifiedChatBackendChangeEvent, IVSCloneUnifiedChatBackendService } from '../../common/backend/vscloneUnifiedChatBackendService.js';
import type { IVSCloneModelSelection, IVSCloneThreadSelectionMap, IVSCloneUnifiedChatSelectionState } from '../../common/vscloneModelSelectionTypes.js';
import type { IVSCloneUnifiedChatPlanModeState } from '../../common/vsclonePlanModeTypes.js';

function isModelSelection(value: unknown): value is IVSCloneModelSelection {
	const record = typeof value === 'object' && value !== null ? value as Partial<IVSCloneModelSelection> : undefined;
	return !!record && typeof record.location === 'string' && typeof record.modelIdentifier === 'string';
}

function cloneThreadSelectionMap(value: unknown): IVSCloneThreadSelectionMap {
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

export class TestVSCloneUnifiedChatBackendService implements IVSCloneUnifiedChatBackendService {
	declare readonly _serviceBrand: undefined;

	readonly onDidChange: Event<IVSCloneUnifiedChatBackendChangeEvent> = Event.None;
	private planModeState: IVSCloneUnifiedChatPlanModeState = { modeByThread: {} };
	private selectionState: IVSCloneUnifiedChatSelectionState = {
		selectedByThread: {},
		selectedByLocation: {},
		recentModelIdentifiers: [],
	};

	async initialize(): Promise<void> { }

	async deleteThread(threadId: string): Promise<void> {
		delete this.planModeState.modeByThread[threadId];
		delete this.selectionState.selectedByThread[threadId];
	}

	async clearAll(): Promise<void> {
		this.planModeState = { modeByThread: {} };
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

	getPlanModeState(): IVSCloneUnifiedChatPlanModeState {
		return {
			modeByThread: { ...this.planModeState.modeByThread },
		};
	}

	async replacePlanModeState(state: IVSCloneUnifiedChatPlanModeState): Promise<void> {
		this.planModeState = {
			modeByThread: { ...state.modeByThread },
		};
	}
}
