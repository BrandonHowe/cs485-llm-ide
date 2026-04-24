/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { hasKey } from '../../../../../base/common/types.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IVSCloneConvertToLLMMessageService } from '../../browser/vscloneConvertToLLMMessageService.js';
import { IVSCloneLLMMessageService } from '../../browser/vscloneLLMMessageService.js';
import { VSCloneThreadRuntimeService } from '../../browser/vscloneThreadRuntimeService.js';
import { IVSCloneToolExecutionService, IVSCloneToolRuntimeService } from '../../browser/vscloneToolExecutionService.js';
import type { IVSCloneChatTransportRequestOptions } from '../../common/vscloneChatTransportTypes.js';
import type {
	IVSCloneLLMMessageChatRequest,
	IVSCloneLLMMessageObserver,
	IVSCloneLLMMessageRequestHandle,
	IVSCloneLLMMessageToolCall,
	IVSCloneLLMPreparedChatPayload,
} from '../../common/vscloneLLMMessageTypes.js';
import { IVSCloneOAuthService } from '../../common/vscloneOAuthService.js';
import { IVSCloneSettingsService } from '../../common/vscloneSettingsService.js';
import { TestVSCloneUnifiedChatBackendService } from '../common/vscloneTestUnifiedChatBackendService.js';

interface ISequencedChatResponse {
	readonly fullText: string;
	readonly toolCall?: IVSCloneLLMMessageToolCall;
}

class SequencedLLMMessageService implements IVSCloneLLMMessageService {
	declare readonly _serviceBrand: undefined;
	requestCount = 0;

	constructor(private readonly responses: ISequencedChatResponse[]) { }

	sendRequest(): IVSCloneLLMMessageRequestHandle {
		throw new Error('Generic LLM requests are not used in these runtime tests.');
	}

	sendChatRequest(_request: IVSCloneLLMMessageChatRequest, observer: IVSCloneLLMMessageObserver = {}): IVSCloneLLMMessageRequestHandle {
		this.requestCount++;
		const response = this.responses.shift();
		if (!response) {
			throw new Error('Test exhausted the sequenced chat responses.');
		}

		queueMicrotask(() => {
			observer.onFinalMessage?.({
				fullText: response.fullText,
				fullReasoning: '',
				toolCall: response.toolCall,
				anthropicReasoning: null,
			});
		});

		return {
			requestId: `request-${this.responses.length}`,
			done: Promise.resolve(),
			cancel: () => observer.onAbort?.(),
		};
	}

	abort(): void { }
}

