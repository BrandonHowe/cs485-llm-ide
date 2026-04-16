/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { IVSCloneAgentLoopHandle, IVSCloneAgentLoopOptions, IVSCloneAgentLoopService } from '../../browser/vscloneAgentLoopService.js';
import { IVSCloneThreadRuntimeRunOptions, VSCloneThreadRuntimeService } from '../../browser/vscloneThreadRuntimeService.js';
import { IVSCloneToolExecutionResult, IVSCloneToolExecutionService, IVSCloneToolRuntimeService } from '../../browser/vscloneToolExecutionService.js';
import { IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn } from '../../common/vscloneChatHistoryTypes.js';
import { type VSCloneChatMode } from '../../common/vsclonePlanModeTypes.js';
import { formatToolResult } from '../../common/vscloneToolDefinitions.js';
import { IVSCloneThreadRuntimeState } from '../../common/vscloneThreadRuntimeTypes.js';

const RUNTIME_STORAGE_PREFIX = 'vsclone.threadRuntime.v1';
const RUNTIME_INDEX_STORAGE_KEY = `${RUNTIME_STORAGE_PREFIX}.index`;
const RUNTIME_THREAD_STORAGE_KEY_PREFIX = `${RUNTIME_STORAGE_PREFIX}.thread.`;

class TestAgentLoopHandle implements IVSCloneAgentLoopHandle {
	readonly done: Promise<void>;
	private doneResolver: (() => void) | undefined;

	constructor() {
		this.done = new Promise<void>(resolve => {
			this.doneResolver = resolve;
		});
	}

	cancel(): void {
		// The runtime service only needs a cancellable handle in tests; the
		// underlying fake loop never performs asynchronous cancellation work.
	}

	complete(): void {
		this.doneResolver?.();
		this.doneResolver = undefined;
	}
}

class RecordingAgentLoopService implements IVSCloneAgentLoopService {
	declare readonly _serviceBrand: undefined;
	readonly handles: TestAgentLoopHandle[] = [];
	lastOptions: IVSCloneAgentLoopOptions | undefined;

	runAgentLoop(options: IVSCloneAgentLoopOptions): IVSCloneAgentLoopHandle {
		this.lastOptions = options;
		const handle = new TestAgentLoopHandle();
		this.handles.push(handle);
		return handle;
	}
}

class StaticToolRuntimeService implements IVSCloneToolRuntimeService {
	declare readonly _serviceBrand: undefined;

	listToolDefinitions(_mode?: VSCloneChatMode) {
		return [];
	}

	getToolDefinition() {
		return undefined;
	}

	getApprovalType(toolName: string) {
		switch (toolName) {
			case 'edit_file':
			case 'create_file':
				return 'edits';
			case 'run_command':
			case 'run_persistent_command':
			case 'open_persistent_terminal':
			case 'kill_persistent_terminal':
				return 'terminal';
			default:
				return undefined;
		}
	}
}

class RecordingToolExecutionService implements IVSCloneToolExecutionService {
	declare readonly _serviceBrand: undefined;
	readonly calls: Array<{ toolName: string; params: Record<string, string>; mode: VSCloneChatMode }> = [];

	async executeTool(toolName: string, params: Record<string, string>, mode: VSCloneChatMode = 'act', _token: CancellationToken = CancellationToken.None): Promise<IVSCloneToolExecutionResult> {
		this.calls.push({ toolName, params, mode });
		return {
			success: true,
			output: `Executed ${toolName}.`,
		};
	}
}

class BlockingToolExecutionService extends RecordingToolExecutionService {
	cancelledCalls = 0;

	override async executeTool(toolName: string, params: Record<string, string>, mode: VSCloneChatMode = 'act', token: CancellationToken = CancellationToken.None): Promise<IVSCloneToolExecutionResult> {
		this.calls.push({ toolName, params, mode });
		if (token.isCancellationRequested) {
			this.cancelledCalls += 1;
			return { success: false, output: `Tool ${toolName} was cancelled before it could finish.` };
		}

		return new Promise<IVSCloneToolExecutionResult>(resolve => {
			const listener = token.onCancellationRequested(() => {
				listener.dispose();
				this.cancelledCalls += 1;
				resolve({ success: false, output: `Tool ${toolName} was cancelled before it could finish.` });
			});
		});
	}
}

class NeverSettlingToolExecutionService extends RecordingToolExecutionService {
	override async executeTool(toolName: string, params: Record<string, string>, mode: VSCloneChatMode = 'act', _token: CancellationToken = CancellationToken.None): Promise<IVSCloneToolExecutionResult> {
		this.calls.push({ toolName, params, mode });
		// The timeout test needs a tool that never resolves so the runtime's own recovery path is
		// the only thing that can move the restored thread forward.
		return new Promise<IVSCloneToolExecutionResult>(() => undefined);
	}
}

class InMemoryFileService {
	readonly files = new Map<string, string>();
	private existsGate: DeferredPromise<void> | undefined;

	blockExistsUntilReleased(): DeferredPromise<void> {
		this.existsGate = new DeferredPromise<void>();
		return this.existsGate;
	}

	private isDirectory(resource: URI): boolean {
		const prefix = resource.toString().replace(/\/+$/, '');
		if (prefix === URI.file('/workspace').toString()) {
			return true;
		}

		for (const path of this.files.keys()) {
			if (path.startsWith(`${prefix}/`)) {
				return true;
			}
		}

		return false;
	}

	asService() {
		return {
			exists: async (resource: URI) => {
				await this.existsGate?.p;
				return this.files.has(resource.toString());
			},
			resolve: async (resource: URI) => ({
				resource,
				name: resource.path.split('/').filter(Boolean).pop() ?? resource.path,
				isDirectory: this.isDirectory(resource),
			}),
			readFile: async (resource: URI) => ({ value: VSBuffer.fromString(this.files.get(resource.toString()) ?? '') }),
			writeFile: async (resource: URI, content: VSBuffer) => {
				this.files.set(resource.toString(), content.toString());
			},
			del: async (resource: URI) => {
				const target = resource.toString();
				this.files.delete(target);
				for (const path of [...this.files.keys()]) {
					if (path.startsWith(`${target}/`)) {
						this.files.delete(path);
					}
				}
			},
			createFolder: async (_resource: URI) => {
				// Folder creation is only observed indirectly through rewind restore.
			},
		} as unknown as import('../../../../../platform/files/common/files.js').IFileService;
	}
}

function createWorkspaceContextService(): IWorkspaceContextService {
	return {
		_serviceBrand: undefined,
		getWorkspace: () => ({ id: 'workspace-1', folders: [{ uri: URI.file('/workspace') }] }),
		getCompleteWorkspace: async () => ({ id: 'workspace-1', folders: [{ uri: URI.file('/workspace') }] }),
		getWorkspaceFolder: () => null,
		getWorkbenchState: () => 3,
		getOptions: () => ({}),
		isCurrentWorkspace: () => true,
		isInsideWorkspace: () => true,
		toResource: (workspaceRelativePath: string) => URI.file(`/workspace/${workspaceRelativePath}`),
		onDidChangeWorkspaceName: undefined as never,
		onWillChangeWorkspaceFolders: undefined as never,
		onDidChangeWorkspaceFolders: undefined as never,
		onDidChangeWorkbenchState: undefined as never,
	} as IWorkspaceContextService;
}

