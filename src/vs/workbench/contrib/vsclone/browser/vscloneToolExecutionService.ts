/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IBulkEditService, ResourceTextEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { isFileMatch, ISearchService, resultIsMatch } from '../../../services/search/common/search.js';
import { formatToolResultWithDiff } from '../common/vscloneToolResultDiff.js';
import { resolveContentEdits, type IVSCloneParsedEdit, type IVSCloneResolvedContentEdit } from './vscloneEditApplicationService.js';

const maxReadChars = 100000;
const maxDirectoryEntries = 200;
const maxSearchMatches = 50;
const maxDiffPreviewLines = 220;
const maxDiffPreviewChars = 12000;

export interface IVSCloneToolExecutionResult {
	readonly success: boolean;
	readonly output: string;
}

export const IVSCloneToolExecutionService = createDecorator<IVSCloneToolExecutionService>('vscloneToolExecutionService');

export interface IVSCloneToolExecutionService {
	readonly _serviceBrand: undefined;
	executeTool(toolName: string, params: Record<string, string>): Promise<IVSCloneToolExecutionResult>;
}

interface IParsedSearchReplaceBlock {
	readonly searchText: string;
	readonly replaceText: string;
}

interface IWorkspacePathResolution {
	readonly uri: URI;
	readonly rawPath: string;
}

