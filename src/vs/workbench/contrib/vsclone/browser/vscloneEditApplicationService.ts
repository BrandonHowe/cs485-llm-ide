/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IBulkEditService, ResourceFileEdit, ResourceTextEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

export interface IVSCloneParsedEdit {
	readonly filePath: string;
	readonly searchText: string;
	readonly replaceText: string;
	readonly order: number;
}

export interface IVSCloneResolvedContentEdit {
	readonly startOffset: number;
	readonly endOffset: number;
	readonly replaceText: string;
	readonly source: IVSCloneParsedEdit;
}

export interface IVSCloneEditApplyResult {
	readonly attemptedEdits: number;
	readonly appliedEdits: number;
	readonly modifiedFiles: readonly URI[];
	readonly failures: readonly string[];
	/**
	 * Per-file metadata describing what changed during the apply. This powers the post-apply
	 * summary UI (file rows + line stats) and supplies the original content snapshots needed
	 * to undo each change.
	 */
	readonly fileChanges: readonly IVSCloneEditFileChange[];
}

export interface IVSCloneEditFileChange {
	readonly uri: URI;
	readonly displayPath: string;
	readonly addedLines: number;
	readonly removedLines: number;
	readonly action: 'create' | 'modify';
	/**
	 * The full content of the file before the edit ran. Undefined for files that were created by
	 * the apply operation, since the undo path for those is a delete instead of a write-back.
	 */
	readonly originalContent: string | undefined;
}

export function parseSearchReplaceBlocks(responseText: string): readonly IVSCloneParsedEdit[] {
	const normalized = responseText.replace(/\r\n/g, '\n');
	const blockPattern = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
	const edits: IVSCloneParsedEdit[] = [];

	let match: RegExpExecArray | null;
	while ((match = blockPattern.exec(normalized)) !== null) {
		const filePath = findNearestFilePathLine(normalized, match.index);
		if (!filePath) {
			continue;
		}

		edits.push({
			filePath,
			searchText: match[1],
			replaceText: match[2],
			order: edits.length,
		});
	}

	return edits;
}

export function resolveContentEdits(content: string, edits: readonly IVSCloneParsedEdit[]): {
	readonly resolved: readonly IVSCloneResolvedContentEdit[];
	readonly failed: readonly IVSCloneParsedEdit[];
} {
	const resolved: IVSCloneResolvedContentEdit[] = [];
	const failed: IVSCloneParsedEdit[] = [];

	for (const edit of edits) {
		const exactStart = content.indexOf(edit.searchText);
		if (exactStart >= 0) {
			resolved.push({
				startOffset: exactStart,
				endOffset: exactStart + edit.searchText.length,
				replaceText: edit.replaceText,
				source: edit,
			});
			continue;
		}

		const fallbackRange = resolveWhitespaceInsensitiveRange(content, edit.searchText);
		if (fallbackRange) {
			resolved.push({
				startOffset: fallbackRange.startOffset,
				endOffset: fallbackRange.endOffset,
				replaceText: edit.replaceText,
				source: edit,
			});
			continue;
		}

		failed.push(edit);
	}

	return { resolved, failed };
}

export function applyResolvedEditsInReverse(content: string, edits: readonly IVSCloneResolvedContentEdit[]): string {
	let next = content;
	for (const edit of [...edits].sort((left, right) => right.startOffset - left.startOffset)) {
		next = `${next.slice(0, edit.startOffset)}${edit.replaceText}${next.slice(edit.endOffset)}`;
	}
	return next;
}

export const IVSCloneEditApplicationService = createDecorator<IVSCloneEditApplicationService>('vscloneEditApplicationService');

export interface IVSCloneEditApplicationService {
	readonly _serviceBrand: undefined;
	hasSearchReplaceBlocks(responseText: string): boolean;
	parseSearchReplaceBlocks(responseText: string): readonly IVSCloneParsedEdit[];
	applySearchReplaceBlocks(responseText: string): Promise<IVSCloneEditApplyResult>;
	undoEditApply(fileChanges: readonly IVSCloneEditFileChange[]): Promise<IVSCloneEditUndoResult>;
}

