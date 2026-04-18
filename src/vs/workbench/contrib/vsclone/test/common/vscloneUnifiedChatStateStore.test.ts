/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import type { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { VSCloneUnifiedChatStateStore } from '../../common/backend/vscloneUnifiedChatStateStore.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';

suite('VSCloneUnifiedChatStateStore', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes legacy single-selection thread payloads into location-scoped maps on restore', () => {
		const storageService = store.add(new TestStorageService());
		const workspaceContextService = {
			getWorkspace: () => ({ id: 'workspace-store-test' }),
		} as Partial<IWorkspaceContextService> as IWorkspaceContextService;
		const unifiedChatStateStore = store.add(new VSCloneUnifiedChatStateStore(
			storageService,
			workspaceContextService,
			new NullLogService(),
		));

		storageService.store('vsclone.unifiedState.v1', JSON.stringify({
			updatedAt: 1,
			workspaceId: 'workspace-store-test',
			selectionState: {
				selectedByThread: {
					'thread-1': {
						location: 'chat',
						modelIdentifier: 'openai/gpt-5.3-codex',
						vendor: 'openai',
						modelId: 'gpt-5.3-codex',
						modelName: 'GPT-5.3-Codex',
						selectedAt: 1,
					},
				},
				selectedByLocation: {},
				recentModelIdentifiers: ['openai/gpt-5.3-codex'],
			},
			planModeState: {
				modeByThread: {},
			},
		}), StorageScope.WORKSPACE, StorageTarget.MACHINE);

		const snapshot = unifiedChatStateStore.load();
		assert.strictEqual(snapshot.selectionState.selectedByThread['thread-1']?.chat?.modelIdentifier, 'openai/gpt-5.3-codex');
	});
});
