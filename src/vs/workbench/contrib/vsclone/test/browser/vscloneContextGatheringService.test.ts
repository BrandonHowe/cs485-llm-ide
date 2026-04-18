/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { EditorType } from '../../../../../editor/common/editorCommon.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
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

function createEditorService(activeTextEditorControl: unknown): IEditorService {
	return {
		_serviceBrand: undefined,
		activeTextEditorControl,
		editors: [],
		mostRecentlyActiveEditors: [],
	} as unknown as IEditorService;
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

suite('VSCloneContextGatheringService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('constructs with the lightweight collaborators that remain after prompt-stack cleanup', () => {
		const service = new VSCloneContextGatheringService(
			createEditorService(undefined),
			createModelService([]),
		);

		assert.strictEqual(typeof service.gatherContext, 'function');
	});

	test('gatherContext returns only the active editor summary used by prompt assembly', async () => {
		const active = URI.file('/workspace/src/app.ts');
		const originalModel = createTextModel(active, 'first line\nold selection\nthird line');
		const liveModel = createTextModel(active, 'first line\nnew selection\nthird line');
		const service = new VSCloneContextGatheringService(
			createEditorService(createCodeEditor(originalModel, new Selection(2, 1, 2, 4))),
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
			},
			{
				activeFile: {
					uri: active.toString(),
					languageId: 'typescript',
					content: 'first line\nnew selection\nthird line',
					selection: 'new',
					selectionRange: { startLine: 2, endLine: 2 },
				},
			},
		);
	});

	test('getActiveFileContext returns undefined without a code editor', () => {
		const service = new VSCloneContextGatheringService(
			createEditorService(undefined),
			createModelService([]),
		) as unknown as IContextGatheringServiceInternals;

		assert.strictEqual(service.getActiveFileContext(), undefined);
	});

	test('getActiveFileContext prefers the live model and preserves the cursor range', () => {
		const active = URI.file('/workspace/src/app.ts');
		const originalModel = createTextModel(active, 'first line\nold selection\nthird line');
		const liveModel = createTextModel(active, 'first line\nnew selection\nthird line');
		const service = new VSCloneContextGatheringService(
			createEditorService(createCodeEditor(originalModel, new Selection(2, 1, 2, 4))),
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
});
