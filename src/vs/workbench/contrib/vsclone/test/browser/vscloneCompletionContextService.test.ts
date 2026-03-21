/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { VSCloneCompletionContextService } from '../../browser/vscloneCompletionContextService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';

interface ITestModelDefinition {
	readonly resource: URI;
	readonly languageId: string;
	readonly content: string;
	readonly versionId?: number;
}

function createTextModel(definition: ITestModelDefinition): ITextModel {
	return {
		uri: definition.resource,
		getLanguageId: () => definition.languageId,
		getVersionId: () => definition.versionId ?? 1,
		getValueLength: () => definition.content.length,
		getValue: () => definition.content,
	} as unknown as ITextModel;
}

function createModelService(models: readonly ITextModel[]): IModelService {
	const modelsByResource = new Map(models.map(model => [model.uri.toString(), model]));

	return {
		_serviceBrand: undefined,
		createModel: () => { throw new Error('not implemented'); },
		updateModel: () => undefined,
		destroyModel: () => undefined,
		getModels: () => [...models],
		getCreationOptions: () => { throw new Error('not implemented'); },
		getModel: resource => modelsByResource.get(resource.toString()) ?? null,
		onModelAdded: Event.None,
		onModelRemoved: Event.None,
		onModelLanguageChanged: Event.None,
	};
}

function createEditorService(resources: readonly URI[]): IEditorService {
	return {
		_serviceBrand: undefined,
		editors: resources.map(resource => ({ resource })) as unknown as IEditorService['editors'],
		mostRecentlyActiveEditors: [],
	} as unknown as IEditorService;
}

suite('VSCloneCompletionContextService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns empty when no other editors are open', () => {
		const current = URI.file('/workspace/src/current.ts');
		const service = new VSCloneCompletionContextService(
			createEditorService([current]),
			createModelService([createTextModel({ resource: current, languageId: 'typescript', content: 'const current = true;\n' })]),
			new NullLogService(),
		);

		const snippets = service.gatherContext(current, 'typescript', 3, 2_000);
		assert.deepStrictEqual(snippets, []);
	});

	test('filters out the current file', () => {
		const current = URI.file('/workspace/src/current.ts');
		const helper = URI.file('/workspace/src/helper.ts');
		const service = new VSCloneCompletionContextService(
			createEditorService([current, helper]),
			createModelService([
				createTextModel({ resource: current, languageId: 'typescript', content: 'const current = true;\n' }),
				createTextModel({ resource: helper, languageId: 'typescript', content: 'export const helper = true;\n' }),
			]),
			new NullLogService(),
		);

		const snippets = service.gatherContext(current, 'typescript', 3, 2_000);
		assert.deepStrictEqual(snippets.map(snippet => snippet.filePath), [helper.fsPath]);
	});

	test('respects per-snippet and total character budgets', () => {
		const current = URI.file('/workspace/src/current.ts');
		const helpers = [
			URI.file('/workspace/src/a.ts'),
			URI.file('/workspace/src/b.ts'),
			URI.file('/workspace/src/c.ts'),
		];
		const longContent = `${'x'.repeat(2_500)}\n${'y'.repeat(500)}`;
		const service = new VSCloneCompletionContextService(
			createEditorService([current, ...helpers]),
			createModelService([
				createTextModel({ resource: current, languageId: 'typescript', content: 'const current = true;\n' }),
				...helpers.map(resource => createTextModel({ resource, languageId: 'typescript', content: longContent })),
			]),
			new NullLogService(),
		);

		const snippets = service.gatherContext(current, 'typescript', 3, 2_000);
		assert.ok(snippets.every(snippet => snippet.content.length <= 2_000));
		assert.ok(snippets.reduce((total, snippet) => total + snippet.content.length, 0) <= 5_000);
	});

	test('scores same-language files higher', () => {
		const current = URI.file('/workspace/src/current.ts');
		const sameLanguage = URI.file('/workspace/src/same.ts');
		const otherLanguage = URI.file('/workspace/src/other.py');
		const service = new VSCloneCompletionContextService(
			createEditorService([current, otherLanguage, sameLanguage]),
			createModelService([
				createTextModel({ resource: current, languageId: 'typescript', content: 'const current = true;\n' }),
				createTextModel({ resource: sameLanguage, languageId: 'typescript', content: `${'a'.repeat(4_000)}\n` }),
				createTextModel({ resource: otherLanguage, languageId: 'python', content: 'value = 1\n' }),
			]),
			new NullLogService(),
		);

		const snippets = service.gatherContext(current, 'typescript', 2, 2_000);
		assert.strictEqual(snippets[0].filePath, sameLanguage.fsPath);
	});

	test('returns at most the requested number of snippets', () => {
		const current = URI.file('/workspace/src/current.ts');
		const resources = [
			URI.file('/workspace/src/a.ts'),
			URI.file('/workspace/src/b.ts'),
			URI.file('/workspace/src/c.ts'),
			URI.file('/workspace/src/d.ts'),
		];
		const service = new VSCloneCompletionContextService(
			createEditorService([current, ...resources]),
			createModelService([
				createTextModel({ resource: current, languageId: 'typescript', content: 'const current = true;\n' }),
				...resources.map(resource => createTextModel({ resource, languageId: 'typescript', content: 'export const value = true;\n' })),
			]),
			new NullLogService(),
		);

		const snippets = service.gatherContext(current, 'typescript', 2, 2_000);
		assert.strictEqual(snippets.length, 2);
	});
});
