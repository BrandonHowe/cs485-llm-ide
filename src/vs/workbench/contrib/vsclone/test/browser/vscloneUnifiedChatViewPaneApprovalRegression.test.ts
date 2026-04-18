/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSCloneUnifiedChatViewPane } from '../../browser/vscloneUnifiedChatViewPane.js';
import {
	type IVSCloneThreadRuntimeMessage,
	type IVSCloneThreadRuntimeState,
	type IVSCloneThreadRuntimeToolRequestMessage,
} from '../../common/vscloneThreadRuntimeTypes.js';

function createToolRequestMessage(id: string, requestedAt: number): IVSCloneThreadRuntimeToolRequestMessage {
	return {
		id,
		role: 'tool',
		createdAt: requestedAt,
		type: 'tool_request',
		toolName: 'run_command',
		approvalType: 'terminal',
		params: { command: 'git status' },
		requestedAt,
		snapshots: [],
		run: {
			turnId: 'thread-1:turn-1',
			sequence: 1,
			sessionResource: 'vsclone://api/thread-1',
			mode: 'act',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelIdentifier: 'openai/gpt-5.3-codex',
		},
	};
}

function createAwaitingState(messages: readonly IVSCloneThreadRuntimeMessage[]): IVSCloneThreadRuntimeState {
	return {
		threadId: 'thread-1',
		catalog: {
			threadId: 'thread-1',
			sessionResource: 'vsclone://api/thread-1',
			title: 'Thread 1',
			activeModelIdentifier: 'openai/gpt-5.3-codex',
			createdAt: 1,
			updatedAt: 2,
			status: 'active',
			archived: false,
			turnCount: 1,
			lastTurnPreview: 'Waiting on approval',
		},
		turnId: 'thread-1:turn-1',
		mode: 'act',
		streamState: {
			kind: 'awaiting_user',
			toolName: 'run_command',
			approvalType: 'terminal',
		},
		messages,
		checkpoints: [],
		lastUpdatedAt: 2,
	};
}

suite('VSCloneUnifiedChatViewPaneApprovalRegression', () => {
	test('approval controls only render on the live pending tool request even when an identical request exists in history', () => {
		const historicalRequest = createToolRequestMessage('tool-request-1', 1);
		const liveRequest = createToolRequestMessage('tool-request-2', 2);
		const state = createAwaitingState([historicalRequest, liveRequest]);
		const approvedThreadIds: string[] = [];
		const rejectedRequests: Array<{ threadId: string; reason?: string }> = [];
		const warnings: string[] = [];
		// Rendering the whole pane would require a full workbench harness. This focused regression
		// only exercises the DOM helper whose identity check decides whether a historical card can
		// mutate the live runtime, so an object with the required collaborators is sufficient.
		const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
		Object.assign(pane as object, {
			threadRuntimeService: {
				approveLatestToolRequest: (threadId: string) => {
					approvedThreadIds.push(threadId);
					return true;
				},
				rejectLatestToolRequest: (threadId: string, reason?: string) => {
					rejectedRequests.push({ threadId, reason });
					return true;
				},
			},
			notificationService: {
				warn: (message: string) => warnings.push(message),
			},
		});

		const historicalActions = (pane as any).renderRuntimeToolActions('thread-1', state, historicalRequest) as HTMLElement | undefined;
		const liveActions = (pane as any).renderRuntimeToolActions('thread-1', state, liveRequest) as HTMLElement | undefined;

		assert.strictEqual(historicalActions, undefined);
		assert.ok(liveActions);
		const actionButtons = liveActions!.querySelectorAll('button');
		assert.strictEqual(actionButtons.length, 2);

		(actionButtons[0] as HTMLButtonElement).click();
		(actionButtons[1] as HTMLButtonElement).click();

		assert.deepStrictEqual(approvedThreadIds, ['thread-1']);
		assert.deepStrictEqual(rejectedRequests, [{
			threadId: 'thread-1',
			reason: 'Tool request was rejected by the user.',
		}]);
		assert.deepStrictEqual(warnings, []);
	});
});