export class VSCloneToolExecutionService implements IVSCloneToolExecutionService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IModelService private readonly modelService: IModelService,
		@IEditorService private readonly editorService: IEditorService,
		@IBulkEditService private readonly bulkEditService: IBulkEditService,
		@ISearchService private readonly searchService: ISearchService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
	}

	async executeTool(toolName: string, params: Record<string, string>): Promise<IVSCloneToolExecutionResult> {
		const invocationLog = `[VSCloneToolExecution] Executing ${toolName} (${summarizeToolParams(params)})`;
		this.logService.info(invocationLog);
		console.info(invocationLog);
		try {
			switch (toolName) {
				case 'read_file':
					return this.executeReadFile(params);
				case 'list_directory':
					return this.executeListDirectory(params);
				case 'search_files':
					return this.executeSearchFiles(params);
				case 'edit_file':
					return this.executeEditFile(params);
				case 'create_file':
					return this.executeCreateFile(params);
				case 'attempt_completion':
					return {
						success: true,
						output: params.result?.trim() || 'Task complete.',
					};
				default:
					return {
						success: false,
						output: `Unknown tool: ${toolName}`,
					};
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logService.error('[VSCloneToolExecution] Tool execution failed', error);
			console.error('[VSCloneToolExecution] Tool execution failed', error);
			return {
				success: false,
				output: message,
			};
		}
	}

	private async executeReadFile(params: Record<string, string>): Promise<IVSCloneToolExecutionResult> {
		const path = params.path;
		if (!path) {
			return { success: false, output: 'Missing required parameter: path' };
		}

		const target = this.resolveWorkspacePath(path);
		if (!target) {
			return { success: false, output: this.invalidPathMessage(path) };
		}

		const stat = await this.safeResolve(target.uri);
		if (!stat) {
			return { success: false, output: `File not found: ${target.rawPath}` };
		}
		if (stat.isDirectory) {
			return { success: false, output: `Path is a directory, not a file: ${target.rawPath}` };
		}

		const content = await this.readFileContents(target.uri);
		const { text: boundedContent, truncatedChars } = truncateText(content, maxReadChars);
		const truncationNotice = truncatedChars > 0 ? `\n\n[truncated ${truncatedChars} characters]` : '';

		return {
			success: true,
			output: [
				`Contents of ${target.uri.toString()}:`,
				'```',
				boundedContent,
				'```',
				truncationNotice,
			].filter(Boolean).join('\n'),
		};
	}

	private async executeListDirectory(params: Record<string, string>): Promise<IVSCloneToolExecutionResult> {
		const path = params.path;
		if (!path) {
			return { success: false, output: 'Missing required parameter: path' };
		}

		const target = this.resolveWorkspacePath(path);
		if (!target) {
			return { success: false, output: this.invalidPathMessage(path) };
		}

		const recursive = toBoolean(params.recursive);
		const root = await this.safeResolve(target.uri);
		if (!root) {
			return { success: false, output: `Directory not found: ${target.rawPath}` };
		}
		if (!root.isDirectory) {
			return { success: false, output: `Path is a file, not a directory: ${target.rawPath}` };
		}

		const lines: string[] = [`Directory listing for ${target.uri.toString()}:`];
		const state = { count: 0, truncated: false };
		await this.appendDirectoryListing(root.resource, '', recursive, lines, state);
		if (state.truncated) {
			lines.push(`[truncated after ${maxDirectoryEntries} entries]`);
		}

		return {
			success: true,
			output: lines.join('\n'),
		};
	}

	private async executeSearchFiles(params: Record<string, string>): Promise<IVSCloneToolExecutionResult> {
		const path = params.path;
		const pattern = params.pattern;
		if (!path) {
			return { success: false, output: 'Missing required parameter: path' };
		}
		if (!pattern) {
			return { success: false, output: 'Missing required parameter: pattern' };
		}

		const target = this.resolveWorkspacePath(path);
		if (!target) {
			return { success: false, output: this.invalidPathMessage(path) };
		}

		const root = await this.safeResolve(target.uri);
		if (!root) {
			return { success: false, output: `Directory not found: ${target.rawPath}` };
		}
		if (!root.isDirectory) {
			return { success: false, output: `Path is a file, not a directory: ${target.rawPath}` };
		}

		const queryBuilder = this.instantiationService.createInstance(QueryBuilder);
		const textQuery = queryBuilder.text({
			pattern,
			isRegExp: true,
		}, [target.uri], {
			includePattern: params.file_glob ? params.file_glob : undefined,
			previewOptions: { matchLines: 1, charsPerLine: 160 },
			maxResults: maxSearchMatches,
		});

		const cts = new CancellationTokenSource();
		const lines: string[] = [];
		let matchCount = 0;
		let limited = false;

		try {
			await this.searchService.textSearch(textQuery, cts.token, item => {
				if (!isFileMatch(item) || !item.results || limited) {
					return;
				}

				for (const result of item.results) {
					if (!resultIsMatch(result)) {
						continue;
					}

					for (const location of result.rangeLocations) {
						if (matchCount >= maxSearchMatches) {
							limited = true;
							cts.cancel();
							break;
						}

						matchCount += 1;
						const preview = result.previewText.replace(/\s+/g, ' ').trim();
						lines.push(`${item.resource.toString()}:${location.source.startLineNumber}:${location.source.startColumn} ${preview}`);
					}

					if (limited) {
						break;
					}
				}
			});
		} catch (error) {
			// Cancellation is used intentionally to stop once we reach the configured result cap.
			if (!cts.token.isCancellationRequested) {
				throw error;
			}
		} finally {
			cts.dispose();
		}

		if (lines.length === 0) {
			return {
				success: true,
				output: `No matches found for pattern /${pattern}/ in ${target.uri.toString()}.`,
			};
		}

		const limitedNotice = limited ? `\n[limited to ${maxSearchMatches} matches]` : '';
		return {
			success: true,
			output: [
				`Found ${matchCount} match(es) in ${target.uri.toString()}:`,
				...lines,
				limitedNotice,
			].filter(Boolean).join('\n'),
		};
	}

	private async executeEditFile(params: Record<string, string>): Promise<IVSCloneToolExecutionResult> {
		const path = params.path;
		const changes = params.changes;
		if (!path) {
			return { success: false, output: 'Missing required parameter: path' };
		}
		if (!changes) {
			return { success: false, output: 'Missing required parameter: changes' };
		}

		const target = this.resolveWorkspacePath(path);
		if (!target) {
			return { success: false, output: this.invalidPathMessage(path) };
		}

		const stat = await this.safeResolve(target.uri);
		if (!stat) {
			return { success: false, output: `File not found: ${target.rawPath}` };
		}
		if (stat.isDirectory) {
			return { success: false, output: `Path is a directory, not a file: ${target.rawPath}` };
		}

		const parsedBlocks = parseSearchReplaceBlocks(changes);
		if (parsedBlocks.length === 0) {
			return { success: false, output: 'No SEARCH/REPLACE blocks found in changes parameter.' };
		}
		if (parsedBlocks.some(block => block.searchText.trim().length === 0)) {
			return { success: false, output: 'Empty SEARCH blocks are not allowed in edit_file. Use create_file for new files.' };
		}

		const content = await this.readFileContents(target.uri);
		const edits: IVSCloneParsedEdit[] = parsedBlocks.map((block, index) => ({
			filePath: target.uri.toString(),
			searchText: block.searchText,
			replaceText: block.replaceText,
			order: index,
		}));

		const resolved = resolveContentEdits(content, edits);
		if (resolved.failed.length > 0) {
			return {
				success: false,
				output: `One or more SEARCH blocks did not match ${target.uri.toString()}.`,
			};
		}

		const resourceEdits = [...resolved.resolved]
			.sort((left, right) => right.startOffset - left.startOffset)
			.map(edit => {
				const range = this.rangeFromOffsets(content, edit.startOffset, edit.endOffset);
				return new ResourceTextEdit(target.uri, {
					range,
					text: edit.replaceText,
				});
			});

		const applyResult = await this.bulkEditService.apply(resourceEdits, {
			label: 'VSClone tool: edit file',
		});
		if (!applyResult.isApplied) {
			return { success: false, output: 'Workspace edit was not applied.' };
		}

		await this.editorService.openEditor({ resource: target.uri });
		const markerCount = this.markerService.read({ resource: target.uri }).length;
		const diffPreview = this.buildEditFileDiffPreview(target.rawPath, content, resolved.resolved);
		return {
			success: true,
			output: formatToolResultWithDiff(
				`Applied ${resourceEdits.length} edit(s) to ${target.uri.toString()}. Current diagnostics on file: ${markerCount}.`,
				diffPreview,
			),
		};
	}

	private async executeCreateFile(params: Record<string, string>): Promise<IVSCloneToolExecutionResult> {
		const path = params.path;
		const content = params.content;
		if (!path) {
			return { success: false, output: 'Missing required parameter: path' };
		}
		if (content === undefined) {
			return { success: false, output: 'Missing required parameter: content' };
		}

		const target = this.resolveWorkspacePath(path);
		if (!target) {
			return { success: false, output: this.invalidPathMessage(path) };
		}

		if (await this.fileService.exists(target.uri)) {
			return { success: false, output: `File already exists: ${target.rawPath}` };
		}

		await this.fileService.createFolder(dirname(target.uri));
		await this.fileService.writeFile(target.uri, VSBuffer.fromString(content));
		await this.editorService.openEditor({ resource: target.uri });
		const diffPreview = this.buildCreateFileDiffPreview(target.rawPath, content);
		return {
			success: true,
			output: formatToolResultWithDiff(
				`Created file ${target.uri.toString()}.`,
				diffPreview,
			),
		};
	}

	private async appendDirectoryListing(
		root: URI,
		prefix: string,
		recursive: boolean,
		lines: string[],
		state: { count: number; truncated: boolean },
	): Promise<void> {
		if (state.truncated) {
			return;
		}

		const stat = await this.safeResolve(root);
		if (!stat?.children) {
			return;
		}

		const children = [...stat.children].sort((left, right) => {
			if (left.isDirectory !== right.isDirectory) {
				return left.isDirectory ? -1 : 1;
			}
			return left.name.localeCompare(right.name);
		});

		for (let index = 0; index < children.length; index++) {
			if (state.count >= maxDirectoryEntries) {
				state.truncated = true;
				return;
			}

			const child = children[index];
			const isLast = index === children.length - 1;
			const connector = isLast ? '`-- ' : '|-- ';
			lines.push(`${prefix}${connector}${child.name}${child.isDirectory ? '/' : ''}`);
			state.count += 1;

			if (recursive && child.isDirectory) {
				const childPrefix = `${prefix}${isLast ? '    ' : '|   '}`;
				await this.appendDirectoryListing(child.resource, childPrefix, recursive, lines, state);
				if (state.truncated) {
					return;
				}
			}
		}
	}

	private resolveWorkspacePath(rawPath: string): IWorkspacePathResolution | undefined {
		const normalizedPath = normalizePath(rawPath);
		if (!normalizedPath) {
			return undefined;
		}

		const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
		if (workspaceFolders.length === 0) {
			return undefined;
		}

		let candidate: URI | undefined;
		if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalizedPath)) {
			try {
				candidate = URI.parse(normalizedPath);
			} catch {
				candidate = undefined;
			}
		} else if (normalizedPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(normalizedPath)) {
			candidate = URI.file(normalizedPath);
		} else {
			const relativePath = normalizedPath.replace(/^\.\//, '');
			candidate = joinPath(workspaceFolders[0].uri, relativePath);
		}

		if (!candidate || !this.workspaceContextService.isInsideWorkspace(candidate)) {
			return undefined;
		}

		return { uri: candidate, rawPath: normalizedPath };
	}

	private async readFileContents(resource: URI): Promise<string> {
		// Open models include unsaved text; prefer them so edits/search operate on what the user sees.
		const openModel = this.modelService.getModel(resource);
		if (openModel) {
			return openModel.getValue();
		}

		const fileContents = await this.fileService.readFile(resource);
		return fileContents.value.toString();
	}

	private async safeResolve(resource: URI) {
		try {
			return await this.fileService.resolve(resource);
		} catch {
			return undefined;
		}
	}

	private rangeFromOffsets(content: string, startOffset: number, endOffset: number): Range {
		const start = positionAtOffset(content, startOffset);
		const end = positionAtOffset(content, endOffset);
		return new Range(start.lineNumber, start.column, end.lineNumber, end.column);
	}

	/**
	 * The preview only includes mutated hunks so transcript diffs stay compact enough to read
	 * while still exposing exactly what was replaced. We emit unified hunk headers with the
	 * modified start line so the chat transcript can navigate back to the applied location.
	 */
	private buildEditFileDiffPreview(rawPath: string, originalContent: string, edits: readonly IVSCloneResolvedContentEdit[]): string {
		const displayPath = toDiffDisplayPath(rawPath);
		const lines: string[] = [
			`--- a/${displayPath}`,
			`+++ b/${displayPath}`,
		];

		const ordered = [...edits].sort((left, right) => left.startOffset - right.startOffset);
		let modifiedLineDelta = 0;
		for (const edit of ordered) {
			const before = originalContent.slice(edit.startOffset, edit.endOffset);
			const beforeLines = splitLinesForDiff(before);
			const afterLines = splitLinesForDiff(edit.replaceText);
			const originalStart = positionAtOffset(originalContent, edit.startOffset);
			const originalLineCount = countDiffHunkLines(before);
			const modifiedLineCount = countDiffHunkLines(edit.replaceText);
			const modifiedStartLineNumber = Math.max(1, originalStart.lineNumber + modifiedLineDelta);
			lines.push(`@@ -${originalStart.lineNumber},${originalLineCount} +${modifiedStartLineNumber},${modifiedLineCount} @@`);
			for (const line of beforeLines) {
				lines.push(`-${line}`);
			}
			for (const line of afterLines) {
				lines.push(`+${line}`);
			}
			modifiedLineDelta += modifiedLineCount - originalLineCount;
		}

		return finalizeDiffPreview(lines);
	}

	/**
	 * New files are represented as a /dev/null diff so the UI can reuse the same renderer
	 * for both create_file and edit_file tool results.
	 */
	private buildCreateFileDiffPreview(rawPath: string, content: string): string {
		const displayPath = toDiffDisplayPath(rawPath);
		const addedLines = splitLinesForDiff(content);
		const lines: string[] = [
			'--- /dev/null',
			`+++ b/${displayPath}`,
			`@@ -0,0 +1,${addedLines.length} @@`,
			...addedLines.map(line => `+${line}`),
		];
		return finalizeDiffPreview(lines);
	}

	private invalidPathMessage(path: string): string {
		return `Invalid path '${path}'. Paths must resolve inside the current workspace.`;
	}
}

