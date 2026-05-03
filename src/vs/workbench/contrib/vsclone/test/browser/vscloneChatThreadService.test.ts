/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { VSCloneChatThreadService } from '../../browser/vscloneChatThreadService.js';
import { IVSCloneContextGatheringService } from '../../browser/vscloneContextGatheringService.js';
import { IVSCloneThreadRuntimeHandle, IVSCloneThreadRuntimeService } from '../../browser/vscloneThreadRuntimeService.js';
import { TestVSCloneUnifiedChatBackendService } from '../common/vscloneTestUnifiedChatBackendService.js';
import { createVSCloneTestFileService } from '../common/vscloneTestFileService.js';
import { type VSCloneChatMode } from '../../common/vsclonePlanModeTypes.js';
import { IVSClonePlanModeService } from '../../common/vsclonePlanModeService.js';
import { IVSCloneModelSelection } from '../../common/vscloneModelSelectionTypes.js';
import type { IVSClonePromptContext } from '../../common/vsclonePrompts.js';
import { IVSCloneReasoningFieldOverrides, IVSCloneSettingsService } from '../../common/vscloneSettingsService.js';
import type { IVSCloneSettingsState } from '../../common/vscloneSettingsTypes.js';
import { IVSCloneThreadRuntimeRunOptions, IVSCloneThreadRuntimeState } from '../../common/vscloneThreadRuntimeTypes.js';
import type { IVSCloneImageAttachment } from '../../common/vscloneImageAttachmentTypes.js';
import type { IVSCloneContextSelection } from '../../common/vscloneContextSelectionTypes.js';

class StaticSettingsService implements IVSCloneSettingsService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeState = Event.None;
	readonly onDidChangeSelection = Event.None;

	constructor(private readonly selection: IVSCloneModelSelection) { }

	async initialize(): Promise<void> { }
	async refreshState(): Promise<void> { }
	getState(): IVSCloneSettingsState { throw new Error('State access is not needed in this focused submit test.'); }
	getProviders() { return []; }
	getModels() { return []; }
	getModelsForFeature() { return []; }
	getModel() { return undefined; }
	getSelectableModels() { return []; }
	getFeatureSelection() { return undefined; }
	getFeatureDefaults() {
		return {
			Chat: { featureName: 'Chat' as const, location: 'chat' as const, selection: undefined },
			Autocomplete: { featureName: 'Autocomplete' as const, location: 'editorInline' as const, selection: undefined },
			Notebook: { featureName: 'Notebook' as const, location: 'notebook' as const, selection: undefined },
			Terminal: { featureName: 'Terminal' as const, location: 'terminal' as const, selection: undefined },
		};
	}
	getCurrentSelectionForFeatureName(): IVSCloneModelSelection | undefined { return this.selection; }
	getCurrentSelectionForFeature(): IVSCloneModelSelection | undefined { return this.selection; }
	getThreadSelectionSnapshot() { return undefined; }
	async setSelectionForFeature(): Promise<void> { }
	async switchToNextModel(): Promise<IVSCloneModelSelection | undefined> { return undefined; }
	async resetSelectionForThread(): Promise<void> { }
	hasSelectionForThread(): boolean { return true; }
	getRecentModels() { return []; }
	getRecentModelIdentifiers(): readonly string[] { return [this.selection.modelIdentifier]; }
	getEligibilityRecords() { return []; }
	getIneligibilityRecord() { return undefined; }
	async markModelIneligible(): Promise<void> { }
	async clearIneligibilityForVendor(): Promise<void> { }
	sanitizeReasoningFields(_modelIdentifier: string, fields: IVSCloneReasoningFieldOverrides): IVSCloneReasoningFieldOverrides { return { ...fields }; }
}

