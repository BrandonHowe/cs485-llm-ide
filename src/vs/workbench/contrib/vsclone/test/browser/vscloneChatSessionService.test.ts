/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService, ILogService } from '../../../../../platform/log/common/log.js';
import { IVSCloneAgentLoopHandle, IVSCloneAgentLoopOptions, IVSCloneAgentLoopService } from '../../browser/vscloneAgentLoopService.js';
import { VSCloneChatSessionService } from '../../browser/vscloneChatSessionService.js';
import { IVSCloneContextGatheringService } from '../../browser/vscloneContextGatheringService.js';
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
import { IVSCloneImageAttachment } from '../../common/vscloneImageAttachmentTypes.js';
import { IVSCloneModelSelection, IVSCloneThreadModelSelectionService } from '../../common/backend/vscloneThreadModelSelectionService.js';

class TestHistoryService implements IVSCloneChatHistoryService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChange = Event.None;
	readonly updates: IVSCloneChatTurnUpdate[] = [];
	readonly threads: IVSCloneChatHistoryThread[] = [];
	readonly turnsByThread = new Map<string, readonly IVSCloneChatHistoryTurn[]>();
	initializeCalls = 0;

	async initialize(): Promise<void> {
		this.initializeCalls += 1;
	}

	getThreads(): readonly IVSCloneChatHistoryThread[] {
		return this.threads;
	}

	getTurns(threadId: string): readonly IVSCloneChatHistoryTurn[] {
		return this.turnsByThread.get(threadId) ?? [];
	}

	applyTurnUpdate(update: IVSCloneChatTurnUpdate): void {
		this.updates.push(update);
	}

	async archiveThread(_threadId: string, _archived: boolean): Promise<void> { }
	async deleteThread(_threadId: string): Promise<void> { }
	async clearAll(_scope: VSCloneChatHistoryScope): Promise<void> { }
}

class TestAgentLoopHandle implements IVSCloneAgentLoopHandle {
	readonly done: Promise<void>;
	cancelCalls = 0;
	private doneResolver: (() => void) | undefined;

	constructor() {
		this.done = new Promise<void>(resolve => {
			this.doneResolver = resolve;
		});
	}

	cancel(): void {
		this.cancelCalls += 1;
	}

	complete(): void {
		this.doneResolver?.();
		this.doneResolver = undefined;
	}
}

class TestAgentLoopService implements IVSCloneAgentLoopService {
	declare readonly _serviceBrand: undefined;
	readonly handlesByTurnId = new Map<string, TestAgentLoopHandle>();
	lastRunOptions: IVSCloneAgentLoopOptions | undefined;
	runCalls = 0;

	runAgentLoop(options: IVSCloneAgentLoopOptions): IVSCloneAgentLoopHandle {
		this.runCalls += 1;
		this.lastRunOptions = options;
		const handle = new TestAgentLoopHandle();
		this.handlesByTurnId.set(options.turnId, handle);
		return handle;
	}

	completeLastRun(): void {
		if (!this.lastRunOptions) {
			return;
		}

		this.handlesByTurnId.get(this.lastRunOptions.turnId)?.complete();
	}
}

class TestSelectionService implements IVSCloneThreadModelSelectionService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeSelection = Event.None;
	readonly selectedByThread = new Map<string, IVSCloneModelSelection>();
	readonly locationSelection = new Map<'chat' | 'editorInline' | 'notebook' | 'terminal', IVSCloneModelSelection>();
	initializeCalls = 0;
	setCalls = 0;
	resetCalls = 0;

	constructor(initialSelections: readonly [string, IVSCloneModelSelection][] = []) {
		for (const [threadId, selection] of initialSelections) {
			this.selectedByThread.set(threadId, { ...selection, threadId });
		}
	}

	async initialize(): Promise<void> {
		this.initializeCalls += 1;
	}

	getCurrentSelectionForThread(threadId: string, location: 'chat' | 'editorInline' | 'notebook' | 'terminal'): IVSCloneModelSelection | undefined {
		return this.selectedByThread.get(threadId) ?? this.locationSelection.get(location);
	}

	async setSelectionForThread(threadId: string, selection: IVSCloneModelSelection): Promise<void> {
		this.setCalls += 1;
		this.selectedByThread.set(threadId, { ...selection, threadId });
		this.locationSelection.set(selection.location, { ...selection, threadId: undefined });
	}

	async switchToNextModel(_threadId: string, _location: 'chat' | 'editorInline' | 'notebook' | 'terminal'): Promise<IVSCloneModelSelection | undefined> {
		return undefined;
	}

	async resetSelectionForThread(threadId: string): Promise<void> {
		this.resetCalls += 1;
		this.selectedByThread.delete(threadId);
	}

	hasSelectionForThread(threadId: string): boolean {
		return this.selectedByThread.has(threadId);
	}

	getRecentModelIdentifiers(limit = 3): readonly string[] {
		return [...this.selectedByThread.values()].map(selection => selection.modelIdentifier).slice(0, limit);
	}
}

