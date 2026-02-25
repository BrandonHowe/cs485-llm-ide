/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const VSCLONE_OAUTH_CHANNEL_NAME = 'vsclone-oauth';

export const VSCLONE_OAUTH_COMMAND_START_LOOPBACK = 'startLoopback';
export const VSCLONE_OAUTH_COMMAND_WAIT_FOR_LOOPBACK = 'waitForLoopback';
export const VSCLONE_OAUTH_COMMAND_STOP_LOOPBACK = 'stopLoopback';

export interface IVSCloneOAuthLoopbackStartRequest {
	readonly sessionId: string;
	readonly redirectUriTemplate: string;
	readonly preferredPort: number;
}

export interface IVSCloneOAuthLoopbackStartResponse {
	readonly redirectUri: string;
}

export interface IVSCloneOAuthLoopbackWaitRequest {
	readonly sessionId: string;
	readonly timeoutMs: number;
}

export interface IVSCloneOAuthLoopbackWaitResponse {
	readonly code: string;
	readonly state: string;
	readonly callbackUrl: string;
}

export interface IVSCloneOAuthLoopbackStopRequest {
	readonly sessionId: string;
}
