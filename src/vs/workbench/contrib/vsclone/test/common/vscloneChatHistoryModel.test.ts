/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSCloneChatHistoryModel } from '../../common/backend/vscloneChatHistoryModel.js';
import { IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn } from '../../common/backend/vscloneChatHistoryService.js';

suite('VSCloneChatHistoryModel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function thread(id: string, updatedAt: number, overrides: Partial<IVSCloneChatHistoryThread> = {}): IVSCloneChatHistoryThread {
		return {
			threadId: id,
			sessionResource: `vscode-chat://session/${id}`,
			title: id,
			createdAt: updatedAt - 10,
			updatedAt,
			status: 'active',
			archived: false,
			turnCount: 1,
			lastTurnPreview: 'preview',
			...overrides,
		};
	}

	function turn(threadId: string, sequence: number, text: string): IVSCloneChatHistoryTurn {
		return {
			turnId: `${threadId}-${sequence}`,
			threadId,
			sequence,
			promptText: text,
			responseMarkdown: text,
			responsePlainText: text,
			startedAt: sequence,
			status: 'completed',
		};
	}

	test('orders threads by updatedAt desc', () => {
		const model = new VSCloneChatHistoryModel();
		model.initialize({
			updatedAt: 1,
			threads: [thread('a', 10), thread('b', 30), thread('c', 20)],
			turnsByThreadId: {},
			modeByThread: {},
			selectedByThread: {},
			selectedByLocation: {},
			recentModelIdentifiers: [],
		});

		const ids = model.getThreads({ includeArchived: true }).map(t => t.threadId);
		assert.deepStrictEqual(ids, ['b', 'c', 'a']);
	});

	test('filters by tabs All/Active/Archived', () => {
		const model = new VSCloneChatHistoryModel();
		model.initialize({
			updatedAt: 1,
			threads: [
				thread('active', 30, { status: 'active', archived: false }),
				thread('completed', 20, { status: 'completed', archived: false }),
				thread('archived', 10, { status: 'archived', archived: true }),
			],
			turnsByThreadId: {},
			modeByThread: {},
			selectedByThread: {},
			selectedByLocation: {},
			recentModelIdentifiers: [],
		});

		assert.deepStrictEqual(model.getThreads({ tab: 'all' }).map(t => t.threadId), ['active', 'completed', 'archived']);
		assert.deepStrictEqual(model.getThreads({ tab: 'active' }).map(t => t.threadId), ['active']);
		assert.deepStrictEqual(model.getThreads({ tab: 'archived' }).map(t => t.threadId), ['archived']);
	});

	test('supports text query against title and turn text', () => {
		const model = new VSCloneChatHistoryModel();
		model.initialize({
			updatedAt: 1,
			threads: [thread('first', 20, { title: 'Database schema' }), thread('second', 10, { title: 'React optimization' })],
			turnsByThreadId: {
				first: [turn('first', 1, 'normalize tables')],
				second: [turn('second', 1, 'memo and useCallback')],
			},
			modeByThread: {},
			selectedByThread: {},
			selectedByLocation: {},
			recentModelIdentifiers: [],
		});

		assert.deepStrictEqual(model.getThreads({ text: 'database' }).map(t => t.threadId), ['first']);
		assert.deepStrictEqual(model.getThreads({ text: 'usecallback' }).map(t => t.threadId), ['second']);
	});

	test('prunes old and extra threads with retention', () => {
		const model = new VSCloneChatHistoryModel();
		const now = Date.now();
		model.initialize({
			updatedAt: now,
			threads: [
				thread('newest', now - 1_000),
				thread('middle', now - 2_000),
				thread('old', now - (40 * 24 * 60 * 60 * 1000)),
			],
			turnsByThreadId: {
				newest: [turn('newest', 1, 'a')],
				middle: [turn('middle', 1, 'b')],
				old: [turn('old', 1, 'c')],
			},
			modeByThread: {},
			selectedByThread: {},
			selectedByLocation: {},
			recentModelIdentifiers: [],
		});

		const result = model.applyRetention(1, 30, now);
		assert.ok(result.deletedThreadIds.includes('old'));
		assert.ok(result.deletedThreadIds.includes('middle'));
		assert.deepStrictEqual(model.getThreads({ includeArchived: true }).map(t => t.threadId), ['newest']);
	});

	test('respects max turns per thread through state set', () => {
		const model = new VSCloneChatHistoryModel();
		const baseThread = thread('t', 10);
		model.setThreadState(baseThread, [turn('t', 1, 'a'), turn('t', 2, 'b'), turn('t', 3, 'c')]);
		assert.strictEqual(model.getTurns('t').length, 3);
	});

	test('marks streaming and pending turns from a previous session as failed on initialize', () => {
		const model = new VSCloneChatHistoryModel();
		const interruptedStreaming: IVSCloneChatHistoryTurn = {
			...turn('alpha', 1, 'in-flight'),
			status: 'streaming',
			responseMarkdown: 'partial markdown',
			responsePlainText: 'partial plain',
		};
		const interruptedPending: IVSCloneChatHistoryTurn = {
			...turn('alpha', 2, 'queued'),
			status: 'pending',
			responseMarkdown: '',
			responsePlainText: '',
		};
		const completed: IVSCloneChatHistoryTurn = turn('alpha', 3, 'fine');

		model.initialize({
			updatedAt: 1,
			threads: [thread('alpha', 100)],
			turnsByThreadId: {
				alpha: [interruptedStreaming, interruptedPending, completed],
			},
			modeByThread: {},
			selectedByThread: {},
			selectedByLocation: {},
			recentModelIdentifiers: [],
		});

		const restored = model.getTurns('alpha');
		assert.deepStrictEqual(
			restored.map(t => ({ id: t.turnId, status: t.status, errorCode: t.errorCode, includesNotice: t.responsePlainText.includes('interrupted') })),
			[
				{ id: 'alpha-1', status: 'failed', errorCode: 'interrupted', includesNotice: true },
				{ id: 'alpha-2', status: 'failed', errorCode: 'interrupted', includesNotice: true },
				{ id: 'alpha-3', status: 'completed', errorCode: undefined, includesNotice: false },
			],
		);
		assert.ok(restored[0].responsePlainText.startsWith('partial plain'));
	});
});
