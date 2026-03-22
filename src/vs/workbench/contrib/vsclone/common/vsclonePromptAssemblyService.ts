/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PlatformToString, platform } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { VSCloneModelVendor } from './vscloneOAuthTypes.js';
import { type VSCloneChatMode } from './vsclonePlanModeTypes.js';
import { formatToolDefinitionsForPrompt } from './vscloneToolDefinitions.js';

const maxActiveFileChars = 8000;
const maxSystemMessageChars = 80000;

export interface IVSClonePromptContext {
	readonly activeFile?: {
		readonly uri: URI;
		readonly languageId: string;
		readonly content: string;
		readonly selection?: string;
		readonly selectionRange?: {
			readonly startLine: number;
			readonly endLine: number;
		};
	};
	readonly openFiles: readonly URI[];
	readonly workspaceFolders: readonly { name: string; uri: URI }[];
	readonly directoryTree: string;
	readonly diagnostics: readonly { uri: URI; message: string; severity: string; line: number }[];
}

export const IVSClonePromptAssemblyService = createDecorator<IVSClonePromptAssemblyService>('vsclonePromptAssemblyService');

export interface IVSClonePromptAssemblyService {
	readonly _serviceBrand: undefined;
	assembleSystemMessage(context: IVSClonePromptContext, vendor: VSCloneModelVendor, mode: VSCloneChatMode): string;
}

export class VSClonePromptAssemblyService implements IVSClonePromptAssemblyService {
	declare readonly _serviceBrand: undefined;

	assembleSystemMessage(context: IVSClonePromptContext, vendor: VSCloneModelVendor, mode: VSCloneChatMode): string {
		const workspaceNames = context.workspaceFolders.map(folder => folder.name).join(', ') || '(none)';
		const openFilesSection = context.openFiles.length > 0
			? context.openFiles.map(uri => `- ${uri.toString()}`).join('\n')
			: '- (none)';
		const diagnosticsSection = context.diagnostics.length > 0
			? context.diagnostics.map(diagnostic => `- ${diagnostic.uri.toString()}: line ${diagnostic.line}: ${diagnostic.severity}: ${diagnostic.message}`).join('\n')
			: '- (none)';

		const activeFileSection = this.formatActiveFileSection(context.activeFile);
		const instructionsSection = mode === 'plan'
			? [
				'## Instructions',
				'You are in PLAN MODE for this turn.',
				'Inspect the workspace, reason about the requested change, and then propose a concrete plan.',
				'Do not produce SEARCH/REPLACE execution blocks or otherwise attempt to modify files.',
				'Do not invent tool results or continue past a tool call. The runtime will execute tools and provide the real results.',
				'When you are done researching, finish with attempt_completion and summarize the implementation plan.',
			]
			: [
				'## Instructions',
				'When suggesting code changes, use SEARCH/REPLACE blocks with exact SEARCH matches.',
				'Use this exact shape:',
				'File: <path>',
				'<<<<<<< SEARCH',
				'<exact existing code>',
				'=======',
				'<replacement code>',
				'>>>>>>> REPLACE',
				'For new files, keep SEARCH empty and put full content in REPLACE.',
				'Do not invent tool results or continue past a tool call. The runtime will execute tools and provide the real results.',
			];
		const message = [
			'You are VSClone, an AI coding assistant integrated into a code editor.',
			mode === 'plan'
				? 'You have direct tool access to read, search, and list files inside the workspace for this read-only turn.'
				: 'You have direct tool access to read/search/list/edit/create files inside the workspace.',
			'Never ask the user to open, share, or paste files when a tool can fetch that information.',
			// The agent prompt is strongly workspace/tool oriented, so we must state the multimodal
			// contract explicitly or the model tends to incorrectly assume image-bearing turns arrived
			// as plain text only.
			'User turns may also include image attachments. Inspect attached images directly when they are present and use them as part of your answer.',
			'Do not claim that the current request was text-only unless no image attachments were provided or the runtime explicitly reports an image-processing failure.',
			'',
			'## System Information',
			`- Vendor: ${vendor}`,
			`- OS: ${PlatformToString(platform)}`,
			`- Workspace: ${workspaceNames}`,
			'',
			// Tool instructions are intentionally near the top so they survive context truncation.
			formatToolDefinitionsForPrompt(mode),
			'',
			'## Active File',
			activeFileSection,
			'',
			'## Open Files',
			openFilesSection,
			'',
			'## Workspace Structure',
			context.directoryTree || '(unavailable)',
			'',
			'## Diagnostics',
			diagnosticsSection,
			'',
			...instructionsSection,
		].join('\n');

		return this.truncateSystemMessage(message);
	}

	private formatActiveFileSection(activeFile: IVSClonePromptContext['activeFile']): string {
		if (!activeFile) {
			return '(no active text editor)';
		}

		const content = this.truncateActiveFileContent(activeFile.content, activeFile.selection, activeFile.selectionRange);
		const sections = [
			`File: ${activeFile.uri.toString()} (${activeFile.languageId})`,
			`\`\`\`${activeFile.languageId}`,
			content,
			'\`\`\`',
		];

		if (activeFile.selection && activeFile.selectionRange) {
			sections.push('', 'Selected Code:', `Lines ${activeFile.selectionRange.startLine}-${activeFile.selectionRange.endLine}:`, activeFile.selection);
		}

		return sections.join('\n');
	}

	private truncateActiveFileContent(
		content: string,
		selection: string | undefined,
		selectionRange: { startLine: number; endLine: number } | undefined,
	): string {
		if (content.length <= maxActiveFileChars) {
			return content;
		}

		let anchorStart = 0;
		let anchorEnd = 0;
		if (selection && selection.length > 0) {
			const selectionIndex = content.indexOf(selection);
			if (selectionIndex >= 0) {
				anchorStart = selectionIndex;
				anchorEnd = selectionIndex + selection.length;
			}
		}
		if (anchorStart === 0 && anchorEnd === 0 && selectionRange) {
			const startOffset = this.offsetAtLine(content, selectionRange.startLine);
			const endOffset = this.offsetAtLine(content, selectionRange.endLine + 1);
			anchorStart = startOffset;
			anchorEnd = Math.max(startOffset, endOffset);
		}

		const center = Math.floor((anchorStart + anchorEnd) / 2);
		const halfWindow = Math.floor(maxActiveFileChars / 2);
		let start = Math.max(0, center - halfWindow);
		const end = Math.min(content.length, start + maxActiveFileChars);

		if (end - start < maxActiveFileChars) {
			start = Math.max(0, end - maxActiveFileChars);
		}

		let chunk = content.slice(start, end);
		if (start > 0) {
			chunk = `... [truncated ${start} chars]\n${chunk}`;
		}
		if (end < content.length) {
			chunk = `${chunk}\n... [truncated ${content.length - end} chars]`;
		}

		return chunk;
	}

	private offsetAtLine(content: string, lineNumber: number): number {
		if (lineNumber <= 1) {
			return 0;
		}

		let line = 1;
		for (let offset = 0; offset < content.length; offset++) {
			if (content.charCodeAt(offset) === 10 /* \n */) {
				line += 1;
				if (line === lineNumber) {
					return offset + 1;
				}
			}
		}

		return content.length;
	}

	private truncateSystemMessage(message: string): string {
		if (message.length <= maxSystemMessageChars) {
			return message;
		}

		const tailNotice = '\n\n... [system context truncated to stay within budget]';
		const budget = Math.max(0, maxSystemMessageChars - tailNotice.length);
		return `${message.slice(0, budget)}${tailNotice}`;
	}
}
