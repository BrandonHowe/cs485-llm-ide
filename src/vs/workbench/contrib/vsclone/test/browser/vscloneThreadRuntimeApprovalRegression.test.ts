/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { hasKey } from '../../../../../base/common/types.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import type { IStorageService } from '../../../../../platform/storage/common/storage.js';
import type { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IVSCloneConvertToLLMMessageService } from '../../browser/vscloneConvertToLLMMessageService.js';
import type { IVSCloneLLMMessageService } from '../../browser/vscloneLLMMessageService.js';
import { type IVSCloneThreadRuntimeService, VSCloneThreadRuntimeService } from '../../browser/vscloneThreadRuntimeService.js';
import type { IVSCloneToolExecutionService, IVSCloneToolRuntimeService } from '../../browser/vscloneToolExecutionService.js';
import type { IVSCloneChatTransportRequestOptions } from '../../common/vscloneChatTransportTypes.js';
import {
	type IVSCloneLLMMessageChatRequest,
	type IVSCloneLLMMessageObserver,
	type IVSCloneLLMMessageRequest,
	type IVSCloneLLMMessageRequestHandle,
	type IVSCloneLLMPreparedChatPayload,
} from '../../common/vscloneLLMMessageTypes.js';
import type { IVSCloneOAuthService } from '../../common/vscloneOAuthService.js';
import type { IVSCloneSettingsService } from '../../common/vscloneSettingsService.js';
import type { IVSCloneThreadRuntimeMessage } from '../../common/vscloneThreadRuntimeTypes.js';
import type { IVSCloneToolDefinition } from '../../common/vscloneToolDefinitions.js';
import { TestVSCloneUnifiedChatBackendService } from '../common/vscloneTestUnifiedChatBackendService.js';

type ChatRequestScriptStep = (request: IVSCloneLLMMessageChatRequest, observer: IVSCloneLLMMessageObserver) => void;

class ScriptedLLMMessageService implements IVSCloneLLMMessageService {
	declare readonly _serviceBrand: undefined;

	private requestIndex = 0;

	constructor(private readonly steps: readonly ChatRequestScriptStep[]) { }

	sendRequest(request: IVSCloneLLMMessageRequest, observer: IVSCloneLLMMessageObserver = {}): IVSCloneLLMMessageRequestHandle {
		if (request.kind !== 'chat') {
			throw new Error('This focused runtime regression only scripts chat requests.');
		}

		return this.sendChatRequest(request, observer);
	}

	sendChatRequest(request: IVSCloneLLMMessageChatRequest, observer: IVSCloneLLMMessageObserver = {}): IVSCloneLLMMessageRequestHandle {
		const stepIndex = this.requestIndex++;
		const step = this.steps[stepIndex];
		assert.ok(step, `Unexpected chat request #${stepIndex + 1}`);
		const requestId = `request-${stepIndex + 1}`;
		let cancelled = false;
		const done = Promise.resolve().then(() => {
			if (cancelled) {
				return;
			}

			step(request, observer);
		});

		return {
			requestId,
			done,
			cancel: () => {
				if (cancelled) {
					return;
				}

				cancelled = true;
				observer.onAbort?.();
			},
		};
	}

	abort(): void { }
}

function createPreparedChatPayload(): IVSCloneLLMPreparedChatPayload {
	return {
		vendor: 'openai',
		modelId: 'gpt-5.3-codex',
		modelIdentifier: 'openai/gpt-5.3-codex',
		mode: 'act',
		messages: [],
	};
}