class TestPlanModeService implements IVSClonePlanModeService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeMode = Event.None;
	readonly modeByThread = new Map<string, VSCloneChatMode>();
	initializeCalls = 0;
	setCalls = 0;
	private composerMode: VSCloneChatMode = 'act';

	async initialize(): Promise<void> {
		this.initializeCalls += 1;
	}

	getModeForThread(threadId?: string): VSCloneChatMode {
		if (!threadId) {
			return this.composerMode;
		}

		return this.modeByThread.get(threadId) ?? 'act';
	}

	async setModeForThread(threadId: string | undefined, mode: VSCloneChatMode): Promise<void> {
		this.setCalls += 1;
		if (!threadId) {
			this.composerMode = mode;
			return;
		}

		this.modeByThread.set(threadId, mode);
	}

	isToolAllowed(mode: VSCloneChatMode, toolName: string): boolean {
		return mode === 'act' || toolName === 'read_file' || toolName === 'list_directory' || toolName === 'search_files' || toolName === 'attempt_completion';
	}
}

class RecordingLogService extends NullLogService implements ILogService {
	readonly infoCalls: unknown[][] = [];
	readonly warnCalls: unknown[][] = [];
	readonly errorCalls: unknown[][] = [];

	override info(message: string, ...args: unknown[]): void {
		this.infoCalls.push([message, ...args]);
	}

	override warn(message: string | Error, ...args: unknown[]): void {
		this.warnCalls.push([message, ...args]);
	}

	override error(message: string | Error, ...args: unknown[]): void {
		this.errorCalls.push([message, ...args]);
	}
}

class TestContextGatheringService implements IVSCloneContextGatheringService {
	declare readonly _serviceBrand: undefined;
	calls = 0;

	constructor(
		private readonly context: IVSClonePromptContext,
		private readonly throwOnGather?: Error,
	) { }

	async gatherContext(): Promise<IVSClonePromptContext> {
		this.calls += 1;
		if (this.throwOnGather) {
			throw this.throwOnGather;
		}

		return this.context;
	}
}

class TestPromptAssemblyService implements IVSClonePromptAssemblyService {
	declare readonly _serviceBrand: undefined;
	calls = 0;
	lastContext: IVSClonePromptContext | undefined;
	lastVendor: string | undefined;
	lastMode: VSCloneChatMode | undefined;

	assembleSystemMessage(context: IVSClonePromptContext, vendor: 'openai' | 'anthropic' | 'google', mode: VSCloneChatMode): string {
		this.calls += 1;
		this.lastContext = context;
		this.lastVendor = vendor;
		this.lastMode = mode;
		return `SYSTEM:${vendor}:${mode}`;
	}
}

function createModelSelection(overrides: Partial<IVSCloneModelSelection> = {}): IVSCloneModelSelection {
	return {
		threadId: 'thread-1',
		location: 'chat',
		modelIdentifier: 'openai/gpt-5.3-codex',
		vendor: 'openai',
		modelId: 'gpt-5.3-codex',
		modelName: 'GPT-5.3-Codex',
		reasoningEffort: 'high',
		selectedAt: Date.now(),
		...overrides,
	};
}

