/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { Event } from '../../../../../base/common/event.js';
import { IVSCloneConvertToLLMMessageService } from '../../browser/vscloneConvertToLLMMessageService.js';
import { IVSCloneLLMMessageService } from '../../browser/vscloneLLMMessageService.js';
import { VSCloneThreadRuntimeService } from '../../browser/vscloneThreadRuntimeService.js';
import type { IVSCloneChatTransportRequestOptions } from '../../common/vscloneChatTransportTypes.js';
import { IVSCloneLLMPreparedChatPayload } from '../../common/vscloneLLMMessageTypes.js';
import { IVSCloneOAuthService } from '../../common/vscloneOAuthService.js';
import { IVSCloneSettingsService } from '../../common/vscloneSettingsService.js';
import { IVSCloneToolExecutionService, IVSCloneToolRuntimeService } from '../../browser/vscloneToolExecutionService.js';
import { TestVSCloneUnifiedChatBackendService } from '../common/vscloneTestUnifiedChatBackendService.js';

function createThreadSelection(threadId: string) {
	return {
		threadId,
		location: 'chat' as const,
		modelIdentifier: 'openai/gpt-5.3-codex',
		vendor: 'openai' as const,
		modelId: 'gpt-5.3-codex',
		modelName: 'GPT-5.3-Codex',
		selectedAt: Date.now(),
	};
}

