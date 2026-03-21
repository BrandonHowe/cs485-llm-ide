/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVSCloneCompletionPromptEnvelope } from '../vscloneCompletionTypes.js';
import type { IVSCloneModelSelection } from '../vscloneModelSelectionTypes.js';

export const VSCLONE_COMPLETION_CHANNEL_NAME = 'vsclone-completion';

export const VSCLONE_COMPLETION_COMMAND_SUBMIT = 'submit';
export const VSCLONE_COMPLETION_COMMAND_ABORT = 'abort';

export interface IVSCloneCompletionSubmitRequest {
	readonly requestId: string;
	readonly envelope: IVSCloneCompletionPromptEnvelope;
	readonly selection: IVSCloneModelSelection;
	readonly headers: Readonly<Record<string, string>>;
}

export interface IVSCloneCompletionAbortRequest {
	readonly requestId: string;
}

export interface IVSCloneCompletionSubmitResponse {
	readonly rawText: string | undefined;
}
