/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TestWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { IVSCloneChatHistorySnapshot } from '../../common/backend/vscloneChatHistoryService.js';
import { VSCloneChatHistoryStore } from '../../common/backend/vscloneChatHistoryStore.js';

suite('VSCloneChatHistoryStore', () => {
	const storeDisposables = ensureNoDisposablesAreLeakedInTestSuite();

	let instantiationService: TestInstantiationService;
	let storageService: TestStorageService;

	setup(() => {
		instantiationService = storeDisposables.add(new TestInstantiationService(new ServiceCollection()));
		storageService = storeDisposables.add(new TestStorageService());

		instantiationService.stub(IStorageService, storageService);
		instantiationService.stub(IWorkspaceContextService, new TestContextService(TestWorkspace));
		instantiationService.stub(ILogService, NullLogService);
	});

	function createSnapshot(): IVSCloneChatHistorySnapshot {
		return {
			updatedAt: 10,
			threads: [{
				threadId: 'thread-1',
				sessionResource: 'vscode-chat://session/thread-1',
				title: 'Thread 1',
				createdAt: 1,
				updatedAt: 10,
				status: 'active',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Preview',
			}],
			turnsByThreadId: {
				'thread-1': [{
					turnId: 'turn-1',
					threadId: 'thread-1',
					sequence: 1,
					executionMode: 'plan',
					promptText: 'Prompt',
					responseMarkdown: 'Response',
					responsePlainText: 'Response',
					startedAt: 1,
					status: 'completed',
				}],
			},
			modeByThread: {
				'thread-1': 'plan',
			},
			selectedByThread: {
				'thread-1': {
					threadId: 'thread-1',
					location: 'chat',
					modelIdentifier: 'openai/gpt-5.3-codex',
					vendor: 'openai',
					modelId: 'gpt-5.3-codex',
					modelName: 'GPT-5.3-Codex',
					selectedAt: 10,
				},
			},
			selectedByLocation: {},
			recentModelIdentifiers: ['openai/gpt-5.3-codex'],
		};
	}

	test('writes index and thread records into storage, then loads them', async () => {
		const store = storeDisposables.add(instantiationService.createInstance(VSCloneChatHistoryStore));
		const snapshot = createSnapshot();
		await store.save('workspace', snapshot, { redactSecrets: false });

		assert.strictEqual(storageService.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).length, 2);

		const loaded = await store.load('workspace');
		assert.strictEqual(loaded.threads.length, 1);
		assert.strictEqual(loaded.threads[0].threadId, 'thread-1');
		assert.strictEqual(loaded.turnsByThreadId['thread-1']?.length, 1);
		assert.strictEqual(loaded.turnsByThreadId['thread-1'][0].executionMode, 'plan');
		assert.strictEqual(loaded.modeByThread['thread-1'], 'plan');
		assert.strictEqual(loaded.turnsByThreadId['thread-1'][0].responsePlainText, 'Response');
		assert.strictEqual(loaded.selectedByThread['thread-1']?.modelIdentifier, 'openai/gpt-5.3-codex');
		assert.deepStrictEqual(loaded.recentModelIdentifiers, ['openai/gpt-5.3-codex']);
	});

	test('saving a smaller snapshot removes stale thread records', async () => {
		const store = storeDisposables.add(instantiationService.createInstance(VSCloneChatHistoryStore));
		const first = createSnapshot();
		await store.save('workspace', first, { redactSecrets: false });

		const second: IVSCloneChatHistorySnapshot = {
			updatedAt: 20,
			threads: [],
			turnsByThreadId: {},
			modeByThread: {},
			selectedByThread: {},
			selectedByLocation: {},
			recentModelIdentifiers: [],
		};
		await store.save('workspace', second, { redactSecrets: false });

		assert.strictEqual(storageService.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).length, 1);
	});

	test('clear removes persisted workspace storage', async () => {
		const store = storeDisposables.add(instantiationService.createInstance(VSCloneChatHistoryStore));
		await store.save('workspace', createSnapshot(), { redactSecrets: false });

		await store.clear('workspace');

		assert.strictEqual(storageService.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE).length, 0);
	});
});
