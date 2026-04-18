/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VSCloneChatMode } from './vsclonePlanModeTypes.js';
import { PlatformToString, platform } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { type VSCloneModelVendor } from './vscloneOAuthTypes.js';
import { formatToolDefinitionsForPrompt } from './vscloneToolDefinitions.js';

/**
 * Phase 3 keeps the system prompt intentionally small and static. The runtime should discover the
 * repository lazily through tools instead of re-serializing workspace structure into every turn.
 * Centralizing the remaining copy here makes that ownership explicit and keeps prompt policy from
 * drifting across multiple browser/common services.
 */
export const VSCLONE_BASE_SYSTEM_PROMPT_LINES: readonly string[] = [
	'You are VSClone, an AI coding assistant integrated into a code editor.',
	'Use tools to inspect the workspace instead of asking the user to open, share, or paste files.',
	'The runtime will execute tools and provide the real results. Never invent tool outputs yourself.',
	'User turns may also include image attachments. Inspect attached images directly when they are present and use them as part of your answer.',
	'Do not claim that the current request was text-only unless no image attachments were provided or the runtime explicitly reports an image-processing failure.',
];

const maxSelectionPreviewChars = 2_000;

export interface IVSClonePromptActiveFileContext {
	readonly uri: URI;
	readonly languageId: string;
	readonly content: string;
	readonly selection?: string;
	readonly selectionRange?: {
		readonly startLine: number;
		readonly endLine: number;
	};
}

/**
 * Phase 3 stops serializing repo-wide state into every system message. The prompt context now
 * carries only the active editor summary that still belongs in the system prompt instead of a
 * large compatibility envelope for open tabs, directory trees, or diagnostics dumps.
 */
export interface IVSClonePromptContext {
	readonly activeFile?: IVSClonePromptActiveFileContext;
}

export function getVSCloneSystemInformationSection(vendor: VSCloneModelVendor): readonly string[] {
	return [
		'## System Information',
		`- Vendor: ${vendor}`,
		`- OS: ${PlatformToString(platform)}`,
	];
}

export function getVSCloneActiveFileSection(activeFile: IVSClonePromptActiveFileContext | undefined): readonly string[] {
	if (!activeFile) {
		return [
			'## Active File',
			'(no active text editor; use tools to inspect the relevant files)',
		];
	}

	const lineCount = countLines(activeFile.content);
	const lines = [
		'## Active File',
		`File: ${activeFile.uri.toString()} (${activeFile.languageId})`,
		`Summary: ${lineCount} line(s), ${activeFile.content.length} char(s).`,
	];

	if (activeFile.selection && activeFile.selectionRange) {
		lines.push(
			`Selection: lines ${activeFile.selectionRange.startLine}-${activeFile.selectionRange.endLine} (${activeFile.selection.length} char(s)).`,
			'Selected Code:',
			`\`\`\`${activeFile.languageId}`,
			truncateSelectionPreview(activeFile.selection),
			'\`\`\`',
		);
	} else if (activeFile.selectionRange) {
		// Even without selected text, the cursor line is a stable hint about where the user is focused.
		lines.push(`Cursor: line ${activeFile.selectionRange.startLine}.`);
	}

	return lines;
}

export function getVSCloneTurnPolicySection(mode: VSCloneChatMode): readonly string[] {
	if (mode === 'plan') {
		return [
			'## Turn Policy',
			'PLAN MODE',
			'This turn is read-only.',
			'Inspect the workspace with tools, reason about the requested change, and finish with attempt_completion once you have a concrete plan.',
			'Do not produce executable SEARCH/REPLACE edits in this mode.',
		];
	}

	return [
		'## Turn Policy',
		'You may inspect and modify the workspace with tools during this turn.',
		'Use SEARCH/REPLACE edit blocks only when calling edit_file.',
		'For new files, use create_file with the full file contents.',
	];
}

/**
 * Prompt assembly lives in the prompt module now that the service layer no longer adds dynamic
 * repo-wide context. Keeping the composition here makes the final system-message shape a pure
 * function of prompt context, vendor, and turn mode.
 */
export function assembleVSCloneSystemMessage(
	context: IVSClonePromptContext,
	vendor: VSCloneModelVendor,
	mode: VSCloneChatMode,
): string {
	return [
		...VSCLONE_BASE_SYSTEM_PROMPT_LINES,
		'',
		...getVSCloneSystemInformationSection(vendor),
		'',
		formatToolDefinitionsForPrompt(mode),
		'',
		...getVSCloneActiveFileSection(context.activeFile),
		'',
		...getVSCloneTurnPolicySection(mode),
	].join('\n');
}

function countLines(content: string): number {
	if (content.length === 0) {
		return 0;
	}

	return content.split(/\r\n|\r|\n/).length;
}

function truncateSelectionPreview(selection: string): string {
	if (selection.length <= maxSelectionPreviewChars) {
		return selection;
	}

	return `${selection.slice(0, maxSelectionPreviewChars)}\n... [selection truncated]`;
}
