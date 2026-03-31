/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ILogService } from '../../../../../platform/log/common/log.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { VSCloneChatHistoryEnabledSetting, VSCloneChatHistoryMaxThreadsSetting, VSCloneChatHistoryMaxTurnsPerThreadSetting, VSCloneChatHistoryPersistScopeSetting, VSCloneChatHistoryRedactSecretsSetting, VSCloneChatHistoryRetentionDaysSetting } from '../../common/vscloneChatHistorySettings.js';
import type { IVSCloneChatHistoryChangeEvent, IVSCloneChatHistorySnapshot, IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn, IVSCloneChatTurnUpdate } from '../../common/vscloneChatHistoryTypes.js';
import { VSCloneChatHistoryStore } from '../../common/backend/vscloneChatHistoryStore.js';
import { VSCloneUnifiedChatBackendService } from '../../common/backend/vscloneUnifiedChatBackendService.js';
import type { IVSCloneChatLocation, IVSCloneModelSelection, IVSCloneUnifiedChatSelectionState } from '../../common/vscloneModelSelectionTypes.js';
import type { IVSCloneUnifiedChatPlanModeState } from '../../common/vsclonePlanModeTypes.js';

type TestStore = Pick<VSCloneChatHistoryStore, 'load' | 'save' | 'clear'> & {
	readonly dispose: () => void;
	load: sinon.SinonStub;
	save: sinon.SinonStub;
	clear: sinon.SinonStub;
};

class TestLogService {
	readonly infos: unknown[][] = [];
	readonly warnings: unknown[][] = [];
	readonly errors: unknown[][] = [];

	info(...args: unknown[]): void {
		this.infos.push(args);
	}

	warn(...args: unknown[]): void {
		this.warnings.push(args);
	}

	error(...args: unknown[]): void {
		this.errors.push(args);
	}
}

class TestNotificationService {
	readonly warnings: string[] = [];

	warn(message: string): void {
		this.warnings.push(message);
	}
}

function createConfigurationService(values: Record<string, unknown | undefined> = {}): IConfigurationService {
	return {
		getValue<T>(key: string): T | undefined {
			return values[key] as T | undefined;
		},
	} as IConfigurationService;
}

function createStore(snapshot: IVSCloneChatHistorySnapshot): TestStore {
	return {
		dispose: () => { },
		load: sinon.stub().resolves(snapshot),
		save: sinon.stub().resolves(undefined),
		clear: sinon.stub().resolves(undefined),
	};
}

function createSnapshot(overrides: Partial<IVSCloneChatHistorySnapshot> = {}): IVSCloneChatHistorySnapshot {
	return {
		updatedAt: Date.now(),
		threads: [],
		turnsByThreadId: {},
		modeByThread: {},
		selectedByThread: {},
		selectedByLocation: {},
		recentModelIdentifiers: [],
		...overrides,
	};
}

function createThread(threadId: string, updatedAt: number, overrides: Partial<IVSCloneChatHistoryThread> = {}): IVSCloneChatHistoryThread {
	return {
		threadId,
		sessionResource: `vsclone://session/${threadId}`,
		title: threadId,
		createdAt: updatedAt,
		updatedAt,
		status: 'active',
		archived: false,
		turnCount: 1,
		lastTurnPreview: 'Preview',
		...overrides,
	};
}

function createTurn(threadId: string, turnId: string, sequence: number, overrides: Partial<IVSCloneChatHistoryTurn> = {}): IVSCloneChatHistoryTurn {
	return {
		turnId,
		threadId,
		sequence,
		promptText: 'Prompt',
		responseMarkdown: 'Response',
		responsePlainText: 'Response',
		startedAt: sequence,
		status: 'completed',
		...overrides,
	};
}

function createSelection(threadId: string | undefined, location: IVSCloneChatLocation, overrides: Partial<IVSCloneModelSelection> = {}): IVSCloneModelSelection {
	return {
		threadId,
		location,
		modelIdentifier: 'openai/gpt-5.3-codex',
		vendor: 'openai',
		modelId: 'gpt-5.3-codex',
		modelName: 'GPT-5.3-Codex',
		selectedAt: Date.now(),
		...overrides,
	};
}