function createSettingsService(): IVSCloneSettingsService {
	return {
		_serviceBrand: undefined,
		onDidChangeState: Event.None,
		onDidChangeSelection: Event.None,
		initialize: async () => undefined,
		refreshState: async () => undefined,
		getState: () => ({
			status: 'ready',
			providers: [],
			models: [],
			featureSelections: {},
			modelSelectionOfFeature: {
				Chat: undefined,
				Autocomplete: undefined,
				Notebook: undefined,
				Terminal: undefined,
			},
			featureDefaults: {
				Chat: { featureName: 'Chat', location: 'chat', selection: undefined },
				Autocomplete: { featureName: 'Autocomplete', location: 'editorInline', selection: undefined },
				Notebook: { featureName: 'Notebook', location: 'notebook', selection: undefined },
				Terminal: { featureName: 'Terminal', location: 'terminal', selection: undefined },
			},
			threadSelections: {},
			threadSelectionSnapshots: {},
			recentModels: [],
			recentModelIdentifiers: [],
			eligibilityRecords: [],
			ineligibilityRecords: [],
		}),
		getProviders: () => [],
		getModels: () => [],
		getModelsForFeature: () => [],
		getModel: () => undefined,
		getSelectableModels: () => [],
		getFeatureSelection: () => undefined,
		getFeatureDefaults: () => ({
			Chat: { featureName: 'Chat', location: 'chat', selection: undefined },
			Autocomplete: { featureName: 'Autocomplete', location: 'editorInline', selection: undefined },
			Notebook: { featureName: 'Notebook', location: 'notebook', selection: undefined },
			Terminal: { featureName: 'Terminal', location: 'terminal', selection: undefined },
		}),
		getCurrentSelectionForFeatureName: () => undefined,
		getCurrentSelectionForFeature: () => undefined,
		getThreadSelectionSnapshot: () => undefined,
		setSelectionForFeature: async () => undefined,
		switchToNextModel: async () => undefined,
		resetSelectionForThread: async () => undefined,
		hasSelectionForThread: () => false,
		getRecentModels: () => [],
		getRecentModelIdentifiers: () => [],
		getEligibilityRecords: () => [],
		setProviderEnabled: async () => undefined,
		getIneligibilityRecord: () => undefined,
		markModelIneligible: async () => undefined,
		clearIneligibilityForVendor: async () => undefined,
	};
}

function createRuntimeService(
	testDisposables: DisposableStore,
	options: {
		readonly llmMessageService: IVSCloneLLMMessageService;
		readonly toolExecutionService: IVSCloneToolExecutionService;
		readonly toolRuntimeService?: IVSCloneToolRuntimeService;
	},
	persistedStorage: Map<string, string> = new Map<string, string>(),
): VSCloneThreadRuntimeService {
	const oauthService: IVSCloneOAuthService = {
		_serviceBrand: undefined,
		state: {
			providers: {
				openai: { vendor: 'openai', displayName: 'OpenAI', status: 'signed_in', userDisplayName: 'Test User', errorMessage: undefined, isReady: true },
				anthropic: { vendor: 'anthropic', displayName: 'Anthropic', status: 'signed_out', userDisplayName: undefined, errorMessage: undefined, isReady: false },
				google: { vendor: 'google', displayName: 'Google', status: 'signed_out', userDisplayName: undefined, errorMessage: undefined, isReady: false },
			},
		},
		onDidChangeState: Event.None,
		initialize: async () => undefined,
		signIn: async () => undefined,
		signOut: async () => undefined,
		getAccessToken: async () => undefined,
		getTokenSet: async () => undefined,
		getApiHeaders: async () => ({ Authorization: 'Bearer test-token' }),
		isSignedIn: () => true,
	};
	const convertToLLMMessageService: IVSCloneConvertToLLMMessageService = {
		_serviceBrand: undefined,
		prepareChatRequest: (_options: IVSCloneChatTransportRequestOptions): IVSCloneLLMPreparedChatPayload => createPreparedChatPayload(),
		prepareFIMRequest: () => {
			throw new Error('FIM conversion should not run in this runtime regression test.');
		},
	};
	const toolRuntimeService: IVSCloneToolRuntimeService = options.toolRuntimeService ?? {
		_serviceBrand: undefined,
		prepareToolDefinitions: async () => [],
		listToolDefinitions: () => [],
		getToolDefinition: () => undefined,
		// The approval gate is the behavior under test, so the scripted tool must be marked as
		// approval-requiring even though the concrete tool implementation is replaced in the harness.
		getApprovalType: toolName => toolName === 'run_command' ? 'terminal' : undefined,
	};
	const storageService = {
		get: (key: string) => persistedStorage.get(key),
		store: (key: string, value: string | boolean | number | null | undefined) => {
			if (value === undefined || value === null) {
				persistedStorage.delete(key);
				return;
			}

			persistedStorage.set(key, String(value));
		},
		remove: (key: string) => {
			persistedStorage.delete(key);
		},
	} as unknown as IStorageService;
	const workspaceContextService = {
		getWorkspace: () => ({ id: 'workspace-test', folders: [] }),
		isInsideWorkspace: () => true,
	} as Partial<IWorkspaceContextService> as IWorkspaceContextService;

	return testDisposables.add(new VSCloneThreadRuntimeService(
		oauthService,
		options.llmMessageService,
		convertToLLMMessageService,
		createSettingsService(),
		toolRuntimeService,
		options.toolExecutionService,
		new TestVSCloneUnifiedChatBackendService(),
		{} as IFileService,
		storageService,
		new NullLogService(),
		workspaceContextService,
	));
}

