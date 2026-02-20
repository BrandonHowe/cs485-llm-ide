/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { reduceThreadTurns } from '../../common/vscloneChatHistoryStateMachine.js';
import { IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn, IVSCloneChatTurnUpdate } from '../../common/vscloneChatHistoryService.js';

suite('VSCloneChatHistoryStateMachine', () => {
	const sessionResource = 'vscode-chat://session/test';

	function update(overrides: Partial<IVSCloneChatTurnUpdate>): IVSCloneChatTurnUpdate {
		return {
			threadId: 'thread-1',
			turnId: 'turn-1',
			sequence: 1,
			sessionResource,
			phase: 'prompt',
			occurredAt: Date.now(),
			promptText: 'hello',
			...overrides,
		};
	}

	test('prompt -> stream -> complete', () => {
		let thread: IVSCloneChatHistoryThread | undefined;
		let turns: readonly IVSCloneChatHistoryTurn[] | undefined;

		({ thread, turns } = reduceThreadTurns(thread, turns, update({ phase: 'prompt', occurredAt: 1, promptText: 'Hello world' }), { sessionResource, maxTurnsPerThread: 100 }));
		assert.strictEqual(turns.length, 1);
		assert.strictEqual(turns[0].status, 'pending');
		assert.strictEqual(thread.status, 'active');

		({ thread, turns } = reduceThreadTurns(thread, turns, update({ phase: 'stream', occurredAt: 2, responsePlainTextDelta: 'Hi' }), { sessionResource, maxTurnsPerThread: 100 }));
		assert.strictEqual(turns[0].status, 'streaming');
		assert.strictEqual(turns[0].responsePlainText, 'Hi');

		({ thread, turns } = reduceThreadTurns(thread, turns, update({ phase: 'complete', occurredAt: 3, responsePlainTextDelta: ' there' }), { sessionResource, maxTurnsPerThread: 100 }));
		assert.strictEqual(turns[0].status, 'completed');
		assert.strictEqual(turns[0].responsePlainText, 'Hi there');
		assert.strictEqual(thread.status, 'completed');
	});

	test('prompt -> stream -> error', () => {
		let thread: IVSCloneChatHistoryThread | undefined;
		let turns: readonly IVSCloneChatHistoryTurn[] | undefined;

		({ thread, turns } = reduceThreadTurns(thread, turns, update({ phase: 'prompt', occurredAt: 1 }), { sessionResource, maxTurnsPerThread: 100 }));
		({ thread, turns } = reduceThreadTurns(thread, turns, update({ phase: 'stream', occurredAt: 2, responsePlainTextDelta: 'partial' }), { sessionResource, maxTurnsPerThread: 100 }));
		({ thread, turns } = reduceThreadTurns(thread, turns, update({ phase: 'error', occurredAt: 3, errorCode: 'network_error' }), { sessionResource, maxTurnsPerThread: 100 }));

		assert.strictEqual(turns[0].status, 'failed');
		assert.strictEqual(turns[0].errorCode, 'network_error');
		assert.strictEqual(thread.status, 'failed');
	});

	test('prompt -> cancel', () => {
		let thread: IVSCloneChatHistoryThread | undefined;
		let turns: readonly IVSCloneChatHistoryTurn[] | undefined;

		({ thread, turns } = reduceThreadTurns(thread, turns, update({ phase: 'prompt', occurredAt: 1 }), { sessionResource, maxTurnsPerThread: 100 }));
		({ thread, turns } = reduceThreadTurns(thread, turns, update({ phase: 'cancel', occurredAt: 2 }), { sessionResource, maxTurnsPerThread: 100 }));

		assert.strictEqual(turns[0].status, 'cancelled');
		assert.strictEqual(thread.status, 'completed');
	});

	test('duplicate and stale updates are idempotent', () => {
		let thread: IVSCloneChatHistoryThread | undefined;
		let turns: readonly IVSCloneChatHistoryTurn[] | undefined;

		({ thread, turns } = reduceThreadTurns(thread, turns, update({ phase: 'prompt', occurredAt: 1 }), { sessionResource, maxTurnsPerThread: 100 }));
		({ thread, turns } = reduceThreadTurns(thread, turns, update({ phase: 'stream', occurredAt: 2, responsePlainTextDelta: 'abc' }), { sessionResource, maxTurnsPerThread: 100 }));
		({ thread, turns } = reduceThreadTurns(thread, turns, update({ phase: 'stream', occurredAt: 2, responsePlainTextDelta: 'abc' }), { sessionResource, maxTurnsPerThread: 100 }));
		({ thread, turns } = reduceThreadTurns(thread, turns, update({ phase: 'stream', occurredAt: 1, responsePlainTextDelta: 'stale' }), { sessionResource, maxTurnsPerThread: 100 }));

		assert.strictEqual(turns[0].responsePlainText, 'abc');
	});

	test('archived thread remains archived through updates', () => {
		const archivedThread: IVSCloneChatHistoryThread = {
			threadId: 'thread-1',
			sessionResource,
			title: 'Archived',
			createdAt: 1,
			updatedAt: 2,
			status: 'archived',
			archived: true,
			turnCount: 1,
			lastTurnPreview: 'done',
		};
		const archivedTurns: readonly IVSCloneChatHistoryTurn[] = [{
			turnId: 'turn-1',
			threadId: 'thread-1',
			sequence: 1,
			promptText: 'Q',
			responseMarkdown: 'A',
			responsePlainText: 'A',
			startedAt: 1,
			completedAt: 2,
			status: 'completed',
		}];

		const result = reduceThreadTurns(archivedThread, archivedTurns, update({ phase: 'stream', occurredAt: 3, responsePlainTextDelta: '!' }), { sessionResource, maxTurnsPerThread: 100 });
		assert.strictEqual(result.thread.archived, true);
		assert.strictEqual(result.thread.status, 'archived');
	});
});
