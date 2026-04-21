/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IFileService } from '../../../../../platform/files/common/files.js';

/**
 * Minimal IFileService stub for VSClone tests that exercise prompt submission. The chat thread
 * service only touches the file service when the caller attaches `contextSelections`; tests that
 * don't pass selections never invoke any of these methods, so a Proxy that throws on access keeps
 * the surface honest without forcing every test to import the heavy file service helpers.
 */
export function createVSCloneTestFileService(): IFileService {
	const handler: ProxyHandler<object> = {
		get(_target, property) {
			throw new Error(`VSCloneTestFileService.${String(property)} was unexpectedly invoked. Tests that need a real file service should construct one explicitly.`);
		},
	};
	return new Proxy({}, handler) as IFileService;
}
