/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IBulkEditService, ResourceFileEdit, ResourceTextEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import type {
	IVSCloneEditCodeService as IVSCloneEditCodeServiceContract,
	VSCloneAddCtrlKOpts,
	VSCloneEditApplyResult,
	VSCloneEditFileChange,
	VSCloneEditUndoResult,
	VSCloneParsedEdit,
	VSCloneResolvedContentEdit,
	VSCloneStartApplyingOpts,
} from './vscloneEditCodeServiceInterface.js';
import {
	VSCloneComputedDiff,
	VSCloneCtrlKZone,
	VSCloneDiff,
	VSCloneDiffArea,
	VSCloneDiffAreaSnapshotEntry,
	VSCloneDiffZone,
	VSCloneFileSnapshot,
	vscloneDiffAreaSnapshotKeys,
} from '../common/vscloneEditCodeServiceTypes.js';

type IFileApplyPlan = {
	readonly uri: URI;
	readonly action: 'create' | 'modify';
	readonly originalContent: string | undefined;
	readonly finalContent: string;
	readonly appliedEdits: number;
	readonly addedLines: number;
	readonly removedLines: number;
	readonly bulkEdit: ResourceFileEdit | ResourceTextEdit;
	readonly fileChange: VSCloneEditFileChange;
	readonly resolvedEdits: readonly VSCloneResolvedContentEdit[];
};

type IApplyMode = {
	readonly createDiffZones: boolean;
	readonly overrideUri?: URI;
};

const defaultApplyMode: IApplyMode = { createDiffZones: false };

export const IVSCloneEditCodeService = createDecorator<IVSCloneEditCodeServiceContract>('vscloneEditCodeService');

export class VSCloneEditCodeService extends Disposable implements IVSCloneEditCodeServiceContract {
	declare readonly _serviceBrand: undefined;

	diffAreaOfId: Record<string, VSCloneDiffArea> = {};
	diffAreasOfURI: Record<string, Set<string> | undefined> = {};
	diffOfId: Record<string, VSCloneDiff> = {};

	private readonly _onDidAddOrDeleteDiffZones = new Emitter<{ uri: URI }>();
	readonly onDidAddOrDeleteDiffZones = this._onDidAddOrDeleteDiffZones.event;

	private readonly _onDidChangeDiffsInDiffZoneNotStreaming = new Emitter<{ uri: URI; diffareaid: number }>();
	readonly onDidChangeDiffsInDiffZoneNotStreaming = this._onDidChangeDiffsInDiffZoneNotStreaming.event;

	private readonly _onDidChangeStreamingInDiffZone = new Emitter<{ uri: URI; diffareaid: number }>();
	readonly onDidChangeStreamingInDiffZone = this._onDidChangeStreamingInDiffZone.event;

	private readonly _onDidChangeStreamingInCtrlKZone = new Emitter<{ uri: URI; diffareaid: number }>();
	readonly onDidChangeStreamingInCtrlKZone = this._onDidChangeStreamingInCtrlKZone.event;

	private _diffareaidPool = 0;
	private _diffidPool = 0;
	// Assistant-driven apply creates reviewable diff zones after the workspace mutation lands.
	// Track those zones separately so undo can clear them and a later redo can recreate a single
	// fresh review surface instead of stacking duplicate zones for the same file.
	private readonly assistantApplyDiffZoneIdsByURI = new Map<string, Set<number>>();

	constructor(
		@IBulkEditService private readonly bulkEditService: IBulkEditService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
	}

	processRawKeybindingText(keybindingStr: string): string {
		return keybindingStr
			// Keep this formatter ASCII-only so pre-commit hooks and downstream terminals do not
			// depend on glyph support just to render keybinding hints.
			.replace(/Enter/g, '[Enter]')
			.replace(/Backspace/g, '[Backspace]');
	}

	async callBeforeApplyOrEdit(uri: URI | 'current'): Promise<void> {
		const resolved = this.resolveUri(uri);
		if (!resolved) {
			return;
		}

		// The new engine only needs the model to exist and be stable before we start mutating the
		// file. We do not try to force a save here because VSClone does not own a Void-style model
		// lifecycle yet.
		const modelReference = await this.safeCreateModelReference(resolved);
		modelReference?.dispose();
	}

	startApplying(opts: VSCloneStartApplyingOpts): [URI, Promise<void>] | null {
		if (opts.from === 'QuickEdit') {
			const diffArea = this.diffAreaOfId[opts.diffareaid];
			if (!diffArea || diffArea.type !== 'CtrlKZone') {
				return null;
			}

			const linkedDiffZoneId = diffArea._linkedStreamingDiffZone;
			if (linkedDiffZoneId === null) {
				return [diffArea._URI, Promise.resolve()];
			}

			const linkedDiffZone = this.diffAreaOfId[linkedDiffZoneId];
			if (!linkedDiffZone || linkedDiffZone.type !== 'DiffZone') {
				return [diffArea._URI, Promise.resolve()];
			}

			// Quick-edit apply is the closest VSClone equivalent to Void's "accept the streamed edit
			// zone now" path. We accept the linked diff zone in one shot and clear the originating
			// Ctrl+K zone so follow-up quick edits start from a clean editor state.
			const applyPromise = this.acceptDiffsInZone(linkedDiffZone).finally(() => {
				this.removeCtrlKZone({ diffareaid: diffArea.diffareaid });
			});
			return [linkedDiffZone._URI, applyPromise];
		}

		const resolvedUri = this.resolveUri(opts.uri);
		if (!resolvedUri) {
			return null;
		}

		// Click-apply is the current bridge between the higher-level workflow runtime and the new
		// edit engine. If the payload contains SEARCH/REPLACE blocks we route through the diff-aware
		// apply path; otherwise we treat it as a whole-file rewrite fallback.
		const applyPromise = this.hasSearchReplaceBlocks(opts.applyStr)
			? this.instantlyApplySearchReplaceBlocks({ uri: resolvedUri, searchReplaceBlocks: opts.applyStr }).then(() => undefined)
			: this.instantlyRewriteFile({ uri: resolvedUri, newContent: opts.applyStr }).then(() => undefined);
		return [resolvedUri, applyPromise];
	}

