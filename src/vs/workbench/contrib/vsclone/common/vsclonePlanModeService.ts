/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IVSCloneUnifiedChatBackendService } from './backend/vscloneUnifiedChatBackendService.js';
import { normalizeVSCloneThreadId } from './vscloneModelSelectionTypes.js';
import { VSCLONE_TOOL_DEFINITIONS } from './vscloneToolDefinitions.js';
import { type VSCloneChatMode } from './vsclonePlanModeTypes.js';

export const IVSClonePlanModeService = createDecorator<IVSClonePlanModeService>('vsclonePlanModeService');

export interface IVSClonePlanModeChangeEvent {
	readonly threadId?: string;
	readonly mode: VSCloneChatMode;
}

export interface IVSClonePlanModeService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeMode: Event<IVSClonePlanModeChangeEvent>;
	initialize(): Promise<void>;
	getModeForThread(threadId?: string): VSCloneChatMode;
	setModeForThread(threadId: string | undefined, mode: VSCloneChatMode): Promise<void>;
	isToolAllowed(mode: VSCloneChatMode, toolName: string): boolean;
}

function clonePlanModeState(modeByThread: Record<string, VSCloneChatMode>): Record<string, VSCloneChatMode> {
	return { ...modeByThread };
}

/**
 * The service owns just enough mutable state to keep the unsaved composer usable. Thread-specific
 * persistence still lives in the unified backend so restored threads and execution read the same
 * source of truth.
 */
export class VSClonePlanModeService extends Disposable implements IVSClonePlanModeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeMode = this._register(new Emitter<IVSClonePlanModeChangeEvent>());
	readonly onDidChangeMode = this._onDidChangeMode.event;

	private initializing: Promise<void> | undefined;
	private initialized = false;
	private composerMode: VSCloneChatMode = 'act';

	constructor(
		@IVSCloneUnifiedChatBackendService private readonly backendService: IVSCloneUnifiedChatBackendService,
	) {
		super();
	}

	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		if (this.initializing) {
			return this.initializing;
		}

		this.initializing = this.backendService.initialize().then(() => {
			this.initialized = true;
		}).finally(() => {
			this.initializing = undefined;
		});

		return this.initializing;
	}

	getModeForThread(threadId?: string): VSCloneChatMode {
		const normalizedThreadId = normalizeVSCloneThreadId(threadId ?? '');
		if (!normalizedThreadId) {
			return this.composerMode;
		}

		const mode = this.backendService.getPlanModeState().modeByThread[normalizedThreadId];
		return mode ?? 'act';
	}

	async setModeForThread(threadId: string | undefined, mode: VSCloneChatMode): Promise<void> {
		const normalizedThreadId = normalizeVSCloneThreadId(threadId ?? '');
		if (!normalizedThreadId) {
			if (this.composerMode === mode) {
				return;
			}
			this.composerMode = mode;
			this._onDidChangeMode.fire({ threadId: undefined, mode });
			return;
		}

		await this.initialize();
		const currentState = this.backendService.getPlanModeState();
		if (currentState.modeByThread[normalizedThreadId] === mode) {
			return;
		}

		const nextState = clonePlanModeState(currentState.modeByThread);
		nextState[normalizedThreadId] = mode;
		await this.backendService.replacePlanModeState({ modeByThread: nextState });
		this._onDidChangeMode.fire({ threadId: normalizedThreadId, mode });
	}

	isToolAllowed(mode: VSCloneChatMode, toolName: string): boolean {
		const tool = VSCLONE_TOOL_DEFINITIONS.find(candidate => candidate.name === toolName);
		if (!tool) {
			return false;
		}

		return mode === 'plan' ? tool.planModeAllowed : true;
	}
}
