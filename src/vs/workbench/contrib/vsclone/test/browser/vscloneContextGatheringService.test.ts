/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EditorType } from '../../../../../editor/common/editorCommon.js';
import { IFileService, IFileStat } from '../../../../../platform/files/common/files.js';
import { IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { VSCloneContextGatheringService } from '../../browser/vscloneContextGatheringService.js';

interface IContextGatheringServiceInternals {
	getActiveFileContext(): {
		uri: URI;
		languageId: string;
		content: string;
		selection?: string;
		selectionRange?: { startLine: number; endLine: number };
	} | undefined;
	getOpenFiles(): readonly URI[];
	getDiagnostics(resource: URI | undefined): readonly { uri: URI; message: string; severity: string; line: number }[];
	toSeverityLabel(severity: MarkerSeverity): string;
	buildDirectoryTree(workspaceFolders: readonly { name: string; uri: URI }[]): Promise<string>;
	appendDirectoryChildren(resource: URI, prefix: string, depth: number, lines: string[], budget: { remaining: number; truncated: boolean }): Promise<void>;
	pushLineWithinBudget(lines: string[], line: string, budget: { remaining: number; truncated: boolean }): boolean;
}

function createTextModel(resource: URI, content: string, languageId = 'typescript'): ITextModel {
	return {
		uri: resource,
		getLanguageId: () => languageId,
		getValue: () => content,
		getValueInRange: (selection: Selection) => {
			const lines = content.replace(/\r\n/g, '\n').split('\n');
			const startLine = selection.startLineNumber - 1;
			const endLine = selection.endLineNumber - 1;
			if (startLine === endLine) {
				return (lines[startLine] ?? '').slice(selection.startColumn - 1, selection.endColumn - 1);
			}

			const parts = [
				(lines[startLine] ?? '').slice(selection.startColumn - 1),
			];
			for (let line = startLine + 1; line < endLine; line++) {
				parts.push(lines[line] ?? '');
			}
			parts.push((lines[endLine] ?? '').slice(0, selection.endColumn - 1));
			return parts.join('\n');
		},
	} as unknown as ITextModel;
}

function createCodeEditor(model: ITextModel | null, selection: Selection | null) {
	return {
		getEditorType: () => EditorType.ICodeEditor,
		getModel: () => model,
		getSelection: () => selection,
	};
}

function createEditorService(activeTextEditorControl: unknown, editors: readonly unknown[]): IEditorService {
	return {
		_serviceBrand: undefined,
		activeTextEditorControl,
		editors,
		mostRecentlyActiveEditors: [],
	} as unknown as IEditorService;
}

function createWorkspaceContextService(folders: readonly { name: string; uri: URI }[]): IWorkspaceContextService {
	return {
		_serviceBrand: undefined,
		getWorkspace: () => ({ folders }),
	} as unknown as IWorkspaceContextService;
}

function createModelService(models: readonly ITextModel[]): IModelService {
	const modelsByUri = new Map(models.map(model => [model.uri.toString(), model]));

	return {
		_serviceBrand: undefined,
		createModel: () => { throw new Error('not implemented'); },
		updateModel: () => undefined,
		destroyModel: () => undefined,
		getModels: () => [...models],
		getCreationOptions: () => { throw new Error('not implemented'); },
		getModel: (resource: URI) => modelsByUri.get(resource.toString()) ?? null,
		onModelAdded: { on: () => undefined } as never,
		onModelRemoved: { on: () => undefined } as never,
		onModelLanguageChanged: { on: () => undefined } as never,
	} as unknown as IModelService;
}

function createMarkerService(markersByResource: Map<string, readonly unknown[]>): IMarkerService {
	return {
		_serviceBrand: undefined,
		getStatistics: () => ({ toString: () => '' } as never),
		changeOne: () => undefined,
		changeAll: () => undefined,
		remove: () => undefined,
		read: (filter: { resource?: URI } | undefined) => (markersByResource.get(filter?.resource?.toString() ?? '') ?? []) as never[],
		installResourceFilter: () => ({ dispose: () => undefined }),
		onMarkerChanged: { on: () => undefined } as never,
	} as unknown as IMarkerService;
}

function createFileStat(resource: URI, children: readonly IFileStat[] | undefined = undefined): IFileStat {
	return {
		name: resource.path.split('/').filter(Boolean).pop() ?? resource.fsPath,
		resource,
		isDirectory: true,
		mtime: 0,
		ctime: 0,
		size: 0,
		etag: undefined,
		readonly: false,
		children,
	} as unknown as IFileStat;
}

function createFileService(statsByResource: Map<string, IFileStat>): IFileService {
	return {
		_serviceBrand: undefined,
		resolve: async (resource: URI) => {
			const stat = statsByResource.get(resource.toString());
			if (!stat) {
				throw new Error(`Missing stat for ${resource.toString()}`);
			}
			return stat;
		},
	} as unknown as IFileService;
}

suite('VSCloneContextGatheringService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('constructs with lightweight collaborators', () => {
		const service = new VSCloneContextGatheringService(
			createEditorService(undefined, []),
			createWorkspaceContextService([]),
			createFileService(new Map()),
			createMarkerService(new Map()),
			createModelService([]),
		);

		assert.strictEqual(typeof service.gatherContext, 'function');
	});

	test('gatherContext returns active file data, open files, tree, and diagnostics', async () => {
		const active = URI.file('/workspace/src/app.ts');
		const helper = URI.file('/workspace/src/helper.ts');
		const workspaceRoot = URI.file('/workspace');
		const originalModel = createTextModel(active, 'first line\nold selection\nthird line');
		const liveModel = createTextModel(active, 'first line\nnew selection\nthird line');
		const service = new VSCloneContextGatheringService(
			createEditorService(
				createCodeEditor(originalModel, new Selection(2, 1, 2, 4)),
				[
					{ resource: active },
					{ resource: active },
					{},
					{ resource: helper },
				],
			),
			createWorkspaceContextService([{ name: 'workspace', uri: workspaceRoot }]),
			createFileService(new Map([
				[workspaceRoot.toString(), createFileStat(workspaceRoot, [])],
			])),
			createMarkerService(new Map([
				[active.toString(), [
					{ resource: active, message: 'problem', severity: MarkerSeverity.Error, startLineNumber: 2 },
					{ resource: active, message: 'note', severity: MarkerSeverity.Info, startLineNumber: 3 },
				]],
			])),
			createModelService([liveModel]),
		);

		const result = await service.gatherContext();

		assert.deepStrictEqual(
			{
				activeFile: {
					uri: result.activeFile?.uri.toString(),
					languageId: result.activeFile?.languageId,
					content: result.activeFile?.content,
					selection: result.activeFile?.selection,
					selectionRange: result.activeFile?.selectionRange,
				},
				openFiles: result.openFiles.map(uri => uri.toString()),
				workspaceFolders: result.workspaceFolders.map(folder => ({ name: folder.name, uri: folder.uri.toString() })),
				directoryTree: result.directoryTree,
				diagnostics: result.diagnostics.map(diag => ({ uri: diag.uri.toString(), message: diag.message, severity: diag.severity, line: diag.line })),
			},
			{
				activeFile: {
					uri: active.toString(),
					languageId: 'typescript',
					content: 'first line\nnew selection\nthird line',
					selection: 'new',
					selectionRange: { startLine: 2, endLine: 2 },
				},
				openFiles: [active.toString(), helper.toString()],
				workspaceFolders: [{ name: 'workspace', uri: workspaceRoot.toString() }],
				directoryTree: 'workspace/',
				diagnostics: [
					{ uri: active.toString(), message: 'problem', severity: 'error', line: 2 },
					{ uri: active.toString(), message: 'note', severity: 'info', line: 3 },
				],
			},
		);
	});

	test('getActiveFileContext returns undefined without a code editor', () => {
		const service = new VSCloneContextGatheringService(
			createEditorService(undefined, []),
			createWorkspaceContextService([]),
			createFileService(new Map()),
			createMarkerService(new Map()),
			createModelService([]),
		) as unknown as IContextGatheringServiceInternals;

		assert.strictEqual(service.getActiveFileContext(), undefined);
	});

	test('getActiveFileContext prefers the live model and preserves the cursor range', () => {
		const active = URI.file('/workspace/src/app.ts');
		const originalModel = createTextModel(active, 'first line\nold selection\nthird line');
		const liveModel = createTextModel(active, 'first line\nnew selection\nthird line');
		const service = new VSCloneContextGatheringService(
			createEditorService(createCodeEditor(originalModel, new Selection(2, 1, 2, 4)), []),
			createWorkspaceContextService([]),
			createFileService(new Map()),
			createMarkerService(new Map()),
			createModelService([liveModel]),
		) as unknown as IContextGatheringServiceInternals;

		assert.deepStrictEqual(service.getActiveFileContext(), {
			uri: active,
			languageId: 'typescript',
			content: 'first line\nnew selection\nthird line',
			selection: 'new',
			selectionRange: { startLine: 2, endLine: 2 },
		});
	});

	test('getOpenFiles filters undefined inputs, deduplicates, and preserves first-seen order', () => {
		const active = URI.file('/workspace/src/app.ts');
		const helper = URI.file('/workspace/src/helper.ts');
		const service = new VSCloneContextGatheringService(
			createEditorService(undefined, [
				{ resource: active },
				{ resource: active },
				{},
				{ resource: helper },
			]),
			createWorkspaceContextService([]),
			createFileService(new Map()),
			createMarkerService(new Map()),
			createModelService([]),
		) as unknown as IContextGatheringServiceInternals;

		assert.deepStrictEqual(service.getOpenFiles().map(uri => uri.toString()), [active.toString(), helper.toString()]);
	});

	test('getDiagnostics returns an empty list for missing resources and maps marker severities', () => {
		const active = URI.file('/workspace/src/app.ts');
		const service = new VSCloneContextGatheringService(
			createEditorService(undefined, []),
			createWorkspaceContextService([]),
			createFileService(new Map()),
			createMarkerService(new Map([
				[active.toString(), [
					{ resource: active, message: 'problem', severity: MarkerSeverity.Error, startLineNumber: 7 },
					{ resource: active, message: 'warning', severity: MarkerSeverity.Warning, startLineNumber: 8 },
					{ resource: active, message: 'hint', severity: MarkerSeverity.Hint, startLineNumber: 9 },
				]],
			])),
			createModelService([]),
		) as unknown as IContextGatheringServiceInternals;

		assert.deepStrictEqual(service.getDiagnostics(undefined), []);
		assert.deepStrictEqual(service.getDiagnostics(active), [
			{ uri: active, message: 'problem', severity: 'error', line: 7 },
			{ uri: active, message: 'warning', severity: 'warning', line: 8 },
			{ uri: active, message: 'hint', severity: 'hint', line: 9 },
		]);
	});

	test('toSeverityLabel maps known severities to stable labels', () => {
		const service = new VSCloneContextGatheringService(
			createEditorService(undefined, []),
			createWorkspaceContextService([]),
			createFileService(new Map()),
			createMarkerService(new Map()),
			createModelService([]),
		) as unknown as IContextGatheringServiceInternals;

		assert.strictEqual(service.toSeverityLabel(MarkerSeverity.Error), 'error');
		assert.strictEqual(service.toSeverityLabel(MarkerSeverity.Warning), 'warning');
		assert.strictEqual(service.toSeverityLabel(MarkerSeverity.Info), 'info');
		assert.strictEqual(service.toSeverityLabel(MarkerSeverity.Hint), 'hint');
	});

	test('buildDirectoryTree returns the empty-workspace marker and formats multiple roots', async () => {
		const first = URI.file('/workspace-a');
		const second = URI.file('/workspace-b');
		const service = new VSCloneContextGatheringService(
			createEditorService(undefined, []),
			createWorkspaceContextService([]),
			createFileService(new Map([
				[first.toString(), createFileStat(first, [])],
				[second.toString(), createFileStat(second, [])],
			])),
			createMarkerService(new Map()),
			createModelService([]),
		) as unknown as IContextGatheringServiceInternals;

		assert.strictEqual(await service.buildDirectoryTree([]), '(no workspace folders)');
		assert.strictEqual(await service.buildDirectoryTree([
			{ name: 'workspace-a', uri: first },
			{ name: 'workspace-b', uri: second },
		]), 'workspace-a/\n\nworkspace-b/');
	});

	test('buildDirectoryTree truncates when the first line exceeds the budget', async () => {
		const root = URI.file('/workspace');
		const service = new VSCloneContextGatheringService(
			createEditorService(undefined, []),
			createWorkspaceContextService([]),
			createFileService(new Map()),
			createMarkerService(new Map()),
			createModelService([]),
		) as unknown as IContextGatheringServiceInternals;

		assert.strictEqual(await service.buildDirectoryTree([
			{ name: 'x'.repeat(15_000), uri: root },
		]), '... (truncated)');
	});

	test('appendDirectoryChildren filters ignored names, sorts directories first, and summarizes overflow', async () => {
		const root = URI.file('/workspace');
		const docs = URI.file('/workspace/docs');
		const src = URI.file('/workspace/src');
		const zzz = URI.file('/workspace/zzz');
		const service = new VSCloneContextGatheringService(
			createEditorService(undefined, []),
			createWorkspaceContextService([]),
			createFileService(new Map([
				[root.toString(), createFileStat(root, [
					createFileStat(URI.file('/workspace/node_modules')),
					createFileStat(docs),
					createFileStat(src),
					createFileStat(zzz),
					{ resource: URI.file('/workspace/a.txt'), name: 'a.txt', isDirectory: false } as IFileStat,
					{ resource: URI.file('/workspace/b.txt'), name: 'b.txt', isDirectory: false } as IFileStat,
				])],
				[docs.toString(), createFileStat(docs, [])],
				[src.toString(), createFileStat(src, [])],
				[zzz.toString(), createFileStat(zzz, [])],
			])),
			createMarkerService(new Map()),
			createModelService([]),
		) as unknown as IContextGatheringServiceInternals;

		const lines: string[] = [];
		await service.appendDirectoryChildren(root, '', 0, lines, { remaining: 1_000, truncated: false });

		assert.deepStrictEqual(lines, ['├── docs/', '├── src/', '└── zzz/', '└── ...']);
	});

	test('appendDirectoryChildren formats recursive prefixes and stops at the configured depth', async () => {
		const root = URI.file('/workspace');
		const dir1 = URI.file('/workspace/dir1');
		const dir2 = URI.file('/workspace/dir1/dir2');
		const dir3 = URI.file('/workspace/dir1/dir2/dir3');
		const deep = URI.file('/workspace/dir1/dir2/dir3/deep.txt');
		const service = new VSCloneContextGatheringService(
			createEditorService(undefined, []),
			createWorkspaceContextService([]),
			createFileService(new Map([
				[root.toString(), createFileStat(root, [createFileStat(dir1)])],
				[dir1.toString(), createFileStat(dir1, [createFileStat(dir2)])],
				[dir2.toString(), createFileStat(dir2, [createFileStat(dir3)])],
				[dir3.toString(), createFileStat(dir3, [{ resource: deep, name: 'deep.txt', isDirectory: false } as IFileStat])],
			])),
			createMarkerService(new Map()),
			createModelService([]),
		) as unknown as IContextGatheringServiceInternals;

		const lines: string[] = [];
		await service.appendDirectoryChildren(root, '', 0, lines, { remaining: 1_000, truncated: false });

		assert.deepStrictEqual(lines, ['└── dir1/', '    └── dir2/', '        └── dir3/']);
	});

	test('pushLineWithinBudget updates the remaining budget and marks truncation when the line does not fit', () => {
		const service = new VSCloneContextGatheringService(
			createEditorService(undefined, []),
			createWorkspaceContextService([]),
			createFileService(new Map()),
			createMarkerService(new Map()),
			createModelService([]),
		) as unknown as IContextGatheringServiceInternals;

		const lines: string[] = [];
		const budget = { remaining: 5, truncated: false };
		assert.strictEqual(service.pushLineWithinBudget(lines, 'abc', budget), true);
		assert.deepStrictEqual(lines, ['abc']);
		assert.deepStrictEqual(budget, { remaining: 1, truncated: false });

		const secondBudget = { remaining: 3, truncated: false };
		assert.strictEqual(service.pushLineWithinBudget(lines, 'abcd', secondBudget), false);
		assert.deepStrictEqual(lines, ['abc']);
		assert.deepStrictEqual(secondBudget, { remaining: 3, truncated: true });
	});
});