async function waitForAwaitingApproval(
	runtimeService: IVSCloneThreadRuntimeService,
	threadId: string,
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (runtimeService.getState(threadId)?.streamState.kind === 'awaiting_user') {
			return;
		}

		await timeout(0);
	}

	throw new Error(`Timed out waiting for thread ${threadId} to reach awaiting_user state.`);
}

async function waitForIdleThread(runtimeService: IVSCloneThreadRuntimeService, threadId: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (runtimeService.getState(threadId)?.streamState.kind === 'idle') {
			return;
		}

		await timeout(0);
	}

	throw new Error(`Timed out waiting for thread ${threadId} to return to idle state.`);
}

suite('VSCloneThreadRuntimeApprovalRegression', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('rejecting a live approval records only the rejected outcome for that invocation', async () => {
		const testDisposables = store.add(new DisposableStore());
		let toolExecutionCount = 0;
		const llmMessageService = new ScriptedLLMMessageService([
			(_request, observer) => {
				observer.onFinalMessage?.({
					fullText: 'I need approval before running that command.',
					fullReasoning: '',
					anthropicReasoning: null,
					toolCall: {
						id: 'call-1',
						name: 'run_command',
						rawParams: { command: 'git status' },
						doneParams: ['command'],
						isDone: true,
					},
				});
			},
			(_request, observer) => {
				observer.onFinalMessage?.({
					fullText: 'Okay, I will not run it.',
					fullReasoning: '',
					anthropicReasoning: null,
				});
			},
		]);
		const runtimeService = createRuntimeService(testDisposables, {
			llmMessageService,
			toolExecutionService: {
				_serviceBrand: undefined,
				executeTool: async () => {
					toolExecutionCount++;
					return { success: true, output: 'unexpected execution' };
				},
			},
		});

		const handle = runtimeService.runThread({
			threadId: 'thread-1',
			turnId: 'thread-1:turn-1',
			sequence: 1,
			sessionResource: 'vsclone://api/thread-1',
			promptText: 'Show me the repository status.',
			mode: 'act',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelIdentifier: 'openai/gpt-5.3-codex',
		});

		await waitForAwaitingApproval(runtimeService, 'thread-1');
		assert.strictEqual(runtimeService.rejectLatestToolRequest('thread-1', 'Command rejected by reviewer.'), true);
		await handle.done;

		const state = runtimeService.getState('thread-1');
		assert.ok(state);
		const toolMessages = state!.messages.filter((message): message is Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'tool' }> => message.role === 'tool');
		const rejectedMessage = toolMessages.find(message => message.type === 'rejected');
		assert.deepStrictEqual(toolMessages.map(message => message.type), ['tool_request', 'rejected']);
		assert.strictEqual(toolMessages.some(message => message.type === 'tool_error'), false);
		assert.ok(rejectedMessage && hasKey(rejectedMessage, { output: true }));
		assert.strictEqual(rejectedMessage.output, 'Command rejected by reviewer.');
		assert.strictEqual(toolExecutionCount, 0);
		assert.strictEqual(state!.streamState.kind, 'idle');
	});

	test('rejecting a restored approval resumes the assistant follow-up after reload', async () => {
		const initialDisposables = store.add(new DisposableStore());
		const restoredDisposables = store.add(new DisposableStore());
		let toolExecutionCount = 0;
		const persistedStorage = new Map<string, string>();
		const initialRuntime = createRuntimeService(initialDisposables, {
			llmMessageService: new ScriptedLLMMessageService([
				(_request, observer) => {
					observer.onFinalMessage?.({
						fullText: 'I need approval before running that command.',
						fullReasoning: '',
						anthropicReasoning: null,
						toolCall: {
							id: 'call-restore-1',
							name: 'run_command',
							rawParams: { command: 'git status' },
							doneParams: ['command'],
							isDone: true,
						},
					});
				},
			]),
			toolExecutionService: {
				_serviceBrand: undefined,
				executeTool: async () => {
					toolExecutionCount++;
					return { success: true, output: 'unexpected execution' };
				},
			},
		}, persistedStorage);

		void initialRuntime.runThread({
			threadId: 'thread-restore',
			turnId: 'thread-restore:turn-1',
			sequence: 1,
			sessionResource: 'vsclone://api/thread-restore',
			promptText: 'Show me the repository status.',
			mode: 'act',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelIdentifier: 'openai/gpt-5.3-codex',
		}).done.catch(() => undefined);

		await waitForAwaitingApproval(initialRuntime, 'thread-restore');

		const restoredRuntime = createRuntimeService(restoredDisposables, {
			llmMessageService: new ScriptedLLMMessageService([
				(_request, observer) => {
					observer.onFinalMessage?.({
						fullText: 'Okay, I will not run it.',
						fullReasoning: '',
						anthropicReasoning: null,
					});
				},
			]),
			toolExecutionService: {
				_serviceBrand: undefined,
				executeTool: async () => {
					toolExecutionCount++;
					return { success: true, output: 'unexpected execution' };
				},
			},
		}, persistedStorage);

		assert.strictEqual(restoredRuntime.getState('thread-restore')?.streamState.kind, 'awaiting_user');
		assert.strictEqual(restoredRuntime.rejectLatestToolRequest('thread-restore', 'Command rejected after restore.'), true);
		await waitForIdleThread(restoredRuntime, 'thread-restore');

		const state = restoredRuntime.getState('thread-restore');
		assert.ok(state);
		const lastMessage = state!.messages.at(-1);
		assert.strictEqual(lastMessage?.role, 'assistant');
		assert.strictEqual(lastMessage && lastMessage.role === 'assistant' ? lastMessage.content : undefined, 'Okay, I will not run it.');
		const toolMessages = state!.messages.filter((message): message is Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'tool' }> => message.role === 'tool');
		assert.deepStrictEqual(toolMessages.map(message => message.type), ['tool_request', 'rejected']);
		assert.strictEqual(toolExecutionCount, 0);
	});

	test('MCP approval uses the advertised tool snapshot when the live registry misses', async () => {
		const testDisposables = store.add(new DisposableStore());
		const mcpToolName = 'mcp_deadbeef_lookup';
		const advertisedMcpTool: IVSCloneToolDefinition = {
			name: mcpToolName,
			description: 'Look up data through a test MCP server.',
			approvalType: 'MCP tools',
			planModeAllowed: false,
			parameters: [],
		};
		let toolExecutionCount = 0;
		const llmMessageService = new ScriptedLLMMessageService([
			(request, observer) => {
				assert.strictEqual(request.prepared.toolDefinitions?.some(tool => tool.name === mcpToolName && tool.approvalType === 'MCP tools'), true);
				observer.onFinalMessage?.({
					fullText: 'I need to query the MCP server.',
					fullReasoning: '',
					anthropicReasoning: null,
					toolCall: {
						id: 'call-mcp-1',
						name: mcpToolName,
						rawParams: { query: 'status' },
						doneParams: ['query'],
						isDone: true,
					},
				});
			},
			(_request, observer) => {
				observer.onFinalMessage?.({
					fullText: 'I will not call it.',
					fullReasoning: '',
					anthropicReasoning: null,
				});
			},
		]);
		const runtimeService = createRuntimeService(testDisposables, {
			llmMessageService,
			toolExecutionService: {
				_serviceBrand: undefined,
				executeTool: async () => {
					toolExecutionCount++;
					return { success: true, output: 'unexpected MCP execution' };
				},
			},
			toolRuntimeService: {
				_serviceBrand: undefined,
				prepareToolDefinitions: async () => [advertisedMcpTool],
				listToolDefinitions: () => [],
				getToolDefinition: () => undefined,
				// Simulate the race where MCP discovery advertised a provider name, but the live
				// registry lookup misses before the approval gate records the tool request.
				getApprovalType: () => undefined,
			},
		});

		const handle = runtimeService.runThread({
			threadId: 'thread-mcp-snapshot',
			turnId: 'thread-mcp-snapshot:turn-1',
			sequence: 1,
			sessionResource: 'vsclone://api/thread-mcp-snapshot',
			promptText: 'Use the lookup MCP tool.',
			mode: 'act',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelIdentifier: 'openai/gpt-5.3-codex',
		});

		await waitForAwaitingApproval(runtimeService, 'thread-mcp-snapshot');
		const pendingState = runtimeService.getState('thread-mcp-snapshot');
		assert.strictEqual(pendingState?.streamState.kind, 'awaiting_user');
		assert.strictEqual(pendingState?.streamState.kind === 'awaiting_user' ? pendingState.streamState.approvalType : undefined, 'MCP tools');
		assert.strictEqual(runtimeService.rejectLatestToolRequest('thread-mcp-snapshot', 'MCP rejected by reviewer.'), true);
		await handle.done;

		const state = runtimeService.getState('thread-mcp-snapshot');
		assert.ok(state);
		const toolMessages = state!.messages.filter((message): message is Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'tool' }> => message.role === 'tool');
		assert.deepStrictEqual(toolMessages.map(message => message.type), ['tool_request', 'rejected']);
		assert.strictEqual(toolMessages[0].approvalType, 'MCP tools');
		assert.strictEqual(toolExecutionCount, 0);
	});
});
