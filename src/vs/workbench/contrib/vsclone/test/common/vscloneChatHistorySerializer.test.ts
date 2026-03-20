/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSCloneChatHistorySerializer } from '../../common/backend/vscloneChatHistorySerializer.js';
import { IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn } from '../../common/backend/vscloneChatHistoryService.js';

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
		const first = serializer.serializeIndex('ws', 1, [threadA, threadB], {}, []);
		const second = serializer.serializeIndex('ws', 1, [threadB, threadA], {}, []);
		assert.strictEqual(first, second);

		const turnsFirst = serializer.serializeThread('a', threadA.sessionResource, [turnA1, turnA2], undefined);
		const turnsSecond = serializer.serializeThread('a', threadA.sessionResource, [turnA2, turnA1], undefined);
		assert.strictEqual(turnsFirst, turnsSecond);
	});

	test('roundtrips index and thread files', () => {
		const index = serializer.deserializeIndex(serializer.serializeIndex('ws', 3, [threadA, threadB], {
			chat: {
				location: 'chat',
				modelIdentifier: 'openai/gpt-5.3-codex',
				vendor: 'openai',
				modelId: 'gpt-5.3-codex',
				modelName: 'GPT-5.3-Codex',
				selectedAt: 3,
			},
		}, ['openai/gpt-5.3-codex']));
		assert.strictEqual(index.threads.length, 2);
		assert.strictEqual(index.threads[0].threadId, 'b');
		assert.strictEqual(index.selectedByLocation.chat?.modelIdentifier, 'openai/gpt-5.3-codex');
		assert.deepStrictEqual(index.recentModelIdentifiers, ['openai/gpt-5.3-codex']);

		const thread = serializer.deserializeThread(serializer.serializeThread('a', threadA.sessionResource, [turnA1, turnA2], {
			location: 'chat',
			modelIdentifier: 'openai/gpt-5.3-codex',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelName: 'GPT-5.3-Codex',
			selectedAt: 3,
		}));
		assert.strictEqual(thread.turns.length, 2);
		assert.strictEqual(thread.turns[1].turnId, 'a2');
		assert.strictEqual(thread.selection?.modelIdentifier, 'openai/gpt-5.3-codex');
	});

	test('rejects invalid schema', () => {
		assert.throws(() => serializer.deserializeIndex('{"schemaVersion":2,"workspaceId":"x","updatedAt":1,"threads":[{"bad":true}],"selectedByLocation":{},"recentModelIdentifiers":[]}'));
		assert.throws(() => serializer.deserializeThread('{"schemaVersion":2,"threadId":"x","sessionResource":"x","turns":[{"bad":true}]}'));
	});
});
