/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ResourceTextEdit } from '../../../../../editor/browser/services/bulkEditService.js';
import { VSCloneEditCodeService } from '../../browser/vscloneEditCodeService.js';

suite('VSCloneEditCodeService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	type IVSCloneEditCodeServiceHarness = {
		instantlyApplySearchReplaceBlocks: VSCloneEditCodeService['instantlyApplySearchReplaceBlocks'];
		instantlyRewriteFile: VSCloneEditCodeService['instantlyRewriteFile'];
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

	test('recordAppliedDiffZone keeps previous assistant apply zones for the same file', () => {
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
		assert.strictEqual(trackedZoneIds.length, 2);
		assert.strictEqual(trackedZoneIds.includes(firstZoneIds[0]), true);
		assert.notStrictEqual(trackedZoneIds[1], firstZoneIds[0]);
		assert.strictEqual(Object.keys(service.diffAreaOfId).length, 2);
	});

	test('instantlyApplySearchReplaceBlocks accepts bare SEARCH/REPLACE blocks when the target URI is already known', async () => {
		const service = createServiceHarness();
		const uri = URI.file('/workspace/src/app.ts');
		const appliedResourceEdits: unknown[][] = [];
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
});
