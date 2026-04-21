/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

/**
 * User-picked context attached to a chat message via the composer `@` picker or the "Add Code
 * Selection" affordance. Selections are persisted on the transport/runtime user message alongside
 * the user's instructions so the sidebar can re-render context chips on reload without reparsing
 * the serialized prompt.
 */
export type IVSCloneContextSelection =
	| {
		readonly kind: 'file';
		readonly uri: URI;
		readonly languageId: string;
	}
	| {
		readonly kind: 'folder';
		readonly uri: URI;
	}
	| {
		readonly kind: 'codeSelection';
		readonly uri: URI;
		readonly languageId: string;
		readonly startLine: number;
		readonly endLine: number;
	};