function cloneWorkspaceStorage(source: TestStorageService): TestStorageService {
	// Reload tests need a fresh storage instance so the new runtime service reads
	// the persisted payload instead of sharing object identity with the writer.
	const clone = new TestStorageService();
	for (const key of source.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE)) {
		const value = source.get(key, StorageScope.WORKSPACE);
		if (value !== undefined) {
			clone.store(key, value, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
	}
	return clone;
}

function createThreadOptions(threadId: string, turnId: string, promptText: string): IVSCloneThreadRuntimeRunOptions {
	return {
		threadId,
		turnId,
		sequence: 1,
		sessionResource: `vsclone://api/${threadId}`,
		promptText,
		mode: 'act',
		vendor: 'openai',
		modelId: 'gpt-5.3-codex',
		modelIdentifier: 'openai/gpt-5.3-codex',
		previousTurns: [],
		systemMessage: 'SYSTEM',
	};
}

function createHistoryThread(overrides: Partial<IVSCloneChatHistoryThread> & Pick<IVSCloneChatHistoryThread, 'threadId'>): IVSCloneChatHistoryThread {
	return {
		threadId: overrides.threadId,
		sessionResource: overrides.sessionResource ?? `vsclone://api/${overrides.threadId}`,
		title: overrides.title ?? `Imported ${overrides.threadId}`,
		activeModelIdentifier: overrides.activeModelIdentifier ?? 'openai/gpt-5.3-codex',
		createdAt: overrides.createdAt ?? 1,
		updatedAt: overrides.updatedAt ?? 2,
		status: overrides.status ?? 'completed',
		archived: overrides.archived ?? false,
		turnCount: overrides.turnCount ?? 1,
		lastTurnPreview: overrides.lastTurnPreview ?? `Preview for ${overrides.threadId}`,
	};
}

function storeRawRuntimePayload(storageService: TestStorageService, threadId: string, payload: string, updatedAt = Date.now()): void {
	storageService.store(
		`${RUNTIME_THREAD_STORAGE_KEY_PREFIX}${encodeURIComponent(threadId)}`,
		payload,
		StorageScope.WORKSPACE,
		StorageTarget.MACHINE,
	);
	storageService.store(
		RUNTIME_INDEX_STORAGE_KEY,
		JSON.stringify({
			schemaVersion: 1,
			workspaceId: 'workspace-1',
			updatedAt,
			threadIds: [threadId],
		}),
		StorageScope.WORKSPACE,
		StorageTarget.MACHINE,
	);
}

function createHarness(options: {
	storageService?: TestStorageService;
	fileService?: InMemoryFileService;
	toolExecutionService?: RecordingToolExecutionService;
	persistedToolExecutionTimeoutMs?: number;
} = {}) {
	const storageService = options.storageService ?? new TestStorageService();
	const fileService = options.fileService ?? new InMemoryFileService();
	const workspaceContextService = createWorkspaceContextService();
	const logService = new NullLogService();
	const instantiationService = new TestInstantiationService(new ServiceCollection());
	const agentLoopService = new RecordingAgentLoopService();
	const toolRuntimeService = new StaticToolRuntimeService();
	const toolExecutionService = options.toolExecutionService ?? new RecordingToolExecutionService();

	instantiationService.stub(IStorageService, storageService);
	instantiationService.stub(IWorkspaceContextService, workspaceContextService);
	instantiationService.stub(ILogService, logService);

	return {
		storageService,
		fileService,
		workspaceContextService,
		logService,
		instantiationService,
		agentLoopService,
		toolRuntimeService,
		toolExecutionService,
		service: new VSCloneThreadRuntimeService(
			agentLoopService,
			toolRuntimeService,
			toolExecutionService,
			fileService.asService(),
			logService,
			workspaceContextService,
			instantiationService,
			options.persistedToolExecutionTimeoutMs,
		),
	};
}

function getLatestAssistantMessageId(state: IVSCloneThreadRuntimeState | undefined): string {
	const assistantMessage = [...(state?.messages ?? [])].reverse().find(message => message.role === 'assistant');
	assert.ok(assistantMessage, 'Expected the runtime thread to have an assistant message.');
	if (!assistantMessage || assistantMessage.role !== 'assistant') {
		throw new Error('Expected the runtime thread to have an assistant message.');
	}
	return assistantMessage.id;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('Timed out waiting for runtime state to settle.');
		}
		await new Promise<void>(resolve => setTimeout(resolve, 10));
	}
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function expectPromiseToSettle<T>(promise: Promise<T>, timeoutMs = 250): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<{ kind: 'timeout' }>(resolve => {
		timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
	});
	const settled = await Promise.race([
		promise.then(value => ({ kind: 'value' as const, value })),
		timedOut,
	]);
	if (timeoutId !== undefined) {
		clearTimeout(timeoutId);
	}
	assert.notStrictEqual(settled.kind, 'timeout', 'the persisted approval promise should settle after the runtime decision');
	return settled.value;
}