suite('VSCloneThreadRuntimeService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function waitForAwaitingApproval(service: VSCloneThreadRuntimeService, threadId: string): Promise<void> {
		// The runtime reaches awaiting-user state asynchronously after the provider callback lands, so
		// the test waits on the real runtime state instead of assuming a specific microtask schedule.
		for (let attempt = 0; attempt < 20; attempt++) {
			if (service.getState(threadId)?.streamState.kind === 'awaiting_user') {
				return;
			}
			await timeout(0);
		}
		throw new Error('Timed out waiting for the runtime to reach awaiting_user state.');
	}

	function createService(
		testDisposables: DisposableStore,
		responses: ISequencedChatResponse[],
		overrides: { readonly toolRuntimeService?: IVSCloneToolRuntimeService } = {},
	): { service: VSCloneThreadRuntimeService; llmMessageService: SequencedLLMMessageService } {
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
			isSignedIn: vendor => vendor === 'openai',
		};
		const llmMessageService = new SequencedLLMMessageService(responses);
		const convertToLLMMessageService: IVSCloneConvertToLLMMessageService = {
			_serviceBrand: undefined,
			prepareChatRequest: (_options: IVSCloneChatTransportRequestOptions): IVSCloneLLMPreparedChatPayload => ({
				vendor: 'openai',
				modelId: 'gpt-5.3-codex',
				modelIdentifier: 'openai/gpt-5.3-codex',
				mode: 'act',
				messages: [],
			}),
			prepareFIMRequest: (): never => {
				throw new Error('Completion prompt conversion is not used in these runtime tests.');
			},
		};
		const settingsService: IVSCloneSettingsService = {
			_serviceBrand: undefined,
			onDidChangeState: Event.None,
			onDidChangeSelection: Event.None,
			initialize: async () => undefined,
			refreshState: async () => undefined,
			getState: (): never => {
				throw new Error('Settings state is not used in these runtime tests.');
			},
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
		const toolRuntimeService: IVSCloneToolRuntimeService = overrides.toolRuntimeService ?? {
			_serviceBrand: undefined,
			prepareToolDefinitions: async () => [],
			listToolDefinitions: () => [],
			getToolDefinition: () => undefined,
			getApprovalType: toolName => toolName === 'run_terminal_command' ? 'terminal' : undefined,
		};
		const toolExecutionService: IVSCloneToolExecutionService = {
			_serviceBrand: undefined,
			executeTool: async () => {
				throw new Error('Rejected approvals should not execute the tool body.');
			},
		};
		const runtimeStorage = new Map<string, string>();
		const storageService = {
			get: (key: string) => runtimeStorage.get(key),
			store: (key: string, value: string | boolean | number | null | undefined) => {
				if (value === undefined || value === null) {
					runtimeStorage.delete(key);
					return;
				}
				runtimeStorage.set(key, String(value));
			},
			remove: (key: string) => {
				runtimeStorage.delete(key);
			},
		} as unknown as IStorageService;
		const workspaceContextService = {
			// Runtime persistence keys thread snapshots by workspace id, so this test double needs the
			// same `getWorkspace()` contract that production workbench services now provide.
			getWorkspace: () => ({ id: 'workspace-test', folders: [] }),
		} as Partial<IWorkspaceContextService> as IWorkspaceContextService;

		return {
			llmMessageService,
			service: testDisposables.add(new VSCloneThreadRuntimeService(
				oauthService,
				llmMessageService,
				convertToLLMMessageService,
				settingsService,
				toolRuntimeService,
				toolExecutionService,
				new TestVSCloneUnifiedChatBackendService(),
				{} as IFileService,
				storageService,
				new NullLogService(),
				workspaceContextService,
			)),
		};
	}

	test('records only the rejected terminal outcome when a live approval is denied', async () => {
		const testDisposables = store.add(new DisposableStore());
		const { service } = createService(testDisposables, [
			{
				fullText: 'I need to run a terminal command first.',
				toolCall: {
					id: 'tool-call-1',
					name: 'run_terminal_command',
					rawParams: { command: 'pwd' },
					doneParams: ['command'],
					isDone: true,
				},
			},
			{
				fullText: 'Understood, I will continue without that command.',
			},
		]);

		const handle = service.runThread({
			threadId: 'thread-1',
			turnId: 'thread-1:turn-1',
			sequence: 1,
			sessionResource: 'vsclone://api/thread-1',
			promptText: 'Inspect the workspace',
			mode: 'act',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelIdentifier: 'openai/gpt-5.3-codex',
		});

		await waitForAwaitingApproval(service, 'thread-1');
		assert.strictEqual(service.rejectLatestToolRequest('thread-1', 'Rejected by the test harness.'), true);
		await handle.done;

		const toolMessages = service.getState('thread-1')?.messages.filter(message => message.role === 'tool') ?? [];
		const rejectedMessage = toolMessages.find(message => message.type === 'rejected');
		assert.deepStrictEqual(toolMessages.map(message => message.type), ['tool_request', 'rejected']);
		// Tool terminal states share one result-message interface, so an explicit runtime guard keeps
		// this assertion aligned with the actual message shape instead of over-constraining the type.
		assert.ok(rejectedMessage && hasKey(rejectedMessage, { output: true }));
		assert.strictEqual(rejectedMessage.output, 'Rejected by the test harness.');
	});

	test('cancels tool definition preparation before sending a chat request', async () => {
		const testDisposables = store.add(new DisposableStore());
		const prepareStarted = new DeferredPromise<void>();
		const prepareCancelled = new DeferredPromise<void>();
		let tokenWasCancelled = false;
		const toolRuntimeService: IVSCloneToolRuntimeService = {
			_serviceBrand: undefined,
			prepareToolDefinitions: async (_mode, token) => {
				prepareStarted.complete();
				if (token?.isCancellationRequested) {
					tokenWasCancelled = true;
					return [];
				}
				const listener = token?.onCancellationRequested(() => {
					tokenWasCancelled = true;
					prepareCancelled.complete();
				});
				try {
					// The regression lives in this pre-request window: cancellation must reach tool
					// preparation so the runtime can stop before constructing a new provider request.
					await prepareCancelled.p;
					return [];
				} finally {
					listener?.dispose();
				}
			},
			listToolDefinitions: () => [],
			getToolDefinition: () => undefined,
			getApprovalType: () => undefined,
		};
		const { service, llmMessageService } = createService(testDisposables, [
			{ fullText: 'This response should never be requested.' },
		], { toolRuntimeService });

		const handle = service.runThread({
			threadId: 'thread-cancel-prepare',
			turnId: 'thread-cancel-prepare:turn-1',
			sequence: 1,
			sessionResource: 'vsclone://api/thread-cancel-prepare',
			promptText: 'Inspect the workspace',
			mode: 'act',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelIdentifier: 'openai/gpt-5.3-codex',
		});

		await prepareStarted.p;
		handle.cancel();
		await handle.done;

		assert.strictEqual(tokenWasCancelled, true);
		assert.strictEqual(llmMessageService.requestCount, 0);
	});
});
