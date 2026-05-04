/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
// These edit-service tests build narrow model/editor stubs to cover failure paths without pulling
// in the complete editor service implementation.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ResourceTextEdit } from '../../../../../editor/browser/services/bulkEditService.js';
import { SaveReason } from '../../../../common/editor.js';
import { VSCloneEditCodeService } from '../../browser/vscloneEditCodeService.js';
import type { VSCloneParsedEdit } from '../../browser/vscloneEditCodeServiceInterface.js';

suite('VSCloneEditCodeService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	type IVSCloneEditCodeServiceHarness = {
		instantlyApplySearchReplaceBlocks: VSCloneEditCodeService['instantlyApplySearchReplaceBlocks'];
		instantlyRewriteFile: VSCloneEditCodeService['instantlyRewriteFile'];
		applySearchReplaceBlocks: VSCloneEditCodeService['applySearchReplaceBlocks'];
		parseSearchReplaceBlocks: VSCloneEditCodeService['parseSearchReplaceBlocks'];
		startApplying: VSCloneEditCodeService['startApplying'];
		recordAppliedDiffZone: (plan: {
			uri: URI;
			action: 'create' | 'modify';
			originalContent: string | undefined;
			finalContent: string;
			appliedEdits: number;
			addedLines: number;
			removedLines: number;
			bulkEdit: unknown;
			fileChange: unknown;
			resolvedEdits: readonly unknown[];
		}) => void;
		undoEditApply: VSCloneEditCodeService['undoEditApply'];
		diffAreaOfId: Record<string, unknown>;
		diffAreasOfURI: Record<string, Set<string> | undefined>;
		diffOfId: Record<string, unknown>;
		assistantApplyDiffZoneIdsByURI: Map<string, Set<number>>;
		_diffareaidPool: number;
		_diffidPool: number;
		_onDidAddOrDeleteDiffZones: { fire: (value: unknown) => void };
		_onDidChangeDiffsInDiffZoneNotStreaming: { fire: (value: unknown) => void };
		_modelService: { getModel: (uri: URI) => null };
		bulkEditService: { apply: (edits: readonly unknown[], options: { label: string }) => Promise<{ isApplied: boolean }> };
		fileService: { exists: (uri: URI) => Promise<boolean>; createFolder: (uri: URI) => Promise<void> };
		textFileService: { isDirty: (uri: URI) => boolean; save: (uri: URI, options: { reason: SaveReason }) => Promise<URI | undefined> };
		textModelService: { createModelReference: (uri: URI) => Promise<{ object: { textEditorModel: { getValue: () => string; getLineCount: () => number; getLineMaxColumn: (lineNumber: number) => number } }; dispose: () => void }> };
		workspaceContextService: { getWorkspace: () => { folders: Array<{ uri: URI; name: string; index: number }> } };
		editorService: { openEditor: (input: { resource: URI }) => Promise<void> };
		safeCreateModelReference: (uri: URI) => Promise<{ object: { textEditorModel: { getValue: () => string; getLineCount: () => number; getLineMaxColumn: (lineNumber: number) => number } }; dispose: () => void } | undefined>;
	};

	function trackHarnessLifetime<T extends object>(service: T): T {
		// These tests use a prototype-only harness instead of constructing the full service graph, so
		// register a no-op disposable shell with the standard leak harness rather than calling the
		// real Disposable constructor path.
		return store.add(Object.assign(service, { dispose: () => undefined }));
	}

	function createServiceHarness(): IVSCloneEditCodeServiceHarness {
		// Cast through an explicit harness shape instead of intersecting with the class type because
		// these tests intentionally bypass the real constructor and private fields.
		const service = Object.create(VSCloneEditCodeService.prototype) as unknown as IVSCloneEditCodeServiceHarness;
		service.diffAreaOfId = {};
		service.diffAreasOfURI = {};
		service.diffOfId = {};
		service.assistantApplyDiffZoneIdsByURI = new Map();
		service._diffareaidPool = 0;
		service._diffidPool = 0;
		service._onDidAddOrDeleteDiffZones = { fire: () => undefined };
		service._onDidChangeDiffsInDiffZoneNotStreaming = { fire: () => undefined };
		// The constructor normally supplies this dependency. The prototype harness only cares about
		// bookkeeping state, so returning null exercises the production "model not loaded yet" path
		// without forcing editor decoration setup into these narrow unit tests.
		service._modelService = { getModel: () => null };
		service.bulkEditService = {
			apply: async () => ({ isApplied: true }),
		};
		service.fileService = {
			exists: async () => false,
			createFolder: async () => undefined,
		};
		service.textFileService = {
			isDirty: () => false,
			save: async uri => uri,
		};
		service.textModelService = {
			createModelReference: async () => {
				throw new Error('No default test model is registered.');
			},
		};
		service.workspaceContextService = {
			getWorkspace: () => ({ folders: [{ uri: URI.file('/workspace'), name: 'workspace', index: 0 }] }),
		};
		service.editorService = {
			openEditor: async () => undefined,
		};
		service.safeCreateModelReference = async () => undefined;
		return trackHarnessLifetime(service);
	}

	test('undoEditApply clears assistant apply diff zones for reverted files', async () => {
		const service = createServiceHarness();
		const uri = URI.file('/workspace/src/app.ts');
		service.recordAppliedDiffZone({
			uri,
			action: 'create',
			originalContent: undefined,
			finalContent: 'export const created = true;\n',
			appliedEdits: 1,
			addedLines: 1,
			removedLines: 0,
			bulkEdit: {},
			fileChange: {
				uri,
				displayPath: 'src/app.ts',
				addedLines: 1,
				removedLines: 0,
				action: 'create',
			},
			resolvedEdits: [],
		});

		assert.strictEqual(Object.keys(service.diffAreaOfId).length, 1);
		assert.strictEqual(service.assistantApplyDiffZoneIdsByURI.get(uri.fsPath)?.size, 1);

		const undoResult = await service.undoEditApply([{
			uri,
			displayPath: 'src/app.ts',
			addedLines: 1,
			removedLines: 0,
			action: 'create',
			originalContent: undefined,
		}]);

		assert.deepStrictEqual(undoResult, {
			revertedFiles: [uri],
			failures: [],
		});
		assert.strictEqual(Object.keys(service.diffAreaOfId).length, 0);
		assert.strictEqual(Object.keys(service.diffOfId).length, 0);
		assert.strictEqual(service.diffAreasOfURI[uri.fsPath]?.size ?? 0, 0);
		assert.strictEqual(service.assistantApplyDiffZoneIdsByURI.has(uri.fsPath), false);
	});

	test('recordAppliedDiffZone replaces previous assistant apply zones for the same file', () => {
		const service = createServiceHarness();
		const uri = URI.file('/workspace/src/app.ts');
		service.recordAppliedDiffZone({
			uri,
			action: 'create',
			originalContent: undefined,
			finalContent: 'export const first = true;\n',
			appliedEdits: 1,
			addedLines: 1,
			removedLines: 0,
			bulkEdit: {},
			fileChange: {
				uri,
				displayPath: 'src/app.ts',
				addedLines: 1,
				removedLines: 0,
				action: 'create',
			},
			resolvedEdits: [],
		});
		const firstZoneIds = [...(service.assistantApplyDiffZoneIdsByURI.get(uri.fsPath) ?? [])];
		assert.strictEqual(firstZoneIds.length, 1);

		service.recordAppliedDiffZone({
			uri,
			action: 'create',
			originalContent: undefined,
			finalContent: 'export const second = true;\n',
			appliedEdits: 1,
			addedLines: 1,
			removedLines: 0,
			bulkEdit: {},
			fileChange: {
				uri,
				displayPath: 'src/app.ts',
				addedLines: 1,
				removedLines: 0,
				action: 'create',
			},
			resolvedEdits: [],
		});

		const trackedZoneIds = [...(service.assistantApplyDiffZoneIdsByURI.get(uri.fsPath) ?? [])];
		assert.strictEqual(trackedZoneIds.length, 1);
		assert.notStrictEqual(trackedZoneIds[0], firstZoneIds[0]);
		assert.strictEqual(Object.keys(service.diffAreaOfId).length, 1);
		assert.strictEqual(service.diffAreasOfURI[uri.fsPath]?.has(firstZoneIds[0].toString()), false);
	});

	test('instantlyApplySearchReplaceBlocks accepts bare SEARCH/REPLACE blocks when the target URI is already known', async () => {
		const service = createServiceHarness();
		const uri = URI.file('/workspace/src/app.ts');
		const appliedResourceEdits: unknown[][] = [];
		const savedResources: Array<{ uri: URI; reason: SaveReason }> = [];
		service.safeCreateModelReference = async () => ({
			object: {
				textEditorModel: {
					getValue: () => 'alpha\nbeta\n',
					getLineCount: () => 2,
					getLineMaxColumn: (lineNumber: number) => lineNumber === 1 ? 6 : 5,
				},
			},
			dispose: () => undefined,
		});
		service.bulkEditService = {
			apply: async (edits) => {
				appliedResourceEdits.push([...edits]);
				return { isApplied: true };
			},
		};
		service.textFileService = {
			isDirty: candidate => candidate.toString() === uri.toString(),
			save: async (candidate, options) => {
				savedResources.push({ uri: candidate, reason: options.reason });
				return candidate;
			},
		};

		const result = await service.instantlyApplySearchReplaceBlocks({
			uri,
			searchReplaceBlocks: [
				'<<<<<<< SEARCH',
				'alpha',
				'=======',
				'ALPHA',
				'>>>>>>> REPLACE',
			].join('\n'),
		});

		assert.deepStrictEqual(result.failures, []);
		assert.strictEqual(result.appliedEdits, 1);
		assert.deepStrictEqual(result.modifiedFiles, [uri]);
		assert.strictEqual(appliedResourceEdits.length, 1);
		assert.strictEqual(appliedResourceEdits[0].length, 1);
		assert.ok(appliedResourceEdits[0][0] instanceof ResourceTextEdit);
		assert.deepStrictEqual(savedResources, [{ uri, reason: SaveReason.AUTO }]);
	});

	test('startApplying routes bare SEARCH/REPLACE payloads through the edit path when the target URI is already known', async () => {
		const service = createServiceHarness();
		const uri = URI.file('/workspace/src/app.ts');
		let applyCalls = 0;
		let rewriteCalls = 0;
		service.instantlyApplySearchReplaceBlocks = async ({ uri: target, searchReplaceBlocks }) => {
			applyCalls += 1;
			assert.strictEqual(target.toString(), uri.toString());
			assert.ok(searchReplaceBlocks.includes('<<<<<<< SEARCH'));
			return {
				attemptedEdits: 1,
				appliedEdits: 1,
				modifiedFiles: [uri],
				failures: [],
				fileChanges: [],
			};
		};
		service.instantlyRewriteFile = async () => {
			rewriteCalls += 1;
			return {
				attemptedEdits: 0,
				appliedEdits: 0,
				modifiedFiles: [],
				failures: [],
				fileChanges: [],
			};
		};

		const apply = service.startApplying({
			from: 'ClickApply',
			applyStr: [
				'<<<<<<< SEARCH',
				'alpha',
				'=======',
				'ALPHA',
				'>>>>>>> REPLACE',
			].join('\n'),
			uri,
			startBehavior: 'reject-conflicts',
		});

		assert.ok(apply);
		if (!apply) {
			return;
		}

		assert.strictEqual(apply[0].toString(), uri.toString());
		await apply[1];
		assert.strictEqual(applyCalls, 1);
		assert.strictEqual(rewriteCalls, 0);
	});

	test('startApplying routes plain payloads through the rewrite path when no SEARCH/REPLACE blocks are present', async () => {
		const service = createServiceHarness();
		const uri = URI.file('/workspace/src/app.ts');
		let applyCalls = 0;
		let rewriteCalls = 0;
		service.instantlyApplySearchReplaceBlocks = async () => {
			applyCalls += 1;
			return {
				attemptedEdits: 0,
				appliedEdits: 0,
				modifiedFiles: [],
				failures: [],
				fileChanges: [],
			};
		};
		service.instantlyRewriteFile = async ({ uri: target, newContent }) => {
			rewriteCalls += 1;
			assert.strictEqual(target.toString(), uri.toString());
			assert.strictEqual(newContent, 'export const rewritten = true;\n');
			return {
				attemptedEdits: 1,
				appliedEdits: 1,
				modifiedFiles: [uri],
				failures: [],
				fileChanges: [],
			};
		};

		const apply = service.startApplying({
			from: 'ClickApply',
			applyStr: 'export const rewritten = true;\n',
			uri,
			startBehavior: 'reject-conflicts',
		});

		assert.ok(apply);
		if (!apply) {
			return;
		}

		assert.strictEqual(apply[0].toString(), uri.toString());
		await apply[1];
		assert.strictEqual(applyCalls, 0);
		assert.strictEqual(rewriteCalls, 1);
	});

	test('instantlyRewriteFile creates missing files and records workspace-relative display paths', async () => {
		const service = createServiceHarness();
		const uri = URI.file('/workspace/src/new-file.ts');
		const createdFolders: string[] = [];
		const appliedLabels: string[] = [];
		const savedResources: Array<{ uri: URI; reason: SaveReason }> = [];
		let openedResource: URI | undefined;
		service.fileService = {
			exists: async () => false,
			createFolder: async folder => {
				createdFolders.push(folder.path);
			},
		};
		service.bulkEditService = {
			apply: async (_edits, options) => {
				appliedLabels.push(options.label);
				return { isApplied: true };
			},
		};
		service.editorService = {
			openEditor: async input => {
				openedResource = input.resource;
			},
		};
		service.textFileService = {
			isDirty: candidate => candidate.toString() === uri.toString(),
			save: async (candidate, options) => {
				savedResources.push({ uri: candidate, reason: options.reason });
				return candidate;
			},
		};

		const result = await service.instantlyRewriteFile({
			uri,
			newContent: 'export const created = true;\n',
		});

		assert.deepStrictEqual(createdFolders, ['/workspace/src']);
		assert.deepStrictEqual(appliedLabels, ['Rewrite VSClone file']);
		assert.deepStrictEqual(savedResources, [{ uri, reason: SaveReason.AUTO }]);
		assert.strictEqual(openedResource?.toString(), uri.toString());
		assert.strictEqual(result.appliedEdits, 1);
		assert.deepStrictEqual(result.modifiedFiles, [uri]);
		assert.deepStrictEqual(result.fileChanges, [{
			uri,
			displayPath: 'src/new-file.ts',
			addedLines: 1,
			removedLines: 0,
			action: 'create',
			originalContent: undefined,
		}]);
		assert.strictEqual(Object.keys(service.diffAreaOfId).length, 1);
	});

	test('instantlyRewriteFile reports bulk edit refusal without opening the editor or recording zones', async () => {
		const service = createServiceHarness();
		const uri = URI.file('/workspace/src/app.ts');
		let openCalls = 0;
		let saveCalls = 0;
		service.safeCreateModelReference = async () => ({
			object: {
				textEditorModel: {
					getValue: () => 'before\n',
					getLineCount: () => 1,
					getLineMaxColumn: () => 8,
				},
			},
			dispose: () => undefined,
		});
		service.bulkEditService = {
			apply: async () => ({ isApplied: false }),
		};
		service.editorService = {
			openEditor: async () => {
				openCalls += 1;
			},
		};
		service.textFileService = {
			isDirty: () => true,
			save: async candidate => {
				saveCalls += 1;
				return candidate;
			},
		};

		const result = await service.instantlyRewriteFile({
			uri,
			newContent: 'after\n',
		});

		assert.deepStrictEqual(result, {
			attemptedEdits: 1,
			appliedEdits: 0,
			modifiedFiles: [],
			failures: ['Workspace edit was not applied.'],
			fileChanges: [],
		});
		assert.strictEqual(openCalls, 0);
		assert.strictEqual(saveCalls, 0);
		assert.strictEqual(Object.keys(service.diffAreaOfId).length, 0);
	});

	test('instantlyApplySearchReplaceBlocks reports parse, open, match, and bulk-edit failures', async () => {
		const service = createServiceHarness();
		const uri = URI.file('/workspace/src/app.ts');

		const noBlocks = await service.instantlyApplySearchReplaceBlocks({
			uri,
			searchReplaceBlocks: 'plain text',
		});
		assert.deepStrictEqual(noBlocks.failures, ['No SEARCH/REPLACE blocks were found.']);
		assert.strictEqual(noBlocks.appliedEdits, 0);

		const openFailure = await service.instantlyApplySearchReplaceBlocks({
			uri,
			searchReplaceBlocks: [
				'<<<<<<< SEARCH',
				'before',
				'=======',
				'after',
				'>>>>>>> REPLACE',
			].join('\n'),
		});
		assert.deepStrictEqual(openFailure.failures, [`Could not open ${uri.toString()} for editing.`]);
		assert.strictEqual(openFailure.appliedEdits, 0);

		service.safeCreateModelReference = async () => ({
			object: {
				textEditorModel: {
					getValue: () => 'alpha\n',
					getLineCount: () => 1,
					getLineMaxColumn: () => 7,
				},
			},
			dispose: () => undefined,
		});

		const missingSearch = await service.instantlyApplySearchReplaceBlocks({
			uri,
			searchReplaceBlocks: [
				'<<<<<<< SEARCH',
				'beta',
				'=======',
				'BETA',
				'>>>>>>> REPLACE',
			].join('\n'),
		});
		assert.deepStrictEqual(missingSearch.failures, [`SEARCH block did not match in ${uri.toString()}: beta`]);
		assert.strictEqual(missingSearch.appliedEdits, 0);

		service.bulkEditService = {
			apply: async () => ({ isApplied: false }),
		};
		const refusedEdit = await service.instantlyApplySearchReplaceBlocks({
			uri,
			searchReplaceBlocks: [
				'<<<<<<< SEARCH',
				'alpha',
				'=======',
				'ALPHA',
				'>>>>>>> REPLACE',
			].join('\n'),
		});
		assert.deepStrictEqual(refusedEdit.failures, ['Workspace edit was not applied.']);
		assert.strictEqual(refusedEdit.appliedEdits, 0);
		assert.deepStrictEqual(refusedEdit.modifiedFiles, []);
	});

	test('applySearchReplaceBlocks handles create blocks, duplicate creates, and skipped replacements', async () => {
		const service = createServiceHarness();
		const uri = URI.file('/workspace/src/generated.ts');
		let appliedEditCount = 0;
		service.fileService = {
			exists: async (_candidate: URI) => false,
			createFolder: async () => undefined,
		};
		service.bulkEditService = {
			apply: async edits => {
				appliedEditCount = edits.length;
				return { isApplied: true };
			},
		};

		const result = await service.applySearchReplaceBlocks([
			'File: src/generated.ts',
			'<<<<<<< SEARCH',
			'',
			'=======',
			'export const first = true;',
			'>>>>>>> REPLACE',
			'File: src/generated.ts',
			'<<<<<<< SEARCH',
			'',
			'=======',
			'export const second = true;',
			'>>>>>>> REPLACE',
			'File: src/generated.ts',
			'<<<<<<< SEARCH',
			'first',
			'=======',
			'FIRST',
			'>>>>>>> REPLACE',
		].join('\n'));

		assert.strictEqual(appliedEditCount, 1);
		assert.strictEqual(result.appliedEdits, 1);
		assert.deepStrictEqual(result.modifiedFiles.map((resource: URI) => resource.toString()), [uri.toString()]);
		assert.deepStrictEqual(result.failures, [
			`Multiple create-file blocks target ${uri.toString()}; only the first block was used.`,
			`Skipped replacement edits for ${uri.toString()} because create-file syntax was also present.`,
		]);
		assert.deepStrictEqual(result.fileChanges, [{
			uri,
			displayPath: 'src/generated.ts',
			addedLines: 1,
			removedLines: 0,
			action: 'create',
			originalContent: undefined,
		}]);
	});

	test('applySearchReplaceBlocks uses basename display paths for files outside the workspace', async () => {
		const service = createServiceHarness();
		const uri = URI.file('/outside/app.ts');
		service.safeCreateModelReference = async () => ({
			object: {
				textEditorModel: {
					getValue: () => 'alpha\n',
					getLineCount: () => 1,
					getLineMaxColumn: () => 7,
				},
			},
			dispose: () => undefined,
		});

		const result = await service.applySearchReplaceBlocks([
			'File: /outside/app.ts',
			'<<<<<<< SEARCH',
			'alpha',
			'=======',
			'ALPHA',
			'>>>>>>> REPLACE',
		].join('\n'));

		assert.strictEqual(result.appliedEdits, 1);
		assert.strictEqual(result.fileChanges[0]?.displayPath, 'app.ts');
		assert.deepStrictEqual(result.modifiedFiles.map((resource: URI) => resource.toString()), [uri.toString()]);
	});

	test('undoEditApply reports missing snapshots, model-open failures, and refused undo edits', async () => {
		const service = createServiceHarness();
		const uri = URI.file('/workspace/src/app.ts');
		const noSnapshot = await service.undoEditApply([{
			uri,
			displayPath: 'src/app.ts',
			addedLines: 1,
			removedLines: 1,
			action: 'modify',
			originalContent: undefined,
		}]);
		assert.deepStrictEqual(noSnapshot, {
			revertedFiles: [],
			failures: [`No original snapshot recorded for ${uri.toString()}`],
		});

		const openFailure = await service.undoEditApply([{
			uri,
			displayPath: 'src/app.ts',
			addedLines: 1,
			removedLines: 1,
			action: 'modify',
			originalContent: 'before\n',
		}]);
		assert.deepStrictEqual(openFailure, {
			revertedFiles: [],
			failures: [`Could not open ${uri.toString()} to undo the change.`],
		});

		service.safeCreateModelReference = async () => ({
			object: {
				textEditorModel: {
					getValue: () => 'after\n',
					getLineCount: () => 1,
					getLineMaxColumn: () => 7,
				},
			},
			dispose: () => undefined,
		});
		service.bulkEditService = {
			apply: async () => ({ isApplied: false }),
		};

		const refusedUndo = await service.undoEditApply([{
			uri,
			displayPath: 'src/app.ts',
			addedLines: 1,
			removedLines: 1,
			action: 'modify',
			originalContent: 'before\n',
		}]);
		assert.deepStrictEqual(refusedUndo, {
			revertedFiles: [],
			failures: ['Workspace undo edit was not applied.'],
		});
	});

	test('parseSearchReplaceBlocks handles CRLF blocks, quoted file headers, and default file paths', () => {
		const service = createServiceHarness();
		const parsed = service.parseSearchReplaceBlocks([
			'- File: `"src/app.ts"`',
			'<<<<<<< SEARCH',
			'alpha',
			'=======',
			'ALPHA',
			'>>>>>>> REPLACE',
			'File: \'src/second.ts\'',
			'<<<<<<< SEARCH',
			'beta',
			'=======',
			'BETA',
			'>>>>>>> REPLACE',
		].join('\r\n'));

		assert.deepStrictEqual(parsed.map((edit: VSCloneParsedEdit) => ({
			filePath: edit.filePath,
			searchText: edit.searchText,
			replaceText: edit.replaceText,
		})), [{
			filePath: 'src/app.ts',
			searchText: 'alpha',
			replaceText: 'ALPHA',
		}, {
			filePath: 'src/second.ts',
			searchText: 'beta',
			replaceText: 'BETA',
		}]);

		const omittedHeader = service.parseSearchReplaceBlocks([
			'<<<<<<< SEARCH',
			'gamma',
			'=======',
			'GAMMA',
			'>>>>>>> REPLACE',
		].join('\n'));
		assert.deepStrictEqual(omittedHeader, []);

		const defaulted = service.parseSearchReplaceBlocks([
			'<<<<<<< SEARCH',
			'gamma',
			'=======',
			'GAMMA',
			'>>>>>>> REPLACE',
		].join('\n'), URI.file('/workspace/src/default.ts').toString());
		assert.strictEqual(defaulted[0]?.filePath, URI.file('/workspace/src/default.ts').toString());
	});

	test('Ctrl+K zones preserve overlap rules and streaming state bookkeeping', () => {
		const service = createServiceHarness() as unknown as IVSCloneEditCodeServiceHarness & {
			addCtrlKZone: VSCloneEditCodeService['addCtrlKZone'];
			removeCtrlKZone: VSCloneEditCodeService['removeCtrlKZone'];
			isCtrlKZoneStreaming: VSCloneEditCodeService['isCtrlKZoneStreaming'];
			interruptCtrlKStreaming: VSCloneEditCodeService['interruptCtrlKStreaming'];
			_refreshStylesAndDiffsInURI(uri: URI): void;
		};
		const uri = URI.file('/workspace/src/app.ts');
		const revealedLines: number[] = [];
		let refreshCalls = 0;
		service._refreshStylesAndDiffsInURI = () => {
			refreshCalls += 1;
		};
		(service as unknown as { _onDidChangeStreamingInCtrlKZone: { fire(value: unknown): void } })._onDidChangeStreamingInCtrlKZone = { fire: () => undefined };
		const editor = {
			getId: () => 'editor-1',
			getModel: () => ({ uri }),
			revealLine: (line: number) => revealedLines.push(line),
		};

		const firstZoneId = service.addCtrlKZone({ startLine: 3, endLine: 5, editor: editor as never });
		assert.strictEqual(firstZoneId, 0);
		assert.strictEqual(refreshCalls, 1);
		assert.strictEqual(Object.keys(service.diffAreaOfId).length, 1);

		const overlappingZoneId = service.addCtrlKZone({ startLine: 4, endLine: 4, editor: editor as never });
		assert.strictEqual(overlappingZoneId, firstZoneId);
		assert.deepStrictEqual(revealedLines, [3]);

		const ctrlKZone = service.diffAreaOfId[firstZoneId! as number] as { _linkedStreamingDiffZone: number | null };
		ctrlKZone._linkedStreamingDiffZone = 99;
		assert.strictEqual(service.isCtrlKZoneStreaming({ diffareaid: firstZoneId! }), true);
		service.interruptCtrlKStreaming({ diffareaid: firstZoneId! });
		assert.strictEqual(service.isCtrlKZoneStreaming({ diffareaid: firstZoneId! }), false);

		service.removeCtrlKZone({ diffareaid: firstZoneId! });
		assert.strictEqual(Object.keys(service.diffAreaOfId).length, 0);
		assert.strictEqual(service.diffAreasOfURI[uri.fsPath]?.size ?? 0, 0);
		assert.strictEqual(refreshCalls, 2);

		service.diffAreaOfId[7] = {
			type: 'DiffZone',
			diffareaid: 7,
			startLine: 10,
			endLine: 12,
			originalCode: 'before',
			_URI: uri,
			_diffOfId: {},
			_streamState: { isStreaming: false },
			_removeStylesFns: new Set(),
		};
		service.diffAreasOfURI[uri.fsPath] = new Set(['7']);
		assert.strictEqual(service.addCtrlKZone({ startLine: 11, endLine: 11, editor: editor as never }), undefined);
	});

	test('snapshots and restores diff and Ctrl+K zones atomically around file writes', async () => {
		const service = createServiceHarness() as unknown as IVSCloneEditCodeServiceHarness & {
			getVSCloneFileSnapshot: VSCloneEditCodeService['getVSCloneFileSnapshot'];
			restoreVSCloneFileSnapshotAsync(uri: URI, snapshot: ReturnType<VSCloneEditCodeService['getVSCloneFileSnapshot']>): Promise<void>;
			writeWholeFile(uri: URI, text: string): Promise<boolean>;
			_refreshStylesAndDiffsInURI(uri: URI): void;
		};
		const uri = URI.file('/workspace/src/app.ts');
		const calls: string[] = [];
		service._modelService = {
			getModel: () => ({
				getValue: () => 'live file\n',
			}),
		};
		service.writeWholeFile = async (_uri, text) => {
			calls.push(`write:${text}`);
			return true;
		};
		service._refreshStylesAndDiffsInURI = () => calls.push('refresh');
		service.diffAreaOfId[1] = {
			type: 'DiffZone',
			diffareaid: 1,
			startLine: 1,
			endLine: 1,
			originalCode: 'before\n',
			_URI: uri,
			_diffOfId: {},
			_streamState: { isStreaming: true, line: 1 },
			_removeStylesFns: new Set(),
		};
		service.diffAreaOfId[2] = {
			type: 'CtrlKZone',
			diffareaid: 2,
			startLine: 3,
			endLine: 4,
			editorId: 'editor-1',
			_URI: uri,
			_removeStylesFns: new Set(),
			_mountInfo: null,
			_linkedStreamingDiffZone: 1,
		};
		service.diffAreasOfURI[uri.fsPath] = new Set(['1', '2']);

		const snapshot = service.getVSCloneFileSnapshot(uri);
		assert.strictEqual(snapshot.entireFileCode, 'live file\n');
		assert.deepStrictEqual(Object.keys(snapshot.snapshottedDiffAreaOfId).sort(), ['1', '2']);

		service.diffAreaOfId[3] = {
			type: 'DiffZone',
			diffareaid: 3,
			startLine: 9,
			endLine: 9,
			originalCode: 'stale',
			_URI: uri,
			_diffOfId: {},
			_streamState: { isStreaming: false },
			_removeStylesFns: new Set([() => calls.push('dispose-stale')]),
		};
		service.diffAreasOfURI[uri.fsPath]?.add('3');

		await service.restoreVSCloneFileSnapshotAsync(uri, snapshot);

		assert.deepStrictEqual(calls, ['write:live file\n', 'dispose-stale', 'refresh']);
		assert.deepStrictEqual(Object.keys(service.diffAreaOfId).sort(), ['1', '2']);
		assert.strictEqual((service.diffAreaOfId[1] as { _streamState: { isStreaming: boolean } })._streamState.isStreaming, false);
		assert.strictEqual((service.diffAreaOfId[2] as { _linkedStreamingDiffZone: number | null })._linkedStreamingDiffZone, null);

		await assert.rejects(
			() => service.restoreVSCloneFileSnapshotAsync(uri, {
				entireFileCode: 'bad\n',
				snapshottedDiffAreaOfId: {
					4: {
						type: 'CtrlKZone',
						diffareaid: 4,
						startLine: 1,
						endLine: 1,
					},
				},
			} as never),
			/Ctrl\+K snapshots must retain editorId/,
		);
	});

	test('safeCreateModelReference converts resolver exceptions into undefined', async () => {
		const service = createServiceHarness();
		const uri = URI.file('/workspace/src/app.ts');
		let createAttempts = 0;
		// Delete the test stub so this assertion covers the production helper's catch branch.
		delete (service as Partial<IVSCloneEditCodeServiceHarness>).safeCreateModelReference;
		service.textModelService = {
			createModelReference: async () => {
				createAttempts += 1;
				throw new Error('resolver failed');
			},
		};

		const reference = await service.safeCreateModelReference(uri);

		assert.strictEqual(reference, undefined);
		assert.strictEqual(createAttempts, 1);
	});
});
