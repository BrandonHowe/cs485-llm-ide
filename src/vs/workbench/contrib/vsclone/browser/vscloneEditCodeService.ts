/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { EndOfLinePreference, IModelDecorationOptions, ITextModel } from '../../../../editor/common/model.js';
import { ModelDecorationOptions } from '../../../../editor/common/model/textModel.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { RenderOptions } from '../../../../editor/browser/widget/diffEditor/components/diffEditorViewZones/renderLines.js';
import { IViewZone } from '../../../../editor/browser/editorBrowser.js';
import { IBulkEditService, ResourceFileEdit, ResourceTextEdit } from '../../../../editor/browser/services/bulkEditService.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IVSCloneConsistentItemService } from './helperServices/vscloneConsistentItemService.js';
import { VSCloneAcceptRejectInlineWidget } from './vscloneAcceptRejectInlineWidget.js';
import { findDiffs } from './helpers/findDiffs.js';
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
		@IModelService private readonly _modelService: IModelService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IVSCloneConsistentItemService private readonly _consistentItemService: IVSCloneConsistentItemService,
		@ICodeEditorService private readonly _codeEditorService: ICodeEditorService,
	) {
		super();

		// Mirror Void's constructor wiring: when a model or editor appears after a DiffZone has been
		// registered, re-run the refresh so decorations and inline widgets reappear. Without this,
		// DiffZones created before the editor opens stay invisible forever.
		this._register(this._modelService.onModelAdded(model => {
			if (this.diffAreasOfURI[model.uri.fsPath] && (this.diffAreasOfURI[model.uri.fsPath]?.size ?? 0) > 0) {
				this._refreshStylesAndDiffsInURI(model.uri);
			}
		}));
		this._register(this._codeEditorService.onCodeEditorAdd(editor => {
			const uri = editor.getModel()?.uri;
			if (!uri) {
				return;
			}
			if (this.diffAreasOfURI[uri.fsPath] && (this.diffAreasOfURI[uri.fsPath]?.size ?? 0) > 0) {
				this._refreshStylesAndDiffsInURI(uri);
			}
		}));
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

		// Click-apply already resolved the target URI, so bare SEARCH/REPLACE payloads must count as
		// structured edits before we choose between the diff-aware apply path and whole-file rewrite.
		const applyPromise = this.parseSearchReplaceBlocks(opts.applyStr, resolvedUri.toString()).length > 0
			? this.instantlyApplySearchReplaceBlocks({ uri: resolvedUri, searchReplaceBlocks: opts.applyStr }).then(() => undefined)
			: this.instantlyRewriteFile({ uri: resolvedUri, newContent: opts.applyStr }).then(() => undefined);
		return [resolvedUri, applyPromise];
	}

	async instantlyApplySearchReplaceBlocks(opts: { uri: URI; searchReplaceBlocks: string }): Promise<VSCloneEditApplyResult> {
		// edit_file already resolves the target resource before it reaches the engine, so the
		// engine must accept bare SEARCH/REPLACE blocks here instead of requiring an extra File:
		// header that only multi-file transcript apply paths need.
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

		const ctrlKZone = this.addDiffArea(adding);
		this._onDidAddOrDeleteDiffZones.fire({ uri });
		// Matches Void: paint the CtrlK highlight decorations via the refresh-rebuild pipeline.
		this._refreshStylesAndDiffsInURI(uri);
		return ctrlKZone.diffareaid;
	}

	removeCtrlKZone({ diffareaid }: { diffareaid: number }): void {
		const ctrlKZone = this.diffAreaOfId[diffareaid];
		if (!ctrlKZone || ctrlKZone.type !== 'CtrlKZone') {
			return;
		}

		this.deleteCtrlKZone(ctrlKZone);
		this._onDidAddOrDeleteDiffZones.fire({ uri: ctrlKZone._URI });
		// Matches Void: tear down the CtrlK highlight the zone contributed in the next refresh pass.
		this._refreshStylesAndDiffsInURI(ctrlKZone._URI);
	}

	hasSearchReplaceBlocks(responseText: string): boolean {
		return this.parseSearchReplaceBlocks(responseText).length > 0;
	}

	parseSearchReplaceBlocks(responseText: string, defaultFilePath?: string): readonly VSCloneParsedEdit[] {
		return parseSearchReplaceBlocks(responseText, defaultFilePath);
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
				// Route through the zone-level helpers even if _diffOfId is empty. When the URI's
				// model hasn't loaded yet, refresh defers diff rebuild, so the empty map does NOT
				// mean "no work to do" -- for reject we still need to write originalCode back.
				if (behavior === 'reject') {
					await this.rejectDiffsInZone(diffArea);
				} else {
					await this.acceptDiffsInZone(diffArea);
				}
			} else if (diffArea.type === 'CtrlKZone' && removeCtrlKs) {
				this.deleteCtrlKZone(diffArea);
			}
		}

		// Inner helpers (acceptDiffsInZone / rejectDiffsInZone) already fire onDidAddOrDeleteDiffZones
		// via deleteDiffZone and run refresh per-zone. A failed rejectDiffsInZone deliberately skips
		// both, so we don't want an outer unconditional fire + refresh here -- it would emit phantom
		// add/delete events for zones that weren't actually removed. Matches Void's batch path.
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

		// Bake this hunk into the zone baseline via line slicing, matching Void's acceptDiff.
		const originalLines = diffArea.originalCode.split('\n');
		let newOriginalCode: string;

		if (diff.type === 'deletion') {
			newOriginalCode = [
				...originalLines.slice(0, diff.originalStartLine - 1),
				...originalLines.slice(diff.originalEndLine),
			].join('\n');
		} else if (diff.type === 'insertion') {
			newOriginalCode = [
				...originalLines.slice(0, diff.originalStartLine - 1),
				diff.code,
				...originalLines.slice(diff.originalStartLine - 1),
			].join('\n');
		} else {
			newOriginalCode = [
				...originalLines.slice(0, diff.originalStartLine - 1),
				diff.code,
				...originalLines.slice(diff.originalEndLine),
			].join('\n');
		}

		diffArea.originalCode = newOriginalCode;
		const uri = diffArea._URI;
		this.deleteDiff(diff);

		if (Object.keys(diffArea._diffOfId).length === 0) {
			this.deleteDiffZone(diffArea);
		}

		this._refreshStylesAndDiffsInURI(uri);
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

		const uri = diffArea._URI;
		let writeText: string;
		let toRange: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };

		// Mirrors Void: undo this hunk in the editor without touching originalCode. The refresh pass
		// then rebuilds the remaining diffs via findDiffs.
		if (diff.type === 'deletion') {
			if (diff.startLine - 1 === diffArea.endLine) {
				writeText = '\n' + diff.originalCode;
				toRange = { startLineNumber: diff.startLine - 1, startColumn: Number.MAX_SAFE_INTEGER, endLineNumber: diff.startLine - 1, endColumn: Number.MAX_SAFE_INTEGER };
			} else {
				writeText = diff.originalCode + '\n';
				toRange = { startLineNumber: diff.startLine, startColumn: 1, endLineNumber: diff.startLine, endColumn: 1 };
			}
		} else if (diff.type === 'insertion') {
			if (diff.endLine === diffArea.endLine) {
				writeText = '';
				toRange = { startLineNumber: diff.startLine - 1, startColumn: Number.MAX_SAFE_INTEGER, endLineNumber: diff.endLine, endColumn: 1 };
			} else {
				writeText = '';
				toRange = { startLineNumber: diff.startLine, startColumn: 1, endLineNumber: diff.endLine + 1, endColumn: 1 };
			}
		} else {
			writeText = diff.originalCode;
			toRange = { startLineNumber: diff.startLine, startColumn: 1, endLineNumber: diff.endLine, endColumn: Number.MAX_SAFE_INTEGER };
		}

		await this._writeURIText(uri, writeText, toRange);

		// originalCode stays the same on reject -- only the live file reverts.
		this.deleteDiff(diff);

		if (Object.keys(diffArea._diffOfId).length === 0) {
			this.deleteDiffZone(diffArea);
		}

		this._refreshStylesAndDiffsInURI(uri);
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

		// Match Void (_getCurrentVoidFileSnapshot): read directly from the model service so hidden
		// but loaded models still yield their text. The editor-walking fallback would return '' for
		// any URI whose model is not currently mounted in a visible/active control.
		const model = this._modelService.getModel(uri);
		const entireFileCode = model ? model.getValue(EndOfLinePreference.LF) : '';
		return {
			snapshottedDiffAreaOfId,
			entireFileCode,
		};
	}

	restoreVSCloneFileSnapshot(uri: URI, snapshot: VSCloneFileSnapshot): void {
		void this.restoreVSCloneFileSnapshotAsync(uri, snapshot);
	}

	private async restoreVSCloneFileSnapshotAsync(uri: URI, snapshot: VSCloneFileSnapshot): Promise<void> {
		// Prebuild every restored zone object and validate invariants BEFORE touching the filesystem
		// or in-memory state. This makes the restore effectively atomic: any schema violation in the
		// snapshot throws before the write, so we can't end up with the file mutated and the zone
		// map half-populated.
		const clonedSnapshot = this.cloneFileSnapshot(snapshot);
		const prebuiltZones: { diffareaid: string; zone: VSCloneDiffZone | VSCloneCtrlKZone }[] = [];
		for (const diffareaid in clonedSnapshot.snapshottedDiffAreaOfId) {
			const diffArea = clonedSnapshot.snapshottedDiffAreaOfId[diffareaid];
			if (diffArea.type === 'DiffZone') {
				if (diffArea.originalCode === undefined) {
					throw new Error('VSClone diff snapshots must retain originalCode so restore can rebuild the live diff zone.');
				}
				prebuiltZones.push({
					diffareaid,
					zone: {
						type: 'DiffZone',
						diffareaid: diffArea.diffareaid,
						startLine: diffArea.startLine,
						endLine: diffArea.endLine,
						originalCode: diffArea.originalCode,
						_URI: uri,
						_diffOfId: {},
						_streamState: { isStreaming: false },
						_removeStylesFns: new Set(),
					},
				});
			} else if (diffArea.type === 'CtrlKZone') {
				if (diffArea.editorId === undefined) {
					throw new Error('VSClone Ctrl+K snapshots must retain editorId so restore can rebind the inline zone.');
				}
				prebuiltZones.push({
					diffareaid,
					zone: {
						type: 'CtrlKZone',
						diffareaid: diffArea.diffareaid,
						startLine: diffArea.startLine,
						endLine: diffArea.endLine,
						editorId: diffArea.editorId,
						_URI: uri,
						_removeStylesFns: new Set(),
						_mountInfo: null,
						_linkedStreamingDiffZone: null,
					},
				});
			}
		}

		// Now commit: write file first, and if the workspace edit is refused leave in-memory state
		// untouched so the caller's visible zones still match the on-disk file.
		const applied = await this.writeWholeFile(uri, clonedSnapshot.entireFileCode);
		if (!applied) {
			return;
		}

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

		for (const { diffareaid, zone } of prebuiltZones) {
			this.diffAreaOfId[diffareaid] = zone;
			this.addOrInitializeDiffAreaAtURI(uri, diffareaid);
		}

		this._onDidAddOrDeleteDiffZones.fire({ uri });
		this._refreshStylesAndDiffsInURI(uri);
	}

	private async applySearchReplaceBlocksToString(responseText: string, mode: IApplyMode): Promise<VSCloneEditApplyResult> {
		// Single-file tool and click-apply paths resolve the target URI before they reach the shared
		// parser, so thread that URI through here to keep bare SEARCH/REPLACE payloads on the edit
		// path instead of silently dropping them as "missing" file headers.
		const parsedEdits = this.parseSearchReplaceBlocks(responseText, mode.overrideUri?.toString());
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
			const uri = mode.overrideUri ?? await this.resolveEditTargetUri(edit.filePath, workspaceFolders);
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
				// Read LF-normalized so snapshots and diff computations see the same line endings as
				// _computeDiffsAndAddStylesToURI. Otherwise CRLF files show every line as changed.
				const originalContent = model.getValue(EndOfLinePreference.LF);
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
		// LF-normalized so the diff baseline matches _computeDiffsAndAddStylesToURI's reads.
		const originalContent = modelReference?.object.textEditorModel.getValue(EndOfLinePreference.LF) ?? '';
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
		// Monaco counts a trailing newline as its own empty line; our custom `countLines` strips it.
		// The DiffZone has to cover every line the model reports, otherwise the refresh slice drops
		// the trailing empty line and findDiffs reports a phantom deletion below the file. Split on
		// every Monaco-recognized line break (\r\n, \r, \n) so mixed-ending payloads count correctly.
		const lineCount = plan.finalContent === '' ? 1 : plan.finalContent.split(/\r\n|\r|\n/).length;
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
		const diffZone = this.addDiffArea(adding);

		// Multiple assistant edits can land against the same file before the user has reviewed the
		// earlier ones. Keep each review zone alive so a later apply does not implicitly accept the
		// previous suggestion by deleting its diff surface. Explicit accept/reject and undo paths
		// remain responsible for clearing zones once the user or transcript action resolves them.
		this.trackAssistantApplyDiffZone(diffZone);
		// Under Void's refresh-rebuild model, _diffOfId is populated by the refresh pass that runs
		// here. `plan.resolvedEdits` no longer drives the diff list -- findDiffs does.
		this._onDidAddOrDeleteDiffZones.fire({ uri });
		this._refreshStylesAndDiffsInURI(uri);
	}

	private async acceptDiffsInZone(diffArea: VSCloneDiffZone): Promise<void> {
		// Match Void's whole-zone accept path (acceptOrRejectAllDiffAreas → _deleteDiffZone). Rather
		// than iterating per-diff -- which breaks because acceptDiff runs a refresh that re-mints the
		// diffids mid-loop -- we baseline originalCode to the current model slice and drop the zone.
		// _deleteDiffZone runs _clearAllDiffAreaEffects so decorations/widgets tear down cleanly.
		const uri = diffArea._URI;
		const model = this._modelService.getModel(uri);
		if (model) {
			const fullFileText = model.getValue(EndOfLinePreference.LF);
			const lines = fullFileText.split('\n');
			diffArea.originalCode = lines.slice(diffArea.startLine - 1, diffArea.endLine).join('\n');
		}
		this.deleteDiffZone(diffArea);
		this._refreshStylesAndDiffsInURI(uri);
	}

	private async rejectDiffsInZone(diffArea: VSCloneDiffZone): Promise<void> {
		// Mirror Void's reject-all path: write originalCode back, then delete the zone. Skip the
		// zone deletion if the whole-file revert failed -- otherwise the editor keeps the modified
		// text but the review UI disappears, stranding the user.
		const uri = diffArea._URI;

		// No-op guard: if the live file already matches originalCode (e.g. all diffs accepted and
		// the zone hasn't been cleaned up, or the zone was empty to begin with) skip the bulk edit
		// so reject-all doesn't create undo-stack noise. Matches Void's _writeURIText no-op path.
		const model = this._modelService.getModel(uri);
		if (model && model.getValue(EndOfLinePreference.LF) === diffArea.originalCode) {
			this.deleteDiffZone(diffArea);
			this._refreshStylesAndDiffsInURI(uri);
			return;
		}

		const applied = await this.writeWholeFile(uri, diffArea.originalCode);
		if (!applied) {
			return;
		}
		this.deleteDiffZone(diffArea);
		this._refreshStylesAndDiffsInURI(uri);
	}

	private addDiffArea(diffArea: Omit<VSCloneCtrlKZone, 'diffareaid'>): VSCloneCtrlKZone;
	private addDiffArea(diffArea: Omit<VSCloneDiffZone, 'diffareaid'>): VSCloneDiffZone;
	private addDiffArea(
		diffArea: Omit<VSCloneCtrlKZone, 'diffareaid'> | Omit<VSCloneDiffZone, 'diffareaid'>,
	): VSCloneCtrlKZone | VSCloneDiffZone {
		const diffareaid = this._diffareaidPool++;
		// `addDiffArea` only services the concrete editable zone types, so overloads preserve the
		// caller's exact zone shape while we attach the runtime-generated id in one place.
		const diffArea2 = {
			diffareaid,
			...diffArea,
		};
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
		// Run the stored remove-style fns before tearing down the lookup tables. Otherwise the
		// refresh-rebuild pass can't find the zone to call its disposers and the inline widget +
		// red view zone stick around after the final accept/reject.
		this._clearAllDiffAreaEffects(diffZone);
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
		// Match Void (:818): clear the zone's removeStyles fns and dispose the inline mount before
		// tearing down the lookup tables, otherwise its highlight decoration and mounted widget
		// survive the delete.
		this._clearAllDiffAreaEffects(ctrlKZone);
		try {
			ctrlKZone._mountInfo?.dispose();
		} catch (err) {
			onUnexpectedError(err);
		}
		delete this.diffAreaOfId[ctrlKZone.diffareaid];
		this.diffAreasOfURI[ctrlKZone._URI.fsPath]?.delete(ctrlKZone.diffareaid.toString());
	}

	// ---------- Void's refresh-rebuild decoration pipeline ----------

	private _addLineDecoration(model: ITextModel, startLine: number, endLine: number, className: string, options?: Partial<IModelDecorationOptions>) {
		const decorationOptions = ModelDecorationOptions.createDynamic({
			className,
			description: className,
			isWholeLine: true,
			...(options ?? {}),
		});
		const ids = model.deltaDecorations([], [{
			range: new Range(startLine, 1, endLine, Number.MAX_SAFE_INTEGER),
			options: decorationOptions,
		}]);
		// Match Void (:300): deltaDecorations throws on a disposed model, so guard the teardown.
		return () => { if (!model.isDisposed()) { model.deltaDecorations(ids, []); } };
	}

	private _addDiffAreaStylesToURI(uri: URI): void {
		const model = this._modelService.getModel(uri);
		if (!model) {
			return;
		}

		for (const diffareaid of this.diffAreasOfURI[uri.fsPath] ?? []) {
			const diffArea = this.diffAreaOfId[diffareaid];
			if (!diffArea) {
				continue;
			}

			if (diffArea.type === 'DiffZone' && diffArea._streamState.isStreaming) {
				const fn1 = this._addLineDecoration(model, diffArea._streamState.line, diffArea._streamState.line, 'vsclone-sweepIdxBG');
				const fn2 = diffArea._streamState.line + 1 <= diffArea.endLine
					? this._addLineDecoration(model, diffArea._streamState.line + 1, diffArea.endLine, 'vsclone-sweepBG')
					: null;
				diffArea._removeStylesFns.add(() => { fn1?.(); fn2?.(); });
			} else if (diffArea.type === 'CtrlKZone' && diffArea._linkedStreamingDiffZone === null) {
				const fn = this._addLineDecoration(model, diffArea.startLine, diffArea.endLine, 'vsclone-highlightBG');
				diffArea._removeStylesFns.add(() => { fn?.(); });
			}
		}
	}

	private _addDiffStylesToURI(uri: URI, diff: VSCloneDiff): () => void {
		const disposeFns: (() => void)[] = [];
		const model = this._modelService.getModel(uri);

		// Green decoration over the new-file range (insertions and edits).
		if (diff.type !== 'deletion' && model) {
			const fn = this._addLineDecoration(model, diff.startLine, diff.endLine, 'vsclone-greenBG', {
				minimap: { color: { id: 'minimapGutter.addedBackground' }, position: 2 },
				overviewRuler: { color: { id: 'editorOverviewRuler.addedForeground' }, position: 7 },
			});
			disposeFns.push(() => { fn?.(); });
		}

		// Red view zone rendering the removed lines (deletions and edits).
		if (diff.type !== 'insertion') {
			const originalCode = diff.originalCode;
			const consistentZoneId = this._consistentItemService.addConsistentItemToURI({
				uri,
				fn: (editor) => {
					const domNode = document.createElement('div');
					domNode.className = 'vsclone-redBG';

					const renderOptions = RenderOptions.fromEditor(editor);
					const processedText = originalCode.replace(/\t/g, ' '.repeat(renderOptions.tabSize));
					const lines = processedText.split('\n');

					const linesContainer = document.createElement('div');
					linesContainer.style.fontFamily = renderOptions.fontInfo.fontFamily;
					linesContainer.style.fontSize = `${renderOptions.fontInfo.fontSize}px`;
					linesContainer.style.lineHeight = `${renderOptions.fontInfo.lineHeight}px`;
					linesContainer.style.whiteSpace = 'pre';
					linesContainer.style.position = 'relative';
					linesContainer.style.width = '100%';

					lines.forEach(line => {
						const lineDiv = document.createElement('div');
						lineDiv.className = 'view-line';
						lineDiv.style.whiteSpace = 'pre';
						lineDiv.style.position = 'relative';
						lineDiv.style.height = `${renderOptions.fontInfo.lineHeight}px`;

						const span = document.createElement('span');
						span.textContent = line || '\u00a0';
						span.style.whiteSpace = 'pre';
						span.style.display = 'inline-block';

						lineDiv.appendChild(span);
						linesContainer.appendChild(lineDiv);
					});

					domNode.appendChild(linesContainer);

					const heightInLines = lines.length;
					const minWidthInPx = Math.max(...lines.map(line =>
						Math.ceil(renderOptions.fontInfo.typicalFullwidthCharacterWidth * line.length),
					));

					const viewZone: IViewZone = {
						afterLineNumber: diff.startLine - 1,
						heightInLines,
						minWidthInPx,
						domNode,
						marginDomNode: document.createElement('div'),
						suppressMouseDown: false,
						showInHiddenAreas: false,
					};

					let zoneId: string | null = null;
					editor.changeViewZones(accessor => { zoneId = accessor.addZone(viewZone); });
					return () => editor.changeViewZones(accessor => { if (zoneId) { accessor.removeZone(zoneId); } });
				},
			});
			disposeFns.push(() => { this._consistentItemService.removeConsistentItemFromURI(consistentZoneId); });
		}

		// Accept / Reject inline widget for non-streaming zones.
		const diffZone = this.diffAreaOfId[diff.diffareaid];
		if (diffZone && diffZone.type === 'DiffZone' && !diffZone._streamState.isStreaming) {
			const diffid = diff.diffid;

			const consistentWidgetId = this._consistentItemService.addConsistentItemToURI({
				uri,
				fn: (editor) => {
					let startLine: number;
					let offsetLines: number;
					if (diff.type === 'insertion' || diff.type === 'edit') {
						startLine = diff.startLine;
						offsetLines = 0;
					} else if (diff.type === 'deletion') {
						if (diff.startLine === 1) {
							const numRedLines = diff.originalEndLine - diff.originalStartLine + 1;
							startLine = diff.startLine;
							offsetLines = -numRedLines;
						} else {
							startLine = diff.startLine - 1;
							offsetLines = 1;
						}
					} else {
						throw new Error('VSClone edit service: unknown diff.type');
					}

					const widget = this._instantiationService.createInstance(VSCloneAcceptRejectInlineWidget, {
						editor,
						onAccept: () => { this.acceptDiff({ diffid }); },
						onReject: () => { this.rejectDiff({ diffid }); },
						diffid: diffid.toString(),
						startLine,
						offsetLines,
					});
					return () => { widget.dispose(); };
				},
			});
			disposeFns.push(() => { this._consistentItemService.removeConsistentItemFromURI(consistentWidgetId); });
		}

		return () => { disposeFns.forEach(fn => fn()); };
	}

	private _computeDiffsAndAddStylesToURI(uri: URI): void {
		const model = this._modelService.getModel(uri);
		if (model === null || model === undefined) {
			return;
		}
		const fullFileText = model.getValue(EndOfLinePreference.LF);

		for (const diffareaid of this.diffAreasOfURI[uri.fsPath] ?? []) {
			const diffArea = this.diffAreaOfId[diffareaid];
			if (!diffArea || diffArea.type !== 'DiffZone') {
				continue;
			}

			const newDiffAreaCode = fullFileText.split('\n').slice(diffArea.startLine - 1, diffArea.endLine).join('\n');
			const computedDiffs = findDiffs(diffArea.originalCode, newDiffAreaCode);
			for (const computedDiff of computedDiffs) {
				// findDiffs produces zone-local line numbers; shift them into file coordinates.
				if (computedDiff.type === 'deletion') {
					computedDiff.startLine += diffArea.startLine - 1;
				} else {
					computedDiff.startLine += diffArea.startLine - 1;
					computedDiff.endLine += diffArea.startLine - 1;
				}
				this._addDiff(computedDiff, diffArea);
			}
		}
	}

	private _addDiff(computedDiff: VSCloneComputedDiff, diffZone: VSCloneDiffZone): VSCloneDiff {
		const uri = diffZone._URI;
		const diffid = this._diffidPool++;

		const newDiff: VSCloneDiff = {
			...computedDiff,
			diffid,
			diffareaid: diffZone.diffareaid,
		};

		const fn = this._addDiffStylesToURI(uri, newDiff);
		if (fn) {
			diffZone._removeStylesFns.add(fn);
		}

		this.diffOfId[diffid] = newDiff;
		diffZone._diffOfId[diffid] = newDiff;

		return newDiff;
	}

	private _clearAllDiffAreaEffects(diffArea: VSCloneDiffArea): void {
		if (diffArea.type === 'DiffZone') {
			// Tear down every diff record; the refresh pass that follows will rebuild via findDiffs.
			this.deleteDiffs(diffArea);
		}
		// Wrap each disposal so a single throwing style-remove fn (e.g. an already-disposed widget)
		// doesn't abort teardown mid-commit. Callers rely on this method to be non-throwing -- it
		// runs after filesystem writes in snapshot-restore and as part of the refresh pipeline.
		diffArea._removeStylesFns?.forEach(removeStyles => {
			try {
				removeStyles();
			} catch (err) {
				onUnexpectedError(err);
			}
		});
		diffArea._removeStylesFns?.clear();
	}

	private _clearAllEffects(uri: URI): void {
		for (const diffareaid of this.diffAreasOfURI[uri.fsPath] ?? []) {
			const diffArea = this.diffAreaOfId[diffareaid];
			if (!diffArea) {
				continue;
			}
			this._clearAllDiffAreaEffects(diffArea);
		}
	}

	private _fireChangeDiffsIfNotStreaming(uri: URI): void {
		for (const diffareaid of this.diffAreasOfURI[uri.fsPath] ?? []) {
			const diffArea = this.diffAreaOfId[diffareaid];
			if (!diffArea || diffArea.type !== 'DiffZone') {
				continue;
			}
			if (diffArea._streamState.isStreaming) {
				continue;
			}
			// Consumers (e.g., the Phase 3 command bar) rebuild their per-URI indexes from this.
			// The service itself does NOT re-subscribe to this event -- refresh is only called from
			// mutation sites, never via its own events, to avoid feedback loops.
			this._onDidChangeDiffsInDiffZoneNotStreaming.fire({ uri, diffareaid: diffArea.diffareaid });
		}
	}

	private _refreshStylesAndDiffsInURI(uri: URI): void {
		// If the model has not been loaded yet, skip the clear+rebuild cycle entirely. Otherwise
		// _clearAllEffects wipes _diffOfId and _computeDiffsAndAddStylesToURI can't rebuild (it
		// early-returns when the model is null), leaving the zone diff-less forever. The constructor's
		// onModelAdded listener will call this method again once the model loads.
		if (this._modelService.getModel(uri) === null) {
			return;
		}
		this._clearAllEffects(uri);
		this._addDiffAreaStylesToURI(uri);
		this._computeDiffsAndAddStylesToURI(uri);
		this._fireChangeDiffsIfNotStreaming(uri);
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

	private async _writeURIText(
		uri: URI,
		text: string,
		range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number },
	): Promise<void> {
		const modelReference = await this.safeCreateModelReference(uri);
		if (!modelReference) {
			return;
		}
		try {
			await this.bulkEditService.apply([new ResourceTextEdit(uri, {
				range: new Range(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn),
				text,
			})], { label: 'VSClone reject diff' });
		} finally {
			modelReference.dispose();
		}
	}

	private async writeWholeFile(uri: URI, text: string): Promise<boolean> {
		const modelReference = await this.safeCreateModelReference(uri);
		if (!modelReference) {
			// Snapshot restore can target files that no longer exist, so it follows the same parent
			// folder creation path as initial create_file rewrites to keep restore behavior symmetric.
			await this.fileService.createFolder(dirname(uri));
			const result = await this.bulkEditService.apply([new ResourceFileEdit(undefined, uri, {
				overwrite: true,
				ignoreIfExists: false,
				contents: Promise.resolve(VSBuffer.fromString(text)),
			})], { label: 'Restore VSClone file' });
			return result.isApplied;
		}

		try {
			const model = modelReference.object.textEditorModel;
			const lineCount = model.getLineCount();
			const lastLineLength = model.getLineMaxColumn(lineCount);
			const edit = new ResourceTextEdit(uri, {
				range: new Range(1, 1, lineCount, lastLineLength),
				text,
			});
			const result = await this.bulkEditService.apply([edit], { label: 'Restore VSClone file' });
			return result.isApplied;
		} finally {
			modelReference.dispose();
		}
	}
}

export function parseSearchReplaceBlocks(responseText: string, defaultFilePath?: string): readonly VSCloneParsedEdit[] {
	const normalized = responseText.replace(/\r\n/g, '\n');
	const blockPattern = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
	const edits: VSCloneParsedEdit[] = [];

	let match: RegExpExecArray | null;
	while ((match = blockPattern.exec(normalized)) !== null) {
		// When the caller already resolved a concrete URI, allow single-file SEARCH/REPLACE payloads
		// to omit File: headers. Multi-file transcript applies still rely on nearby File: lines.
		const filePath = findNearestFilePathLine(normalized, match.index) ?? defaultFilePath;
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