class RecordingSettingsService implements IVSCloneSettingsService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeState = Event.None;
	readonly onDidChangeSelection = Event.None;
	readonly setSelections: IVSCloneModelSelection[] = [];
	private selection: IVSCloneModelSelection | undefined;

	constructor(selection: IVSCloneModelSelection | undefined) {
		this.selection = selection;
	}

	async initialize(): Promise<void> { }
	async refreshState(): Promise<void> { }
	getState(): IVSCloneSettingsState { throw new Error('State access is not needed in this focused submit test.'); }
	getProviders() { return []; }
	getModels() { return []; }
	getModelsForFeature() { return []; }
	getModel() { return undefined; }
	getSelectableModels() { return []; }
	getFeatureSelection() { return undefined; }
	getFeatureDefaults() {
		return {
			Chat: { featureName: 'Chat' as const, location: 'chat' as const, selection: undefined },
			Autocomplete: { featureName: 'Autocomplete' as const, location: 'editorInline' as const, selection: undefined },
			Notebook: { featureName: 'Notebook' as const, location: 'notebook' as const, selection: undefined },
			Terminal: { featureName: 'Terminal' as const, location: 'terminal' as const, selection: undefined },
		};
	}
	getCurrentSelectionForFeatureName(): IVSCloneModelSelection | undefined { return this.selection; }
	getCurrentSelectionForFeature(): IVSCloneModelSelection | undefined { return this.selection; }
	getThreadSelectionSnapshot() { return undefined; }
	async setSelectionForFeature(_threadId: string, selection: IVSCloneModelSelection): Promise<void> {
		this.selection = { ...selection };
		this.setSelections.push({ ...selection });
	}
	async switchToNextModel(): Promise<IVSCloneModelSelection | undefined> { return undefined; }
	async resetSelectionForThread(): Promise<void> { this.selection = undefined; }
	hasSelectionForThread(): boolean { return this.selection !== undefined; }
	getRecentModels() { return []; }
	getRecentModelIdentifiers(): readonly string[] { return this.selection ? [this.selection.modelIdentifier] : []; }
	getEligibilityRecords() { return []; }
	getIneligibilityRecord() { return undefined; }
	async markModelIneligible(): Promise<void> { }
	async clearIneligibilityForVendor(): Promise<void> { }
	sanitizeReasoningFields(_modelIdentifier: string, fields: IVSCloneReasoningFieldOverrides): IVSCloneReasoningFieldOverrides { return { ...fields }; }
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
	readonly statesByThreadId = new Map<string, IVSCloneThreadRuntimeState>();
	lastOptions: IVSCloneThreadRuntimeRunOptions | undefined;
	lastRejectedTurn: {
		threadId: string;
		turnId: string;
		sessionResource: string;
		promptText: string;
		mode: IVSCloneThreadRuntimeRunOptions['mode'];
		reason: string;
		imageAttachments?: IVSCloneThreadRuntimeRunOptions['imageAttachments'];
		contextSelections?: IVSCloneThreadRuntimeRunOptions['contextSelections'];
	} | undefined;
	cancelledThreadId: string | undefined;
	deletedThreadId: string | undefined;
	clearAllCallCount = 0;

	runThread(options: IVSCloneThreadRuntimeRunOptions): IVSCloneThreadRuntimeHandle {
		this.lastOptions = options;
		return new RecordingThreadRuntimeHandle();
	}

	recordRejectedTurn(options: NonNullable<RecordingThreadRuntimeService['lastRejectedTurn']>): void {
		this.lastRejectedTurn = options;
	}
	cancelThread(threadId: string): void { this.cancelledThreadId = threadId; }
	approveLatestToolRequest(): boolean { return false; }
	rejectLatestToolRequest(): boolean { return false; }
	answerLatestToolRequest(): boolean { return false; }
	isAutoApproveEdits(): boolean { return false; }
	setAutoApproveEdits(): void { }
	readonly onDidChangeAutoApproveEdits = Event.None;
	getThreads(): readonly [] { return []; }
	isDeletedThread(): boolean { return false; }
	archiveThread(): boolean { return false; }
	deleteThread(threadId: string): boolean {
		this.deletedThreadId = threadId;
		return true;
	}
	clearAll(): void {
		this.clearAllCallCount++;
	}
	getState(threadId: string): IVSCloneThreadRuntimeState | undefined { return this.statesByThreadId.get(threadId); }
	async rewindToCheckpoint(): Promise<boolean> { return false; }
}

class StaticContextGatheringService implements IVSCloneContextGatheringService {
	declare readonly _serviceBrand: undefined;

