/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { VSClonePlanModeService } from '../../common/vsclonePlanModeService.js';
import { type IVSCloneModelSelection } from '../../common/vscloneModelSelectionTypes.js';
import { VSCloneSettingsService } from '../../common/vscloneSettingsService.js';
import { VSCloneUnifiedChatBackendService } from '../../common/backend/vscloneUnifiedChatBackendService.js';
import { TestVSCloneOAuthService } from '../common/vscloneTestOAuthService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';

function createSelection(location: IVSCloneModelSelection['location'], overrides: Partial<IVSCloneModelSelection> = {}): IVSCloneModelSelection {
	return {
		threadId: undefined,
		location,
		modelIdentifier: 'openai/gpt-5.3-codex',
		vendor: 'openai',
		modelId: 'gpt-5.3-codex',
		modelName: 'GPT-5.3-Codex',
		selectedAt: 1,
		...overrides,
	};
}

function createBackendService(
	testDisposables: DisposableStore,
	storageService: TestStorageService,
	workspaceId: string = 'vsclone-integration-workspace',
): VSCloneUnifiedChatBackendService {
	const instantiationService = testDisposables.add(new TestInstantiationService());
	const workspaceContextService = {
		// The real store stamps a workspace id into persisted payloads so restore logic can reject
		// copied state. The tests keep that guard active by using a stable synthetic workspace id.
		getWorkspace: () => ({ id: workspaceId }),
	} as Partial<IWorkspaceContextService> as IWorkspaceContextService;

	instantiationService.set(IStorageService, storageService);
	instantiationService.set(IWorkspaceContextService, workspaceContextService);
	instantiationService.set(ILogService, new NullLogService());

	return testDisposables.add(new VSCloneUnifiedChatBackendService(
		instantiationService,
		new TestConfigurationService(),
		new NullLogService(),
		new TestNotificationService(),
	));
}

suite('VSCloneUnifiedChatBackend integration', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('settings state resynchronizes when the real backend selection state changes after initialization', async () => {
		const testDisposables = store.add(new DisposableStore());
		const storageService = testDisposables.add(new TestStorageService());
		const backendService = createBackendService(testDisposables, storageService);
		const settingsService = testDisposables.add(new VSCloneSettingsService(
			storageService,
			new TestVSCloneOAuthService(),
			backendService,
		));

		await settingsService.initialize();
		await backendService.replaceSelectionState({
			selectedByThread: {
				'thread-1': {
					chat: createSelection('chat', {
						threadId: 'thread-1',
						modelIdentifier: 'openai/gpt-5.4-codex',
						modelId: 'gpt-5.4-codex',
						modelName: 'GPT-5.4-Codex',
						reasoningEffort: 'high',
						selectedAt: 11,
					}),
					editorInline: createSelection('editorInline', {
						threadId: 'thread-1',
						modelIdentifier: 'openai/gpt-5.3-codex-spark',
						modelId: 'gpt-5.3-codex-spark',
						modelName: 'GPT-5.3-Codex-Spark',
						reasoningEffort: 'lite',
						selectedAt: 12,
					}),
				},
			},
			selectedByLocation: {
				chat: createSelection('chat', {
					modelIdentifier: 'openai/gpt-5.3-codex',
					modelId: 'gpt-5.3-codex',
					modelName: 'GPT-5.3-Codex',
					selectedAt: 10,
				}),
			},
			recentModelIdentifiers: [
				'openai/gpt-5.4-codex',
				'openai/gpt-5.3-codex-spark',
			],
		});

		const state = settingsService.getState();
		assert.strictEqual(settingsService.getFeatureSelection('Chat')?.modelIdentifier, 'openai/gpt-5.3-codex');
		assert.strictEqual(state.threadSelections['thread-1']?.chat?.modelIdentifier, 'openai/gpt-5.4-codex');
		assert.strictEqual(state.threadSelections['thread-1']?.editorInline?.modelIdentifier, 'openai/gpt-5.3-codex-spark');
		assert.strictEqual(settingsService.getThreadSelectionSnapshot('thread-1', 'chat')?.selection.modelIdentifier, 'openai/gpt-5.4-codex');
		assert.strictEqual(settingsService.getThreadSelectionSnapshot('thread-1', 'editorInline')?.selection.modelIdentifier, 'openai/gpt-5.3-codex-spark');
		assert.deepStrictEqual(state.recentModelIdentifiers, [
			'openai/gpt-5.4-codex',
			'openai/gpt-5.3-codex-spark',
		]);
	});

	test('plan mode persists through the real backend store and restores in a fresh service instance', async () => {
		const testDisposables = store.add(new DisposableStore());
		const storageService = testDisposables.add(new TestStorageService());
		const firstBackendService = createBackendService(testDisposables, storageService, 'vsclone-plan-mode-workspace');
		const firstPlanModeService = testDisposables.add(new VSClonePlanModeService(firstBackendService));

		await firstPlanModeService.setModeForThread('thread-1', 'plan');

		const restoredBackendService = createBackendService(testDisposables, storageService, 'vsclone-plan-mode-workspace');
		const restoredPlanModeService = testDisposables.add(new VSClonePlanModeService(restoredBackendService));
		await restoredPlanModeService.initialize();

		assert.strictEqual(restoredPlanModeService.getModeForThread('thread-1'), 'plan');
		assert.deepStrictEqual(restoredBackendService.getPlanModeState(), {
			modeByThread: {
				'thread-1': 'plan',
			},
		});
	});
});
