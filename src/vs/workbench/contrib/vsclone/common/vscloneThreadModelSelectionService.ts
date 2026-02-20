/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const IVSCloneThreadModelSelectionService = createDecorator<IVSCloneThreadModelSelectionService>('vsCloneThreadModelSelectionService');

export type IVSCloneChatLocation = 'chat' | 'editorInline' | 'notebook' | 'terminal';

export interface IVSCloneModelSelection {
	threadId?: string;
	location: IVSCloneChatLocation;
	modelIdentifier: string;
	vendor: string;
	modelId: string;
	modelName: string;
	selectedAt: number;
}

export interface IVSCloneModelSelectionChangeEvent {
	threadId?: string;
	previous: IVSCloneModelSelection | undefined;
	current: IVSCloneModelSelection | undefined;
	reason: 'user' | 'restore' | 'fallback' | 'reset';
}

export interface IVSCloneThreadModelSelectionService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSelection: Event<IVSCloneModelSelectionChangeEvent>;
	initialize(): Promise<void>;
	getCurrentSelectionForThread(threadId: string, location: IVSCloneChatLocation): IVSCloneModelSelection | undefined;
	setSelectionForThread(threadId: string, selection: IVSCloneModelSelection): Promise<void>;
	switchToNextModel(threadId: string, location: IVSCloneChatLocation): Promise<IVSCloneModelSelection | undefined>;
	resetSelectionForThread(threadId: string): Promise<void>;
}

export class VSCloneNoopThreadModelSelectionService implements IVSCloneThreadModelSelectionService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeSelection = Event.None;

	async initialize(): Promise<void> {
		return;
	}

	getCurrentSelectionForThread(threadId: string, location: IVSCloneChatLocation): IVSCloneModelSelection | undefined {
		return undefined;
	}

	async setSelectionForThread(threadId: string, selection: IVSCloneModelSelection): Promise<void> {
		return;
	}

	async switchToNextModel(threadId: string, location: IVSCloneChatLocation): Promise<IVSCloneModelSelection | undefined> {
		return undefined;
	}

	async resetSelectionForThread(threadId: string): Promise<void> {
		return;
	}
}