function createTurn(threadId: string, overrides: Partial<IVSCloneChatHistoryTurn> = {}): IVSCloneChatHistoryTurn {
	return {
		turnId: `${threadId}:turn-1`,
		threadId,
		sequence: 1,
		modelIdentifier: 'openai/gpt-5.3-codex',
		providerId: 'openai',
		promptText: 'Existing prompt',
		promptImages: [{ mimeType: 'image/png', base64Data: 'ZmFrZQ==' }],
		responseMarkdown: 'Existing response',
		responsePlainText: 'Existing response',
		startedAt: 1,
		completedAt: 2,
		status: 'completed',
		lastEventAt: 2,
		...overrides,
	};
}

function createImageAttachment(): IVSCloneImageAttachment {
	return {
		mimeType: 'image/png',
		base64Data: 'ZmFrZQ==',
	};
}

function createContext(): IVSClonePromptContext {
	return {
		activeFile: undefined,
		openFiles: [],
		workspaceFolders: [],
		directoryTree: '(no workspace folders)',
		diagnostics: [],
	};
}

function createHarness(options: {
	readonly turnsByThread?: readonly [string, readonly IVSCloneChatHistoryTurn[]][];
	readonly selections?: readonly [string, IVSCloneModelSelection][];
	readonly modeByThread?: readonly [string, VSCloneChatMode][];
	readonly context?: IVSClonePromptContext;
	readonly contextError?: Error;
} = {}) {
	const testDisposables = new DisposableStore();
	const historyService = new TestHistoryService();
	const selectionService = new TestSelectionService(options.selections);
	const planModeService = new TestPlanModeService();
	const logService = new RecordingLogService();
	const agentLoopService = new TestAgentLoopService();
	const contextGatheringService = new TestContextGatheringService(options.context ?? createContext(), options.contextError);
	const promptAssemblyService = new TestPromptAssemblyService();

	for (const [threadId, turns] of options.turnsByThread ?? []) {
		historyService.turnsByThread.set(threadId, turns);
	}
	for (const [threadId, mode] of options.modeByThread ?? []) {
		planModeService.modeByThread.set(threadId, mode);
	}

	const service = testDisposables.add(new VSCloneChatSessionService(
		historyService,
		selectionService,
		planModeService,
		logService,
		agentLoopService,
		contextGatheringService,
		promptAssemblyService,
	));

	return {
		testDisposables,
		service,
		historyService,
		selectionService,
		planModeService,
		logService,
		agentLoopService,
		contextGatheringService,
		promptAssemblyService,
	};
}

interface IChatSessionServiceInternals {
	readonly apiRequestHandles: Map<string, TestAgentLoopHandle>;
	ensureThreadSelectionBinding(threadId: string, selection: IVSCloneModelSelection | undefined): Promise<IVSCloneModelSelection | undefined>;
	getApiVendor(selection: IVSCloneModelSelection | undefined): 'openai' | 'anthropic' | 'google' | undefined;
}

function asInternals(service: VSCloneChatSessionService): VSCloneChatSessionService & IChatSessionServiceInternals {
	// These tests intentionally verify private coordination state because submitPrompt delegates
	// selection binding and active-request lifetime management through those helpers.
	return service as unknown as VSCloneChatSessionService & IChatSessionServiceInternals;
}

