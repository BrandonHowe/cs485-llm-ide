/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { toVSCloneRailRows } from '../../browser/vscloneChatHistoryRailTree.js';
import { IVSCloneChatHistoryThread } from '../../common/backend/vscloneChatHistoryService.js';

function createThread(overrides: Partial<IVSCloneChatHistoryThread>): IVSCloneChatHistoryThread {
	return {
		threadId: 'thread-1',
		sessionResource: 'vsclone://chat/thread-1',
		title: 'Thread 1',
		createdAt: 1000,
		updatedAt: 2000,
		status: 'completed',
		archived: false,
		turnCount: 1,
		lastTurnPreview: 'Preview 1',
		...overrides,
	};
}

suite('VSCloneChatHistoryRailTree', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('toVSCloneRailRows maps thread metadata and selection state into rail rows', () => {
		const threads = [
			createThread({
				threadId: 'thread-1',
				title: 'Alpha',
				updatedAt: 1111,
				status: 'active',
				turnCount: 3,
				lastTurnPreview: 'Preview A',
			}),
			createThread({
				threadId: 'thread-2',
				title: 'Beta',
				updatedAt: 2222,
				status: 'archived',
				archived: true,
				turnCount: 5,
				lastTurnPreview: 'Preview B',
			}),
		];

		const rows = toVSCloneRailRows(threads, 'thread-2', timestamp => timestamp === 1111 ? '2m ago' : 'just now');

		assert.deepStrictEqual(rows, [
			{
				threadId: 'thread-1',
				title: 'Alpha',
				preview: 'Preview A',
				updatedLabel: '2m ago',
				archived: false,
				turnCount: 3,
				status: 'active',
				selected: false,
			},
			{
				threadId: 'thread-2',
				title: 'Beta',
				preview: 'Preview B',
				updatedLabel: 'just now',
				archived: true,
				turnCount: 5,
				status: 'archived',
				selected: true,
			},
		]);
	});

	test('toVSCloneRailRows returns an empty array without formatting work when there are no threads', () => {
		let formatterCalls = 0;

		const rows = toVSCloneRailRows([], undefined, () => {
			formatterCalls += 1;
			return 'unused';
		});

		assert.deepStrictEqual(rows, []);
		assert.strictEqual(formatterCalls, 0);
	});
});
