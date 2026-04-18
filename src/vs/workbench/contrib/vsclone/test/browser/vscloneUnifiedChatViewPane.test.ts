/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSCloneUnifiedChatViewPane } from '../../browser/vscloneUnifiedChatViewPane.js';
import type {
	IVSCloneThreadRuntimeMessage,
	IVSCloneThreadRuntimeRunContext,
	IVSCloneThreadRuntimeState,
	IVSCloneThreadRuntimeToolRequestMessage,
} from '../../common/vscloneThreadRuntimeTypes.js';

interface IVSCloneUnifiedChatViewPaneHarness {
	threadRuntimeService: {
		approveLatestToolRequest(threadId: string): boolean;
		rejectLatestToolRequest(threadId: string, reason?: string): boolean;
	};
	notificationService: {
		warn(message: string): void;
	};
	renderRuntimeToolActions(
		threadId: string,
		state: IVSCloneThreadRuntimeState,
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'tool' }>,
	): HTMLElement | undefined;
}

function createRunContext(): IVSCloneThreadRuntimeRunContext {
	return {
		turnId: 'thread-1:turn-1',
		sequence: 1,
		sessionResource: 'vsclone://api/thread-1',
		mode: 'act',
		vendor: 'openai',
		modelId: 'gpt-5.3-codex',
		modelIdentifier: 'openai/gpt-5.3-codex',
	};
}

function createToolRequestMessage(id: string, requestedAt: number): IVSCloneThreadRuntimeToolRequestMessage {
	return {
		id,
		role: 'tool',
		createdAt: requestedAt,
		type: 'tool_request',
		toolName: 'run_terminal_command',
		approvalType: 'terminal',
		params: { command: 'pwd' },
		requestedAt,
		snapshots: [],
		run: createRunContext(),
	};
}

function createHarness(): IVSCloneUnifiedChatViewPaneHarness {
	// The full pane constructor wires a large DOM/service graph that is unrelated to this regression.
	// A prototype-only harness keeps the test pinned to the approval-card gating logic.
	const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as IVSCloneUnifiedChatViewPaneHarness;
	pane.threadRuntimeService = {
		approveLatestToolRequest: () => true,
		rejectLatestToolRequest: () => true,
	};
	pane.notificationService = {
		warn: () => undefined,
	};
	return pane;
}

suite('VSCloneUnifiedChatViewPane', () => {
	test('renders approval controls only for the latest awaiting tool request', () => {
		const harness = createHarness();
		const firstRequest = createToolRequestMessage('tool-request-1', 1);
		const repeatedRequest = createToolRequestMessage('tool-request-2', 2);
		const state: IVSCloneThreadRuntimeState = {
			threadId: 'thread-1',
			catalog: {
				threadId: 'thread-1',
				title: 'Existing thread',
				createdAt: 1,
				updatedAt: 2,
				status: 'active',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Need approval',
			},
			streamState: { kind: 'awaiting_user', toolName: 'run_terminal_command', approvalType: 'terminal' },
			messages: [firstRequest, repeatedRequest],
			checkpoints: [],
			lastUpdatedAt: 2,
		};

		assert.strictEqual(harness.renderRuntimeToolActions('thread-1', state, firstRequest), undefined);
		assert.ok(harness.renderRuntimeToolActions('thread-1', state, repeatedRequest));
	});
});
