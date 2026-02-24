/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVSCloneApiSubmitOptions } from './vscloneChatApiAdapters.js';

export const VSCLONE_CHAT_API_CHANNEL_NAME = 'vsclone-chat-api';

// Keep command names centralized so browser and main process stay in lockstep.
export const VSCLONE_CHAT_API_COMMAND_SUBMIT = 'submit';
export const VSCLONE_CHAT_API_COMMAND_ABORT = 'abort';

// Stream events are keyed by requestId so multiple concurrent requests can share one channel.
export const VSCLONE_CHAT_API_EVENT_DELTA = 'onDelta';
export const VSCLONE_CHAT_API_EVENT_COMPLETE = 'onComplete';
export const VSCLONE_CHAT_API_EVENT_ERROR = 'onError';
export const VSCLONE_CHAT_API_EVENT_ABORTED = 'onAborted';

export interface IVSCloneChatApiSubmitRequest {
	readonly requestId: string;
	readonly options: IVSCloneApiSubmitOptions;
	readonly headers: Readonly<Record<string, string>>;
}

export interface IVSCloneChatApiAbortRequest {
	readonly requestId: string;
}

export interface IVSCloneChatApiDeltaEvent {
	readonly requestId: string;
	readonly text: string;
}

export interface IVSCloneChatApiCompleteEvent {
	readonly requestId: string;
}

export interface IVSCloneChatApiErrorEvent {
	readonly requestId: string;
	readonly message: string;
}

export interface IVSCloneChatApiAbortedEvent {
	readonly requestId: string;
}
