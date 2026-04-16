/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { VSCloneChatSessionService } from '../../browser/vscloneChatSessionService.js';
import { IVSCloneContextGatheringService } from '../../browser/vscloneContextGatheringService.js';
import { IVSCloneThreadRuntimeHandle, IVSCloneThreadRuntimeRunOptions, IVSCloneThreadRuntimeService } from '../../browser/vscloneThreadRuntimeService.js';
import {
	IVSCloneChatHistoryService,
	IVSCloneChatHistoryThread,
	IVSCloneChatHistoryTurn,
	IVSCloneChatTurnUpdate,
	VSCloneChatHistoryScope,
} from '../../common/backend/vscloneChatHistoryService.js';
import { IVSClonePlanModeService } from '../../common/vsclonePlanModeService.js';
import { type VSCloneChatMode } from '../../common/vsclonePlanModeTypes.js';
import { IVSClonePromptAssemblyService, IVSClonePromptContext } from '../../common/vsclonePromptAssemblyService.js';
import { IVSCloneModelSelection, IVSCloneThreadModelSelectionService } from '../../common/backend/vscloneThreadModelSelectionService.js';

class TestHistoryService implements IVSCloneChatHistoryService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChange = Event.None;

	constructor(private readonly turns: readonly IVSCloneChatHistoryTurn[]) { }

	async initialize(): Promise<void> { }
	getThreads(): readonly IVSCloneChatHistoryThread[] { return []; }
	getTurns(): readonly IVSCloneChatHistoryTurn[] { return this.turns; }
	applyTurnUpdate(_update: IVSCloneChatTurnUpdate): void { }
	async archiveThread(_threadId: string, _archived: boolean): Promise<void> { }
	async deleteThread(_threadId: string): Promise<void> { }
	async clearAll(_scope: VSCloneChatHistoryScope): Promise<void> { }
}

class StaticSelectionService implements IVSCloneThreadModelSelectionService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeSelection = Event.None;

	constructor(private readonly selection: IVSCloneModelSelection) { }

	async initialize(): Promise<void> { }
	getCurrentSelectionForThread(): IVSCloneModelSelection | undefined { return this.selection; }
	async setSelectionForThread(): Promise<void> { }
	async switchToNextModel(): Promise<IVSCloneModelSelection | undefined> { return undefined; }
	async resetSelectionForThread(): Promise<void> { }
	hasSelectionForThread(): boolean { return true; }
	getRecentModelIdentifiers(): readonly string[] { return [this.selection.modelIdentifier]; }
}

class StaticPlanModeService implements IVSClonePlanModeService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeMode = Event.None;

	async initialize(): Promise<void> { }
	getModeForThread(): VSCloneChatMode { return 'act'; }
	async setModeForThread(): Promise<void> { }
	isToolAllowed(): boolean { return true; }
}

class RecordingThreadRuntimeHandle implements IVSCloneThreadRuntimeHandle {
	readonly done = Promise.resolve();
	cancel(): void { }
}

class RecordingThreadRuntimeService implements IVSCloneThreadRuntimeService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeState = Event.None;
	lastOptions: IVSCloneThreadRuntimeRunOptions | undefined;

	runThread(options: IVSCloneThreadRuntimeRunOptions): IVSCloneThreadRuntimeHandle {
		this.lastOptions = options;
		return new RecordingThreadRuntimeHandle();
	}

	recordRejectedTurn(): void { }
	cancelThread(): void { }
	approveLatestToolRequest(): boolean { return false; }
	rejectLatestToolRequest(): boolean { return false; }
	getState(): undefined { return undefined; }
	async rewindToCheckpoint(): Promise<boolean> { return false; }
}

class StaticContextGatheringService implements IVSCloneContextGatheringService {
	declare readonly _serviceBrand: undefined;

	async gatherContext(): Promise<IVSClonePromptContext> {
		return {
			openFiles: [],
			workspaceFolders: [],
			directoryTree: '(empty)',
			diagnostics: [],
		};
	}
}

class RecordingPromptAssemblyService implements IVSClonePromptAssemblyService {
	declare readonly _serviceBrand: undefined;

	assembleSystemMessage(_context: IVSClonePromptContext, _vendor: 'openai' | 'anthropic' | 'google', _mode: VSCloneChatMode): string {
		return 'SYSTEM';
	}
}

function createSelection(): IVSCloneModelSelection {
	return {
		threadId: 'thread-1',
		location: 'chat',
		modelIdentifier: 'openai/gpt-5.3-codex',
		vendor: 'openai',
		modelId: 'gpt-5.3-codex',
		modelName: 'GPT-5.3-Codex',
		selectedAt: Date.now(),
	};
}

function createHistoricalTurn(overrides: Partial<IVSCloneChatHistoryTurn>): IVSCloneChatHistoryTurn {
	return {
		turnId: 'thread-1:turn-1',
		threadId: 'thread-1',
		sequence: 1,
		promptText: 'Initial prompt',
		responseMarkdown: 'Assistant response from markdown',
		responsePlainText: '',
		startedAt: 1,
		status: 'completed',
		...overrides,
	};
}

suite('VSCloneChatExecutionIntegration', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('submit should preserve previous assistant context when only response markdown is stored', async () => {
		const testDisposables = store.add(new DisposableStore());
		const historyService = new TestHistoryService([
			createHistoricalTurn({ responsePlainText: '', responseMarkdown: 'Assistant response from markdown' }),
		]);
		const selectionService = new StaticSelectionService(createSelection());
		const threadRuntimeService = new RecordingThreadRuntimeService();
		const sessionService = testDisposables.add(new VSCloneChatSessionService(
			historyService,
			selectionService,
			new StaticPlanModeService(),
			new NullLogService(),
			threadRuntimeService,
			new StaticContextGatheringService(),
			new RecordingPromptAssemblyService(),
		));

		const result = await sessionService.submitPrompt('Follow up on the earlier answer', {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
		});

		assert.deepStrictEqual(result, {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
		});
		assert.deepStrictEqual(threadRuntimeService.lastOptions?.previousTurns, [
			{ role: 'user', content: 'Initial prompt', imageAttachments: undefined },
			{ role: 'assistant', content: 'Assistant response from markdown' },
		]);
	});
});
