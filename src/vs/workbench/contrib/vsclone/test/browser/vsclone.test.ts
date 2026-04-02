/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSCloneViewContainerId, VSCloneViewId } from '../../browser/vsclone.js';

suite('VSClone', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('exports the expected view identifiers', () => {
		assert.strictEqual(VSCloneViewContainerId, 'workbench.view.vsclone');
		assert.strictEqual(VSCloneViewId, 'workbench.view.vsclone.view');
	});
});
