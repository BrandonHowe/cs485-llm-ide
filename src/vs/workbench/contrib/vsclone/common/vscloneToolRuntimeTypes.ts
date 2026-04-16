/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

/**
 * Tool approvals stay intentionally coarse because the future thread runtime needs a small,
 * stable set of policy buckets rather than per-tool special cases.
 */
export type VSCloneToolApprovalType = 'edits' | 'terminal' | 'MCP tools';

export const VSCLONE_TOOL_APPROVAL_TYPES = ['edits', 'terminal', 'MCP tools'] as const satisfies readonly VSCloneToolApprovalType[];

export const VSCLONE_TOOL_APPROVAL_TYPE_SET = new Set<VSCloneToolApprovalType>(VSCLONE_TOOL_APPROVAL_TYPES);

/**
 * Terminal runs report either a structured exit or a timeout. Keeping the reason explicit lets
 * later workflow code distinguish "command finished" from "the shell is still running".
 */
export type VSCloneTerminalResolveReason =
	| { readonly type: 'timeout' }
	| { readonly type: 'done'; readonly exitCode: number };

/**
 * Directory listings only need the narrow subset of file stat information that the tool runtime
 * renders in prompts and structured tool outputs.
 */
export interface IVSCloneShallowDirectoryItem {
	readonly uri: URI;
	readonly name: string;
	readonly isDirectory: boolean;
	readonly isSymbolicLink: boolean;
}

export interface IVSCloneToolParameterDefinition {
	readonly name: string;
	readonly required: boolean;
	readonly description: string;
}

export interface IVSCloneToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly approvalType?: VSCloneToolApprovalType;
	readonly planModeAllowed: boolean;
	readonly parameters: readonly IVSCloneToolParameterDefinition[];
}

export interface IVSCloneToolResultPayload {
	readonly success: boolean;
	readonly output: string;
}
