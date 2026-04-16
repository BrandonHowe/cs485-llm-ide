/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TestWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { VSCloneThreadRuntimeSerializer } from '../../common/backend/vscloneThreadRuntimeSerializer.js';
import { IVSCloneThreadRuntimeState } from '../../common/vscloneThreadRuntimeTypes.js';
import { VSCloneThreadRuntimeStore } from '../../common/backend/vscloneThreadRuntimeStore.js';

suite('VSCloneThreadRuntimeStore', () => {
	const storeDisposables = ensureNoDisposablesAreLeakedInTestSuite();
	const STORAGE_PREFIX = 'vsclone.threadRuntime.v1';
	const INDEX_STORAGE_KEY = `${STORAGE_PREFIX}.index`;
	const THREAD_STORAGE_KEY_PREFIX = `${STORAGE_PREFIX}.thread.`;

	let instantiationService: TestInstantiationService;
	let storageService: TestStorageService;

	setup(() => {
		instantiationService = storeDisposables.add(new TestInstantiationService(new ServiceCollection()));
		storageService = storeDisposables.add(new TestStorageService());

		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(IWorkspaceContextService, new TestContextService(TestWorkspace));
		instantiationService.stub(ILogService, new NullLogService());
	});

	function createState(threadId = 'thread-1'): IVSCloneThreadRuntimeState {
		return {
			threadId,
			catalog: {
				threadId,
				sessionResource: `vsclone://api/${threadId}`,
				title: `Prompt for ${threadId}`,
				activeModelIdentifier: 'openai/gpt-5.3-codex',
				createdAt: 1,
				updatedAt: 3,
				status: 'completed',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Applied the edit suggestion.',
			},
			turnId: `${threadId}:turn-1`,
			mode: 'act',
			streamState: { kind: 'idle' },
			messages: [{
				id: `${threadId}:msg-1`,
				role: 'user',
				mode: 'plan',
				createdAt: 1,
				content: 'Prompt',
				imageAttachments: undefined,
			}, {
				id: `${threadId}:msg-2`,
				role: 'assistant',
				mode: 'plan',
				createdAt: 2,
				content: 'Applied the edit suggestion.',
			}],
			assistantEditApplications: [{
				messageId: `${threadId}:msg-2`,
				state: {
					phase: 'applied',
					result: {
						attemptedEdits: 1,
						appliedEdits: 1,
						modifiedFiles: [URI.file(`/workspace/${threadId}.ts`)],
						failures: [],
						fileChanges: [{
							uri: URI.file(`/workspace/${threadId}.ts`),
							displayPath: `${threadId}.ts`,
							addedLines: 1,
							removedLines: 0,
							action: 'modify',
							originalContent: 'before',
						}],
					},
				},
			}],
			checkpoints: [{
				id: `${threadId}:checkpoint-1`,
				createdAt: 2,
				type: 'tool_edit',
				toolName: 'edit_file',
				snapshots: [{
					uri: URI.file(`/workspace/${threadId}.ts`),
					existed: true,
					content: 'before',
					isDirectory: false,
				}],
			}],
			currentCheckpointId: `${threadId}:checkpoint-1`,
			branchHeadMessageId: `${threadId}:msg-2`,
			pausedApproval: undefined,
			isRunning: false,
			lastUpdatedAt: 3,
		};
	}

	test('saves and loads runtime states from workspace storage', () => {
		const store = storeDisposables.add(instantiationService.createInstance(VSCloneThreadRuntimeStore));
		store.saveState(createState());

		assert.strictEqual(storageService.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).length, 2);
		assert.deepStrictEqual(store.loadAll(), [createState()]);
	});

	test('deleting a state removes its thread record and clears the index when empty', () => {
		const store = storeDisposables.add(instantiationService.createInstance(VSCloneThreadRuntimeStore));
		store.saveState(createState('thread-1'));
		store.saveState(createState('thread-2'));

		store.deleteState('thread-1');
		assert.deepStrictEqual(store.loadAll(), [createState('thread-2')]);

		store.deleteState('thread-2');
		assert.strictEqual(storageService.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).length, 0);
	});

	test('markDeletedThread persists a tombstone that saveState clears when the thread is recreated', () => {
		const store = storeDisposables.add(instantiationService.createInstance(VSCloneThreadRuntimeStore));
		store.saveState(createState('thread-1'));

		store.markDeletedThread('thread-1');
		assert.deepStrictEqual(store.loadAll(), []);
		assert.deepStrictEqual(store.loadDeletedThreadIds(), ['thread-1']);

		store.saveState(createState('thread-1'));
		assert.deepStrictEqual(store.loadDeletedThreadIds(), []);
		assert.deepStrictEqual(store.loadAll(), [createState('thread-1')]);
	});

	test('clearAll removes every persisted runtime thread and the shared index', () => {
		const store = storeDisposables.add(instantiationService.createInstance(VSCloneThreadRuntimeStore));
		store.saveState(createState('thread-1'));
		store.saveState(createState('thread-2'));

		store.clearAll();

		assert.deepStrictEqual(store.loadAll(), []);
		assert.strictEqual(storageService.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).length, 0);
	});

	test('rebuilds from per-thread payloads when the index is malformed', () => {
		const store = storeDisposables.add(instantiationService.createInstance(VSCloneThreadRuntimeStore));
		const serializer = new VSCloneThreadRuntimeSerializer();

		// The fallback path should trust the per-thread payloads because a single broken index write
		// must not orphan otherwise valid runtime state.
		storageService.store(
			`${THREAD_STORAGE_KEY_PREFIX}${encodeURIComponent('thread-a')}`,
			serializer.serializeState(createState('thread-a')),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
		storageService.store(
			`${THREAD_STORAGE_KEY_PREFIX}${encodeURIComponent('thread-b')}`,
			serializer.serializeState(createState('thread-b')),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
		storageService.store(
			`${THREAD_STORAGE_KEY_PREFIX}${encodeURIComponent('thread-bad')}`,
			'{"schemaVersion":1,"state":{"threadId":"thread-bad"}}',
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
		storageService.store(
			`${STORAGE_PREFIX}.deleted.${encodeURIComponent('thread-deleted')}`,
			'1',
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
		storageService.store(INDEX_STORAGE_KEY, '{not valid json', StorageScope.WORKSPACE, StorageTarget.MACHINE);

		const loaded = store.loadAll();
		assert.deepStrictEqual(loaded.map(state => state.threadId).sort(), ['thread-a', 'thread-b']);
		assert.ok(loaded.every(state => state.isRunning === false));
		assert.deepStrictEqual(store.loadDeletedThreadIds(), ['thread-deleted']);
		assert.ok(storageService.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).some(key => key.startsWith(THREAD_STORAGE_KEY_PREFIX)));
	});

	test('loads deleted-thread tombstones even when the shared index key is missing', () => {
		const store = storeDisposables.add(instantiationService.createInstance(VSCloneThreadRuntimeStore));
		storageService.store(
			`${STORAGE_PREFIX}.deleted.${encodeURIComponent('thread-deleted')}`,
			'1',
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);

		assert.deepStrictEqual(store.loadAll(), []);
		assert.deepStrictEqual(store.loadDeletedThreadIds(), ['thread-deleted']);
	});

	test('rebuilds persisted runtime threads even when the shared index key is missing', () => {
		const store = storeDisposables.add(instantiationService.createInstance(VSCloneThreadRuntimeStore));
		const serializer = new VSCloneThreadRuntimeSerializer();
		storageService.store(
			`${THREAD_STORAGE_KEY_PREFIX}${encodeURIComponent('thread-orphan')}`,
			serializer.serializeState(createState('thread-orphan')),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);

		assert.deepStrictEqual(store.loadAll(), [createState('thread-orphan')]);

		store.clearAll();
		assert.strictEqual(storageService.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).length, 0);
	});

	test('missing-index rebuild prefers a deleted-thread tombstone over a stale thread payload with the same id', () => {
		const store = storeDisposables.add(instantiationService.createInstance(VSCloneThreadRuntimeStore));
		const serializer = new VSCloneThreadRuntimeSerializer();
		storageService.store(
			`${THREAD_STORAGE_KEY_PREFIX}${encodeURIComponent('thread-conflict')}`,
			serializer.serializeState(createState('thread-conflict')),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
		storageService.store(
			`${STORAGE_PREFIX}.deleted.${encodeURIComponent('thread-conflict')}`,
			'1',
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);

		assert.deepStrictEqual(store.loadAll(), []);
		assert.deepStrictEqual(store.loadDeletedThreadIds(), ['thread-conflict']);

		store.clearAll();
		assert.strictEqual(storageService.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).length, 0);
	});

	test('valid index prefers a deleted-thread tombstone over a stale thread payload with the same id', () => {
		const store = storeDisposables.add(instantiationService.createInstance(VSCloneThreadRuntimeStore));
		const serializer = new VSCloneThreadRuntimeSerializer();
		storageService.store(
			`${THREAD_STORAGE_KEY_PREFIX}${encodeURIComponent('thread-conflict')}`,
			serializer.serializeState(createState('thread-conflict')),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
		storageService.store(
			`${STORAGE_PREFIX}.deleted.${encodeURIComponent('thread-conflict')}`,
			'1',
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
		storageService.store(
			INDEX_STORAGE_KEY,
			serializer.serializeIndex(TestWorkspace.id, 10, ['thread-conflict']),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);

		assert.deepStrictEqual(store.loadAll(), []);
		assert.deepStrictEqual(store.loadDeletedThreadIds(), ['thread-conflict']);
	});

	test('valid index rebuild merges orphaned thread payloads that are missing from the index', () => {
		const store = storeDisposables.add(instantiationService.createInstance(VSCloneThreadRuntimeStore));
		const serializer = new VSCloneThreadRuntimeSerializer();
		storageService.store(
			`${THREAD_STORAGE_KEY_PREFIX}${encodeURIComponent('thread-indexed')}`,
			serializer.serializeState(createState('thread-indexed')),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
		storageService.store(
			`${THREAD_STORAGE_KEY_PREFIX}${encodeURIComponent('thread-orphan')}`,
			serializer.serializeState(createState('thread-orphan')),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
		storageService.store(
			INDEX_STORAGE_KEY,
			serializer.serializeIndex(TestWorkspace.id, 10, ['thread-indexed']),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);

		assert.deepStrictEqual(
			store.loadAll().map(state => state.threadId).sort(),
			['thread-indexed', 'thread-orphan'],
		);
	});
});