function parseSearchReplaceBlocks(changes: string): readonly IParsedSearchReplaceBlock[] {
	const normalized = changes.replace(/\r\n/g, '\n');
	const blockPattern = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
	const blocks: IParsedSearchReplaceBlock[] = [];
	let match: RegExpExecArray | null;

	while ((match = blockPattern.exec(normalized)) !== null) {
		blocks.push({
			searchText: match[1],
			replaceText: match[2],
		});
	}

	return blocks;
}

function normalizePath(rawPath: string): string {
	return rawPath.trim().replace(/^`+|`+$/g, '').replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
}

function toBoolean(value: string | undefined): boolean {
	if (!value) {
		return false;
	}
	const normalized = value.trim().toLowerCase();
	return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function summarizeToolParams(params: Record<string, string>): string {
	const maxSummaryLength = 160;
	const entries = Object.entries(params);
	if (entries.length === 0) {
		return 'no params';
	}

	const summary = entries.map(([key, value]) => `${key}=${truncateText(value, 48).text.replace(/\s+/g, ' ')}`).join(', ');
	if (summary.length <= maxSummaryLength) {
		return summary;
	}

	return `${summary.slice(0, maxSummaryLength)}...`;
}

function truncateText(value: string, maxChars: number): { text: string; truncatedChars: number } {
	if (value.length <= maxChars) {
		return { text: value, truncatedChars: 0 };
	}
	return {
		text: value.slice(0, maxChars),
		truncatedChars: value.length - maxChars,
	};
}

function splitLinesForDiff(value: string): readonly string[] {
	const normalized = value.replace(/\r\n/g, '\n');
	if (normalized.length === 0) {
		return [''];
	}
	const lines = normalized.split('\n');
	if (lines.length > 1 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

function toDiffDisplayPath(value: string): string {
	const normalized = value.replace(/\\/g, '/').trim();
	if (!normalized) {
		return 'unknown-path';
	}
	return normalized.startsWith('/') ? normalized.slice(1) : normalized;
}

/**
 * Unified hunk counts use 0 for empty replacements, but blank lines still count as a single line.
 */
function countDiffHunkLines(value: string): number {
	if (value.length === 0) {
		return 0;
	}

	return splitLinesForDiff(value).length;
}

function finalizeDiffPreview(lines: readonly string[]): string {
	let previewLines = [...lines];
	let truncated = false;
	if (previewLines.length > maxDiffPreviewLines) {
		previewLines = previewLines.slice(0, maxDiffPreviewLines);
		truncated = true;
	}

	let text = previewLines.join('\n');
	if (text.length > maxDiffPreviewChars) {
		text = text.slice(0, maxDiffPreviewChars);
		truncated = true;
	}

	return truncated ? `${text}\n... [diff truncated]` : text;
}

function positionAtOffset(content: string, offset: number): { lineNumber: number; column: number } {
	const boundedOffset = Math.max(0, Math.min(offset, content.length));
	let lineNumber = 1;
	let lineStartOffset = 0;

	for (let index = 0; index < boundedOffset; index++) {
		if (content.charCodeAt(index) === 10 /* \n */) {
			lineNumber += 1;
			lineStartOffset = index + 1;
		}
	}

	return {
		lineNumber,
		column: boundedOffset - lineStartOffset + 1,
	};
}