	async gatherContext(): Promise<IVSClonePromptContext> {
		return {};
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

function createSelectionWithOverrides(overrides: Partial<IVSCloneModelSelection>): IVSCloneModelSelection {
	return {
		...createSelection(),
		...overrides,
	};
}

function createThreadSelection(threadId: string): IVSCloneModelSelection {
	return createSelectionWithOverrides({ threadId });
}

function createRuntimeState(threadId: string, messages: IVSCloneThreadRuntimeState['messages']): IVSCloneThreadRuntimeState {
	return {
		threadId,
		catalog: {
			threadId,
			sessionResource: `vsclone://api/${threadId}`,
			title: 'Existing thread',
			createdAt: 1,
			updatedAt: 2,
			status: 'completed',
			archived: false,
			turnCount: 1,
			lastTurnPreview: 'Assistant response',
		},
		streamState: { kind: 'idle' },
		messages,
		checkpoints: [],
		lastUpdatedAt: 2,
	};
}

suite('VSCloneChatThreadService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('owns prompt submission and thread cancellation without going through the legacy session facade', async () => {
		const testDisposables = store.add(new DisposableStore());
		const settingsService = new StaticSettingsService(createSelection());
		const runtimeService = new RecordingThreadRuntimeService();
		runtimeService.statesByThreadId.set('thread-1', {
			threadId: 'thread-1',
			catalog: {
				threadId: 'thread-1',
				title: 'Existing thread',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Assistant response',
			},
			streamState: { kind: 'idle' },
			messages: [
				{
					id: 'thread-1:turn-1:user',
					role: 'user',
					mode: 'act',
					createdAt: 1,
					content: 'Initial prompt',
				},
				{
					id: 'thread-1:turn-1:assistant',
					role: 'assistant',
					mode: 'act',
					createdAt: 2,
					content: 'Assistant response',
				},
			],
			checkpoints: [],
			lastUpdatedAt: 2,
		});
		const threadService = testDisposables.add(new VSCloneChatThreadService(
			settingsService,
			new StaticPlanModeService(),
			new NullLogService(),
			runtimeService,
			new StaticContextGatheringService(),
			new TestVSCloneUnifiedChatBackendService(),
			createVSCloneTestFileService(),
		));

		const result = await threadService.sendMessage('Follow up on the earlier answer', {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
		});
		threadService.cancelThread('thread-1');

		assert.deepStrictEqual(result, {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
		});
		assert.deepStrictEqual(runtimeService.lastOptions?.previousTurns, [
			{ role: 'user', content: 'Initial prompt' },
			{ role: 'assistant', content: 'Assistant response' },
		]);
		assert.ok(runtimeService.lastOptions?.systemMessage?.includes('## Available Tools'));
		assert.ok(runtimeService.lastOptions?.systemMessage?.includes('(no active text editor; use tools to inspect the relevant files)'));
		assert.strictEqual(runtimeService.lastOptions?.mode, 'act');
		assert.strictEqual(runtimeService.cancelledThreadId, 'thread-1');
	});

	test('continues a restored thread when the pane only passes the thread id', async () => {
		const testDisposables = store.add(new DisposableStore());
		const runtimeService = new RecordingThreadRuntimeService();
		runtimeService.statesByThreadId.set('thread-restored', {
			threadId: 'thread-restored',
			catalog: {
				threadId: 'thread-restored',
				sessionResource: 'vsclone://api/original-session',
				title: 'Restored chat',
				createdAt: 1,
				updatedAt: 2,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Assistant response',
			},
			streamState: { kind: 'idle' },
			messages: [
				{
					id: 'thread-restored:turn-1:user',
					role: 'user',
					mode: 'act',
					createdAt: 1,
					content: 'Initial prompt',
				},
				{
					id: 'thread-restored:turn-1:assistant',
					role: 'assistant',
					mode: 'act',
					createdAt: 2,
					content: 'Assistant response',
				},
			],
			checkpoints: [],
			lastUpdatedAt: 2,
		});
		const threadService = testDisposables.add(new VSCloneChatThreadService(
			new StaticSettingsService(createSelection()),
			new StaticPlanModeService(),
			new NullLogService(),
			runtimeService,
			new StaticContextGatheringService(),
			new TestVSCloneUnifiedChatBackendService(),
			createVSCloneTestFileService(),
		));

		const result = await threadService.sendMessage('Follow up after reload', {
			threadId: 'thread-restored',
			// Reopened views can briefly lack this rail-side cache value; runtime state remains the
			// canonical continuation source and must prevent accidental new-chat creation.
			sessionResource: undefined,
		});

		assert.deepStrictEqual(result, {
			threadId: 'thread-restored',
			sessionResource: 'vsclone://api/original-session',
		});
		assert.strictEqual(runtimeService.lastOptions?.threadId, 'thread-restored');
		assert.strictEqual(runtimeService.lastOptions?.sessionResource, 'vsclone://api/original-session');
		assert.deepStrictEqual(runtimeService.lastOptions?.previousTurns, [
			{ role: 'user', content: 'Initial prompt' },
			{ role: 'assistant', content: 'Assistant response' },
		]);
	});