export interface IVSCloneEditUndoResult {
	readonly revertedFiles: readonly URI[];
	readonly failures: readonly string[];
}

export class VSCloneEditApplicationService implements IVSCloneEditApplicationService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IBulkEditService private readonly bulkEditService: IBulkEditService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@IEditorService private readonly editorService: IEditorService,
	) {
	}

	hasSearchReplaceBlocks(responseText: string): boolean {
		return this.parseSearchReplaceBlocks(responseText).length > 0;
	}

	parseSearchReplaceBlocks(responseText: string): readonly IVSCloneParsedEdit[] {
		return parseSearchReplaceBlocks(responseText);
	}

	async applySearchReplaceBlocks(responseText: string): Promise<IVSCloneEditApplyResult> {
		const parsedEdits = this.parseSearchReplaceBlocks(responseText);
		if (parsedEdits.length === 0) {
			return {
				attemptedEdits: 0,
				appliedEdits: 0,
				modifiedFiles: [],
				failures: ['No SEARCH/REPLACE blocks were found.'],
				fileChanges: [],
			};
		}

		const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
		const failures: string[] = [];
		const groupedByTarget = new Map<string, { uri: URI; edits: IVSCloneParsedEdit[] }>();

		for (const edit of parsedEdits) {
			const uri = await this.resolveEditTargetUri(edit.filePath, workspaceFolders.map(folder => folder.uri));
			if (!uri) {
				failures.push(`Could not resolve file path: ${edit.filePath}`);
				continue;
			}

			const key = uri.toString();
			const grouped = groupedByTarget.get(key);
			if (grouped) {
				grouped.edits.push(edit);
			} else {
				groupedByTarget.set(key, { uri, edits: [edit] });
			}
		}

		const resourceEdits: (ResourceTextEdit | ResourceFileEdit)[] = [];
		const modifiedFiles: URI[] = [];
		const pendingFileChanges = new Map<string, IVSCloneEditFileChange>();
		let appliedEdits = 0;

		for (const { uri, edits } of groupedByTarget.values()) {
			const creationEdits = edits.filter(edit => edit.searchText.trim().length === 0);
			const replacementEdits = edits.filter(edit => edit.searchText.trim().length > 0);

			if (creationEdits.length > 0) {
				const exists = await this.safeExists(uri);
				if (exists) {
					failures.push(`Refused to create ${uri.toString()} because the file already exists.`);
					continue;
				}

				// Empty SEARCH means a new file in this protocol, so we create with REPLACE as the full content.
				const createEdit = creationEdits[0];
				resourceEdits.push(new ResourceFileEdit(undefined, uri, {
					overwrite: false,
					ignoreIfExists: true,
					contents: Promise.resolve(VSBuffer.fromString(createEdit.replaceText)),
				}));
				modifiedFiles.push(uri);
				pendingFileChanges.set(uri.toString(), {
					uri,
					displayPath: this.deriveDisplayPath(uri, workspaceFolders.map(folder => folder.uri)),
					addedLines: countLines(createEdit.replaceText),
					removedLines: 0,
					action: 'create',
					originalContent: undefined,
				});
				appliedEdits += 1;

				if (creationEdits.length > 1) {
					failures.push(`Multiple create-file blocks target ${uri.toString()}; only the first block was used.`);
				}
				if (replacementEdits.length > 0) {
					failures.push(`Skipped replacement edits for ${uri.toString()} because create-file syntax was also present.`);
				}
				continue;
			}

			let modelReference;
			try {
				modelReference = await this.textModelService.createModelReference(uri);
			} catch {
				failures.push(`Could not open ${uri.toString()} for editing.`);
				continue;
			}

			try {
				const model = modelReference.object.textEditorModel;
				const originalContent = model.getValue();
				const { resolved, failed } = resolveContentEdits(originalContent, replacementEdits);
				for (const failedEdit of failed) {
					failures.push(`SEARCH block did not match in ${uri.toString()}: ${trimForError(failedEdit.searchText)}`);
				}

				const ordered = [...resolved].sort((left, right) => right.startOffset - left.startOffset);
				let addedLines = 0;
				let removedLines = 0;
				for (const resolvedEdit of ordered) {
					const start = model.getPositionAt(resolvedEdit.startOffset);
					const end = model.getPositionAt(resolvedEdit.endOffset);
					resourceEdits.push(new ResourceTextEdit(uri, {
						range: new Range(start.lineNumber, start.column, end.lineNumber, end.column),
						text: resolvedEdit.replaceText,
					}));
					removedLines += countLines(originalContent.slice(resolvedEdit.startOffset, resolvedEdit.endOffset));
					addedLines += countLines(resolvedEdit.replaceText);
				}

				if (ordered.length > 0) {
					modifiedFiles.push(uri);
					pendingFileChanges.set(uri.toString(), {
						uri,
						displayPath: this.deriveDisplayPath(uri, workspaceFolders.map(folder => folder.uri)),
						addedLines,
						removedLines,
						action: 'modify',
						// Snapshot the pre-edit text so the UI can offer an undo that restores the
						// exact prior state, even if the user has typed in the file since the apply.
						originalContent,
					});
					appliedEdits += ordered.length;
				}
			} finally {
				modelReference.dispose();
			}
		}

		if (resourceEdits.length === 0) {
			return {
				attemptedEdits: parsedEdits.length,
				appliedEdits: 0,
				modifiedFiles: [],
				failures,
				fileChanges: [],
			};
		}

		const applyResult = await this.bulkEditService.apply(resourceEdits, {
			label: 'Apply VSClone suggested changes',
		});

		if (!applyResult.isApplied) {
			return {
				attemptedEdits: parsedEdits.length,
				appliedEdits: 0,
				modifiedFiles: [],
				failures: [...failures, 'Workspace edit was not applied.'],
				fileChanges: [],
			};
		}

		if (modifiedFiles.length > 0) {
			await this.editorService.openEditor({ resource: modifiedFiles[0] });
		}

		return {
			attemptedEdits: parsedEdits.length,
			appliedEdits,
			modifiedFiles,
			failures,
			fileChanges: [...pendingFileChanges.values()],
		};
	}

	async undoEditApply(fileChanges: readonly IVSCloneEditFileChange[]): Promise<IVSCloneEditUndoResult> {
		const revertedFiles: URI[] = [];
		const failures: string[] = [];
		const resourceEdits: (ResourceTextEdit | ResourceFileEdit)[] = [];

		for (const change of fileChanges) {
			if (change.action === 'create') {
				// Files conjured by an edit apply are reverted by deleting them outright; the apply
				// path explicitly refused to overwrite an existing file, so the user could not have
				// pre-existing content to preserve here.
				resourceEdits.push(new ResourceFileEdit(change.uri, undefined, {
					ignoreIfNotExists: true,
				}));
				revertedFiles.push(change.uri);
				continue;
			}

			if (change.originalContent === undefined) {
				failures.push(`No original snapshot recorded for ${change.uri.toString()}`);
				continue;
			}

			let modelReference;
			try {
				modelReference = await this.textModelService.createModelReference(change.uri);
			} catch {
				failures.push(`Could not open ${change.uri.toString()} to undo the change.`);
				continue;
			}

			try {
				const model = modelReference.object.textEditorModel;
				const lineCount = model.getLineCount();
				const lastLineLength = model.getLineMaxColumn(lineCount);
				resourceEdits.push(new ResourceTextEdit(change.uri, {
					range: new Range(1, 1, lineCount, lastLineLength),
					text: change.originalContent,
				}));
				revertedFiles.push(change.uri);
			} finally {
				modelReference.dispose();
			}
		}

		if (resourceEdits.length === 0) {
			return { revertedFiles: [], failures };
		}

		const applyResult = await this.bulkEditService.apply(resourceEdits, {
			label: 'Undo VSClone suggested changes',
		});
		if (!applyResult.isApplied) {
			return {
				revertedFiles: [],
				failures: [...failures, 'Workspace undo edit was not applied.'],
			};
		}

		return { revertedFiles, failures };
	}

	private deriveDisplayPath(uri: URI, workspaceFolderUris: readonly URI[]): string {
		for (const folderUri of workspaceFolderUris) {
			const folderPath = folderUri.path.endsWith('/') ? folderUri.path : `${folderUri.path}/`;
			if (uri.path.startsWith(folderPath)) {
				return uri.path.slice(folderPath.length);
			}
		}
		const segments = uri.path.split('/').filter(Boolean);
		return segments[segments.length - 1] ?? uri.toString();
	}

	private async resolveEditTargetUri(filePath: string, workspaceFolderUris: readonly URI[]): Promise<URI | undefined> {
		const normalizedPath = normalizeFilePath(filePath);
		if (!normalizedPath) {
			return undefined;
		}

		if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(normalizedPath)) {
			try {
				return URI.parse(normalizedPath);
			} catch {
				return undefined;
			}
		}

		if (normalizedPath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(normalizedPath)) {
			return URI.file(normalizedPath);
		}

		if (workspaceFolderUris.length === 0) {
			return undefined;
		}

		const relativePath = normalizedPath.replace(/^\.\//, '');
		for (const folderUri of workspaceFolderUris) {
			const candidate = joinPath(folderUri, relativePath);
			if (await this.safeExists(candidate)) {
				return candidate;
			}
		}

		// If no existing file matches, we still target the first workspace folder to allow create-file edits.
		return joinPath(workspaceFolderUris[0], relativePath);
	}

	private async safeExists(resource: URI): Promise<boolean> {
		try {
			return await this.fileService.exists(resource);
		} catch {
			return false;
		}
	}
}