suite('VSCloneThreadRuntimeService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('persists runtime state across reloads', async () => {
		const storageService = store.add(new TestStorageService());
		const fileService = new InMemoryFileService();
		fileService.files.set(URI.file('/workspace/src/app.ts').toString(), 'before');

		const first = createHarness({ storageService, fileService });
		const runtimeHandle = first.service.runThread(createThreadOptions('thread-1', 'turn-1', 'edit the file'));
		first.agentLoopService.lastOptions?.observer.onResponseDelta?.('Assistant reply before the tool request.');
		const approvalPromise = first.agentLoopService.lastOptions!.observer.onToolRequested!('edit_file', {
			path: 'src/app.ts',
			changes: 'ignored',
		});

		await waitForCondition(() => (first.service.getState('thread-1')?.pausedApproval?.snapshots.length ?? 0) > 0);

		const reopened = createHarness({
			storageService: store.add(cloneWorkspaceStorage(storageService)),
			fileService,
		});
		const restored = reopened.service.getState('thread-1');
		assert.ok(restored);
		assert.strictEqual(restored?.streamState.kind, 'awaiting_user');
		assert.strictEqual(restored?.pausedApproval?.toolName, 'edit_file');
		assert.strictEqual(restored?.pausedApproval?.snapshots[0]?.content, 'before');
		assert.strictEqual(restored?.messages[0]?.role, 'user');
		assert.strictEqual(restored?.messages[1]?.role, 'assistant');
		assert.strictEqual(restored?.messages.at(-1)?.role, 'tool');
		assert.strictEqual(restored?.branchHeadMessageId, restored?.messages.at(-1)?.id);
		assert.strictEqual(restored?.checkpoints.length, 0);

		assert.ok(first.service.rejectLatestToolRequest('thread-1', 'cleanup after reload assertion'));
		assert.deepStrictEqual(
			await expectPromiseToSettle(approvalPromise),
			{ kind: 'rejected', reason: 'cleanup after reload assertion' },
		);
		first.agentLoopService.handles[0]!.complete();
		await runtimeHandle.done;

		first.service.dispose();
		reopened.service.dispose();
	});

	test('rewind truncates later messages and persists the rewound branch', async () => {
		const storageService = store.add(new TestStorageService());
		const fileService = new InMemoryFileService();
		const targetUri = URI.file('/workspace/src/app.ts');
		fileService.files.set(targetUri.toString(), 'before');

		const harness = createHarness({ storageService, fileService });
		const runtimeHandle = harness.service.runThread(createThreadOptions('thread-2', 'turn-2', 'rewrite the file'));
		harness.agentLoopService.lastOptions?.observer.onResponseDelta?.('Initial assistant response.');
		const approvalPromise = harness.agentLoopService.lastOptions!.observer.onToolRequested!('edit_file', {
			path: 'src/app.ts',
			changes: 'ignored',
		});

		await waitForCondition(() => !!harness.service.getState('thread-2')?.pausedApproval?.snapshots.length);
		harness.service.approveLatestToolRequest('thread-2');
		assert.deepStrictEqual(await approvalPromise, { kind: 'approved' });

		fileService.files.set(targetUri.toString(), 'after');
		harness.agentLoopService.lastOptions?.observer.onToolResult?.('edit_file', {
			path: 'src/app.ts',
			changes: 'ignored',
		}, {
			success: true,
			output: 'Applied edit.',
		});
		harness.agentLoopService.lastOptions?.observer.onResponseDelta?.('Future assistant text.');
		harness.agentLoopService.handles[0]!.complete();
		await runtimeHandle.done;

		const beforeRewind = harness.service.getState('thread-2');
		assert.ok(beforeRewind);
		assert.ok(beforeRewind!.messages.some(message => message.role === 'assistant' && message.content.includes('Future assistant text.')));
		assert.strictEqual(fileService.files.get(targetUri.toString()), 'after');

		const checkpointId = beforeRewind!.checkpoints[0]!.id;
		const rewound = await harness.service.rewindToCheckpoint('thread-2', checkpointId);
		assert.strictEqual(rewound, true);

		const afterRewind = harness.service.getState('thread-2');
		assert.ok(afterRewind);
		assert.strictEqual(afterRewind?.currentCheckpointId, checkpointId);
		assert.strictEqual(afterRewind?.branchHeadMessageId, afterRewind?.messages.at(-1)?.id);
		assert.ok(!afterRewind!.messages.some(message => message.role === 'assistant' && message.content.includes('Future assistant text.')));
		assert.strictEqual(fileService.files.get(targetUri.toString()), 'before');

		const reopened = createHarness({
			storageService: store.add(cloneWorkspaceStorage(storageService)),
			fileService,
		});
		const restored = reopened.service.getState('thread-2');
		assert.ok(restored);
		assert.strictEqual(restored?.currentCheckpointId, checkpointId);
		assert.ok(!restored!.messages.some(message => message.role === 'assistant' && message.content.includes('Future assistant text.')));

		harness.service.dispose();
		reopened.service.dispose();
	});

	test('rewind prunes assistant edit-apply states for messages dropped from the active branch', async () => {
		const storageService = store.add(new TestStorageService());
		const fileService = new InMemoryFileService();
		const targetUri = URI.file('/workspace/src/app.ts');
		fileService.files.set(targetUri.toString(), 'before');

		const harness = createHarness({ storageService, fileService });
		const runtimeHandle = harness.service.runThread(createThreadOptions('thread-edit-state', 'turn-edit-state', 'rewrite the file'));
		harness.agentLoopService.lastOptions?.observer.onResponseDelta?.('Assistant response before checkpoint.');
		const initialAssistantMessageId = getLatestAssistantMessageId(harness.service.getState('thread-edit-state'));
		harness.service.setAssistantEditApplicationState?.('thread-edit-state', initialAssistantMessageId, {
			phase: 'applied',
			result: {
				attemptedEdits: 1,
				appliedEdits: 1,
				modifiedFiles: [targetUri],
				failures: [],
				fileChanges: [{
					uri: targetUri,
					displayPath: 'src/app.ts',
					addedLines: 1,
					removedLines: 1,
					action: 'modify',
					originalContent: 'before',
				}],
			},
		});

		const approvalPromise = harness.agentLoopService.lastOptions!.observer.onToolRequested!('edit_file', {
			path: 'src/app.ts',
			changes: 'ignored',
		});
		await waitForCondition(() => !!harness.service.getState('thread-edit-state')?.pausedApproval?.snapshots.length);
		harness.service.approveLatestToolRequest('thread-edit-state');
		assert.deepStrictEqual(await approvalPromise, { kind: 'approved' });

		fileService.files.set(targetUri.toString(), 'after');
		harness.agentLoopService.lastOptions?.observer.onToolResult?.('edit_file', {
			path: 'src/app.ts',
			changes: 'ignored',
		}, {
			success: true,
			output: 'Applied edit.',
		});
		harness.agentLoopService.lastOptions?.observer.onResponseDelta?.('Assistant response after checkpoint.');
		const futureAssistantMessageId = getLatestAssistantMessageId(harness.service.getState('thread-edit-state'));
		harness.service.setAssistantEditApplicationState?.('thread-edit-state', futureAssistantMessageId, {
			phase: 'undone',
			result: {
				attemptedEdits: 1,
				appliedEdits: 1,
				modifiedFiles: [targetUri],
				failures: [],
				fileChanges: [{
					uri: targetUri,
					displayPath: 'src/app.ts',
					addedLines: 1,
					removedLines: 1,
					action: 'modify',
					originalContent: 'before',
				}],
			},
		});
		harness.agentLoopService.handles[0]!.complete();
		await runtimeHandle.done;

		const checkpointId = harness.service.getState('thread-edit-state')!.checkpoints[0]!.id;
		assert.strictEqual(await harness.service.rewindToCheckpoint('thread-edit-state', checkpointId), true);

		const rewound = harness.service.getState('thread-edit-state');
		assert.ok(rewound);
		assert.strictEqual(rewound?.assistantEditApplications?.length, 1);
		assert.strictEqual(rewound?.assistantEditApplications?.[0]?.messageId, initialAssistantMessageId);
		assert.strictEqual(rewound?.assistantEditApplications?.[0]?.state.phase, 'applied');
		assert.strictEqual(harness.service.getAssistantEditApplicationState?.('thread-edit-state', futureAssistantMessageId), undefined);

		const reopened = createHarness({
			storageService: store.add(cloneWorkspaceStorage(storageService)),
			fileService,
		});
		const restored = reopened.service.getState('thread-edit-state');
		assert.ok(restored);
		assert.strictEqual(restored?.assistantEditApplications?.length, 1);
		assert.strictEqual(restored?.assistantEditApplications?.[0]?.messageId, initialAssistantMessageId);

		harness.service.dispose();
		reopened.service.dispose();
	});

	test('rewind refuses to branch while any assistant edit-apply state is pending on the thread', async () => {
		const storageService = store.add(new TestStorageService());
		const fileService = new InMemoryFileService();
		const targetUri = URI.file('/workspace/src/app.ts');
		fileService.files.set(targetUri.toString(), 'before');

		const harness = createHarness({ storageService, fileService });
		const runtimeHandle = harness.service.runThread(createThreadOptions('thread-rewind-pending-apply', 'turn-rewind-pending-apply', 'rewrite the file'));
		harness.agentLoopService.lastOptions?.observer.onResponseDelta?.('Assistant response before checkpoint.');
		const assistantMessageId = getLatestAssistantMessageId(harness.service.getState('thread-rewind-pending-apply'));

		const approvalPromise = harness.agentLoopService.lastOptions!.observer.onToolRequested!('edit_file', {
			path: 'src/app.ts',
			changes: 'ignored',
		});
		await waitForCondition(() => !!harness.service.getState('thread-rewind-pending-apply')?.pausedApproval?.snapshots.length);
		harness.service.approveLatestToolRequest('thread-rewind-pending-apply');
		assert.deepStrictEqual(await approvalPromise, { kind: 'approved' });

		fileService.files.set(targetUri.toString(), 'after');
		harness.agentLoopService.lastOptions?.observer.onToolResult?.('edit_file', {
			path: 'src/app.ts',
			changes: 'ignored',
		}, {
			success: true,
			output: 'Applied edit.',
		});
		harness.agentLoopService.handles[0]!.complete();
		await runtimeHandle.done;

		const checkpointId = harness.service.getState('thread-rewind-pending-apply')!.checkpoints[0]!.id;
		harness.service.setAssistantEditApplicationState?.('thread-rewind-pending-apply', assistantMessageId, { phase: 'pending' });

		const rewound = await harness.service.rewindToCheckpoint('thread-rewind-pending-apply', checkpointId);

		assert.strictEqual(rewound, false);
		assert.strictEqual(fileService.files.get(targetUri.toString()), 'after');
		assert.strictEqual(harness.service.getState('thread-rewind-pending-apply')?.currentCheckpointId, checkpointId);
		assert.strictEqual(
			harness.service.getAssistantEditApplicationState?.('thread-rewind-pending-apply', assistantMessageId)?.phase,
			'pending',
		);

		harness.service.dispose();
	});

	test('reload normalizes persisted pending assistant edit-apply state and prunes orphaned message entries', async () => {
		const storageService = store.add(new TestStorageService());
		const harness = createHarness({ storageService });
		const runtimeHandle = harness.service.runThread(createThreadOptions('thread-pending-apply', 'turn-pending-apply', 'apply the edit'));
		harness.agentLoopService.lastOptions?.observer.onResponseDelta?.('Assistant reply that started applying edits.');
		const assistantMessageId = getLatestAssistantMessageId(harness.service.getState('thread-pending-apply'));
		harness.service.setAssistantEditApplicationState?.('thread-pending-apply', assistantMessageId, { phase: 'pending' });
		harness.service.setAssistantEditApplicationState?.('thread-pending-apply', 'missing-assistant-message', { phase: 'failed' });
		harness.agentLoopService.handles[0]!.complete();
		await runtimeHandle.done;

		const reopened = createHarness({
			storageService: store.add(cloneWorkspaceStorage(storageService)),
		});
		const restored = reopened.service.getState('thread-pending-apply');
		assert.ok(restored);
		assert.deepStrictEqual(restored?.assistantEditApplications, [{
			messageId: assistantMessageId,
			state: { phase: 'failed' },
		}]);
		assert.strictEqual(reopened.service.getAssistantEditApplicationState?.('thread-pending-apply', assistantMessageId)?.phase, 'failed');
		assert.strictEqual(reopened.service.getAssistantEditApplicationState?.('thread-pending-apply', 'missing-assistant-message'), undefined);

		harness.service.dispose();
		reopened.service.dispose();
	});

	test('restore backfills imported-from-history metadata for older persisted runtime threads that predate message provenance', () => {
		const storageService = store.add(new TestStorageService());
		storeRawRuntimePayload(storageService, 'thread-legacy-import', JSON.stringify({
			schemaVersion: 1,
			state: {
				threadId: 'thread-legacy-import',
				turnId: 'thread-legacy-import:turn-1',
				mode: 'act',
				streamState: { kind: 'idle' },
				messages: [{
					id: 'legacy-user',
					role: 'user',
					mode: 'act',
					createdAt: 1,
					content: 'Apply the change.',
				}, {
					id: 'legacy-assistant',
					role: 'assistant',
					mode: 'act',
					createdAt: 2,
					content: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
				}],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 3,
			},
		}), 3);

		const reopened = createHarness({ storageService });
		const restored = reopened.service.getState('thread-legacy-import');
		assert.ok(restored);
		const restoredConversationMessages = restored?.messages.filter((message): message is Extract<IVSCloneThreadRuntimeState['messages'][number], { role: 'user' | 'assistant' }> =>
			message.role === 'user' || message.role === 'assistant',
		) ?? [];

		assert.deepStrictEqual(
			restoredConversationMessages.map(message => ({
				role: message.role,
				importedFromHistory: message.metadata?.importedFromHistory ?? false,
				content: message.content,
			})),
			[
				{ role: 'user', importedFromHistory: true, content: 'Apply the change.' },
				{ role: 'assistant', importedFromHistory: true, content: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE' },
			],
		);

		reopened.service.dispose();
	});

	test('history hydration falls back thread mode to act when older turns omit executionMode', () => {
		const storageService = store.add(new TestStorageService());
		const harness = createHarness({ storageService });
		const turns: IVSCloneChatHistoryTurn[] = [{
			turnId: 'thread-legacy-mode:turn-1',
			threadId: 'thread-legacy-mode',
			sequence: 1,
			promptText: 'Plan something old.',
			responseMarkdown: 'Legacy response one',
			responsePlainText: 'Legacy response one',
			startedAt: 1,
			completedAt: 2,
			status: 'completed',
			lastEventAt: 2,
		}, {
			turnId: 'thread-legacy-mode:turn-2',
			threadId: 'thread-legacy-mode',
			sequence: 2,
			promptText: 'Apply something old.',
			responseMarkdown: 'Legacy response two',
			responsePlainText: 'Legacy response two',
			startedAt: 3,
			completedAt: 4,
			status: 'completed',
			lastEventAt: 4,
		}];

		const hydrated = harness.service.ensureHydratedFromHistory('thread-legacy-mode', turns);
		assert.ok(hydrated);
		assert.strictEqual(hydrated?.mode, 'act');
		assert.deepStrictEqual(
			hydrated?.messages.filter((message): message is Extract<IVSCloneThreadRuntimeState['messages'][number], { role: 'user' | 'assistant' }> =>
				message.role === 'user' || message.role === 'assistant',
			).map(message => ({
				role: message.role,
				mode: message.mode,
				importedFromHistory: message.metadata?.importedFromHistory ?? false,
				content: message.content,
			})),
			[
				{ role: 'user', mode: 'act', importedFromHistory: true, content: 'Plan something old.' },
				{ role: 'assistant', mode: 'act', importedFromHistory: true, content: 'Legacy response one' },
				{ role: 'user', mode: 'act', importedFromHistory: true, content: 'Apply something old.' },
				{ role: 'assistant', mode: 'act', importedFromHistory: true, content: 'Legacy response two' },
			],
		);

		const reopened = createHarness({
			storageService: store.add(cloneWorkspaceStorage(storageService)),
		});
		const restored = reopened.service.getState('thread-legacy-mode');
		assert.ok(restored);
		assert.strictEqual(restored?.mode, 'act');

		harness.service.dispose();
		reopened.service.dispose();
	});

	test('hydrated mixed-mode history preserves per-message mode and import metadata across reload while keeping edit-apply durability bound to the assistant message', () => {
		const storageService = store.add(new TestStorageService());
		const harness = createHarness({ storageService });
		const turns: IVSCloneChatHistoryTurn[] = [{
			turnId: 'thread-mixed-mode:turn-1',
			threadId: 'thread-mixed-mode',
			sequence: 1,
			executionMode: 'plan',
			promptText: 'Plan the change.',
			responseMarkdown: 'Planning response',
			responsePlainText: 'Planning response',
			startedAt: 1,
			completedAt: 2,
			status: 'completed',
			lastEventAt: 2,
		}, {
			turnId: 'thread-mixed-mode:turn-2',
			threadId: 'thread-mixed-mode',
			sequence: 2,
			executionMode: 'act',
			promptText: 'Apply the change.',
			responseMarkdown: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
			responsePlainText: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
			startedAt: 3,
			completedAt: 4,
			status: 'completed',
			lastEventAt: 4,
		}];

		const hydrated = harness.service.ensureHydratedFromHistory('thread-mixed-mode', turns);
		assert.ok(hydrated);
		const hydratedConversationMessages = hydrated?.messages.filter((message): message is Extract<IVSCloneThreadRuntimeState['messages'][number], { role: 'user' | 'assistant' }> =>
			message.role === 'user' || message.role === 'assistant',
		) ?? [];
		assert.deepStrictEqual(
			hydratedConversationMessages.map(message => ({
				role: message.role,
				mode: message.mode,
				importedFromHistory: message.metadata?.importedFromHistory ?? false,
				content: message.content,
			})),
			[
				{ role: 'user', mode: 'plan', importedFromHistory: true, content: 'Plan the change.' },
				{ role: 'assistant', mode: 'plan', importedFromHistory: true, content: 'Planning response' },
				{ role: 'user', mode: 'act', importedFromHistory: true, content: 'Apply the change.' },
				{ role: 'assistant', mode: 'act', importedFromHistory: true, content: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE' },
			],
		);

		const actAssistantMessageId = [...(hydrated?.messages ?? [])].reverse().find(message => message.role === 'assistant' && message.mode === 'act')?.id;
		assert.ok(actAssistantMessageId);
		if (!actAssistantMessageId) {
			throw new Error('Expected an act-mode assistant message after mixed-mode hydration.');
		}
		harness.service.setAssistantEditApplicationState?.('thread-mixed-mode', actAssistantMessageId, {
			phase: 'applied',
			result: {
				attemptedEdits: 1,
				appliedEdits: 1,
				modifiedFiles: [URI.file('/workspace/src/app.ts')],
				failures: [],
				fileChanges: [{
					uri: URI.file('/workspace/src/app.ts'),
					displayPath: 'src/app.ts',
					addedLines: 1,
					removedLines: 1,
					action: 'modify',
					originalContent: 'old',
				}],
			},
		});

		const reopened = createHarness({
			storageService: store.add(cloneWorkspaceStorage(storageService)),
		});
		const restored = reopened.service.getState('thread-mixed-mode');
		assert.ok(restored);
		const restoredConversationMessages = restored?.messages.filter((message): message is Extract<IVSCloneThreadRuntimeState['messages'][number], { role: 'user' | 'assistant' }> =>
			message.role === 'user' || message.role === 'assistant',
		) ?? [];
		assert.deepStrictEqual(
			restoredConversationMessages.map(message => ({
				role: message.role,
				mode: message.mode,
				importedFromHistory: message.metadata?.importedFromHistory ?? false,
				content: message.content,
			})),
			[
				{ role: 'user', mode: 'plan', importedFromHistory: true, content: 'Plan the change.' },
				{ role: 'assistant', mode: 'plan', importedFromHistory: true, content: 'Planning response' },
				{ role: 'user', mode: 'act', importedFromHistory: true, content: 'Apply the change.' },
				{ role: 'assistant', mode: 'act', importedFromHistory: true, content: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE' },
			],
		);
		assert.deepStrictEqual(
			reopened.service.getAssistantEditApplicationState?.('thread-mixed-mode', actAssistantMessageId),
			{
				phase: 'applied',
				result: {
					attemptedEdits: 1,
					appliedEdits: 1,
					modifiedFiles: [URI.file('/workspace/src/app.ts')],
					failures: [],
					fileChanges: [{
						uri: URI.file('/workspace/src/app.ts'),
						displayPath: 'src/app.ts',
						addedLines: 1,
						removedLines: 1,
						action: 'modify',
						originalContent: 'old',
					}],
				},
			},
		);

		harness.service.dispose();
		reopened.service.dispose();
	});

	test('rewind refuses a restored paused-approval thread even when no live execution handle exists', async () => {
		const storageService = store.add(new TestStorageService());
		const fileService = new InMemoryFileService();
		const firstTargetUri = URI.file('/workspace/src/app.ts');
		const pausedTargetUri = URI.file('/workspace/src/paused.ts');
		fileService.files.set(firstTargetUri.toString(), 'before');
		fileService.files.set(pausedTargetUri.toString(), 'before paused');

		const first = createHarness({ storageService, fileService });
		const runtimeHandle = first.service.runThread(createThreadOptions('thread-rewind-paused-approval', 'turn-rewind-paused-approval', 'apply two edits'));
		first.agentLoopService.lastOptions?.observer.onResponseDelta?.('Assistant response before the first tool.');

		const firstApprovalPromise = first.agentLoopService.lastOptions!.observer.onToolRequested!('edit_file', {
			path: 'src/app.ts',
			changes: 'ignored',
		});
		await waitForCondition(() => !!first.service.getState('thread-rewind-paused-approval')?.pausedApproval?.snapshots.length);
		assert.strictEqual(first.service.approveLatestToolRequest('thread-rewind-paused-approval'), true);
		assert.deepStrictEqual(await firstApprovalPromise, { kind: 'approved' });

		fileService.files.set(firstTargetUri.toString(), 'after');
		first.agentLoopService.lastOptions?.observer.onToolResult?.('edit_file', {
			path: 'src/app.ts',
			changes: 'ignored',
		}, {
			success: true,
			output: 'Applied edit.',
		});
		const checkpointId = first.service.getState('thread-rewind-paused-approval')?.checkpoints[0]?.id;
		assert.ok(checkpointId);
		if (!checkpointId) {
			throw new Error('Expected a durable checkpoint before the second approval request.');
		}

		const pausedApprovalPromise = first.agentLoopService.lastOptions!.observer.onToolRequested!('edit_file', {
			path: 'src/paused.ts',
			changes: 'ignored',
		});
		await waitForCondition(() => first.service.getState('thread-rewind-paused-approval')?.pausedApproval?.params.path === 'src/paused.ts');

		const reopened = createHarness({
			storageService: store.add(cloneWorkspaceStorage(storageService)),
			fileService,
		});
		const restored = reopened.service.getState('thread-rewind-paused-approval');
		assert.ok(restored);
		assert.strictEqual(restored?.streamState.kind, 'awaiting_user');
		assert.strictEqual(restored?.pausedApproval?.params.path, 'src/paused.ts');

		const rewound = await reopened.service.rewindToCheckpoint('thread-rewind-paused-approval', checkpointId);

		assert.strictEqual(rewound, false);
		assert.strictEqual(reopened.service.getState('thread-rewind-paused-approval')?.currentCheckpointId, checkpointId);
		assert.strictEqual(reopened.service.getState('thread-rewind-paused-approval')?.streamState.kind, 'awaiting_user');

		assert.strictEqual(first.service.rejectLatestToolRequest('thread-rewind-paused-approval', 'cleanup after paused approval rewind assertion'), true);
		assert.deepStrictEqual(
			await expectPromiseToSettle(pausedApprovalPromise),
			{ kind: 'rejected', reason: 'cleanup after paused approval rewind assertion' },
		);
		first.agentLoopService.handles[0]!.complete();
		await runtimeHandle.done;

		first.service.dispose();
		reopened.service.dispose();
	});

	test('restores a paused approval after reload and resumes it durably', async () => {
		const storageService = store.add(new TestStorageService());
		const fileService = new InMemoryFileService();
		fileService.files.set(URI.file('/workspace/src/app.ts').toString(), 'before');

		const first = createHarness({ storageService, fileService });
		const runtimeHandle = first.service.runThread(createThreadOptions('thread-3', 'turn-3', 'edit with approval'));
		first.agentLoopService.lastOptions?.observer.onResponseDelta?.('Assistant reply before approval.');
		const approvalPromise = first.agentLoopService.lastOptions!.observer.onToolRequested!('edit_file', {
			path: 'src/app.ts',
			changes: 'ignored',
		});

		await waitForCondition(() => !!first.service.getState('thread-3')?.pausedApproval?.snapshots.length);

		const reopened = createHarness({
			storageService: store.add(cloneWorkspaceStorage(storageService)),
			fileService,
		});
		const restored = reopened.service.getState('thread-3');
		assert.ok(restored);
		assert.strictEqual(restored?.streamState.kind, 'awaiting_user');
		assert.strictEqual(restored?.pausedApproval?.toolName, 'edit_file');
		assert.strictEqual(restored?.pausedApproval?.snapshots[0]?.content, 'before');

		const approved = reopened.service.approveLatestToolRequest('thread-3');
		assert.strictEqual(approved, true);
		await waitForCondition(() => (reopened.service.getState('thread-3')?.checkpoints.length ?? 0) > 0);
		await waitForCondition(() => reopened.agentLoopService.lastOptions?.recordPromptMessage === false);

		const resumed = reopened.service.getState('thread-3');
		assert.ok(resumed);
		assert.strictEqual(resumed?.pausedApproval, undefined);
		assert.strictEqual(reopened.toolExecutionService.calls[0]?.toolName, 'edit_file');
		assert.strictEqual(reopened.toolExecutionService.calls[0]?.mode, 'act');
		assert.ok(resumed!.messages.some(message => message.role === 'checkpoint'));
		assert.deepStrictEqual(reopened.agentLoopService.lastOptions?.previousTurns, [
			{ role: 'user', content: 'edit with approval' },
			{ role: 'assistant', content: 'Assistant reply before approval.' },
		]);
		assert.strictEqual(
			reopened.agentLoopService.lastOptions?.promptText,
			formatToolResult('edit_file', { success: true, output: 'Executed edit_file.' }),
		);
		assert.strictEqual(reopened.agentLoopService.lastOptions?.recordPromptMessage, false);
		reopened.agentLoopService.lastOptions?.observer.onResponseDelta?.('Assistant continued after reload.');
		reopened.agentLoopService.handles[0]!.complete();
		await waitForCondition(() => reopened.service.getState('thread-3')?.isRunning === false);
		assert.ok(reopened.service.getState('thread-3')?.messages.some(message => message.role === 'assistant' && message.content.includes('Assistant continued after reload.')));

		assert.ok(first.service.rejectLatestToolRequest('thread-3', 'cleanup after reload assertion'));
		assert.deepStrictEqual(
			await expectPromiseToSettle(approvalPromise),
			{ kind: 'rejected', reason: 'cleanup after reload assertion' },
		);
		first.agentLoopService.handles[0]!.complete();
		await runtimeHandle.done;

		first.service.dispose();
		reopened.service.dispose();
	});

	test('keeps approval checkpoints durable when snapshot capture finishes after approval', async () => {
		const storageService = store.add(new TestStorageService());
		const fileService = new InMemoryFileService();
		fileService.files.set(URI.file('/workspace/src/app.ts').toString(), 'before');
		const captureGate = fileService.blockExistsUntilReleased();

		const harness = createHarness({ storageService, fileService });
		const runtimeHandle = harness.service.runThread(createThreadOptions('thread-4', 'turn-4', 'edit after approval'));
		const approvalPromise = harness.agentLoopService.lastOptions!.observer.onToolRequested!('edit_file', {
			path: 'src/app.ts',
			changes: 'ignored',
		});

		await waitForCondition(() => harness.service.getState('thread-4')?.streamState.kind === 'awaiting_user');
		assert.deepStrictEqual(
			harness.service.getState('thread-4')?.pausedApproval?.snapshots,
			[],
			'pausedApproval should persist immediately so reload does not lose an in-flight approval while snapshots are still being captured',
		);
		assert.strictEqual(harness.service.approveLatestToolRequest('thread-4'), true);
		captureGate.complete();
		assert.deepStrictEqual(await approvalPromise, { kind: 'approved' });
		await flushMicrotasks();
		assert.strictEqual(harness.service.getState('thread-4')?.pausedApproval, undefined);

		harness.agentLoopService.lastOptions?.observer.onToolResult?.('edit_file', {
			path: 'src/app.ts',
			changes: 'ignored',
		}, {
			success: true,
			output: 'Applied edit.',
		});
		await waitForCondition(() => (harness.service.getState('thread-4')?.checkpoints.length ?? 0) === 1);
		assert.strictEqual(harness.service.getState('thread-4')?.pausedApproval, undefined);
		assert.strictEqual(harness.service.getState('thread-4')?.checkpoints[0]?.toolName, 'edit_file');
		const reopened = createHarness({
			storageService: store.add(cloneWorkspaceStorage(storageService)),
			fileService,
		});
		assert.strictEqual(reopened.service.getState('thread-4')?.pausedApproval, undefined);
		assert.strictEqual(reopened.service.getState('thread-4')?.checkpoints.length, 1);

		harness.agentLoopService.handles[0]!.complete();
		await runtimeHandle.done;
		harness.service.dispose();
		reopened.service.dispose();
	});

	test('restores paused approvals even before snapshot capture finishes', async () => {
		const storageService = store.add(new TestStorageService());
		const fileService = new InMemoryFileService();
		fileService.files.set(URI.file('/workspace/src/app.ts').toString(), 'before');
		const captureGate = fileService.blockExistsUntilReleased();

		const first = createHarness({ storageService, fileService });
		const runtimeHandle = first.service.runThread(createThreadOptions('thread-early-reload', 'turn-early-reload', 'reload while waiting'));
		const approvalPromise = first.agentLoopService.lastOptions!.observer.onToolRequested!('edit_file', {
			path: 'src/app.ts',
			changes: 'ignored',
		});

		await waitForCondition(() => first.service.getState('thread-early-reload')?.pausedApproval !== undefined);
		assert.deepStrictEqual(first.service.getState('thread-early-reload')?.pausedApproval?.snapshots, []);

		const reopened = createHarness({
			storageService: store.add(cloneWorkspaceStorage(storageService)),
			fileService,
		});
		const restored = reopened.service.getState('thread-early-reload');
		assert.ok(restored);
		assert.strictEqual(restored?.streamState.kind, 'awaiting_user');
		assert.strictEqual(restored?.pausedApproval?.toolName, 'edit_file');
		assert.deepStrictEqual(restored?.pausedApproval?.snapshots, []);

		assert.strictEqual(first.service.rejectLatestToolRequest('thread-early-reload', 'cleanup after early reload assertion'), true);
		captureGate.complete();
		assert.deepStrictEqual(
			await expectPromiseToSettle(approvalPromise),
			{ kind: 'rejected', reason: 'cleanup after early reload assertion' },
		);

		first.agentLoopService.handles[0]!.complete();
		await runtimeHandle.done;
		first.service.dispose();
		reopened.service.dispose();
	});

	test('drops late snapshot captures after rejection without restoring paused approval', async () => {
		const storageService = store.add(new TestStorageService());
		const fileService = new InMemoryFileService();
		fileService.files.set(URI.file('/workspace/src/app.ts').toString(), 'before');
		const captureGate = fileService.blockExistsUntilReleased();

		const harness = createHarness({ storageService, fileService });
		const runtimeHandle = harness.service.runThread(createThreadOptions('thread-5', 'turn-5', 'edit after rejection'));
		const approvalPromise = harness.agentLoopService.lastOptions!.observer.onToolRequested!('edit_file', {
			path: 'src/app.ts',
			changes: 'ignored',
		});

		await waitForCondition(() => harness.service.getState('thread-5')?.streamState.kind === 'awaiting_user');
		assert.strictEqual(harness.service.rejectLatestToolRequest('thread-5', 'not now'), true);
		captureGate.complete();
		assert.deepStrictEqual(await approvalPromise, { kind: 'rejected', reason: 'not now' });
		await flushMicrotasks();

		const state = harness.service.getState('thread-5');
		assert.ok(state);
		assert.strictEqual(state?.pausedApproval, undefined);
		assert.strictEqual(state?.checkpoints.length, 0);
		const reopened = createHarness({
			storageService: store.add(cloneWorkspaceStorage(storageService)),
			fileService,
		});
		assert.strictEqual(reopened.service.getState('thread-5')?.pausedApproval, undefined);

		harness.agentLoopService.handles[0]!.complete();
		await runtimeHandle.done;
		harness.service.dispose();
		reopened.service.dispose();
	});

	test('records rejected turns directly into runtime state so reloads preserve the rejection branch', async () => {
		const storageService = store.add(new TestStorageService());
		const harness = createHarness({ storageService });

		harness.service.recordRejectedTurn({
			threadId: 'thread-rejected',
			turnId: 'turn-rejected',
			promptText: 'sign in first',
			mode: 'act',
			reason: 'Sign in to a provider and choose a model before sending messages through VSClone.',
		});

		const state = harness.service.getState('thread-rejected');
		assert.ok(state);
		assert.deepStrictEqual(state?.messages.map(message => message.role), ['user', 'assistant']);
		assert.strictEqual(state?.messages[1]?.content, 'Sign in to a provider and choose a model before sending messages through VSClone.');
		assert.strictEqual(state?.pausedApproval, undefined);
		assert.strictEqual(state?.streamState.kind, 'idle');

		const reopened = createHarness({
			storageService: store.add(cloneWorkspaceStorage(storageService)),
		});
		const restored = reopened.service.getState('thread-rejected');
		assert.ok(restored);
		assert.deepStrictEqual(restored?.messages.map(message => message.role), ['user', 'assistant']);
		assert.strictEqual(restored?.messages[1]?.content, 'Sign in to a provider and choose a model before sending messages through VSClone.');

		harness.service.dispose();
		reopened.service.dispose();
	});

	test('canceling a persisted approval run aborts the resumed tool execution without restarting the loop', async () => {
		const storageService = store.add(new TestStorageService());
		const fileService = new InMemoryFileService();
		fileService.files.set(URI.file('/workspace/src/app.ts').toString(), 'before');

		const first = createHarness({ storageService, fileService });
		const runtimeHandle = first.service.runThread(createThreadOptions('thread-cancel', 'turn-cancel', 'edit after reload'));
		const approvalPromise = first.agentLoopService.lastOptions!.observer.onToolRequested!('edit_file', {
			path: 'src/app.ts',
			changes: 'ignored',
		});

		await waitForCondition(() => !!first.service.getState('thread-cancel')?.pausedApproval?.snapshots.length);

		const reopenedToolExecutionService = new BlockingToolExecutionService();
		const reopened = createHarness({
			storageService: store.add(cloneWorkspaceStorage(storageService)),
			fileService,
			toolExecutionService: reopenedToolExecutionService,
		});
		assert.strictEqual(reopened.service.approveLatestToolRequest('thread-cancel'), true);
		reopened.service.cancelThread('thread-cancel');

		await waitForCondition(() => reopenedToolExecutionService.cancelledCalls === 1);
		await waitForCondition(() => reopened.service.getState('thread-cancel')?.streamState.kind === 'idle');

		const reopenedState = reopened.service.getState('thread-cancel');
		assert.ok(reopenedState);
		assert.strictEqual(reopenedState?.streamState.kind, 'idle');
		assert.strictEqual(reopened.agentLoopService.handles.length, 0);
		assert.ok(reopenedState!.messages.some(message => message.role === 'tool' && message.type === 'tool_error'));

		assert.ok(first.service.rejectLatestToolRequest('thread-cancel', 'cleanup after reload assertion'));
		assert.deepStrictEqual(await approvalPromise, { kind: 'rejected', reason: 'cleanup after reload assertion' });
		first.agentLoopService.handles[0]!.complete();
		await runtimeHandle.done;

		first.service.dispose();
		reopened.service.dispose();
	});

	test('a timed out persisted approval resumes the branch with a tool error instead of wedging forever', async () => {
		const storageService = store.add(new TestStorageService());
		const fileService = new InMemoryFileService();
		fileService.files.set(URI.file('/workspace/src/app.ts').toString(), 'before');

		const first = createHarness({ storageService, fileService });
		const runtimeHandle = first.service.runThread(createThreadOptions('thread-timeout', 'turn-timeout', 'edit after reload timeout'));
		const approvalPromise = first.agentLoopService.lastOptions!.observer.onToolRequested!('edit_file', {
			path: 'src/app.ts',
			changes: 'ignored',
		});

		await waitForCondition(() => !!first.service.getState('thread-timeout')?.pausedApproval?.snapshots.length);

		const reopened = createHarness({
			storageService: store.add(cloneWorkspaceStorage(storageService)),
			fileService,
			toolExecutionService: new NeverSettlingToolExecutionService(),
			persistedToolExecutionTimeoutMs: 500,
		});
		assert.strictEqual(reopened.service.approveLatestToolRequest('thread-timeout'), true);

		await waitForCondition(() => reopened.agentLoopService.lastOptions?.recordPromptMessage === false, 1500);

		const reopenedState = reopened.service.getState('thread-timeout');
		assert.ok(reopenedState);
		assert.ok(reopenedState!.messages.some(message =>
			message.role === 'tool'
			&& message.type === 'tool_error'
			&& message.output?.includes('did not finish within 1 seconds and was cancelled.'),
		));
		assert.strictEqual(reopened.agentLoopService.handles.length, 1);
		assert.strictEqual(reopened.agentLoopService.lastOptions?.recordPromptMessage, false);
		assert.strictEqual(reopened.service.getState('thread-timeout')?.checkpoints.length, 0);

		reopened.agentLoopService.handles[0]!.complete();
		await waitForCondition(() => reopened.service.getState('thread-timeout')?.isRunning === false);

		assert.ok(first.service.rejectLatestToolRequest('thread-timeout', 'cleanup after timeout assertion'));
		assert.deepStrictEqual(await approvalPromise, { kind: 'rejected', reason: 'cleanup after timeout assertion' });
		first.agentLoopService.handles[0]!.complete();
		await runtimeHandle.done;

		first.service.dispose();
		reopened.service.dispose();
	});

	test('imports missing history thread metadata once and serves rail queries from the runtime catalog', async () => {
		const storageService = store.add(new TestStorageService());
		const harness = createHarness({ storageService });
		const hydratedTurns: IVSCloneChatHistoryTurn[] = [{
			turnId: 'thread-imported-completed:turn-1',
			threadId: 'thread-imported-completed',
			sequence: 1,
			executionMode: 'act',
			promptText: 'Synthetic prompt before full history metadata arrives',
			responseMarkdown: 'Synthetic assistant response',
			responsePlainText: 'Synthetic assistant response',
			startedAt: 3,
			completedAt: 4,
			status: 'completed',
			lastEventAt: 4,
		}];

		// The explicit import path is a migration seam: it should seed missing runtime metadata one
		// time and then leave the runtime catalog as the durable owner for later reads and reloads.
		const importedCompletedThread = createHistoryThread({
			threadId: 'thread-imported-completed',
			title: 'Imported planner thread',
			updatedAt: 10,
			lastTurnPreview: 'Planner preview text',
		});
		const archivedThread = createHistoryThread({
			threadId: 'thread-imported-archived',
			title: 'Archived imported thread',
			updatedAt: 9,
			status: 'archived',
			archived: true,
			lastTurnPreview: 'Archived preview text',
		});
		const syntheticHydrated = harness.service.ensureHydratedFromHistory('thread-imported-completed', hydratedTurns);
		assert.ok(syntheticHydrated);
		assert.strictEqual(syntheticHydrated?.catalog.sessionResource, undefined);
		assert.strictEqual(syntheticHydrated?.catalog.title, 'Synthetic prompt before full history metadata arrives');
		harness.service.ensureCatalogImportedFromHistory(importedCompletedThread);
		harness.service.ensureCatalogImportedFromHistory(archivedThread);
		harness.service.ensureCatalogImportedFromHistory({
			...importedCompletedThread,
			title: 'History should not win after import',
			lastTurnPreview: 'This should never replace runtime-owned metadata',
		});

		const activeHandle = harness.service.runThread(createThreadOptions('thread-live-active', 'turn-live-active', 'Live runtime prompt'));
		assert.deepStrictEqual(harness.service.getThreads({ tab: 'all' }).map(thread => thread.threadId), [
			'thread-live-active',
			'thread-imported-completed',
			'thread-imported-archived',
		]);
		assert.deepStrictEqual(harness.service.getThreads({ tab: 'active' }).map(thread => thread.threadId), ['thread-live-active']);
		assert.deepStrictEqual(harness.service.getThreads({ tab: 'archived' }).map(thread => thread.threadId), ['thread-imported-archived']);
		assert.deepStrictEqual(harness.service.getThreads({ text: 'planner', includeArchived: false }).map(thread => thread.threadId), ['thread-imported-completed']);
		assert.strictEqual(harness.service.getState('thread-imported-completed')?.catalog.title, 'Imported planner thread');
		assert.strictEqual(harness.service.getState('thread-imported-completed')?.catalog.sessionResource, importedCompletedThread.sessionResource);
		assert.strictEqual(harness.service.getState('thread-imported-completed')?.catalog.importedFromHistory, true);

		harness.agentLoopService.handles[0]!.complete();
		await activeHandle.done;

		const reopened = createHarness({
			storageService: store.add(cloneWorkspaceStorage(storageService)),
		});
		assert.deepStrictEqual(reopened.service.getThreads({ tab: 'all' }).map(thread => thread.threadId), [
			'thread-live-active',
			'thread-imported-completed',
			'thread-imported-archived',
		]);
		assert.strictEqual(reopened.service.getState('thread-imported-completed')?.catalog.title, 'Imported planner thread');
		assert.strictEqual(reopened.service.getState('thread-imported-completed')?.catalog.sessionResource, importedCompletedThread.sessionResource);
		assert.strictEqual(reopened.service.getState('thread-imported-completed')?.catalog.importedFromHistory, true);

		harness.service.dispose();
		reopened.service.dispose();
	});

	test('explicit history import upgrades restored synthetic runtime catalog metadata that predates import markers', () => {
		const storageService = store.add(new TestStorageService());
		storeRawRuntimePayload(storageService, 'thread-restored-synthetic', JSON.stringify({
			schemaVersion: 1,
			state: {
				threadId: 'thread-restored-synthetic',
				mode: 'act',
				streamState: { kind: 'idle' },
				messages: [{
					id: 'legacy-user',
					role: 'user',
					mode: 'act',
					createdAt: 5,
					content: 'Legacy runtime prompt',
				}, {
					id: 'legacy-assistant',
					role: 'assistant',
					mode: 'act',
					createdAt: 6,
					content: 'Legacy runtime response',
				}],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 7,
			},
		}), 7);

		const restored = createHarness({ storageService });
		const restoredState = restored.service.getState('thread-restored-synthetic');
		assert.ok(restoredState);
		assert.strictEqual(restoredState?.catalog.sessionResource, undefined);
		assert.strictEqual(restoredState?.catalog.importedFromHistory, undefined);
		assert.strictEqual(restoredState?.catalog.title, 'Legacy runtime prompt');

		const importedThread = createHistoryThread({
			threadId: 'thread-restored-synthetic',
			sessionResource: 'vsclone://api/restored-upgrade',
			title: 'Imported thread title',
			updatedAt: 11,
			lastTurnPreview: 'Imported preview',
		});
		restored.service.ensureCatalogImportedFromHistory(importedThread);

		const upgraded = restored.service.getState('thread-restored-synthetic');
		assert.ok(upgraded);
		assert.strictEqual(upgraded?.catalog.sessionResource, importedThread.sessionResource);
		assert.strictEqual(upgraded?.catalog.title, 'Imported thread title');
		assert.strictEqual(upgraded?.catalog.importedFromHistory, true);

		restored.service.ensureCatalogImportedFromHistory({
			...importedThread,
			sessionResource: 'vsclone://api/should-not-win',
			title: 'Second history import should not overwrite runtime',
		});
		assert.strictEqual(restored.service.getState('thread-restored-synthetic')?.catalog.sessionResource, importedThread.sessionResource);
		assert.strictEqual(restored.service.getState('thread-restored-synthetic')?.catalog.title, 'Imported thread title');

		restored.service.dispose();
	});

	test('persists archive and delete lifecycle changes through the runtime catalog', async () => {
		const storageService = store.add(new TestStorageService());
		const harness = createHarness({ storageService });
		const archivedHandle = harness.service.runThread(createThreadOptions('thread-to-archive', 'turn-to-archive', 'Archive this thread'));
		const deletedHandle = harness.service.runThread(createThreadOptions('thread-to-delete', 'turn-to-delete', 'Delete this thread'));
		harness.agentLoopService.handles[0]!.complete();
		await archivedHandle.done;
		harness.agentLoopService.handles[1]!.complete();
		await deletedHandle.done;

		assert.strictEqual(harness.service.archiveThread('thread-to-archive', true), true);
		assert.strictEqual(harness.service.deleteThread('thread-to-delete'), true);
		assert.deepStrictEqual(harness.service.getThreads({ tab: 'archived' }).map(thread => thread.threadId), ['thread-to-archive']);
		assert.strictEqual(harness.service.getState('thread-to-delete'), undefined);

		const reopened = createHarness({
			storageService: store.add(cloneWorkspaceStorage(storageService)),
		});
		assert.deepStrictEqual(reopened.service.getThreads({ tab: 'archived' }).map(thread => thread.threadId), ['thread-to-archive']);
		assert.strictEqual(reopened.service.getState('thread-to-archive')?.catalog.status, 'archived');
		assert.strictEqual(reopened.service.getState('thread-to-delete'), undefined);
		assert.strictEqual(reopened.service.isDeletedThread('thread-to-delete'), true);
		assert.ok(!reopened.service.getThreads({ tab: 'all' }).some(thread => thread.threadId === 'thread-to-delete'));

		harness.service.dispose();
		reopened.service.dispose();
	});

	test('clearAll removes every runtime-owned thread record and its persisted catalog', () => {
		const storageService = store.add(new TestStorageService());
		const harness = createHarness({ storageService });
		harness.service.ensureCatalogImportedFromHistory(createHistoryThread({
			threadId: 'thread-clear-1',
			title: 'First imported thread',
			updatedAt: 10,
		}));
		harness.service.ensureCatalogImportedFromHistory(createHistoryThread({
			threadId: 'thread-clear-2',
			title: 'Second imported thread',
			updatedAt: 11,
			archived: true,
			status: 'archived',
		}));
		assert.strictEqual(harness.service.getThreads({ tab: 'all' }).length, 2);

		harness.service.clearAll();

		assert.deepStrictEqual(harness.service.getThreads({ tab: 'all' }), []);
		assert.strictEqual(harness.service.getState('thread-clear-1'), undefined);
		assert.strictEqual(harness.service.getState('thread-clear-2'), undefined);
		assert.strictEqual(storageService.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).length, 0);

		const reopened = createHarness({
			storageService: store.add(cloneWorkspaceStorage(storageService)),
		});
		assert.deepStrictEqual(reopened.service.getThreads({ tab: 'all' }), []);

		harness.service.dispose();
		reopened.service.dispose();
	});

	test('terminal approvals do not create durable checkpoints', async () => {
		const storageService = store.add(new TestStorageService());
		const fileService = new InMemoryFileService();
		const harness = createHarness({ storageService, fileService });

		const runCommandHandle = harness.service.runThread(createThreadOptions('thread-4', 'turn-4', 'run a shell command'));
		const runCommandApproval = harness.agentLoopService.lastOptions!.observer.onToolRequested!('run_command', {
			command: 'echo after > src/app.ts',
			cwd: '/workspace',
		});
		await waitForCondition(() => harness.service.getState('thread-4')?.pausedApproval !== undefined);
		assert.strictEqual(harness.service.getState('thread-4')?.pausedApproval?.snapshots.length, 0);
		harness.service.approveLatestToolRequest('thread-4');
		assert.deepStrictEqual(await runCommandApproval, { kind: 'approved' });
		harness.agentLoopService.lastOptions?.observer.onToolResult?.('run_command', {
			command: 'echo after > src/app.ts',
			cwd: '/workspace',
		}, {
			success: true,
			output: 'command completed',
		});
		harness.agentLoopService.handles[0]!.complete();
		await runCommandHandle.done;

		const runCommandState = harness.service.getState('thread-4');
		assert.ok(runCommandState);
		assert.strictEqual(runCommandState?.checkpoints.length, 0);

		const persistentHandle = harness.service.runThread(createThreadOptions('thread-5', 'turn-5', 'run a persistent command'));
		const persistentApproval = harness.agentLoopService.lastOptions!.observer.onToolRequested!('run_persistent_command', {
			persistent_terminal_id: '1',
			command: 'echo after > src/app.ts',
		});
		await waitForCondition(() => harness.service.getState('thread-5')?.pausedApproval !== undefined);
		assert.strictEqual(harness.service.getState('thread-5')?.pausedApproval?.snapshots.length, 0);
		harness.service.approveLatestToolRequest('thread-5');
		assert.deepStrictEqual(await persistentApproval, { kind: 'approved' });
		harness.agentLoopService.lastOptions?.observer.onToolResult?.('run_persistent_command', {
			persistent_terminal_id: '1',
			command: 'echo after > src/app.ts',
		}, {
			success: true,
			output: 'command completed',
		});
		harness.agentLoopService.handles[1]!.complete();
		await persistentHandle.done;

		const persistentState = harness.service.getState('thread-5');
		assert.ok(persistentState);
		assert.strictEqual(persistentState?.checkpoints.length, 0);
		const reopened = createHarness({
			storageService: store.add(cloneWorkspaceStorage(storageService)),
			fileService,
		});
		assert.strictEqual(reopened.service.getState('thread-4')?.checkpoints.length, 0);
		assert.strictEqual(reopened.service.getState('thread-5')?.checkpoints.length, 0);

		harness.service.dispose();
		reopened.service.dispose();
	});
});