	test('updates an existing thread binding when the submit-time selection changes', async () => {
		const testDisposables = store.add(new DisposableStore());
		const settingsService = new RecordingSettingsService(createSelectionWithOverrides({
			reasoningEffort: 'minimal',
		}));
		const runtimeService = new RecordingThreadRuntimeService();
		const threadService = testDisposables.add(new VSCloneChatThreadService(
			settingsService,
			new StaticPlanModeService(),
			new NullLogService(),
			runtimeService,
			new StaticContextGatheringService(),
			new TestVSCloneUnifiedChatBackendService(),
			createVSCloneTestFileService(),
		));

		await threadService.sendMessage('Use the updated selection for this turn', {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
			// Follow-up sends must honor the picker snapshot passed with this submission instead of
			// reusing the stale per-thread binding that was stored on an earlier turn.
			modelSelection: createSelectionWithOverrides({
				modelIdentifier: 'openai/gpt-5.4-codex',
				modelId: 'gpt-5.4-codex',
				modelName: 'GPT-5.4-Codex',
				reasoningEffort: 'high',
			}),
		});

		assert.strictEqual(settingsService.setSelections.length, 1);
		assert.strictEqual(settingsService.setSelections[0].modelIdentifier, 'openai/gpt-5.4-codex');
		assert.strictEqual(settingsService.setSelections[0].reasoningEffort, 'high');
		assert.strictEqual(runtimeService.lastOptions?.modelIdentifier, 'openai/gpt-5.4-codex');
		assert.strictEqual(runtimeService.lastOptions?.reasoningEffort, 'high');
	});

	test('replays rich previous turns while skipping non-result tool messages', async () => {
		const testDisposables = store.add(new DisposableStore());
		const runtimeService = new RecordingThreadRuntimeService();
		const imageAttachments: readonly IVSCloneImageAttachment[] = [
			{ mimeType: 'image/png', base64Data: 'iVBORw0KGgo=' },
		];
		const contextSelections: readonly IVSCloneContextSelection[] = [
			{ kind: 'file', uri: URI.file('/workspace/src/app.ts'), languageId: 'typescript' },
		];
		runtimeService.statesByThreadId.set('thread-rich', createRuntimeState('thread-rich', [
			{
				id: 'thread-rich:turn-1:user',
				role: 'user',
				mode: 'act',
				createdAt: 1,
				content: 'Initial prompt',
				imageAttachments,
				contextSelections,
			},
			{
				id: 'thread-rich:turn-1:assistant',
				role: 'assistant',
				mode: 'act',
				createdAt: 2,
				content: 'Assistant response',
				anthropicReasoning: [
					{ type: 'thinking', thinking: 'private chain', signature: 'sig-1' },
				],
			},
			{
				id: 'thread-rich:turn-1:tool-progress',
				role: 'tool',
				type: 'running_now',
				createdAt: 3,
				toolName: 'read_file',
				params: { path: 'src/app.ts' },
			},
			{
				id: 'thread-rich:turn-1:tool-result',
				role: 'tool',
				type: 'success',
				createdAt: 4,
				toolName: 'read_file',
				params: { path: 'src/app.ts' },
				output: 'export const value = 1;',
				success: true,
			},
		]));
		const threadService = testDisposables.add(new VSCloneChatThreadService(
			new StaticSettingsService(createSelection()),
			new StaticPlanModeService(),
			new NullLogService(),
			runtimeService,
			new StaticContextGatheringService(),
			new TestVSCloneUnifiedChatBackendService(),
			createVSCloneTestFileService(),
		));

		await threadService.sendMessage('Continue with the existing context', {
			threadId: 'thread-rich',
		});

		assert.deepStrictEqual(runtimeService.lastOptions?.previousTurns, [
			{
				role: 'user',
				content: 'Initial prompt',
				imageAttachments,
				contextSelections,
			},
			{
				role: 'assistant',
				content: 'Assistant response',
				anthropicReasoning: [
					{ type: 'thinking', thinking: 'private chain', signature: 'sig-1' },
				],
			},
			{
				role: 'tool',
				id: 'thread-rich:turn-1:tool-result',
				name: 'read_file',
				rawParams: { path: 'src/app.ts' },
				content: '<tool_result tool_name="read_file" success="true">\nexport const value = 1;\n</tool_result>',
			},
		]);
		assert.strictEqual(runtimeService.lastOptions?.sequence, 2);
	});

