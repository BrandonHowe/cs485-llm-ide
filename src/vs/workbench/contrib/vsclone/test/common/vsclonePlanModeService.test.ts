/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSClonePlanModeService } from '../../common/vsclonePlanModeService.js';
import { TestVSCloneUnifiedChatBackendService } from './vscloneTestUnifiedChatBackendService.js';

suite('VSClonePlanModeService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('tracks unsaved composer mode separately from thread mode', async () => {
		const backendService = new TestVSCloneUnifiedChatBackendService();
		const service = store.add(new VSClonePlanModeService(backendService));

		assert.strictEqual(service.getModeForThread(undefined), 'act');
		await service.setModeForThread(undefined, 'plan');
		assert.strictEqual(service.getModeForThread(undefined), 'plan');
		assert.strictEqual(service.getModeForThread('thread-1'), 'act');
	});

	test('persists mode for saved threads through the unified backend', async () => {
		const backendService = new TestVSCloneUnifiedChatBackendService();
		const service = store.add(new VSClonePlanModeService(backendService));

		await service.setModeForThread('thread-1', 'plan');
		assert.strictEqual(service.getModeForThread('thread-1'), 'plan');
		assert.deepStrictEqual(backendService.getPlanModeState(), {
			modeByThread: { 'thread-1': 'plan' },
		});
	});

	test('checks tool allowance against the active chat mode policy', () => {
		const backendService = new TestVSCloneUnifiedChatBackendService();
		const service = store.add(new VSClonePlanModeService(backendService));

		assert.strictEqual(service.isToolAllowed('plan', 'read_file'), true);
		assert.strictEqual(service.isToolAllowed('plan', 'edit_file'), false);
		assert.strictEqual(service.isToolAllowed('act', 'edit_file'), true);
	});
});
