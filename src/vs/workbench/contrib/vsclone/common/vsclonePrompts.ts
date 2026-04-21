/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VSCloneChatMode } from './vsclonePlanModeTypes.js';
import { PlatformToString, platform } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { type VSCloneModelVendor } from './vscloneOAuthTypes.js';
import { formatToolDefinitionsForPrompt } from './vscloneToolDefinitions.js';
import type { IVSCloneContextSelection } from './vscloneContextSelectionTypes.js';

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
		'For edit_file, the `changes` argument must contain only exact SEARCH/REPLACE blocks; never send prose, explanations, or summaries in that field.',
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

const maxCharsPerContextFile = 100_000;
const maxFolderEntries = 100;
const maxFilesPerFolderInline = 20;

function truncateFileContent(content: string): string {
	if (content.length <= maxCharsPerContextFile) {
		return content;
	}
	return `${content.slice(0, maxCharsPerContextFile)}\n... [file truncated]`;
}

async function readFileContentSafe(fileService: IFileService, uri: URI): Promise<string | undefined> {
	try {
		const fileContents = await fileService.readFile(uri);
		return fileContents.value.toString();
	} catch {
		return undefined;
	}
}

async function formatFileSelection(fileService: IFileService, uri: URI, languageId: string): Promise<string> {
	const content = await readFileContentSafe(fileService, uri);
	if (content === undefined) {
		return `${uri.fsPath}:\n(unable to read file)`;
	}
	return `${uri.fsPath}:\n\`\`\`${languageId}\n${truncateFileContent(content)}\n\`\`\``;
}

async function formatCodeSelection(fileService: IFileService, uri: URI, languageId: string, startLine: number, endLine: number): Promise<string> {
	const content = await readFileContentSafe(fileService, uri);
	if (content === undefined) {
		return `${uri.fsPath} (lines ${startLine}:${endLine}):\n(unable to read file)`;
	}
	const allLines = content.split(/\r\n|\r|\n/);
	const safeStart = Math.max(1, startLine);
	const safeEnd = Math.min(allLines.length, Math.max(safeStart, endLine));
	const snippet = allLines.slice(safeStart - 1, safeEnd).join('\n');
	return `${uri.fsPath} (lines ${safeStart}:${safeEnd}):\n\`\`\`${languageId}\n${snippet}\n\`\`\``;
}

async function formatFolderSelection(fileService: IFileService, uri: URI): Promise<string> {
	let rootStat;
	try {
		rootStat = await fileService.resolve(uri);
	} catch {
		return `${uri.fsPath}:\n(unable to read folder)`;
	}
	if (!rootStat.isDirectory || !rootStat.children) {
		return `${uri.fsPath}:\n(empty or not a folder)`;
	}

	const treeLines: string[] = [];
	let entryCount = 0;
	let truncated = false;

	const walk = async (children: readonly IFileStat[], prefix: string): Promise<void> => {
		const sorted = [...children].sort((left, right) => {
			if (left.isDirectory !== right.isDirectory) {
				return left.isDirectory ? -1 : 1;
			}
			return left.name.localeCompare(right.name);
		});
		for (let index = 0; index < sorted.length; index++) {
			if (entryCount >= maxFolderEntries) {
				truncated = true;
				return;
			}
			const child = sorted[index];
			const isLast = index === sorted.length - 1;
			const connector = isLast ? '`-- ' : '|-- ';
			treeLines.push(`${prefix}${connector}${child.name}${child.isDirectory ? '/' : ''}`);
			entryCount += 1;
			if (child.isDirectory && child.children) {
				const childPrefix = `${prefix}${isLast ? '    ' : '|   '}`;
				await walk(child.children, childPrefix);
				if (truncated) {
					return;
				}
			}
		}
	};

	await walk(rootStat.children, '');
	if (truncated) {
		treeLines.push('... [folder listing truncated]');
	}

	const fileChildren = rootStat.children.filter(c => !c.isDirectory).slice(0, maxFilesPerFolderInline);
	const inlineFileBlocks: string[] = [];
	for (const child of fileChildren) {
		const content = await readFileContentSafe(fileService, child.resource);
		if (content !== undefined) {
			inlineFileBlocks.push(`${child.resource.fsPath}:\n\`\`\`\n${truncateFileContent(content)}\n\`\`\``);
		}
	}

	const header = `${uri.fsPath} folder structure:\n\`\`\`\n${treeLines.join('\n')}\n\`\`\``;
	return inlineFileBlocks.length === 0 ? header : `${header}\n\n${inlineFileBlocks.join('\n\n')}`;
}

/**
 * Port of void's `messageOfSelection` - serializes user-picked context into a markdown block that
 * gets appended to the user message content. The LLM sees file paths, language-tagged code fences,
 * and a truncated folder tree so it can reason about the same material the user pinned in the UI.
 */
export async function formatContextSelections(
	selections: readonly IVSCloneContextSelection[] | undefined,
	fileService: IFileService,
): Promise<string> {
	if (!selections || selections.length === 0) {
		return '';
	}
	const blocks: string[] = [];
	for (const selection of selections) {
		if (selection.kind === 'file') {
			blocks.push(await formatFileSelection(fileService, selection.uri, selection.languageId));
		} else if (selection.kind === 'codeSelection') {
			blocks.push(await formatCodeSelection(fileService, selection.uri, selection.languageId, selection.startLine, selection.endLine));
		} else {
			blocks.push(await formatFolderSelection(fileService, selection.uri));
		}
	}
	return blocks.join('\n\n');
}

/**
 * Produces the final user-message content sent to the LLM. If there are no selections the original
 * instructions are returned unchanged so downstream replay code cannot regress on plain turns.
 */
export async function buildVSCloneUserMessageContent(
	instructions: string,
	selections: readonly IVSCloneContextSelection[] | undefined,
	fileService: IFileService,
): Promise<string> {
	const selectionsBlock = await formatContextSelections(selections, fileService);
	if (selectionsBlock.length === 0) {
		return instructions;
	}
	return `${instructions}\n---\nSELECTIONS\n${selectionsBlock}`;
}
