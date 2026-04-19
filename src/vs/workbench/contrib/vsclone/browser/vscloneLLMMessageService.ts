/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Keep the browser import path stable while the implementation lives in `common`, because the
// service is pure IPC glue and needs to be reachable from both browser-layer production code and
// electron-main bridge tests without violating layer boundaries.
export {
	IVSCloneLLMMessageService,
	VSCloneLLMMessageService,
} from '../common/vscloneLLMMessageService.js';