suite('VSCloneThreadRuntimeSidecarCleanup', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(
		testDisposables: DisposableStore,
		backendService: TestVSCloneUnifiedChatBackendService,
		runtimeStorage: Map<string, string> = new Map<string, string>(),
	): VSCloneThreadRuntimeService {
		const oauthService: IVSCloneOAuthService = {
			_serviceBrand: undefined,
			state: {
				providers: {
					openai: { vendor: 'openai', displayName: 'OpenAI', status: 'signed_out', userDisplayName: undefined, errorMessage: undefined, isReady: false },
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
			getApiHeaders: async () => undefined,
			isSignedIn: () => false,
		};
		const llmMessageService: IVSCloneLLMMessageService = {
			_serviceBrand: undefined,
			sendRequest: () => {
				throw new Error('LLM transport should not run in these sidecar cleanup tests.');
			},
			sendChatRequest: () => {
				throw new Error('LLM transport should not run in these sidecar cleanup tests.');
			},
			abort: () => undefined,
		};
		const convertToLLMMessageService: IVSCloneConvertToLLMMessageService = {
			_serviceBrand: undefined,
			prepareChatRequest: (_options: IVSCloneChatTransportRequestOptions): IVSCloneLLMPreparedChatPayload => {
				throw new Error('Message conversion should not run in these sidecar cleanup tests.');
			},
			prepareFIMRequest: () => {
				throw new Error('FIM conversion should not run in these sidecar cleanup tests.');
			},
		};
		const settingsService: IVSCloneSettingsService = {
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
			getIneligibilityRecord: () => undefined,
			markModelIneligible: async () => undefined,
			clearIneligibilityForVendor: async () => undefined,
			sanitizeReasoningFields: (_modelIdentifier, fields) => ({ ...fields }),
		};
		const toolRuntimeService: IVSCloneToolRuntimeService = {
			_serviceBrand: undefined,
			listToolDefinitions: () => [],
			getToolDefinition: () => undefined,
			getApprovalType: () => undefined,
		};
		const toolExecutionService: IVSCloneToolExecutionService = {
			_serviceBrand: undefined,
			executeTool: async () => ({ success: false, output: 'unused' }),
		};
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
			// Runtime persistence now stamps the workspace id into the inlined payload so restore logic
			// can reject stale sidecars from a different workspace.
			getWorkspace: () => ({ id: 'test-workspace' }),
		} as Partial<IWorkspaceContextService> as IWorkspaceContextService;

		return testDisposables.add(new VSCloneThreadRuntimeService(
			oauthService,
			llmMessageService,
			convertToLLMMessageService,
			settingsService,
			toolRuntimeService,
			toolExecutionService,
			backendService,
			{} as IFileService,
			storageService,
			new NullLogService(),
			workspaceContextService,
		));
	}

	test('restores persisted runtime threads from the inlined workspace payload', () => {
		const testDisposables = store.add(new DisposableStore());
		const backendService = new TestVSCloneUnifiedChatBackendService();
		const runtimeStorage = new Map<string, string>();
		const firstRuntime = createService(testDisposables, backendService, runtimeStorage);

		firstRuntime.recordRejectedTurn({
			threadId: 'thread-restore',
			turnId: 'thread-restore:rejected:1',
			sessionResource: 'vsclone://api/thread-restore',
			promptText: 'Explain the codebase',
			mode: 'act',
			reason: 'Sign in first.',
		});

		const restoredRuntime = createService(testDisposables, backendService, runtimeStorage);
		const restoredState = restoredRuntime.getState('thread-restore');
		assert.ok(restoredState, 'expected the runtime thread to restore from storage');
		assert.strictEqual(restoredState?.catalog.threadId, 'thread-restore');
		assert.strictEqual(restoredState?.messages.length, 2);
		assert.strictEqual(restoredState?.messages[0].role, 'user');
		assert.strictEqual(restoredState?.messages[1].role, 'assistant');
	});

	test('drops malformed inlined runtime storage payloads instead of throwing during restore', () => {
		const testDisposables = store.add(new DisposableStore());
		const backendService = new TestVSCloneUnifiedChatBackendService();
		const runtimeStorage = new Map<string, string>([
			['vsclone.threadRuntime.v2', '{"schemaVersion":2,"states":{},"deletedThreadIds":[]}'],
		]);

		const runtimeService = createService(testDisposables, backendService, runtimeStorage);

		assert.deepStrictEqual(runtimeService.getThreads(), []);
		assert.strictEqual(runtimeStorage.has('vsclone.threadRuntime.v2'), false);
	});

	test('drops persisted runtime payloads from a different workspace', () => {
		const testDisposables = store.add(new DisposableStore());
		const backendService = new TestVSCloneUnifiedChatBackendService();
		const runtimeStorage = new Map<string, string>();
		const firstRuntime = createService(testDisposables, backendService, runtimeStorage);

		firstRuntime.recordRejectedTurn({
			threadId: 'thread-foreign-workspace',
			turnId: 'thread-foreign-workspace:rejected:1',
			sessionResource: 'vsclone://api/thread-foreign-workspace',
			promptText: 'Explain the codebase',
			mode: 'act',
			reason: 'Sign in first.',
		});

		const rawPersisted = runtimeStorage.get('vsclone.threadRuntime.v2');
		assert.ok(rawPersisted, 'expected a persisted runtime payload');
		const parsedPersisted = JSON.parse(rawPersisted!);
		parsedPersisted.workspaceId = 'different-workspace';
		runtimeStorage.set('vsclone.threadRuntime.v2', JSON.stringify(parsedPersisted));

		const restoredRuntime = createService(testDisposables, backendService, runtimeStorage);
		assert.deepStrictEqual(restoredRuntime.getThreads(), []);
		assert.strictEqual(runtimeStorage.has('vsclone.threadRuntime.v2'), false);
	});

	test('deleteThread also clears persisted selection and plan-mode sidecars', async () => {
		const testDisposables = store.add(new DisposableStore());
		const backendService = new TestVSCloneUnifiedChatBackendService();
		const runtimeService = createService(testDisposables, backendService);

		await backendService.replaceSelectionState({
			selectedByThread: {
				'thread-1': {
					chat: createThreadSelection('thread-1'),
				},
			},
			selectedByLocation: {},
			recentModelIdentifiers: ['openai/gpt-5.3-codex'],
		});
		await backendService.replacePlanModeState({
			modeByThread: {
				'thread-1': 'plan',
			},
		});
		runtimeService.recordRejectedTurn({
			threadId: 'thread-1',
			turnId: 'thread-1:rejected:1',
			sessionResource: 'vsclone://api/thread-1',
			promptText: 'Explain the codebase',
			mode: 'plan',
			reason: 'Sign in first.',
		});

		assert.strictEqual(runtimeService.deleteThread('thread-1'), true);
		await timeout(0);

		assert.deepStrictEqual(backendService.getSelectionState().selectedByThread, {});
		assert.deepStrictEqual(backendService.getPlanModeState().modeByThread, {});
	});

	test('clearAll also clears persisted sidecars for every thread', async () => {
		const testDisposables = store.add(new DisposableStore());
		const backendService = new TestVSCloneUnifiedChatBackendService();
		const runtimeService = createService(testDisposables, backendService);

		await backendService.replaceSelectionState({
			selectedByThread: {
				'thread-1': {
					chat: createThreadSelection('thread-1'),
				},
				'thread-2': {
					chat: createThreadSelection('thread-2'),
				},
			},
			selectedByLocation: {
				chat: createThreadSelection('thread-2'),
			},
			recentModelIdentifiers: ['openai/gpt-5.3-codex'],
		});
		await backendService.replacePlanModeState({
			modeByThread: {
				'thread-1': 'plan',
				'thread-2': 'act',
			},
		});
		runtimeService.recordRejectedTurn({
			threadId: 'thread-1',
			turnId: 'thread-1:rejected:1',
			sessionResource: 'vsclone://api/thread-1',
			promptText: 'Explain the codebase',
			mode: 'plan',
			reason: 'Sign in first.',
		});
		runtimeService.recordRejectedTurn({
			threadId: 'thread-2',
			turnId: 'thread-2:rejected:1',
			sessionResource: 'vsclone://api/thread-2',
			promptText: 'Fix the test',
			mode: 'act',
			reason: 'Sign in first.',
		});

		runtimeService.clearAll();
		await timeout(0);

		assert.deepStrictEqual(backendService.getSelectionState(), {
			selectedByThread: {},
			selectedByLocation: {},
			recentModelIdentifiers: [],
		});
		assert.deepStrictEqual(backendService.getPlanModeState(), {
			modeByThread: {},
		});
	});
});