function createHarness(options: {
	readonly config?: Record<string, unknown | undefined>;
	readonly snapshot?: IVSCloneChatHistorySnapshot;
} = {}): {
	readonly service: VSCloneUnifiedChatBackendService;
	readonly store: TestStore;
	readonly instantiationService: TestInstantiationService;
	readonly logService: TestLogService;
	readonly notificationService: TestNotificationService;
} {
	const instantiationService = new TestInstantiationService(new ServiceCollection());
	const store = createStore(options.snapshot ?? createSnapshot());
	instantiationService.stubInstance(VSCloneChatHistoryStore, store);

	const logService = new TestLogService();
	const notificationService = new TestNotificationService();
	const service = new VSCloneUnifiedChatBackendService(
		instantiationService as unknown as IInstantiationService,
		createConfigurationService(options.config),
		logService as unknown as ILogService,
		notificationService as unknown as INotificationService,
	);

	return {
		service,
		store,
		instantiationService,
		logService,
		notificationService,
	};
}

suite('VSCloneUnifiedChatBackendService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('constructor creates the history store once and does not touch runtime state', () => {
		const testDisposables = store.add(new DisposableStore());
		const instantiationService = testDisposables.add(new TestInstantiationService(new ServiceCollection()));
		const historyStore = createStore(createSnapshot());
		instantiationService.stubInstance(VSCloneChatHistoryStore, historyStore);

		const createInstanceSpy = sinon.spy(instantiationService, 'createInstance');
		const service = testDisposables.add(new VSCloneUnifiedChatBackendService(
			instantiationService as unknown as IInstantiationService,
			createConfigurationService(),
			new TestLogService() as unknown as ILogService,
			new TestNotificationService() as unknown as INotificationService,
		));

		assert.strictEqual(createInstanceSpy.callCount, 1);
		assert.strictEqual(createInstanceSpy.firstCall.args[0], VSCloneChatHistoryStore);
		assert.strictEqual(historyStore.load.callCount, 0);
		assert.strictEqual(historyStore.save.callCount, 0);
		assert.strictEqual(historyStore.clear.callCount, 0);
		assert.strictEqual((service as unknown as { initialized: boolean }).initialized, false);
	});

	test('initialize normalizes the persist scope before loading storage', async () => {
		const profileHarness = createHarness({
			config: {
				[VSCloneChatHistoryPersistScopeSetting]: 'profile',
			},
		});
		const workspaceHarness = createHarness({
			config: {
				[VSCloneChatHistoryPersistScopeSetting]: 'anything-else',
			},
		});
		const testDisposables = store.add(new DisposableStore());
		testDisposables.add(profileHarness.service);
		testDisposables.add(profileHarness.instantiationService);
		testDisposables.add(workspaceHarness.service);
		testDisposables.add(workspaceHarness.instantiationService);

		await profileHarness.service.initialize();
		await workspaceHarness.service.initialize();

		assert.strictEqual(profileHarness.store.load.callCount, 1);
		assert.strictEqual(profileHarness.store.load.firstCall.args[0], 'profile');
		assert.strictEqual(workspaceHarness.store.load.callCount, 1);
		assert.strictEqual(workspaceHarness.store.load.firstCall.args[0], 'workspace');
	});

	test('initialize prunes expired threads, persists the corrected snapshot, and emits initialize state', async () => {
		const now = Date.now();
		const oldThread = createThread('thread-old', now - (3 * 24 * 60 * 60 * 1000));
		const freshThread = createThread('thread-fresh', now);
		const harness = createHarness({
			config: {
				[VSCloneChatHistoryRetentionDaysSetting]: 1,
			},
			snapshot: createSnapshot({
				threads: [oldThread, freshThread],
				turnsByThreadId: {
					[oldThread.threadId]: [],
					[freshThread.threadId]: [],
				},
			}),
		});
		const testDisposables = store.add(new DisposableStore());
		testDisposables.add(harness.service);
		testDisposables.add(harness.instantiationService);

		const events: IVSCloneChatHistoryChangeEvent[] = [];
		testDisposables.add(harness.service.onDidChange(event => events.push(event)));

		await harness.service.initialize();

		assert.strictEqual(harness.store.load.callCount, 1);
		assert.strictEqual(harness.store.save.callCount, 1);
		assert.deepStrictEqual(harness.store.save.firstCall.args[0], 'workspace');
		assert.deepStrictEqual(harness.store.save.firstCall.args[2], { redactSecrets: true });
		assert.deepStrictEqual(harness.service.getThreads({ includeArchived: true }).map(thread => thread.threadId), ['thread-fresh']);
		assert.deepStrictEqual(events, [{
			reason: 'initialize',
			scope: 'workspace',
			threadIds: ['thread-fresh'],
		}]);
	});

	test('initialize shares one in-flight load and no-ops once disabled or already initialized', async () => {
		const pendingHarness = createHarness();
		const disabledHarness = createHarness();
		const turnedOffHarness = createHarness({
			config: {
				[VSCloneChatHistoryEnabledSetting]: false,
			},
		});
		const testDisposables = store.add(new DisposableStore());
		testDisposables.add(pendingHarness.service);
		testDisposables.add(pendingHarness.instantiationService);
		testDisposables.add(disabledHarness.service);
		testDisposables.add(disabledHarness.instantiationService);
		testDisposables.add(turnedOffHarness.service);
		testDisposables.add(turnedOffHarness.instantiationService);

		let resolveLoad: ((snapshot: IVSCloneChatHistorySnapshot) => void) | undefined;
		pendingHarness.store.load.returns(new Promise<IVSCloneChatHistorySnapshot>(resolve => {
			resolveLoad = resolve;
		}));

		const first = pendingHarness.service.initialize();
		const second = pendingHarness.service.initialize();
		assert.strictEqual(pendingHarness.store.load.callCount, 1);

		resolveLoad?.(createSnapshot({
			threads: [createThread('thread-1', Date.now())],
			turnsByThreadId: { 'thread-1': [] },
		}));
		await first;
		await pendingHarness.service.initialize();
		assert.strictEqual(pendingHarness.store.load.callCount, 1);

		(disabledHarness.service as unknown as { disabled: boolean }).disabled = true;
		await disabledHarness.service.initialize();
		await turnedOffHarness.service.initialize();
		assert.strictEqual(disabledHarness.store.load.callCount, 0);
		assert.strictEqual(turnedOffHarness.store.load.callCount, 0);
	});

	test('initialize reports loader failures with a normalized error and warning', async () => {
		const harness = createHarness();
		const testDisposables = store.add(new DisposableStore());
		testDisposables.add(harness.service);
		testDisposables.add(harness.instantiationService);
		harness.store.load.rejects(new Error('boom'));

		const events: IVSCloneChatHistoryChangeEvent[] = [];
		testDisposables.add(harness.service.onDidChange(event => events.push(event)));

		await assert.rejects(harness.service.initialize(), /boom/);
		assert.strictEqual(harness.logService.errors.length, 1);
		assert.strictEqual(harness.logService.errors[0][0], 'Failed to initialize VSClone chat history');
		assert.strictEqual(harness.notificationService.warnings.length, 1);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].reason, 'error');
		assert.strictEqual(events[0].scope, 'workspace');
		assert.deepStrictEqual(events[0].threadIds, []);
		assert.strictEqual(events[0].error?.message, 'boom');
	});

	test('getThreads and getTurns stay empty until initialization and clamp the thread query limit', async () => {
		const harness = createHarness({
			config: {
				[VSCloneChatHistoryMaxThreadsSetting]: 0,
			},
			snapshot: createSnapshot({
				threads: [createThread('thread-1', Date.now(), { turnCount: 1 })],
				turnsByThreadId: {
					'thread-1': [createTurn('thread-1', 'turn-1', 1)],
				},
			}),
		});
		const testDisposables = store.add(new DisposableStore());
		testDisposables.add(harness.service);
		testDisposables.add(harness.instantiationService);

		const model = (harness.service as unknown as { model: { getThreads: (query: unknown) => unknown } }).model;
		const getThreadsSpy = sinon.spy(model, 'getThreads');

		assert.deepStrictEqual(harness.service.getThreads({ includeArchived: true, limit: 99 }), []);
		assert.deepStrictEqual(harness.service.getTurns('thread-1'), []);
		assert.strictEqual(getThreadsSpy.callCount, 0);

		await harness.service.initialize();

		assert.deepStrictEqual(harness.service.getThreads({ includeArchived: true, limit: 99 }).map(thread => thread.threadId), ['thread-1']);
		assert.deepStrictEqual(harness.service.getTurns('thread-1').map(turn => turn.turnId), ['turn-1']);
		assert.deepStrictEqual(getThreadsSpy.lastCall.args[0], {
			includeArchived: true,
			limit: 1,
		});
	});

	test('replaceSelectionState initializes on demand, strips thread ids, and returns defensive copies', async () => {
		const harness = createHarness();
		const testDisposables = store.add(new DisposableStore());
		testDisposables.add(harness.service);
		testDisposables.add(harness.instantiationService);

		const emptyA = harness.service.getSelectionState();
		const emptyB = harness.service.getSelectionState();
		assert.deepStrictEqual(emptyA, {
			selectedByThread: {},
			selectedByLocation: {},
			recentModelIdentifiers: [],
		});
		assert.notStrictEqual(emptyA, emptyB);

		const nextSelection: IVSCloneUnifiedChatSelectionState = {
			selectedByThread: {
				'thread-1': createSelection('thread-1', 'chat'),
			},
			selectedByLocation: {
				chat: createSelection('thread-1', 'chat'),
			},
			recentModelIdentifiers: ['openai/gpt-5.3-codex'],
		};

		await harness.service.replaceSelectionState(nextSelection);

		assert.strictEqual(harness.store.load.callCount, 1);
		assert.strictEqual(harness.store.save.callCount, 1);
		assert.deepStrictEqual(harness.store.save.firstCall.args[1].selectedByThread['thread-1'], {
			threadId: undefined,
			location: 'chat',
			modelIdentifier: 'openai/gpt-5.3-codex',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelName: 'GPT-5.3-Codex',
			selectedAt: nextSelection.selectedByThread['thread-1'].selectedAt,
		});
		assert.strictEqual(harness.store.save.firstCall.args[1].selectedByLocation.chat?.threadId, undefined);

		const roundTripped = harness.service.getSelectionState();
		roundTripped.selectedByThread['thread-1'].modelIdentifier = 'mutated';
		roundTripped.selectedByLocation.chat!.modelIdentifier = 'mutated';

		assert.notStrictEqual(harness.service.getSelectionState().selectedByThread['thread-1'].modelIdentifier, 'mutated');
		assert.notStrictEqual(harness.service.getSelectionState().selectedByLocation.chat!.modelIdentifier, 'mutated');

		const disabledHarness = createHarness();
		const disabledDisposables = store.add(new DisposableStore());
		disabledDisposables.add(disabledHarness.service);
		disabledDisposables.add(disabledHarness.instantiationService);
		(disabledHarness.service as unknown as { disabled: boolean }).disabled = true;
		await disabledHarness.service.replaceSelectionState(nextSelection);
		assert.strictEqual(disabledHarness.store.load.callCount, 0);
		assert.strictEqual(disabledHarness.store.save.callCount, 0);
	});

	test('replacePlanModeState initializes on demand, clones persisted state, and no-ops when disabled', async () => {
		const harness = createHarness();
		const testDisposables = store.add(new DisposableStore());
		testDisposables.add(harness.service);
		testDisposables.add(harness.instantiationService);

		const emptyA = harness.service.getPlanModeState();
		const emptyB = harness.service.getPlanModeState();
		assert.deepStrictEqual(emptyA, { modeByThread: {} });
		assert.notStrictEqual(emptyA, emptyB);

		const nextState: IVSCloneUnifiedChatPlanModeState = {
			modeByThread: {
				'thread-1': 'plan',
			},
		};

		await harness.service.replacePlanModeState(nextState);

		assert.strictEqual(harness.store.load.callCount, 1);
		assert.strictEqual(harness.store.save.callCount, 1);
		assert.deepStrictEqual(harness.store.save.firstCall.args[1].modeByThread, {
			'thread-1': 'plan',
		});

		const roundTripped = harness.service.getPlanModeState();
		roundTripped.modeByThread['thread-1'] = 'act';
		assert.notStrictEqual(harness.service.getPlanModeState().modeByThread['thread-1'], 'act');

		const disabledHarness = createHarness();
		const disabledDisposables = store.add(new DisposableStore());
		disabledDisposables.add(disabledHarness.service);
		disabledDisposables.add(disabledHarness.instantiationService);
		(disabledHarness.service as unknown as { disabled: boolean }).disabled = true;
		await disabledHarness.service.replacePlanModeState(nextState);
		assert.strictEqual(disabledHarness.store.load.callCount, 0);
		assert.strictEqual(disabledHarness.store.save.callCount, 0);
	});

	test('stream updates schedule delayed persistence and update the live thread state', async () => {
		const harness = createHarness({
			config: {
				[VSCloneChatHistoryRedactSecretsSetting]: false,
			},
		});
		const testDisposables = store.add(new DisposableStore());
		testDisposables.add(harness.service);
		testDisposables.add(harness.instantiationService);

		await harness.service.initialize();

		const events: IVSCloneChatHistoryChangeEvent[] = [];
		testDisposables.add(harness.service.onDidChange(event => events.push(event)));

		let scheduledPersist: (() => Promise<void>) | undefined;
		const persistDelayer = (harness.service as unknown as { persistDelayer: { trigger: (fn: () => Promise<void>) => Promise<void> } }).persistDelayer;
		const triggerStub = sinon.stub(persistDelayer, 'trigger').callsFake((callback: () => Promise<void>) => {
			scheduledPersist = callback;
			return Promise.resolve();
		});

		const update: IVSCloneChatTurnUpdate = {
			threadId: 'thread-1',
			turnId: 'turn-1',
			sequence: 1,
			sessionResource: 'vsclone://session/thread-1',
			phase: 'stream',
			occurredAt: Date.now(),
			promptText: 'Build the feature',
			executionMode: 'act',
			modelIdentifier: 'openai/gpt-5.3-codex',
			providerId: 'openai',
			responsePlainTextDelta: 'working',
			responseMarkdownDelta: 'working',
		};

		harness.service.applyTurnUpdate(update);

		assert.strictEqual(harness.store.save.callCount, 0);
		assert.ok(scheduledPersist);
		assert.deepStrictEqual(events, [{
			reason: 'turnUpdate',
			scope: 'workspace',
			threadIds: ['thread-1'],
		}]);
		assert.deepStrictEqual(harness.service.getThreads({ includeArchived: true }).map(thread => ({
			threadId: thread.threadId,
			lastTurnPreview: thread.lastTurnPreview,
			status: thread.status,
			turnCount: thread.turnCount,
		})), [{
			threadId: 'thread-1',
			lastTurnPreview: 'working',
			status: 'active',
			turnCount: 1,
		}]);
		assert.deepStrictEqual(harness.service.getTurns('thread-1').map(turn => ({
			turnId: turn.turnId,
			status: turn.status,
			responsePlainText: turn.responsePlainText,
		})), [{
			turnId: 'turn-1',
			status: 'streaming',
			responsePlainText: 'working',
		}]);

		await scheduledPersist?.();
		assert.strictEqual(harness.store.save.callCount, 1);
		assert.deepStrictEqual(harness.store.save.firstCall.args[2], { redactSecrets: false });
		triggerStub.restore();
	});

	test('complete updates persist immediately and respect the maximum turn count', async () => {
		const harness = createHarness({
			config: {
				[VSCloneChatHistoryMaxTurnsPerThreadSetting]: 1,
			},
		});
		const testDisposables = store.add(new DisposableStore());
		testDisposables.add(harness.service);
		testDisposables.add(harness.instantiationService);

		await harness.service.initialize();

		const now = Date.now();
		const firstUpdate: IVSCloneChatTurnUpdate = {
			threadId: 'thread-1',
			turnId: 'turn-1',
			sequence: 1,
			sessionResource: 'vsclone://session/thread-1',
			phase: 'complete',
			occurredAt: now,
			promptText: 'First prompt',
			executionMode: 'act',
			modelIdentifier: 'openai/gpt-5.3-codex',
			providerId: 'openai',
			responsePlainTextDelta: 'first response',
			responseMarkdownDelta: 'first response',
		};
		const secondUpdate: IVSCloneChatTurnUpdate = {
			...firstUpdate,
			turnId: 'turn-2',
			sequence: 2,
			occurredAt: now + 1,
			promptText: 'Second prompt',
			responsePlainTextDelta: 'second response',
			responseMarkdownDelta: 'second response',
		};

		harness.service.applyTurnUpdate(firstUpdate);
		harness.service.applyTurnUpdate(secondUpdate);

		assert.strictEqual(harness.store.save.callCount, 2);
		assert.deepStrictEqual(harness.store.save.firstCall.args[2], { redactSecrets: true });
		assert.deepStrictEqual(harness.service.getTurns('thread-1').map(turn => turn.turnId), ['turn-2']);
		assert.deepStrictEqual(harness.service.getThreads({ includeArchived: true }).map(thread => ({
			threadId: thread.threadId,
			turnCount: thread.turnCount,
			lastTurnPreview: thread.lastTurnPreview,
			status: thread.status,
		})), [{
			threadId: 'thread-1',
			turnCount: 1,
			lastTurnPreview: 'second response',
			status: 'completed',
		}]);
	});

	test('archiveThread and deleteThread handle missing threads and persist successful changes', async () => {
		const harness = createHarness({
			snapshot: createSnapshot({
				threads: [createThread('thread-1', Date.now())],
				turnsByThreadId: {
					'thread-1': [createTurn('thread-1', 'turn-1', 1)],
				},
			}),
		});
		const testDisposables = store.add(new DisposableStore());
		testDisposables.add(harness.service);
		testDisposables.add(harness.instantiationService);

		await harness.service.initialize();

		const events: IVSCloneChatHistoryChangeEvent[] = [];
		testDisposables.add(harness.service.onDidChange(event => events.push(event)));

		await harness.service.archiveThread('missing-thread', true);
		assert.strictEqual(harness.store.save.callCount, 0);

		await harness.service.archiveThread('thread-1', true);
		assert.strictEqual(harness.store.save.callCount, 1);
		assert.deepStrictEqual(events[0], {
			reason: 'archive',
			scope: 'workspace',
			threadIds: ['thread-1'],
		});
		assert.strictEqual(harness.service.getThreads({ includeArchived: true })[0].archived, true);
		assert.strictEqual(harness.service.getThreads({ includeArchived: true })[0].status, 'archived');

		await harness.service.deleteThread('missing-thread');
		assert.strictEqual(harness.store.save.callCount, 1);

		await harness.service.deleteThread('thread-1');
		assert.strictEqual(harness.store.save.callCount, 2);
		assert.deepStrictEqual(events[1], {
			reason: 'delete',
			scope: 'workspace',
			threadIds: ['thread-1'],
		});
		assert.deepStrictEqual(harness.service.getThreads({ includeArchived: true }), []);
	});

	test('clearAll always clears the requested scope and only resets live state for the active scope', async () => {
		const harness = createHarness({
			snapshot: createSnapshot({
				threads: [createThread('thread-1', Date.now())],
				turnsByThreadId: {
					'thread-1': [createTurn('thread-1', 'turn-1', 1)],
				},
				selectedByThread: {
					'thread-1': createSelection('thread-1', 'chat'),
				},
				modeByThread: {
					'thread-1': 'plan',
				},
			}),
		});
		const testDisposables = store.add(new DisposableStore());
		testDisposables.add(harness.service);
		testDisposables.add(harness.instantiationService);

		await harness.service.initialize();

		const events: IVSCloneChatHistoryChangeEvent[] = [];
		testDisposables.add(harness.service.onDidChange(event => events.push(event)));

		await harness.service.clearAll('profile');
		assert.strictEqual(harness.store.clear.callCount, 1);
		assert.strictEqual(harness.store.clear.firstCall.args[0], 'profile');
		assert.deepStrictEqual(harness.service.getThreads({ includeArchived: true }).map(thread => thread.threadId), ['thread-1']);
		assert.deepStrictEqual(events, []);

		await harness.service.clearAll('workspace');
		assert.strictEqual(harness.store.clear.callCount, 2);
		assert.strictEqual(harness.store.clear.secondCall.args[0], 'workspace');
		assert.deepStrictEqual(harness.service.getThreads({ includeArchived: true }), []);
		assert.deepStrictEqual(events, [{
			reason: 'clear',
			scope: 'workspace',
			threadIds: [],
		}]);
	});
});
