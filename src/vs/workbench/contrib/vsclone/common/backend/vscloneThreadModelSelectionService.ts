/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IVSCloneSettingsService } from '../vscloneSettingsService.js';
import type {
	IVSCloneChatLocation,
	IVSCloneModelSelection,
	IVSCloneModelSelectionChangeEvent,
} from '../vscloneModelSelectionTypes.js';

export const IVSCloneThreadModelSelectionService = createDecorator<IVSCloneThreadModelSelectionService>('vsCloneThreadModelSelectionService');

export type {
	IVSCloneChatLocation,
	IVSCloneModelSelection,
	IVSCloneModelSelectionChangeEvent,
};

export interface IVSCloneThreadModelSelectionService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSelection: Event<IVSCloneModelSelectionChangeEvent>;
	initialize(): Promise<void>;
	getCurrentSelectionForThread(threadId: string, location: IVSCloneChatLocation): IVSCloneModelSelection | undefined;
	setSelectionForThread(threadId: string, selection: IVSCloneModelSelection): Promise<void>;
	switchToNextModel(threadId: string, location: IVSCloneChatLocation): Promise<IVSCloneModelSelection | undefined>;
	resetSelectionForThread(threadId: string): Promise<void>;
	hasSelectionForThread(threadId: string): boolean;
	getRecentModelIdentifiers(limit?: number): readonly string[];
}

/**
 * Phase 2 moves selection policy into `VSCloneSettingsService`. This adapter keeps the historical
 * decorator alive for churn control while ensuring there is only one live owner for defaults,
 * thread-effective snapshots, and selection reconciliation.
 */
export class VSCloneThreadModelSelectionService extends Disposable implements IVSCloneThreadModelSelectionService {
	declare readonly _serviceBrand: undefined;

	readonly onDidChangeSelection: Event<IVSCloneModelSelectionChangeEvent>;

	constructor(
		@IVSCloneSettingsService private readonly settingsService: IVSCloneSettingsService,
	) {
		super();
		this.onDidChangeSelection = this.settingsService.onDidChangeSelection;
	}

	initialize(): Promise<void> {
		return this.settingsService.initialize();
	}

	getCurrentSelectionForThread(threadId: string, location: IVSCloneChatLocation): IVSCloneModelSelection | undefined {
		return this.settingsService.getCurrentSelectionForFeature(threadId, location);
	}

	setSelectionForThread(threadId: string, selection: IVSCloneModelSelection): Promise<void> {
		return this.settingsService.setSelectionForFeature(threadId, selection);
	}

	switchToNextModel(threadId: string, location: IVSCloneChatLocation): Promise<IVSCloneModelSelection | undefined> {
		return this.settingsService.switchToNextModel(threadId, location);
	}

	resetSelectionForThread(threadId: string): Promise<void> {
		return this.settingsService.resetSelectionForThread(threadId);
	}

	hasSelectionForThread(threadId: string): boolean {
		return this.settingsService.hasSelectionForThread(threadId);
	}

	getRecentModelIdentifiers(limit?: number): readonly string[] {
		return this.settingsService.getRecentModelIdentifiers(limit);
	}
}

export class VSCloneNoopThreadModelSelectionService implements IVSCloneThreadModelSelectionService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeSelection = Event.None;

	async initialize(): Promise<void> {
		return;
	}

	getCurrentSelectionForThread(_threadId: string, _location: IVSCloneChatLocation): IVSCloneModelSelection | undefined {
		return undefined;
	}

	async setSelectionForThread(_threadId: string, _selection: IVSCloneModelSelection): Promise<void> {
		return;
	}

	async switchToNextModel(_threadId: string, _location: IVSCloneChatLocation): Promise<IVSCloneModelSelection | undefined> {
		return undefined;
	}

	async resetSelectionForThread(_threadId: string): Promise<void> {
		return;
	}

	hasSelectionForThread(_threadId: string): boolean {
		return false;
	}

	getRecentModelIdentifiers(_limit = 3): readonly string[] {
		return [];
	}
}
