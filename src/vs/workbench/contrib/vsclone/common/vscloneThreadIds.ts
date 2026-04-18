/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hash } from '../../../../base/common/hash.js';

export function deriveVSCloneThreadId(sessionResource: string): string {
	// Thread ids still need to be deterministic across reloads and retries, but that behavior no
	// longer belongs to the deleted history model. Keep the hash-based derivation in a neutral
	// utility so runtime-first callers can reuse it without importing history-era ownership code.
	return `thread-${Math.abs(hash(sessionResource)).toString(16)}`;
}
