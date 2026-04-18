/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSCloneThreadModelSelectionService } from '../../common/backend/vscloneThreadModelSelectionService.js';
import { VSCloneSettingsService } from '../../common/vscloneSettingsService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { TestVSCloneOAuthService } from './vscloneTestOAuthService.js';
import { TestVSCloneUnifiedChatBackendService } from './vscloneTestUnifiedChatBackendService.js';

suite('VSCloneThreadModelSelectionService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function createHarness() {
		const testDisposables = store.add(new DisposableStore());
		const storageService = testDisposables.add(new TestStorageService());
		const oauthService = new TestVSCloneOAuthService();
		const backendService = new TestVSCloneUnifiedChatBackendService();
		const settingsService = testDisposables.add(new VSCloneSettingsService(
			storageService,
			oauthService,
			backendService,
		));
		const selectionService = testDisposables.add(new VSCloneThreadModelSelectionService(settingsService));

		await settingsService.initialize();
		await selectionService.initialize();
		return { oauthService, settingsService, selectionService };
	}

	test('delegates per-thread selections to the settings owner', async () => {
		const { selectionService, settingsService } = await createHarness();
		const model = settingsService.getSelectableModels()[0];
		assert.ok(model);

		await selectionService.setSelectionForThread('thread-1', {
			threadId: 'thread-1',
			location: 'chat',
			modelIdentifier: model.identifier,
			vendor: model.vendor,
			modelId: model.modelId,
			modelName: model.modelName,
			selectedAt: Date.now(),
		});

		const current = selectionService.getCurrentSelectionForThread('thread-1', 'chat');
		const threadChatSelection = settingsService.getState().threadSelections['thread-1']?.chat;
		assert.strictEqual(current?.modelIdentifier, model.identifier);
		assert.strictEqual(threadChatSelection?.modelIdentifier, model.identifier);
	});

	test('prefers Codex Spark for editor-inline fallback selection', async () => {
		const { selectionService } = await createHarness();

		const current = selectionService.getCurrentSelectionForThread('', 'editorInline');
		assert.ok(current);
		assert.strictEqual(current?.modelIdentifier, 'openai/gpt-5.3-codex-spark');
		assert.strictEqual(current?.reasoningEffort, 'lite');
	});

	test('preserves thread snapshots after provider availability changes', async () => {
		const { oauthService, selectionService, settingsService } = await createHarness();
		oauthService.setReady('google', true);
		await settingsService.refreshState();

		const googleModel = settingsService.getModels('google')[0];
		assert.ok(googleModel);
		await selectionService.setSelectionForThread('thread-1', {
			threadId: 'thread-1',
			location: 'chat',
			modelIdentifier: googleModel.identifier,
			vendor: googleModel.vendor,
			modelId: googleModel.modelId,
			modelName: googleModel.modelName,
			selectedAt: Date.now(),
		});

		oauthService.setReady('google', false);
		await settingsService.refreshState();

		const current = selectionService.getCurrentSelectionForThread('thread-1', 'chat');
		assert.ok(current);
		assert.strictEqual(current?.modelIdentifier, googleModel.identifier);
	});

	test('recent identifiers and reset are forwarded through the compatibility adapter', async () => {
		const { selectionService, settingsService } = await createHarness();
		const models = settingsService.getSelectableModels();
		assert.ok(models.length >= 2);

		await selectionService.setSelectionForThread('thread-1', {
			threadId: 'thread-1',
			location: 'chat',
			modelIdentifier: models[0].identifier,
			vendor: models[0].vendor,
			modelId: models[0].modelId,
			modelName: models[0].modelName,
			selectedAt: Date.now(),
		});
		await selectionService.setSelectionForThread('thread-1', {
			threadId: 'thread-1',
			location: 'chat',
			modelIdentifier: models[1].identifier,
			vendor: models[1].vendor,
			modelId: models[1].modelId,
			modelName: models[1].modelName,
			selectedAt: Date.now(),
		});

		assert.deepStrictEqual(selectionService.getRecentModelIdentifiers(2), [models[1].identifier, models[0].identifier]);
		assert.strictEqual(selectionService.hasSelectionForThread('thread-1'), true);

		await selectionService.resetSelectionForThread('thread-1');

		assert.strictEqual(selectionService.hasSelectionForThread('thread-1'), false);
		assert.ok(selectionService.getCurrentSelectionForThread('thread-1', 'chat'));
	});
});