	async instantlyApplySearchReplaceBlocks(opts: { uri: URI; searchReplaceBlocks: string }): Promise<VSCloneEditApplyResult> {
		return this.applySearchReplaceBlocksToString(opts.searchReplaceBlocks, { createDiffZones: true, overrideUri: opts.uri });
	}

	async instantlyRewriteFile(opts: { uri: URI; newContent: string }): Promise<VSCloneEditApplyResult> {
		return this.applyWholeFileRewrite(opts.uri, opts.newContent, { createDiffZones: true });
	}

	addCtrlKZone(opts: VSCloneAddCtrlKOpts): number | undefined {
		const uri = opts.editor.getModel()?.uri;
		if (!uri) {
			return;
		}

		const overlappingCtrlKZone = this.findOverlappingDiffArea({
			startLine: opts.startLine,
			endLine: opts.endLine,
			uri,
			filter: diffArea => diffArea.type === 'CtrlKZone',
		});
		if (overlappingCtrlKZone && overlappingCtrlKZone.type === 'CtrlKZone') {
			opts.editor.revealLine(overlappingCtrlKZone.startLine);
			setTimeout(() => overlappingCtrlKZone._mountInfo?.textAreaRef.current?.focus(), 100);
			return overlappingCtrlKZone.diffareaid;
		}

		if (this.findOverlappingDiffArea({
			startLine: opts.startLine,
			endLine: opts.endLine,
			uri,
			filter: diffArea => diffArea.type === 'DiffZone',
		})) {
			return;
		}

		const adding: Omit<VSCloneCtrlKZone, 'diffareaid'> = {
			type: 'CtrlKZone',
			startLine: opts.startLine,
			endLine: opts.endLine,
			editorId: opts.editor.getId(),
			_URI: uri,
			_removeStylesFns: new Set(),
			_mountInfo: null,
			_linkedStreamingDiffZone: null,
		};

		const ctrlKZone = this.addDiffArea<VSCloneCtrlKZone>(adding);
		this._onDidAddOrDeleteDiffZones.fire({ uri });
		return ctrlKZone.diffareaid;
	}

	removeCtrlKZone({ diffareaid }: { diffareaid: number }): void {
		const ctrlKZone = this.diffAreaOfId[diffareaid];
		if (!ctrlKZone || ctrlKZone.type !== 'CtrlKZone') {
			return;
		}

		this.deleteCtrlKZone(ctrlKZone);
		this._onDidAddOrDeleteDiffZones.fire({ uri: ctrlKZone._URI });
	}

	hasSearchReplaceBlocks(responseText: string): boolean {
		return this.parseSearchReplaceBlocks(responseText).length > 0;
	}

	parseSearchReplaceBlocks(responseText: string): readonly VSCloneParsedEdit[] {
		return parseSearchReplaceBlocks(responseText);
	}

	async startApplyingSearchReplaceBlocks(responseText: string): Promise<VSCloneEditApplyResult> {
		// Assistant-driven apply should create diff zones so the edit engine, not transcript state,
		// owns the live applied-vs-reviewable mutation surface. This preserves the existing summary
		// result while moving the mutation itself onto the engine-native path.
		return this.applySearchReplaceBlocksToString(responseText, { createDiffZones: true });
	}

	async applySearchReplaceBlocks(responseText: string): Promise<VSCloneEditApplyResult> {
		return this.applySearchReplaceBlocksToString(responseText, defaultApplyMode);
	}

