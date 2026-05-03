/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise, timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
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

	constructor(private readonly responses: ISequencedChatResponse[]) { }

	sendRequest(): IVSCloneLLMMessageRequestHandle {
		throw new Error('Generic LLM requests are not used in these runtime tests.');
	}

	sendChatRequest(_request: IVSCloneLLMMessageChatRequest, observer: IVSCloneLLMMessageObserver = {}): IVSCloneLLMMessageRequestHandle {
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

class CancellableLLMMessageService implements IVSCloneLLMMessageService {
	declare readonly _serviceBrand: undefined;

	cancelled = false;
	private completeRequest: (() => void) | undefined;
	private readonly requestStartedDeferred = new DeferredPromise<void>();
	readonly requestStarted = this.requestStartedDeferred.p;

	sendRequest(): IVSCloneLLMMessageRequestHandle {
		throw new Error('Generic LLM requests are not used in these runtime tests.');
	}

	sendChatRequest(_request: IVSCloneLLMMessageChatRequest, observer: IVSCloneLLMMessageObserver = {}): IVSCloneLLMMessageRequestHandle {
		const done = new Promise<void>(resolve => {
			this.completeRequest = resolve;
		});
		// Cancellation only reaches the provider handle after the runtime has stored `activeRequest`.
		// Expose that handoff point so the test does not race the run-loop setup microtasks.
		this.requestStartedDeferred.complete();
		return {
			requestId: 'cancellable-request',
			done,
			cancel: () => {
				this.cancelled = true;
				observer.onAbort?.();
				this.completeRequest?.();
			},
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

	async function waitForIdle(service: VSCloneThreadRuntimeService, threadId: string): Promise<void> {
		// Cancellation and persisted-resume paths settle on later turns of the event loop, so wait on
		// the durable stream state instead of assuming the handle has already run its finalizer.
		for (let attempt = 0; attempt < 40; attempt++) {
			if (service.getState(threadId)?.streamState.kind === 'idle') {
				return;
			}
			await timeout(0);
		}
		throw new Error('Timed out waiting for the runtime to return to idle state.');
	}

	function createService(
		testDisposables: DisposableStore,
		responses: ISequencedChatResponse[],
		options: {
			readonly getApiHeaders?: IVSCloneOAuthService['getApiHeaders'];
			readonly prepareChatRequest?: IVSCloneConvertToLLMMessageService['prepareChatRequest'];
			readonly toolApprovalType?: IVSCloneToolRuntimeService['getApprovalType'];
			readonly toolExecutionService?: IVSCloneToolExecutionService;
			readonly llmMessageService?: IVSCloneLLMMessageService;
			readonly runtimeStorage?: Map<string, string>;
			readonly fileService?: IFileService;
			readonly workspaceFolders?: readonly { readonly uri: URI; readonly name?: string }[];
		} = {},
	): { service: VSCloneThreadRuntimeService; llmMessageService: IVSCloneLLMMessageService; runtimeStorage: Map<string, string> } {
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
			getApiHeaders: options.getApiHeaders ?? (async () => ({ Authorization: 'Bearer test-token' })),
			isSignedIn: vendor => vendor === 'openai',
		};
		const llmMessageService = options.llmMessageService ?? new SequencedLLMMessageService(responses);
		const convertToLLMMessageService: IVSCloneConvertToLLMMessageService = {
			_serviceBrand: undefined,
			prepareChatRequest: options.prepareChatRequest ?? ((_options: IVSCloneChatTransportRequestOptions): IVSCloneLLMPreparedChatPayload => ({
				vendor: 'openai',
				modelId: 'gpt-5.3-codex',
				modelIdentifier: 'openai/gpt-5.3-codex',
				mode: 'act',
				messages: [],
			})),
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
			getIneligibilityRecord: () => undefined,
			markModelIneligible: async () => undefined,
			clearIneligibilityForVendor: async () => undefined,
			sanitizeReasoningFields: (_modelIdentifier, fields) => ({ ...fields }),
		};
		const toolRuntimeService: IVSCloneToolRuntimeService = {
			_serviceBrand: undefined,
			listToolDefinitions: () => [],
			getToolDefinition: () => undefined,
			getApprovalType: options.toolApprovalType ?? (toolName => {
				if (toolName === 'run_terminal_command') {
					return 'terminal';
				}
				if (toolName === 'ask_user') {
					return 'user input';
				}
				return undefined;
			}),
		};
		const toolExecutionService: IVSCloneToolExecutionService = options.toolExecutionService ?? {
			_serviceBrand: undefined,
			executeTool: async () => {
				throw new Error('Rejected approvals should not execute the tool body.');
			},
		};
		const runtimeStorage = options.runtimeStorage ?? new Map<string, string>();
		const storageService = {
			get: (key: string) => runtimeStorage.get(key),
			getBoolean: (key: string, _scope: unknown, fallbackValue: boolean) => {
				const storedValue = runtimeStorage.get(key);
				return storedValue === undefined ? fallbackValue : storedValue === 'true';
			},
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
			getWorkspace: () => ({ id: 'workspace-test', folders: options.workspaceFolders ?? [] }),
			isInsideWorkspace: () => true,
		} as unknown as IWorkspaceContextService;

		return {
			llmMessageService,
			runtimeStorage,
			service: testDisposables.add(new VSCloneThreadRuntimeService(
				oauthService,
				llmMessageService,
				convertToLLMMessageService,
				settingsService,
				toolRuntimeService,
				toolExecutionService,
				new TestVSCloneUnifiedChatBackendService(),
				options.fileService ?? {} as IFileService,
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
		assert.ok(rejectedMessage && rejectedMessage.type === 'rejected');
		assert.strictEqual(rejectedMessage.output, 'Rejected by the test harness.');
	});

	test('records ask_user answer as the terminal tool outcome and resumes the loop', async () => {
		const testDisposables = store.add(new DisposableStore());
		const { service } = createService(testDisposables, [
			{
				fullText: 'I need to ask a focused question.',
				toolCall: {
					id: 'tool-call-ask',
					name: 'ask_user',
					rawParams: {
						questions: JSON.stringify([{
							id: 'strategy',
							question: 'Which implementation strategy should I use?',
							options: [{ label: 'Conservative', description: 'Keep the change narrow.' }],
						}]),
					},
					doneParams: ['questions'],
					isDone: true,
				},
			},
			{
				fullText: 'I will use the conservative strategy.',
			},
		]);

		const handle = service.runThread({
			threadId: 'thread-ask',
			turnId: 'thread-ask:turn-1',
			sequence: 1,
			sessionResource: 'vsclone://api/thread-ask',
			promptText: 'Implement this with the right strategy',
			mode: 'act',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelIdentifier: 'openai/gpt-5.3-codex',
		});

		await waitForAwaitingApproval(service, 'thread-ask');
		const answer = JSON.stringify({ answers: [{ id: 'strategy', choice: 'Conservative', free_response: '' }] }, undefined, 2);
		assert.strictEqual(service.answerLatestToolRequest('thread-ask', answer), true);
		await handle.done;

		const state = service.getState('thread-ask');
		const toolMessages = state?.messages.filter(message => message.role === 'tool') ?? [];
		assert.deepStrictEqual(toolMessages.map(message => message.type), ['tool_request', 'success']);
		const resultMessage = toolMessages.at(-1);
		assert.ok(resultMessage?.type === 'success');
		assert.strictEqual(resultMessage.output, answer);
		const finalMessage = state?.messages.at(-1);
		assert.ok(finalMessage?.role === 'assistant');
		assert.strictEqual(finalMessage.content, 'I will use the conservative strategy.');
	});

	test('executes an approved tool and continues with the follow-up model turn', async () => {
		const testDisposables = store.add(new DisposableStore());
		const executedTools: Array<{ readonly name: string; readonly params: Record<string, string> }> = [];
		const { service } = createService(testDisposables, [
			{
				fullText: 'I will inspect the workspace.',
				toolCall: {
					id: 'tool-call-inspect',
					name: 'inspect_workspace',
					rawParams: { path: '.' },
					doneParams: ['path'],
					isDone: true,
				},
			},
			{
				fullText: 'The workspace contains the expected files.',
			},
		], {
			toolExecutionService: {
				_serviceBrand: undefined,
				executeTool: async (name, params) => {
					executedTools.push({ name, params });
					return { success: true, output: 'README.md\nsrc/' };
				},
			},
		});

		const handle = service.runThread({
			threadId: 'thread-tool-success',
			turnId: 'thread-tool-success:turn-1',
			sequence: 1,
			sessionResource: 'vsclone://api/thread-tool-success',
			promptText: 'Inspect the workspace',
			mode: 'act',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelIdentifier: 'openai/gpt-5.3-codex',
		});

		await handle.done;

		assert.deepStrictEqual(executedTools, [{ name: 'inspect_workspace', params: { path: '.' } }]);
		const state = service.getState('thread-tool-success');
		const toolMessages = state?.messages.filter(message => message.role === 'tool') ?? [];
		assert.deepStrictEqual(toolMessages.map(message => message.type), ['tool_request', 'running_now', 'success']);
		const resultMessage = toolMessages.at(-1);
		assert.ok(resultMessage?.type === 'success');
		assert.strictEqual(resultMessage.output, 'README.md\nsrc/');
		const finalMessage = state?.messages.at(-1);
		assert.ok(finalMessage?.role === 'assistant');
		assert.strictEqual(finalMessage.content, 'The workspace contains the expected files.');
	});

	test('cancels an active model request and leaves the thread idle', async () => {
		const testDisposables = store.add(new DisposableStore());
		const llmMessageService = new CancellableLLMMessageService();
		const { service } = createService(testDisposables, [], { llmMessageService });

		const handle = service.runThread({
			threadId: 'thread-cancel',
			turnId: 'thread-cancel:turn-1',
			sequence: 1,
			sessionResource: 'vsclone://api/thread-cancel',
			promptText: 'Start a long request',
			mode: 'act',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelIdentifier: 'openai/gpt-5.3-codex',
		});

		await llmMessageService.requestStarted;
		handle.cancel();
		await handle.done;
		await waitForIdle(service, 'thread-cancel');

		assert.strictEqual(llmMessageService.cancelled, true);
		assert.strictEqual(service.getState('thread-cancel')?.streamState.kind, 'idle');
		assert.deepStrictEqual(service.getState('thread-cancel')?.messages.map(message => message.role), ['user']);
	});

	test('records a missing auth error without calling the model transport', async () => {
		const testDisposables = store.add(new DisposableStore());
		const { service } = createService(testDisposables, [], {
			getApiHeaders: async () => undefined,
		});

		const handle = service.runThread({
			threadId: 'thread-missing-auth',
			turnId: 'thread-missing-auth:turn-1',
			sequence: 1,
			sessionResource: 'vsclone://api/thread-missing-auth',
			promptText: 'Use the selected provider',
			mode: 'act',
			vendor: 'google',
			modelId: 'gemini-test',
			modelIdentifier: 'google/gemini-test',
		});

		await handle.done;

		const finalMessage = service.getState('thread-missing-auth')?.messages.at(-1);
		assert.ok(finalMessage?.role === 'assistant');
		assert.strictEqual(finalMessage.content, 'Not signed in to google');
	});

	test('records model preparation failures as assistant errors', async () => {
		const testDisposables = store.add(new DisposableStore());
		const { service } = createService(testDisposables, [], {
			prepareChatRequest: () => {
				throw new Error('Missing model selection for Chat.');
			},
		});

		const handle = service.runThread({
			threadId: 'thread-missing-model',
			turnId: 'thread-missing-model:turn-1',
			sequence: 1,
			sessionResource: 'vsclone://api/thread-missing-model',
			promptText: 'Use the selected model',
			mode: 'act',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelIdentifier: 'openai/gpt-5.3-codex',
		});

		await handle.done;

		const finalMessage = service.getState('thread-missing-model')?.messages.at(-1);
		assert.ok(finalMessage?.role === 'assistant');
		assert.strictEqual(finalMessage.content, 'Missing model selection for Chat.');
	});

	test('restores persisted runtime state and deleted-thread markers from workspace storage', () => {
		const testDisposables = store.add(new DisposableStore());
		const runtimeStorage = new Map<string, string>();
		const { service: firstRuntime } = createService(testDisposables, [], { runtimeStorage });

		firstRuntime.recordRejectedTurn({
			threadId: 'thread-persisted',
			turnId: 'thread-persisted:turn-1',
			sessionResource: 'vsclone://api/thread-persisted',
			promptText: 'Explain persisted state',
			mode: 'act',
			reason: 'Sign in before continuing.',
		});

		const { service: restoredRuntime } = createService(testDisposables, [], { runtimeStorage });
		assert.strictEqual(restoredRuntime.getState('thread-persisted')?.catalog.title, 'Explain persisted state');
		assert.deepStrictEqual(restoredRuntime.getThreads({ text: 'persisted' }).map(thread => thread.threadId), ['thread-persisted']);

		assert.strictEqual(restoredRuntime.deleteThread('thread-persisted'), true);
		const { service: afterDeleteRuntime } = createService(testDisposables, [], { runtimeStorage });
		assert.strictEqual(afterDeleteRuntime.getState('thread-persisted'), undefined);
		assert.strictEqual(afterDeleteRuntime.isDeletedThread('thread-persisted'), true);
	});

	test('archives threads and tracks assistant edit application state', () => {
		const testDisposables = store.add(new DisposableStore());
		const { service } = createService(testDisposables, []);
		const now = Date.now();
		// Seed a compact runtime state directly so these assertions can exercise the public
		// bookkeeping APIs without driving a model loop just to manufacture edit metadata.
		(service as unknown as { states: Map<string, unknown> }).states.set('thread-edit-state', {
			threadId: 'thread-edit-state',
			catalog: {
				threadId: 'thread-edit-state',
				sessionResource: 'vsclone://api/thread-edit-state',
				title: 'Edit state',
				createdAt: now,
				updatedAt: now,
				status: 'idle',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Edit state',
			},
			mode: 'act',
			streamState: { kind: 'idle' },
			messages: [
				{ id: 'user-1', role: 'user', createdAt: now, content: 'Apply this edit' },
				{
					id: 'assistant-1',
					role: 'assistant',
					createdAt: now,
					content: '<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
					metadata: { editSuggestion: { kind: 'search_replace', applyMode: 'manual' } },
				},
				{ id: 'assistant-2', role: 'assistant', createdAt: now, content: 'No edit here' },
			],
			assistantEditApplications: [],
			checkpoints: [],
			branchHeadMessageId: 'assistant-2',
			lastUpdatedAt: now,
		});

		assert.strictEqual(service.archiveThread('thread-edit-state', true), true);
		assert.strictEqual(service.archiveThread('thread-edit-state', true), false);
		assert.strictEqual(service.getState('thread-edit-state')?.catalog.archived, true);

		assert.deepStrictEqual(service.getAssistantEditStatuses('missing'), []);
		assert.deepStrictEqual(service.getAssistantEditStatuses('thread-edit-state').map(status => status.messageId), ['assistant-1']);
		assert.strictEqual(service.getAssistantEditStatus('thread-edit-state', 'assistant-1')?.suggestion.applyMode, 'manual');
		service.setAssistantEditApplicationState?.('thread-edit-state', 'assistant-1', { phase: 'pending' });
		assert.deepStrictEqual(service.getAssistantEditApplicationState?.('thread-edit-state', 'assistant-1'), { phase: 'pending' });
		assert.deepStrictEqual(service.getAssistantEditApplicationStates?.('thread-edit-state'), [{ messageId: 'assistant-1', state: { phase: 'pending' } }]);

		service.setAssistantEditApplicationState?.('thread-edit-state', 'assistant-1', { phase: 'failed' });
		assert.deepStrictEqual(service.getAssistantEditApplicationState?.('thread-edit-state', 'assistant-1'), { phase: 'failed' });
		service.setAssistantEditApplicationState?.('thread-edit-state', 'assistant-2', { phase: 'pending' });
		assert.strictEqual(service.getAssistantEditApplicationStates?.('thread-edit-state').length, 1);
		service.setAssistantEditApplicationState?.('thread-edit-state', 'assistant-1', undefined);
		assert.deepStrictEqual(service.getAssistantEditApplicationStates?.('thread-edit-state'), []);
	});

	test('approves a persisted tool request after reload and resumes the thread', async () => {
		const firstDisposables = store.add(new DisposableStore());
		const runtimeStorage = new Map<string, string>();
		const { service: firstRuntime } = createService(firstDisposables, [
			{
				fullText: 'I need terminal output before continuing.',
				toolCall: {
					id: 'tool-call-persisted',
					name: 'run_terminal_command',
					rawParams: { command: 'pwd' },
					doneParams: ['command'],
					isDone: true,
				},
			},
		], { runtimeStorage });

		firstRuntime.runThread({
			threadId: 'thread-persisted-approval',
			turnId: 'thread-persisted-approval:turn-1',
			sequence: 1,
			sessionResource: 'vsclone://api/thread-persisted-approval',
			promptText: 'Run a command',
			mode: 'act',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelIdentifier: 'openai/gpt-5.3-codex',
		});
		await waitForAwaitingApproval(firstRuntime, 'thread-persisted-approval');
		firstDisposables.dispose();

		const secondDisposables = store.add(new DisposableStore());
		const executedTools: string[] = [];
		const { service: restoredRuntime } = createService(secondDisposables, [
			{ fullText: 'The command finished after reload.' },
		], {
			runtimeStorage,
			toolExecutionService: {
				_serviceBrand: undefined,
				executeTool: async (name, params) => {
					executedTools.push(`${name}:${params.command}`);
					return { success: true, output: '/workspace' };
				},
			},
		});

		assert.strictEqual(restoredRuntime.approveLatestToolRequest('thread-persisted-approval'), true);
		await waitForIdle(restoredRuntime, 'thread-persisted-approval');

		assert.deepStrictEqual(executedTools, ['run_terminal_command:pwd']);
		assert.deepStrictEqual(restoredRuntime.getState('thread-persisted-approval')?.messages.filter(message => message.role === 'tool').map(message => message.type), ['tool_request', 'running_now', 'success']);
		const finalMessage = restoredRuntime.getState('thread-persisted-approval')?.messages.at(-1);
		assert.ok(finalMessage?.role === 'assistant');
		assert.strictEqual(finalMessage.content, 'The command finished after reload.');
	});

	test('persists the auto-approve edits flag and skips the live approval wait for edit tools', async () => {
		const testDisposables = store.add(new DisposableStore());
		const runtimeStorage = new Map<string, string>();
		const autoApproveEvents: boolean[] = [];
		const { service } = createService(testDisposables, [
			{
				fullText: 'I will update the file.',
				toolCall: {
					id: 'tool-call-edit',
					name: 'edit_file',
					rawParams: { path: 'src/example.ts' },
					doneParams: ['path'],
					isDone: true,
				},
			},
			{
				fullText: 'The edit is complete.',
			},
		], {
			runtimeStorage,
			workspaceFolders: [{ uri: URI.file('/workspace'), name: 'workspace' }],
			fileService: {
				exists: async () => false,
			} as Partial<IFileService> as IFileService,
			toolApprovalType: toolName => toolName === 'edit_file' ? 'edits' : undefined,
			toolExecutionService: {
				_serviceBrand: undefined,
				executeTool: async () => ({ success: true, output: 'Edited src/example.ts.' }),
			},
		});
		const listener = service.onDidChangeAutoApproveEdits(enabled => autoApproveEvents.push(enabled));
		testDisposables.add(listener);

		service.setAutoApproveEdits(true);
		const handle = service.runThread({
			threadId: 'thread-auto-approve',
			turnId: 'thread-auto-approve:turn-1',
			sequence: 1,
			sessionResource: 'vsclone://api/thread-auto-approve',
			promptText: 'Edit the file',
			mode: 'act',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelIdentifier: 'openai/gpt-5.3-codex',
		});

		await handle.done;

		const { service: restoredRuntime } = createService(testDisposables, [], { runtimeStorage });
		assert.strictEqual(restoredRuntime.isAutoApproveEdits(), true);
		assert.deepStrictEqual(autoApproveEvents, [true]);
		const state = service.getState('thread-auto-approve');
		assert.strictEqual(state?.streamState.kind, 'idle');
		assert.deepStrictEqual(state?.messages.filter(message => message.role === 'tool').map(message => message.type), ['tool_request', 'running_now', 'success']);
		assert.strictEqual(state?.messages.some(message => message.role === 'tool' && message.type === 'tool_request' && message.approvalType === 'edits'), true);
	});
});
