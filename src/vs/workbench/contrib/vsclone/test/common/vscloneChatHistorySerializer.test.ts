/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSCloneChatHistoryMigrationService, VSCloneUnsupportedHistoryVersionError } from '../../common/vscloneChatHistoryMigrationService.js';
import { VSCloneChatHistorySerializer } from '../../common/vscloneChatHistorySerializer.js';
import { IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn } from '../../common/vscloneChatHistoryService.js';

suite('VSCloneChatHistorySerializer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const serializer = new VSCloneChatHistorySerializer();

	const threadA: IVSCloneChatHistoryThread = {
		threadId: 'a',
		sessionResource: 'vscode-chat://session/a',
		title: 'A',
		createdAt: 1,
		updatedAt: 10,
		status: 'active',
		archived: false,
		turnCount: 1,
		lastTurnPreview: 'A',
	};
	const threadB: IVSCloneChatHistoryThread = { ...threadA, threadId: 'b', sessionResource: 'vscode-chat://session/b', title: 'B', updatedAt: 20 };

	const turnA1: IVSCloneChatHistoryTurn = {
		turnId: 'a1',
		threadId: 'a',
		sequence: 1,
		promptText: 'hello',
		responseMarkdown: 'hi',
		responsePlainText: 'hi',
		startedAt: 1,
		status: 'completed',
	};
	const turnA2: IVSCloneChatHistoryTurn = { ...turnA1, turnId: 'a2', sequence: 2, startedAt: 2 };

	test('serializes deterministically', () => {
		const first = serializer.serializeIndex('ws', 1, [threadA, threadB]);
		const second = serializer.serializeIndex('ws', 1, [threadB, threadA]);
		assert.strictEqual(first, second);

		const turnsFirst = serializer.serializeThread('a', threadA.sessionResource, [turnA1, turnA2]);
		const turnsSecond = serializer.serializeThread('a', threadA.sessionResource, [turnA2, turnA1]);
		assert.strictEqual(turnsFirst, turnsSecond);
	});

	test('roundtrips index and thread files', () => {
		const index = serializer.deserializeIndex(serializer.serializeIndex('ws', 3, [threadA, threadB]));
		assert.strictEqual(index.threads.length, 2);
		assert.strictEqual(index.threads[0].threadId, 'b');

		const thread = serializer.deserializeThread(serializer.serializeThread('a', threadA.sessionResource, [turnA1, turnA2]));
		assert.strictEqual(thread.turns.length, 2);
		assert.strictEqual(thread.turns[1].turnId, 'a2');
	});

	test('rejects invalid schema', () => {
		assert.throws(() => serializer.deserializeIndex('{"schemaVersion":1,"workspaceId":"x","updatedAt":1,"threads":[{"bad":true}]}'));
		assert.throws(() => serializer.deserializeThread('{"schemaVersion":1,"threadId":"x","sessionResource":"x","turns":[{"bad":true}]}'));
	});

	test('migration rejects unsupported versions', () => {
		const migration = new VSCloneChatHistoryMigrationService();
		assert.throws(
			() => migration.migrateIndex({ schemaVersion: 2 }),
			(error: unknown) => error instanceof VSCloneUnsupportedHistoryVersionError,
		);
		assert.throws(
			() => migration.migrateThread({ schemaVersion: 99 }),
			(error: unknown) => error instanceof VSCloneUnsupportedHistoryVersionError,
		);
	});
});