	test('records a rejected turn with attachments when no API-backed model is selected', async () => {
		const testDisposables = store.add(new DisposableStore());
		const runtimeService = new RecordingThreadRuntimeService();
		const settingsService = new RecordingSettingsService(undefined);
		const imageAttachments: readonly IVSCloneImageAttachment[] = [
			{ mimeType: 'image/jpeg', base64Data: '/9j/4AAQSkZJRg==' },
		];
		const contextSelections: readonly IVSCloneContextSelection[] = [
			{ kind: 'folder', uri: URI.file('/workspace/src') },
		];
		const threadService = testDisposables.add(new VSCloneChatThreadService(
			settingsService,
			new StaticPlanModeService(),
			new NullLogService(),
			runtimeService,
			new StaticContextGatheringService(),
			new TestVSCloneUnifiedChatBackendService(),
			createVSCloneTestFileService(),
		));

		const result = await threadService.sendMessage('   Please inspect the selected folder   ', {
			threadId: 'thread-rejected',
			sessionResource: 'vsclone://api/thread-rejected',
			imageAttachments,
			contextSelections,
		});

		assert.deepStrictEqual(result, {
			threadId: 'thread-rejected',
			sessionResource: 'vsclone://api/thread-rejected',
		});
		assert.strictEqual(runtimeService.lastOptions, undefined);
		assert.strictEqual(runtimeService.lastRejectedTurn?.threadId, 'thread-rejected');
		assert.strictEqual(runtimeService.lastRejectedTurn?.sessionResource, 'vsclone://api/thread-rejected');
		assert.strictEqual(runtimeService.lastRejectedTurn?.promptText, 'Please inspect the selected folder');
		assert.strictEqual(runtimeService.lastRejectedTurn?.mode, 'act');
		assert.strictEqual(runtimeService.lastRejectedTurn?.reason, 'Sign in to a provider and choose a model before sending messages through VSClone.');
		assert.strictEqual(runtimeService.lastRejectedTurn?.imageAttachments, imageAttachments);
		assert.strictEqual(runtimeService.lastRejectedTurn?.contextSelections, contextSelections);
		assert.strictEqual(/^thread-rejected:rejected:\d+$/.test(runtimeService.lastRejectedTurn?.turnId ?? ''), true);
	});

	test('deleteThread clears unified backend sidecars after the runtime reports a successful delete', async () => {
		const testDisposables = store.add(new DisposableStore());
		const runtimeService = new RecordingThreadRuntimeService();
		const backendService = new TestVSCloneUnifiedChatBackendService();
		await backendService.replaceSelectionState({
			selectedByThread: {
				'thread-1': {
					chat: createThreadSelection('thread-1'),
				},
			},
			selectedByLocation: {},
			recentModelIdentifiers: ['openai/gpt-5.3-codex'],
		});
		await backendService.replacePlanModeState({
			modeByThread: {
				'thread-1': 'plan',
			},
		});
		const threadService = testDisposables.add(new VSCloneChatThreadService(
			new StaticSettingsService(createSelection()),
			new StaticPlanModeService(),
			new NullLogService(),
			runtimeService,
			new StaticContextGatheringService(),
			backendService,
			createVSCloneTestFileService(),
		));

		// The service-level delete contract matters because the runtime owns transcript data while
		// the backend owns the per-thread UI sidecars. A successful delete has to clear both layers.
		const deleted = await threadService.deleteThread('thread-1');

		assert.strictEqual(deleted, true);
		assert.strictEqual(runtimeService.cancelledThreadId, 'thread-1');
		assert.strictEqual(runtimeService.deletedThreadId, 'thread-1');
		assert.deepStrictEqual(backendService.getSelectionState().selectedByThread, {});
		assert.deepStrictEqual(backendService.getPlanModeState().modeByThread, {});
	});

	test('clearAll clears unified backend sidecars after runtime history is reset', async () => {
		const testDisposables = store.add(new DisposableStore());
		const runtimeService = new RecordingThreadRuntimeService();
		const backendService = new TestVSCloneUnifiedChatBackendService();
		await backendService.replaceSelectionState({
			selectedByThread: {
				'thread-1': {
					chat: createThreadSelection('thread-1'),
				},
			},
			selectedByLocation: {
				chat: createThreadSelection('thread-1'),
			},
			recentModelIdentifiers: ['openai/gpt-5.3-codex'],
		});
		await backendService.replacePlanModeState({
			modeByThread: {
				'thread-1': 'plan',
			},
		});
		const threadService = testDisposables.add(new VSCloneChatThreadService(
			new StaticSettingsService(createSelection()),
			new StaticPlanModeService(),
			new NullLogService(),
			runtimeService,
			new StaticContextGatheringService(),
			backendService,
			createVSCloneTestFileService(),
		));

		await threadService.clearAll();

		assert.strictEqual(runtimeService.clearAllCallCount, 1);
		assert.deepStrictEqual(backendService.getSelectionState(), {
			selectedByThread: {},
			selectedByLocation: {},
			recentModelIdentifiers: [],
		});
		assert.deepStrictEqual(backendService.getPlanModeState(), {
			modeByThread: {},
		});
	});
});
