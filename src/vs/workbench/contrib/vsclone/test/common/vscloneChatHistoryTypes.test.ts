/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IVSCloneChatHistoryChangeEvent,
	IVSCloneChatHistoryQuery,
	IVSCloneChatHistorySnapshot,
	IVSCloneChatHistoryThread,
	IVSCloneChatHistoryTurn,
	IVSCloneChatTurnUpdate,
	VSCloneChatHistoryScope,
	VSCloneChatHistoryTab,
	VSCloneChatThreadStatus,
	VSCloneChatTurnPhase,
	VSCloneChatTurnStatus,
} from '../../common/vscloneChatHistoryTypes.js';

// These declarations are intentionally compile-time only. They keep the invalid examples close to
// the valid samples without pretending the unit runner can detect type failures at runtime.
if (false) {
	// @ts-expect-error
	const invalidScope: VSCloneChatHistoryScope = 'global';
	// @ts-expect-error
	const invalidThreadStatus: VSCloneChatThreadStatus = 'pending';
	// @ts-expect-error
	const invalidTurnStatus: VSCloneChatTurnStatus = 'archived';
	// @ts-expect-error
	const invalidTab: VSCloneChatHistoryTab = 'failed';
	// @ts-expect-error
	const invalidPhase: VSCloneChatTurnPhase = 'completed';
	// @ts-expect-error
	const invalidQuery: IVSCloneChatHistoryQuery = { limit: '50' };
	// @ts-expect-error
	const invalidChangeEvent: IVSCloneChatHistoryChangeEvent = { reason: 'update', scope: 'workspace', threadIds: 'thread-1' };
	// @ts-expect-error
	const invalidThread: IVSCloneChatHistoryThread = {
		threadId: 'thread-2',
		sessionResource: 'vscode-chat://session/thread-2',
		title: 'Thread 2',
		createdAt: 1,
		updatedAt: 2,
		status: 'active',
		archived: false,
		turnCount: 0,
	};
	// @ts-expect-error
	const invalidTurn: IVSCloneChatHistoryTurn = { turnId: 'turn-2', threadId: 'thread-2', sequence: 1, promptText: 'Prompt', responseMarkdown: 'Response', responsePlainText: 'Response', startedAt: 1, status: 'archived' };

	void invalidScope;
	void invalidThreadStatus;
	void invalidTurnStatus;
	void invalidTab;
	void invalidPhase;
	void invalidQuery;
	void invalidChangeEvent;
	void invalidThread;
	void invalidTurn;
}

suite('VSCloneChatHistoryTypes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts the supported chat history contracts', () => {
		const scopes = ['workspace', 'profile'] as const satisfies readonly VSCloneChatHistoryScope[];
		const threadStatuses = ['active', 'completed', 'failed', 'archived'] as const satisfies readonly VSCloneChatThreadStatus[];
		const turnStatuses = ['pending', 'streaming', 'completed', 'failed', 'cancelled'] as const satisfies readonly VSCloneChatTurnStatus[];
		const tabs = ['all', 'active', 'archived'] as const satisfies readonly VSCloneChatHistoryTab[];
		const turnPhases = ['prompt', 'stream', 'complete', 'error', 'cancel'] as const satisfies readonly VSCloneChatTurnPhase[];

		const thread = {
			threadId: 'thread-1',
			sessionResource: 'vscode-chat://session/thread-1',
			title: 'Thread 1',
			activeModelIdentifier: 'openai:gpt-5.4',
			createdAt: 1,
			updatedAt: 2,
			status: 'active',
			archived: false,
			turnCount: 1,
			lastTurnPreview: 'Preview text',
		} satisfies IVSCloneChatHistoryThread;

		const turn = {
			turnId: 'turn-1',
			threadId: thread.threadId,
			sequence: 1,
			executionMode: 'plan',
			modelIdentifier: 'openai:gpt-5.4',
			providerId: 'openai',
			promptImages: [{
				mimeType: 'image/png',
				base64Data: 'iVBORw0KGgo=',
			}],
			promptText: 'Prompt text',
			responseMarkdown: 'Response markdown',
			responsePlainText: 'Response plain text',
			startedAt: 3,
			completedAt: 4,
			status: 'completed',
			errorCode: undefined,
			lastEventAt: 5,
			lastEventFingerprint: 'fingerprint-1',
		} satisfies IVSCloneChatHistoryTurn;

		const snapshot = {
			updatedAt: 6,
			threads: [thread],
			turnsByThreadId: {
				[thread.threadId]: [turn],
			},
			modeByThread: {
				[thread.threadId]: 'plan',
			},
			selectedByThread: {
				[thread.threadId]: {
					threadId: thread.threadId,
					location: 'chat',
					modelIdentifier: 'openai:gpt-5.4',
					vendor: 'openai',
					modelId: 'gpt-5.4',
					modelName: 'GPT-5.4',
					selectedAt: 7,
				},
			},
			selectedByLocation: {},
			recentModelIdentifiers: ['openai:gpt-5.4'],
		} satisfies IVSCloneChatHistorySnapshot;

		const query = {
			text: 'preview',
			tab: 'archived',
			includeArchived: true,
			fromTimestamp: 10,
			toTimestamp: 20,
			limit: 50,
		} satisfies IVSCloneChatHistoryQuery;

		const update = {
			threadId: thread.threadId,
			turnId: turn.turnId,
			sequence: turn.sequence,
			sessionResource: thread.sessionResource,
			phase: 'stream',
			occurredAt: 8,
			promptText: turn.promptText,
			threadTitle: thread.title,
			executionMode: 'act',
			modelIdentifier: turn.modelIdentifier,
			providerId: turn.providerId,
			promptImages: turn.promptImages,
			responseMarkdownDelta: 'delta',
			responsePlainTextDelta: 'delta',
			responseMarkdownReplace: 'replace markdown',
			responsePlainTextReplace: 'replace plain text',
			errorCode: undefined,
		} satisfies IVSCloneChatTurnUpdate;

		const changeEvent = {
			reason: 'error',
			scope: 'workspace',
			threadIds: [thread.threadId],
			error: new Error('boom'),
		} satisfies IVSCloneChatHistoryChangeEvent;

		assert.deepStrictEqual(scopes, ['workspace', 'profile']);
		assert.deepStrictEqual(threadStatuses, ['active', 'completed', 'failed', 'archived']);
		assert.deepStrictEqual(turnStatuses, ['pending', 'streaming', 'completed', 'failed', 'cancelled']);
		assert.deepStrictEqual(tabs, ['all', 'active', 'archived']);
		assert.deepStrictEqual(turnPhases, ['prompt', 'stream', 'complete', 'error', 'cancel']);
		assert.strictEqual(thread.activeModelIdentifier, 'openai:gpt-5.4');
		assert.strictEqual(turn.promptImages?.[0].mimeType, 'image/png');
		assert.strictEqual(snapshot.turnsByThreadId[thread.threadId][0].status, 'completed');
		assert.strictEqual(query.limit, 50);
		assert.strictEqual(update.phase, 'stream');
		assert.strictEqual(changeEvent.error?.message, 'boom');
	});
});