function findNearestFilePathLine(text: string, beforeOffset: number): string | undefined {
	const prefixLines = text.slice(0, beforeOffset).split('\n');
	for (let index = prefixLines.length - 1; index >= 0; index--) {
		const line = prefixLines[index].trim();
		if (!line) {
			continue;
		}

		const fileMatch = line.match(/^File:\s*(.+)$/i) ?? line.match(/^[*-]\s*File:\s*(.+)$/i);
		if (fileMatch) {
			return normalizeFilePath(fileMatch[1]);
		}
	}

	return undefined;
}

function normalizeFilePath(rawPath: string): string {
	return rawPath.trim().replace(/^`+|`+$/g, '').replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
}

function resolveWhitespaceInsensitiveRange(content: string, searchText: string): { startOffset: number; endOffset: number } | undefined {
	const normalizedSearchText = searchText.replace(/\r\n/g, '\n');
	const searchLines = normalizedSearchText.split('\n');
	while (searchLines.length > 0 && searchLines[searchLines.length - 1] === '') {
		searchLines.pop();
	}
	if (searchLines.length === 0) {
		return undefined;
	}

	const contentLines = content.replace(/\r\n/g, '\n').split('\n');
	const lineOffsets = computeLineOffsets(content.replace(/\r\n/g, '\n'));
	const normalizedSearchLines = searchLines.map(line => normalizeLine(line));

	for (let startLine = 0; startLine <= contentLines.length - searchLines.length; startLine++) {
		let matches = true;
		for (let offset = 0; offset < searchLines.length; offset++) {
			if (normalizeLine(contentLines[startLine + offset]) !== normalizedSearchLines[offset]) {
				matches = false;
				break;
			}
		}

		if (!matches) {
			continue;
		}

		const startOffset = lineOffsets[startLine];
		const lastLineIndex = startLine + searchLines.length - 1;
		const endOffset = lineOffsets[lastLineIndex] + contentLines[lastLineIndex].length;
		return { startOffset, endOffset };
	}

	return undefined;
}

function computeLineOffsets(text: string): number[] {
	const offsets = [0];
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10 /* \n */) {
			offsets.push(i + 1);
		}
	}
	return offsets;
}

function normalizeLine(line: string): string {
	return line.replace(/[\t ]+/g, ' ').trim();
}

function trimForError(value: string): string {
	const compact = value.replace(/\s+/g, ' ').trim();
	if (compact.length <= 80) {
		return compact;
	}
	return `${compact.slice(0, 77)}...`;
}

/**
 * Counts logical lines in a unified-diff sense: an empty string is zero, a trailing newline is
 * not a separate line, and otherwise the count is the number of `\n`-separated segments.
 */
function countLines(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
	return trimmed.split('\n').length;
}