suite('VSCloneChatSessionService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('CS-01 constructor creates the service without side effects', () => {
		const harness = createHarness();
		store.add(harness.testDisposables);

		assert.ok(harness.service);
		assert.strictEqual(asInternals(harness.service).apiRequestHandles.size, 0);
		assert.strictEqual(harness.selectionService.initializeCalls, 0);
		assert.strictEqual(harness.planModeService.initializeCalls, 0);
		assert.strictEqual(harness.agentLoopService.runCalls, 0);
		assert.strictEqual(harness.contextGatheringService.calls, 0);
		assert.strictEqual(harness.promptAssemblyService.calls, 0);
	});

	test('CS-02 submitPrompt allocates an API session resource under the vsclone://api/ namespace', async () => {
		const harness = createHarness({
			selections: [['thread-1', createModelSelection()]],
		});
		store.add(harness.testDisposables);
		const result = await harness.service.submitPrompt('Route this prompt', {
			modelSelection: createModelSelection({ threadId: undefined }),
		});

		assert.ok(result);
		assert.ok(result.sessionResource.startsWith('vsclone://api/'));
		const encodedSessionId = result.sessionResource.slice('vsclone://api/'.length);
		assert.strictEqual(encodeURIComponent(decodeURIComponent(encodedSessionId)), encodedSessionId);
		assert.strictEqual(harness.agentLoopService.runCalls, 1);
	});

	test('CS-03 blank prompts are rejected before any initialization work starts', async () => {
		const harness = createHarness();
		store.add(harness.testDisposables);

		const result = await harness.service.submitPrompt('   ');

		assert.strictEqual(result, undefined);
		assert.strictEqual(harness.selectionService.initializeCalls, 0);
		assert.strictEqual(harness.planModeService.initializeCalls, 0);
		assert.strictEqual(harness.agentLoopService.runCalls, 0);
		assert.strictEqual(harness.historyService.updates.length, 0);
	});

	test('CS-04 missing model selection rejects the turn on the existing thread and session', async () => {
		const harness = createHarness();
		store.add(harness.testDisposables);

		const result = await harness.service.submitPrompt('Fallback prompt', {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/existing',
		});

		assert.deepStrictEqual(result, {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/existing',
		});
		assert.strictEqual(harness.planModeService.modeByThread.get('thread-1'), 'act');
		assert.deepStrictEqual(harness.historyService.updates.map(update => update.phase), ['prompt', 'error']);
		assert.strictEqual(harness.historyService.updates[1]?.errorCode, 'request_rejected');
		assert.strictEqual(harness.historyService.updates[1]?.responsePlainTextReplace, 'Sign in to a provider and choose a model before sending messages through VSClone.');
		assert.strictEqual(harness.agentLoopService.runCalls, 0);
	});

	test('CS-05 successful routing preserves prior turns, binds the selection, and passes attachments through', async () => {
		const harness = createHarness({
			turnsByThread: [[
				'thread-1',
				[
					createTurn('thread-1', {
						turnId: 'thread-1:turn-1',
						sequence: 1,
						status: 'completed',
						promptText: 'Existing prompt',
						responsePlainText: 'Existing response',
						promptImages: [createImageAttachment()],
					}),
					createTurn('thread-1', {
						turnId: 'thread-1:turn-2',
						sequence: 2,
						status: 'streaming',
						promptText: 'Streaming prompt',
						responsePlainText: 'Streaming response',
						completedAt: undefined,
						lastEventAt: 3,
					}),
				],
			]],
			context: createContext(),
		});
		store.add(harness.testDisposables);

		const result = await harness.service.submitPrompt('Implement a fix', {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
			modelSelection: createModelSelection(),
			imageAttachments: [createImageAttachment()],
		});

		assert.deepStrictEqual(result, {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
		});
		assert.strictEqual(harness.selectionService.setCalls, 1);
		assert.strictEqual(harness.promptAssemblyService.calls, 1);
		assert.strictEqual(harness.promptAssemblyService.lastVendor, 'openai');
		assert.strictEqual(harness.promptAssemblyService.lastMode, 'act');
		assert.strictEqual(harness.contextGatheringService.calls, 1);
		assert.strictEqual(harness.agentLoopService.runCalls, 1);
		assert.deepStrictEqual(harness.agentLoopService.lastRunOptions?.previousTurns, [
			{
				role: 'user',
				content: 'Existing prompt',
				imageAttachments: [createImageAttachment()],
			},
			{
				role: 'assistant',
				content: 'Existing response',
			},
			{
				role: 'user',
				content: 'Streaming prompt',
				imageAttachments: [createImageAttachment()],
			},
			{
				role: 'assistant',
				content: 'Streaming response',
			},
		]);
		assert.deepStrictEqual(harness.agentLoopService.lastRunOptions?.imageAttachments, [createImageAttachment()]);
		assert.strictEqual(harness.agentLoopService.lastRunOptions?.systemMessage, 'SYSTEM:openai:act');
		assert.strictEqual(harness.selectionService.getCurrentSelectionForThread('thread-1', 'chat')?.modelIdentifier, 'openai/gpt-5.3-codex');
		harness.agentLoopService.completeLastRun();
	});

	test('CS-06 context gathering failures fall back to a request without a system message', async () => {
		const harness = createHarness({
			turnsByThread: [['thread-1', [createTurn('thread-1')]]],
			contextError: new Error('context failed'),
		});
		store.add(harness.testDisposables);

		await harness.service.submitPrompt('Keep going', {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
			modelSelection: createModelSelection(),
		});

		assert.strictEqual(harness.agentLoopService.runCalls, 1);
		assert.strictEqual(harness.agentLoopService.lastRunOptions?.systemMessage, undefined);
		assert.strictEqual(harness.promptAssemblyService.calls, 0);
		assert.strictEqual(harness.logService.warnCalls.length, 1);
		assert.ok(String(harness.logService.warnCalls[0]?.[0]).includes('Failed to gather prompt context'));
		harness.agentLoopService.completeLastRun();
	});

	test('CS-07 ensureThreadSelectionBinding reuses an existing thread selection without writing again', async () => {
		const selection = createModelSelection();
		const harness = createHarness({
			selections: [['thread-1', selection]],
		});
		store.add(harness.testDisposables);

		const boundSelection = await asInternals(harness.service).ensureThreadSelectionBinding('thread-1', selection);

		assert.deepStrictEqual(boundSelection, {
			...selection,
			threadId: 'thread-1',
		});
		assert.strictEqual(harness.selectionService.setCalls, 0);
	});

	test('CS-08 cancelThread only removes handles that belong to the exact thread prefix', () => {
		const harness = createHarness();
		store.add(harness.testDisposables);
		const apiRequestHandles = asInternals(harness.service).apiRequestHandles;
		const matchingHandle = new TestAgentLoopHandle();
		const prefixedHandle = new TestAgentLoopHandle();
		const otherHandle = new TestAgentLoopHandle();
		apiRequestHandles.set('thread-1:api:1', matchingHandle);
		apiRequestHandles.set('thread-10:api:2', prefixedHandle);
		apiRequestHandles.set('other:api:3', otherHandle);

		harness.service.cancelThread('thread-1');

		assert.strictEqual(matchingHandle.cancelCalls, 1);
		assert.strictEqual(prefixedHandle.cancelCalls, 0);
		assert.strictEqual(otherHandle.cancelCalls, 0);
		assert.strictEqual(apiRequestHandles.has('thread-1:api:1'), false);
		assert.strictEqual(apiRequestHandles.has('thread-10:api:2'), true);
		assert.strictEqual(apiRequestHandles.has('other:api:3'), true);
	});

	test('CS-09 dispose cancels every active handle and clears the request map', () => {
		const harness = createHarness();
		store.add(harness.testDisposables);
		const apiRequestHandles = asInternals(harness.service).apiRequestHandles;
		const firstHandle = new TestAgentLoopHandle();
		const secondHandle = new TestAgentLoopHandle();
		apiRequestHandles.set('thread-1:api:1', firstHandle);
		apiRequestHandles.set('thread-2:api:2', secondHandle);

		harness.service.dispose();

		assert.strictEqual(firstHandle.cancelCalls, 1);
		assert.strictEqual(secondHandle.cancelCalls, 1);
		assert.strictEqual(apiRequestHandles.size, 0);
	});

	test('CS-10 getApiVendor rejects unsupported provider selections', () => {
		const harness = createHarness();
		store.add(harness.testDisposables);

		const vendor = asInternals(harness.service).getApiVendor({
			threadId: 'thread-1',
			location: 'chat',
			modelIdentifier: 'custom/vendor-model',
			vendor: 'custom',
			modelId: 'vendor-model',
			modelName: 'Vendor Model',
			selectedAt: Date.now(),
		} as unknown as IVSCloneModelSelection);

		assert.strictEqual(vendor, undefined);
	});
});
