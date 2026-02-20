/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { toUserDataProfile } from '../../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { TestWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
import { InMemoryTestFileService, TestContextService } from '../../../../test/common/workbenchTestServices.js';
import { VSCloneChatHistoryMigrationService, IVSCloneChatHistoryMigrationService } from '../../common/vscloneChatHistoryMigrationService.js';
import { IVSCloneChatHistorySnapshot } from '../../common/vscloneChatHistoryService.js';
import { VSCloneChatHistoryStore } from '../../common/vscloneChatHistoryStore.js';

suite('VSCloneChatHistoryStore', () => {
	const storeDisposables = ensureNoDisposablesAreLeakedInTestSuite();

	let instantiationService: TestInstantiationService;
	let fileService: InMemoryTestFileService;

	setup(() => {
		instantiationService = storeDisposables.add(new TestInstantiationService(new ServiceCollection()));
		fileService = storeDisposables.add(new InMemoryTestFileService());

		instantiationService.stub(IFileService, fileService);
		instantiationService.stub(IEnvironmentService, { workspaceStorageHome: URI.file('/test/workspaceStorage') });
		instantiationService.stub(IWorkspaceContextService, new TestContextService(TestWorkspace));
		instantiationService.stub(IUserDataProfileService, { currentProfile: toUserDataProfile('default', 'Default', URI.file('/test/profile'), URI.file('/test/cache')) });
		instantiationService.stub(ILogService, NullLogService);
		instantiationService.stub(IVSCloneChatHistoryMigrationService, new VSCloneChatHistoryMigrationService());
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
					promptText: 'Prompt',
					responseMarkdown: 'Response',
					responsePlainText: 'Response',
					startedAt: 1,
					status: 'completed',
				}],
			},
		};
	}

	test('writes index and thread files, then loads them', async () => {
		const store = storeDisposables.add(instantiationService.createInstance(VSCloneChatHistoryStore));
		const snapshot = createSnapshot();
		await store.save('workspace', snapshot, { redactSecrets: false });

		const loaded = await store.load('workspace');
		assert.strictEqual(loaded.threads.length, 1);
		assert.strictEqual(loaded.threads[0].threadId, 'thread-1');
		assert.strictEqual(loaded.turnsByThreadId['thread-1']?.length, 1);
		assert.strictEqual(loaded.turnsByThreadId['thread-1'][0].responsePlainText, 'Response');
	});

	test('saving a smaller snapshot removes stale thread files', async () => {
		const store = storeDisposables.add(instantiationService.createInstance(VSCloneChatHistoryStore));
		const first = createSnapshot();
		await store.save('workspace', first, { redactSecrets: false });

		const second: IVSCloneChatHistorySnapshot = {
			updatedAt: 20,
			threads: [],
			turnsByThreadId: {},
		};
		await store.save('workspace', second, { redactSecrets: false });

		const root = URI.joinPath(URI.file('/test/workspaceStorage'), TestWorkspace.id, 'vsclone', 'chatHistory', 'threads');
		const stat = await fileService.resolve(root);
		assert.strictEqual(stat.children?.length ?? 0, 0);
	});

	test('clear removes persisted workspace storage', async () => {
		const store = storeDisposables.add(instantiationService.createInstance(VSCloneChatHistoryStore));
		await store.save('workspace', createSnapshot(), { redactSecrets: false });

		await store.clear('workspace');

		const root = URI.joinPath(URI.file('/test/workspaceStorage'), TestWorkspace.id, 'vsclone', 'chatHistory');
		const exists = await fileService.exists(root);
		assert.strictEqual(exists, false);
	});

	test('atomic writes do not leave temp files behind', async () => {
		const store = storeDisposables.add(instantiationService.createInstance(VSCloneChatHistoryStore));
		await store.save('workspace', createSnapshot(), { redactSecrets: false });

		const root = URI.joinPath(URI.file('/test/workspaceStorage'), TestWorkspace.id, 'vsclone', 'chatHistory');
		const stat = await fileService.resolve(root);
		const children = (stat.children ?? []).map(child => child.name);
		assert.ok(!children.some(name => name.endsWith('.tmp')));
	});
});
