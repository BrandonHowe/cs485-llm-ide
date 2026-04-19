/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The transcript-to-provider conversion logic is DOM-free, so the common implementation is shared
// with electron-main tests while browser callers keep their existing import path.
export {
	IVSCloneConvertToLLMMessageService,
	VSCloneConvertToLLMMessageService,
} from '../common/vscloneConvertToLLMMessageService.js';