	async undoEditApply(fileChanges: readonly VSCloneEditFileChange[]): Promise<VSCloneEditUndoResult> {
		const revertedFiles: URI[] = [];
		const failures: string[] = [];
		const resourceEdits: (ResourceTextEdit | ResourceFileEdit)[] = [];

		for (const change of fileChanges) {
			if (change.action === 'create') {
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

			const modelReference = await this.safeCreateModelReference(change.uri);
			if (!modelReference) {
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

		for (const revertedFile of revertedFiles) {
			this.clearAssistantApplyDiffZonesForURI(revertedFile);
		}

		return { revertedFiles, failures };
	}

	acceptOrRejectAllDiffAreas = async (
		{ uri, behavior, removeCtrlKs, _addToHistory }: {
			uri: URI;
			removeCtrlKs: boolean;
			behavior: 'reject' | 'accept';
			_addToHistory?: boolean;
		},
	): Promise<void> => {
		void _addToHistory;

		const diffareaids = [...(this.diffAreasOfURI[uri.fsPath] ?? [])];
		if (diffareaids.length === 0) {
			return;
		}

		for (const diffareaid of diffareaids) {
			const diffArea = this.diffAreaOfId[diffareaid];
			if (!diffArea) {
				continue;
			}

			if (diffArea.type === 'DiffZone') {
				if (Object.keys(diffArea._diffOfId).length === 0) {
					this.deleteDiffZone(diffArea);
					continue;
				}
				if (behavior === 'reject') {
					await this.rejectDiffsInZone(diffArea);
				} else {
					await this.acceptDiffsInZone(diffArea);
				}
			} else if (diffArea.type === 'CtrlKZone' && removeCtrlKs) {
				this.deleteCtrlKZone(diffArea);
			}
		}

		this._onDidAddOrDeleteDiffZones.fire({ uri });
	};

	acceptDiff = async ({ diffid }: { diffid: number }): Promise<void> => {
		const diff = this.diffOfId[diffid];
		if (!diff) {
			return;
		}

		const diffArea = this.diffAreaOfId[diff.diffareaid];
		if (!diffArea || diffArea.type !== 'DiffZone') {
			return;
		}

		const replacementText = this.diffReplacementText(diff);
		diffArea.originalCode = applyResolvedEditToText(diffArea.originalCode, diff.startOffset, diff.endOffset, replacementText);
		this.shiftDiffOffsets(diffArea, diff, replacementText.length - (diff.endOffset - diff.startOffset), countLines(replacementText) - countLines(this.diffOriginalReplacementText(diff)));
		this.deleteDiff(diff);

		if (Object.keys(diffArea._diffOfId).length === 0) {
			this.deleteDiffZone(diffArea);
		}

		this._onDidChangeDiffsInDiffZoneNotStreaming.fire({ uri: diffArea._URI, diffareaid: diffArea.diffareaid });
	};

	rejectDiff = async ({ diffid }: { diffid: number }): Promise<void> => {
		const diff = this.diffOfId[diffid];
		if (!diff) {
			return;
		}

		const diffArea = this.diffAreaOfId[diff.diffareaid];
		if (!diffArea || diffArea.type !== 'DiffZone') {
			return;
		}

		const remainingDiffs = this.getSortedDiffs(diffArea).filter(candidate => candidate.diffid !== diffid);
		const remainingResolved = remainingDiffs.map(candidate => this.diffToResolvedEdit(candidate));
		const nextContent = applyResolvedEditsInReverse(diffArea.originalCode, remainingResolved);
		await this.writeWholeFile(diffArea._URI, nextContent);

		const inverseDelta = (diff.endOffset - diff.startOffset) - this.diffReplacementText(diff).length;
		const inverseLineDelta = countLines(this.diffOriginalReplacementText(diff)) - countLines(this.diffReplacementText(diff));
		this.deleteDiff(diff);
		this.shiftLaterDiffsByStartOffset(diffArea, diff, inverseDelta, inverseLineDelta);

		if (Object.keys(diffArea._diffOfId).length === 0) {
			this.deleteDiffZone(diffArea);
		}

		this._onDidChangeDiffsInDiffZoneNotStreaming.fire({ uri: diffArea._URI, diffareaid: diffArea.diffareaid });
	};

	isCtrlKZoneStreaming({ diffareaid }: { diffareaid: number }): boolean {
		const ctrlKZone = this.diffAreaOfId[diffareaid];
		if (!ctrlKZone || ctrlKZone.type !== 'CtrlKZone') {
			return false;
		}
		return ctrlKZone._linkedStreamingDiffZone !== null;
	}

	interruptCtrlKStreaming({ diffareaid }: { diffareaid: number }): void {
		const ctrlKZone = this.diffAreaOfId[diffareaid];
		if (!ctrlKZone || ctrlKZone.type !== 'CtrlKZone') {
			return;
		}
		ctrlKZone._linkedStreamingDiffZone = null;
		this._onDidChangeStreamingInCtrlKZone.fire({ uri: ctrlKZone._URI, diffareaid: ctrlKZone.diffareaid });
	}

	interruptURIStreaming({ uri }: { uri: URI }): void {
		// The streaming runtime is intentionally not part of this first edit-engine port. We keep
		// the method so the future runtime can wire it up without changing the service contract.
		void uri;
	}

	getVSCloneFileSnapshot(uri: URI): VSCloneFileSnapshot {
		const snapshottedDiffAreaOfId: Record<string, VSCloneDiffAreaSnapshotEntry> = {};

		for (const diffareaid in this.diffAreaOfId) {
			const diffArea = this.diffAreaOfId[diffareaid];
			if (diffArea._URI.fsPath !== uri.fsPath) {
				continue;
			}

			snapshottedDiffAreaOfId[diffareaid] = this.cloneSnapshotEntry(diffArea);
		}

		return {
			snapshottedDiffAreaOfId,
			entireFileCode: this.readModelValue(uri),
		};
	}

	restoreVSCloneFileSnapshot(uri: URI, snapshot: VSCloneFileSnapshot): void {
		void this.restoreVSCloneFileSnapshotAsync(uri, snapshot);
	}

	private async restoreVSCloneFileSnapshotAsync(uri: URI, snapshot: VSCloneFileSnapshot): Promise<void> {
		for (const diffareaid in this.diffAreaOfId) {
			const diffArea = this.diffAreaOfId[diffareaid];
			if (diffArea._URI.fsPath !== uri.fsPath) {
				continue;
			}
			if (diffArea.type === 'DiffZone') {
				this.deleteDiffZone(diffArea);
			} else if (diffArea.type === 'CtrlKZone') {
				this.deleteCtrlKZone(diffArea);
			}
		}

		const clonedSnapshot = this.cloneFileSnapshot(snapshot);
		for (const diffareaid in clonedSnapshot.snapshottedDiffAreaOfId) {
			const diffArea = clonedSnapshot.snapshottedDiffAreaOfId[diffareaid];
			if (diffArea.type === 'DiffZone') {
				const restoredDiffZone: VSCloneDiffZone = {
					...diffArea,
					_URI: uri,
					_diffOfId: {},
					_streamState: { isStreaming: false },
					_removeStylesFns: new Set(),
				};
				this.diffAreaOfId[diffareaid] = restoredDiffZone;
			} else if (diffArea.type === 'CtrlKZone') {
				const restoredCtrlKZone: VSCloneCtrlKZone = {
					...diffArea,
					_URI: uri,
					_removeStylesFns: new Set(),
					_mountInfo: null,
					_linkedStreamingDiffZone: null,
				};
				this.diffAreaOfId[diffareaid] = restoredCtrlKZone;
			}
			this.addOrInitializeDiffAreaAtURI(uri, diffareaid);
		}

		this._onDidAddOrDeleteDiffZones.fire({ uri });
		await this.writeWholeFile(uri, clonedSnapshot.entireFileCode);
	}

	private async applySearchReplaceBlocksToString(responseText: string, mode: IApplyMode, overrideUri?: URI): Promise<VSCloneEditApplyResult> {
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

		const workspaceFolders = this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri);
		const failures: string[] = [];
		const groupedByTarget = new Map<string, { uri: URI; edits: VSCloneParsedEdit[] }>();

		for (const edit of parsedEdits) {
			const uri = overrideUri ?? await this.resolveEditTargetUri(edit.filePath, workspaceFolders);
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
		const pendingFileChanges = new Map<string, VSCloneEditFileChange>();
		const pendingPlans: IFileApplyPlan[] = [];
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

				const createEdit = creationEdits[0];
				const finalContent = createEdit.replaceText;
				resourceEdits.push(new ResourceFileEdit(undefined, uri, {
					overwrite: false,
					ignoreIfExists: true,
					contents: Promise.resolve(VSBuffer.fromString(finalContent)),
				}));

				const fileChange: VSCloneEditFileChange = {
					uri,
					displayPath: this.deriveDisplayPath(uri, workspaceFolders),
					addedLines: countLines(finalContent),
					removedLines: 0,
					action: 'create',
					originalContent: undefined,
				};

				pendingFileChanges.set(uri.toString(), fileChange);
				pendingPlans.push({
					uri,
					action: 'create',
					originalContent: undefined,
					finalContent,
					appliedEdits: 1,
					addedLines: countLines(finalContent),
					removedLines: 0,
					bulkEdit: resourceEdits[resourceEdits.length - 1],
					fileChange,
					resolvedEdits: [],
				});
				modifiedFiles.push(uri);
				appliedEdits += 1;

				if (creationEdits.length > 1) {
					failures.push(`Multiple create-file blocks target ${uri.toString()}; only the first block was used.`);
				}
				if (replacementEdits.length > 0) {
					failures.push(`Skipped replacement edits for ${uri.toString()} because create-file syntax was also present.`);
				}
				continue;
			}

			const modelReference = await this.safeCreateModelReference(uri);
			if (!modelReference) {
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

				const ordered = this.ensureNonOverlappingResolvedEdits(resolved, originalContent);
				if (ordered.length === 0) {
					continue;
				}

				const finalContent = applyResolvedEditsInReverse(originalContent, ordered);
				const lineCount = model.getLineCount();
				const lastLineLength = model.getLineMaxColumn(lineCount);
				resourceEdits.push(new ResourceTextEdit(uri, {
					range: new Range(1, 1, lineCount, lastLineLength),
					text: finalContent,
				}));

				let addedLines = 0;
				let removedLines = 0;
				for (const resolvedEdit of ordered) {
					removedLines += countLines(originalContent.slice(resolvedEdit.startOffset, resolvedEdit.endOffset));
					addedLines += countLines(resolvedEdit.replaceText);
				}

				const fileChange: VSCloneEditFileChange = {
					uri,
					displayPath: this.deriveDisplayPath(uri, workspaceFolders),
					addedLines,
					removedLines,
					action: 'modify',
					originalContent,
				};

				pendingFileChanges.set(uri.toString(), fileChange);
				pendingPlans.push({
					uri,
					action: 'modify',
					originalContent,
					finalContent,
					appliedEdits: ordered.length,
					addedLines,
					removedLines,
					bulkEdit: resourceEdits[resourceEdits.length - 1],
					fileChange,
					resolvedEdits: ordered,
				});
				modifiedFiles.push(uri);
				appliedEdits += ordered.length;
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

		if (mode.createDiffZones) {
			for (const plan of pendingPlans) {
				this.recordAppliedDiffZone(plan);
			}
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

	private async applyWholeFileRewrite(uri: URI, newContent: string, mode: IApplyMode): Promise<VSCloneEditApplyResult> {
		const modelReference = await this.safeCreateModelReference(uri);
		const originalContent = modelReference?.object.textEditorModel.getValue() ?? '';
		modelReference?.dispose();

		const finalContent = newContent;
		if (originalContent === finalContent) {
			return {
				attemptedEdits: 1,
				appliedEdits: 0,
				modifiedFiles: [],
				failures: [],
				fileChanges: [],
			};
		}

		const bulkEdit = await this.buildWholeFileRewriteEdit(uri, finalContent);
		const applyResult = await this.bulkEditService.apply([bulkEdit], {
			label: 'Rewrite VSClone file',
		});
		if (!applyResult.isApplied) {
			return {
				attemptedEdits: 1,
				appliedEdits: 0,
				modifiedFiles: [],
				failures: ['Workspace edit was not applied.'],
				fileChanges: [],
			};
		}

		if (mode.createDiffZones) {
			const resolvedEdit: VSCloneResolvedContentEdit = {
				startOffset: 0,
				endOffset: originalContent.length,
				replaceText: finalContent,
				source: {
					filePath: uri.path,
					searchText: originalContent,
					replaceText: finalContent,
					order: 0,
				},
			};
			this.recordAppliedDiffZone({
				uri,
				action: originalContent.length === 0 ? 'create' : 'modify',
				originalContent: originalContent.length === 0 ? undefined : originalContent,
				finalContent,
				appliedEdits: 1,
				addedLines: countLines(finalContent),
				removedLines: countLines(originalContent),
				bulkEdit,
				fileChange: {
					uri,
					displayPath: this.deriveDisplayPath(uri, this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri)),
					addedLines: countLines(finalContent),
					removedLines: countLines(originalContent),
					action: originalContent.length === 0 ? 'create' : 'modify',
					originalContent: originalContent.length === 0 ? undefined : originalContent,
				},
				resolvedEdits: originalContent.length === 0 ? [] : [resolvedEdit],
			});
		}

		await this.editorService.openEditor({ resource: uri });
		return {
			attemptedEdits: 1,
			appliedEdits: 1,
			modifiedFiles: [uri],
			failures: [],
			fileChanges: [{
				uri,
				displayPath: this.deriveDisplayPath(uri, this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri)),
				addedLines: countLines(finalContent),
				removedLines: countLines(originalContent),
				action: originalContent.length === 0 ? 'create' : 'modify',
				originalContent: originalContent.length === 0 ? undefined : originalContent,
			}],
		};
	}

	private async buildWholeFileRewriteEdit(uri: URI, text: string): Promise<ResourceTextEdit | ResourceFileEdit> {
		const modelReference = await this.safeCreateModelReference(uri);
		if (!modelReference) {
			// Tool-driven create_file now delegates here, so the engine has to own the "make parent
			// folders exist before the first write" behavior that previously lived in the tool layer.
			await this.fileService.createFolder(dirname(uri));
			return new ResourceFileEdit(undefined, uri, {
				overwrite: true,
				ignoreIfExists: false,
				contents: Promise.resolve(VSBuffer.fromString(text)),
			});
		}

		try {
			const model = modelReference.object.textEditorModel;
			const lineCount = model.getLineCount();
			const lastLineLength = model.getLineMaxColumn(lineCount);
			return new ResourceTextEdit(uri, {
				range: new Range(1, 1, lineCount, lastLineLength),
				text,
			});
		} finally {
			modelReference.dispose();
		}
	}

	private recordAppliedDiffZone(plan: IFileApplyPlan): void {
		const uri = plan.uri;
		const lineCount = countLines(plan.finalContent);
		this.clearAssistantApplyDiffZonesForURI(uri);

		const adding: Omit<VSCloneDiffZone, 'diffareaid'> = {
			type: 'DiffZone',
			originalCode: plan.originalContent ?? '',
			startLine: 1,
			endLine: Math.max(1, lineCount),
			_URI: uri,
			_streamState: { isStreaming: false },
			_diffOfId: {},
			_removeStylesFns: new Set(),
		};
		const diffZone = this.addDiffArea<VSCloneDiffZone>(adding);

		if (plan.resolvedEdits.length === 0) {
			// A pure create-file apply still deserves a diff entry so accept/reject can remain
			// symmetric with the search/replace path.
			const insertionText = plan.finalContent;
			if (insertionText.length > 0) {
				this.addDiff({
					type: 'insertion',
					originalCode: '',
					originalStartLine: 1,
					code: insertionText,
					startLine: 1,
					endLine: Math.max(1, countLines(insertionText)),
					startOffset: 0,
					endOffset: 0,
				}, diffZone);
			}
		} else {
			for (const resolvedEdit of plan.resolvedEdits) {
				this.addDiff(this.resolvedEditToComputedDiff(plan.originalContent ?? '', resolvedEdit), diffZone);
			}
		}

		this.trackAssistantApplyDiffZone(diffZone);
		this._onDidAddOrDeleteDiffZones.fire({ uri });
		this._onDidChangeDiffsInDiffZoneNotStreaming.fire({ uri, diffareaid: diffZone.diffareaid });
	}

	private async acceptDiffsInZone(diffArea: VSCloneDiffZone): Promise<void> {
		// Accepting a diff means the current file already reflects the change, so we only need to
		// bake it into the zone's baseline and rebase the remaining diffs.
		const diffs = this.getSortedDiffs(diffArea);
		for (const diff of [...diffs].sort((left, right) => right.startOffset - left.startOffset)) {
			await this.acceptDiff({ diffid: diff.diffid });
		}
	}

	private async rejectDiffsInZone(diffArea: VSCloneDiffZone): Promise<void> {
		const diffs = this.getSortedDiffs(diffArea);
		if (diffs.length === 0) {
			return;
		}

		await this.writeWholeFile(diffArea._URI, diffArea.originalCode);
		for (const diff of [...diffs].sort((left, right) => right.startOffset - left.startOffset)) {
			this.deleteDiff(diff);
		}
		this.deleteDiffZone(diffArea);
	}

	private addDiffArea<T extends VSCloneDiffArea>(diffArea: Omit<T, 'diffareaid'>): T {
		const diffareaid = this._diffareaidPool++;
		const diffArea2 = Object.assign({ diffareaid }, diffArea);
		this.addOrInitializeDiffAreaAtURI(diffArea2._URI, diffareaid);
		this.diffAreaOfId[diffareaid] = diffArea2;
		return diffArea2;
	}

	private addOrInitializeDiffAreaAtURI(uri: URI, diffareaid: string | number): void {
		if (this.diffAreasOfURI[uri.fsPath] === undefined) {
			this.diffAreasOfURI[uri.fsPath] = new Set();
		}
		this.diffAreasOfURI[uri.fsPath]?.add(diffareaid.toString());
	}

	private addDiff(computedDiff: VSCloneComputedDiff, diffZone: VSCloneDiffZone): VSCloneDiff {
		const diffid = this._diffidPool++;
		const newDiff: VSCloneDiff = {
			...computedDiff,
			diffid,
			diffareaid: diffZone.diffareaid,
		};
		this.diffOfId[diffid] = newDiff;
		diffZone._diffOfId[diffid] = newDiff;
		return newDiff;
	}

	private deleteDiff(diff: VSCloneDiff): void {
		const diffArea = this.diffAreaOfId[diff.diffareaid];
		if (diffArea?.type !== 'DiffZone') {
			delete this.diffOfId[diff.diffid];
			return;
		}

		delete diffArea._diffOfId[diff.diffid];
		delete this.diffOfId[diff.diffid];
	}

	private deleteDiffs(diffZone: VSCloneDiffZone): void {
		for (const diffid in diffZone._diffOfId) {
			this.deleteDiff(diffZone._diffOfId[diffid]);
		}
	}

	private deleteDiffZone(diffZone: VSCloneDiffZone): void {
		this.untrackAssistantApplyDiffZone(diffZone);
		this.deleteDiffs(diffZone);
		delete this.diffAreaOfId[diffZone.diffareaid];
		this.diffAreasOfURI[diffZone._URI.fsPath]?.delete(diffZone.diffareaid.toString());
		this._onDidAddOrDeleteDiffZones.fire({ uri: diffZone._URI });
	}

	private trackAssistantApplyDiffZone(diffZone: VSCloneDiffZone): void {
		let trackedDiffZonesForURI = this.assistantApplyDiffZoneIdsByURI.get(diffZone._URI.fsPath);
		if (!trackedDiffZonesForURI) {
			trackedDiffZonesForURI = new Set<number>();
			this.assistantApplyDiffZoneIdsByURI.set(diffZone._URI.fsPath, trackedDiffZonesForURI);
		}
		trackedDiffZonesForURI.add(diffZone.diffareaid);
	}

	private untrackAssistantApplyDiffZone(diffZone: VSCloneDiffZone): void {
		const trackedDiffZonesForURI = this.assistantApplyDiffZoneIdsByURI.get(diffZone._URI.fsPath);
		if (!trackedDiffZonesForURI) {
			return;
		}
		trackedDiffZonesForURI.delete(diffZone.diffareaid);
		if (trackedDiffZonesForURI.size === 0) {
			this.assistantApplyDiffZoneIdsByURI.delete(diffZone._URI.fsPath);
		}
	}

	private clearAssistantApplyDiffZonesForURI(uri: URI): void {
		const trackedDiffZoneIds = [...(this.assistantApplyDiffZoneIdsByURI.get(uri.fsPath) ?? [])];
		if (trackedDiffZoneIds.length === 0) {
			return;
		}

		for (const diffZoneId of trackedDiffZoneIds) {
			const diffZone = this.diffAreaOfId[diffZoneId];
			if (!diffZone || diffZone.type !== 'DiffZone') {
				continue;
			}
			this.deleteDiffZone(diffZone);
		}
		this.assistantApplyDiffZoneIdsByURI.delete(uri.fsPath);
	}

	private deleteCtrlKZone(ctrlKZone: VSCloneCtrlKZone): void {
		delete this.diffAreaOfId[ctrlKZone.diffareaid];
		this.diffAreasOfURI[ctrlKZone._URI.fsPath]?.delete(ctrlKZone.diffareaid.toString());
	}

	private getSortedDiffs(diffZone: VSCloneDiffZone): VSCloneDiff[] {
		return Object.values(diffZone._diffOfId).sort((left, right) => left.startOffset - right.startOffset);
	}

	private diffReplacementText(diff: VSCloneDiff): string {
		return diff.type === 'deletion' ? '' : diff.code;
	}

	private diffOriginalReplacementText(diff: VSCloneDiff): string {
		return diff.type === 'insertion' ? '' : diff.originalCode;
	}

	private diffToResolvedEdit(diff: VSCloneDiff): VSCloneResolvedContentEdit {
		return {
			startOffset: diff.startOffset,
			endOffset: diff.endOffset,
			replaceText: this.diffReplacementText(diff),
			source: {
				filePath: diff.diffareaid.toString(),
				searchText: this.diffOriginalReplacementText(diff),
				replaceText: this.diffReplacementText(diff),
				order: diff.diffid,
			},
		};
	}

	private resolvedEditToComputedDiff(originalContent: string, resolvedEdit: VSCloneResolvedContentEdit): VSCloneComputedDiff {
		const originalSlice = originalContent.slice(resolvedEdit.startOffset, resolvedEdit.endOffset);
		const originalRange = rangeFromOffsets(originalContent, resolvedEdit.startOffset, resolvedEdit.endOffset);
		const replacementLineCount = countLines(resolvedEdit.replaceText);

		if (resolvedEdit.source.searchText.trim().length === 0) {
			return {
				type: 'insertion',
				originalStartLine: originalRange.startLine,
				code: resolvedEdit.replaceText,
				startLine: originalRange.startLine,
				endLine: Math.max(originalRange.startLine, originalRange.startLine + replacementLineCount - 1),
				startOffset: resolvedEdit.startOffset,
				endOffset: resolvedEdit.endOffset,
			};
		}

		if (resolvedEdit.replaceText.length === 0) {
			return {
				type: 'deletion',
				originalCode: originalSlice,
				originalStartLine: originalRange.startLine,
				originalEndLine: originalRange.endLine,
				startLine: originalRange.startLine,
				endLine: originalRange.endLine,
				startOffset: resolvedEdit.startOffset,
				endOffset: resolvedEdit.endOffset,
			};
		}

		return {
			type: 'edit',
			originalCode: originalSlice,
			originalStartLine: originalRange.startLine,
			originalEndLine: originalRange.endLine,
			code: resolvedEdit.replaceText,
			startLine: originalRange.startLine,
			endLine: Math.max(originalRange.startLine, originalRange.startLine + replacementLineCount - 1),
			startOffset: resolvedEdit.startOffset,
			endOffset: resolvedEdit.endOffset,
		};
	}

	private shiftDiffOffsets(diffArea: VSCloneDiffZone, anchorDiff: VSCloneDiff, charDelta: number, lineDelta: number): void {
		this.shiftLaterDiffsByStartOffset(diffArea, anchorDiff, charDelta, lineDelta);
	}

	private shiftLaterDiffsByStartOffset(diffArea: VSCloneDiffZone, anchorDiff: VSCloneDiff, charDelta: number, lineDelta: number): void {
		const diffs = this.getSortedDiffs(diffArea);
		const anchorIndex = diffs.findIndex(candidate => candidate.diffid === anchorDiff.diffid);
		if (anchorIndex === -1) {
			return;
		}

		for (const diff of diffs.slice(anchorIndex + 1)) {
			diff.startOffset += charDelta;
			diff.endOffset += charDelta;
			diff.startLine += lineDelta;
			diff.endLine += lineDelta;
		}
	}

	private findOverlappingDiffArea(
		{ startLine, endLine, uri, filter }: {
			startLine: number;
			endLine: number;
			uri: URI;
			filter?: (diffArea: VSCloneDiffArea) => boolean;
		},
	): VSCloneDiffArea | null {
		for (const diffareaid of this.diffAreasOfURI[uri.fsPath] ?? []) {
			const diffArea = this.diffAreaOfId[diffareaid];
			if (!diffArea) {
				continue;
			}
			if (!filter?.(diffArea)) {
				continue;
			}
			const noOverlap = diffArea.startLine > endLine || diffArea.endLine < startLine;
			if (!noOverlap) {
				return diffArea;
			}
		}
		return null;
	}

	private resolveUri(uriLike: URI | 'current'): URI | undefined {
		if (uriLike !== 'current') {
			return uriLike;
		}

		const activeControl = this.editorService.activeTextEditorControl;
		const model = activeControl?.getModel?.() as { uri?: URI } | null | undefined;
		return model?.uri;
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

		return joinPath(workspaceFolderUris[0], relativePath);
	}

	private async safeExists(resource: URI): Promise<boolean> {
		try {
			return await this.fileService.exists(resource);
		} catch {
			return false;
		}
	}

	private async safeCreateModelReference(resource: URI) {
		try {
			return await this.textModelService.createModelReference(resource);
		} catch {
			return undefined;
		}
	}

	private readModelValue(uri: URI): string {
		for (const control of this.editorService.visibleTextEditorControls) {
			const model = control.getModel() as { uri?: URI; getValue?: () => string } | null;
			if (model?.uri?.toString() === uri.toString() && model.getValue) {
				return model.getValue();
			}
		}

		const activeModel = this.editorService.activeTextEditorControl?.getModel?.() as { uri?: URI; getValue?: () => string } | null | undefined;
		if (activeModel?.uri?.toString() === uri.toString() && activeModel.getValue) {
			return activeModel.getValue();
		}

		return '';
	}

	private cloneSnapshotEntry(diffArea: VSCloneDiffArea): VSCloneDiffAreaSnapshotEntry {
		const snapshot: Partial<VSCloneDiffAreaSnapshotEntry> = {};
		for (const key of vscloneDiffAreaSnapshotKeys) {
			(snapshot as Record<string, unknown>)[key] = (diffArea as Record<string, unknown>)[key];
		}
		return snapshot as VSCloneDiffAreaSnapshotEntry;
	}

	private cloneFileSnapshot(snapshot: VSCloneFileSnapshot): VSCloneFileSnapshot {
		return {
			snapshottedDiffAreaOfId: Object.fromEntries(
				Object.entries(snapshot.snapshottedDiffAreaOfId).map(([key, value]) => [key, { ...value }]),
			),
			entireFileCode: snapshot.entireFileCode,
		};
	}

	private ensureNonOverlappingResolvedEdits(resolved: readonly VSCloneResolvedContentEdit[], originalContent: string): readonly VSCloneResolvedContentEdit[] {
		const ordered = [...resolved].sort((left, right) => left.startOffset - right.startOffset);
		for (let index = 1; index < ordered.length; index += 1) {
			if (ordered[index].startOffset < ordered[index - 1].endOffset) {
				// Overlapping replacements are ambiguous in the reverse-apply model, so we reject them
				// instead of silently producing a bad file state.
				return [];
			}
		}
		void originalContent;
		return ordered;
	}

	private async writeWholeFile(uri: URI, text: string): Promise<void> {
		const modelReference = await this.safeCreateModelReference(uri);
		if (!modelReference) {
			// Snapshot restore can target files that no longer exist, so it follows the same parent
			// folder creation path as initial create_file rewrites to keep restore behavior symmetric.
			await this.fileService.createFolder(dirname(uri));
			await this.bulkEditService.apply([new ResourceFileEdit(undefined, uri, {
				overwrite: true,
				ignoreIfExists: false,
				contents: Promise.resolve(VSBuffer.fromString(text)),
			})], { label: 'Restore VSClone file' });
			return;
		}

		try {
			const model = modelReference.object.textEditorModel;
			const lineCount = model.getLineCount();
			const lastLineLength = model.getLineMaxColumn(lineCount);
			const edit = new ResourceTextEdit(uri, {
				range: new Range(1, 1, lineCount, lastLineLength),
				text,
			});
			await this.bulkEditService.apply([edit], { label: 'Restore VSClone file' });
		} finally {
			modelReference.dispose();
		}
	}
}

export function parseSearchReplaceBlocks(responseText: string): readonly VSCloneParsedEdit[] {
	const normalized = responseText.replace(/\r\n/g, '\n');
	const blockPattern = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
	const edits: VSCloneParsedEdit[] = [];

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

export function resolveContentEdits(content: string, edits: readonly VSCloneParsedEdit[]): {
	readonly resolved: readonly VSCloneResolvedContentEdit[];
	readonly failed: readonly VSCloneParsedEdit[];
} {
	const resolved: VSCloneResolvedContentEdit[] = [];
	const failed: VSCloneParsedEdit[] = [];

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

export function applyResolvedEditsInReverse(content: string, edits: readonly VSCloneResolvedContentEdit[]): string {
	let next = content;
	for (const edit of [...edits].sort((left, right) => right.startOffset - left.startOffset)) {
		next = `${next.slice(0, edit.startOffset)}${edit.replaceText}${next.slice(edit.endOffset)}`;
	}
	return next;
}

function applyResolvedEditToText(content: string, startOffset: number, endOffset: number, replaceText: string): string {
	return `${content.slice(0, startOffset)}${replaceText}${content.slice(endOffset)}`;
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

	const normalizedContent = content.replace(/\r\n/g, '\n');
	const contentLines = normalizedContent.split('\n');
	const lineOffsets = computeLineOffsets(normalizedContent);
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
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 10 /* \n */) {
			offsets.push(index + 1);
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

function countLines(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
	return trimmed.split('\n').length;
}

function rangeFromOffsets(content: string, startOffset: number, endOffset: number): { startLine: number; endLine: number } {
	const normalized = content.replace(/\r\n/g, '\n');
	const lineOffsets = computeLineOffsets(normalized);
	const startLine = lineNumberAtOffset(lineOffsets, startOffset);
	const endLine = lineNumberAtOffset(lineOffsets, Math.max(startOffset, endOffset - 1));
	return { startLine, endLine };
}

function lineNumberAtOffset(lineOffsets: number[], offset: number): number {
	let low = 0;
	let high = lineOffsets.length - 1;
	while (low <= high) {
		const mid = (low + high) >>> 1;
		if (lineOffsets[mid] <= offset) {
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return Math.max(1, high + 1);
}
