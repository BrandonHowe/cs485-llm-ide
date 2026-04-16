/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSCloneEditCodeService } from '../../browser/vscloneEditCodeService.js';

suite('VSCloneEditCodeService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function trackHarnessLifetime<T extends object>(service: T): T {
		// These tests use a prototype-only harness instead of constructing the full service graph, so
		// register a no-op disposable shell with the standard leak harness rather than calling the
		// real Disposable constructor path.
		return store.add(Object.assign(service, { dispose: () => undefined }));
	}

	function createServiceHarness(): VSCloneEditCodeService & {
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
		diffAreaOfId: Record<string, unknown>;
		diffAreasOfURI: Record<string, Set<string> | undefined>;
		diffOfId: Record<string, unknown>;
		assistantApplyDiffZoneIdsByURI: Map<string, Set<number>>;
		_diffareaidPool: number;
		_diffidPool: number;
		_onDidAddOrDeleteDiffZones: { fire: (value: unknown) => void };
		_onDidChangeDiffsInDiffZoneNotStreaming: { fire: (value: unknown) => void };
		bulkEditService: { apply: (edits: readonly unknown[], options: { label: string }) => Promise<{ isApplied: boolean }> };
	} {
		const service = Object.create(VSCloneEditCodeService.prototype) as VSCloneEditCodeService & {
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
			diffAreaOfId: Record<string, unknown>;
			diffAreasOfURI: Record<string, Set<string> | undefined>;
			diffOfId: Record<string, unknown>;
			assistantApplyDiffZoneIdsByURI: Map<string, Set<number>>;
			_diffareaidPool: number;
			_diffidPool: number;
			_onDidAddOrDeleteDiffZones: { fire: (value: unknown) => void };
			_onDidChangeDiffsInDiffZoneNotStreaming: { fire: (value: unknown) => void };
			bulkEditService: { apply: (edits: readonly unknown[], options: { label: string }) => Promise<{ isApplied: boolean }> };
		};
		service.diffAreaOfId = {};
		service.diffAreasOfURI = {};
		service.diffOfId = {};
		service.assistantApplyDiffZoneIdsByURI = new Map();
		service._diffareaidPool = 0;
		service._diffidPool = 0;
		service._onDidAddOrDeleteDiffZones = { fire: () => undefined };
		service._onDidChangeDiffsInDiffZoneNotStreaming = { fire: () => undefined };
		service.bulkEditService = {
			apply: async () => ({ isApplied: true }),
		};
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
		assert.strictEqual(Object.keys(service.diffOfId).length, 1);
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

	test('recordAppliedDiffZone replaces the previous assistant apply zone for the same file', () => {
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
		assert.strictEqual(Object.keys(service.diffOfId).length, 1);
	});
});
