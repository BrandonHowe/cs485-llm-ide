/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { VSCloneAutocompleteService } from '../../browser/vscloneAutocompleteService.js';
import { IVSCloneCompletionApiService } from '../../browser/vscloneCompletionApiService.js';
import { IVSCloneCompletionContextService } from '../../browser/vscloneCompletionContextService.js';
import { VSCloneCompletionBackendService } from '../../browser/vscloneCompletionBackendService.js';
import { IVSCloneCompletionPromptService, VSCloneCompletionPromptService } from '../../common/vscloneCompletionPromptService.js';
import { IVSCloneModelCatalogModelDescriptor, IVSCloneModelCatalogProviderDescriptor, IVSCloneModelCatalogService, IVSCloneModelCatalogState } from '../../common/vscloneModelCatalogService.js';
import { IVSCloneCompletionPromptEnvelope } from '../../common/vscloneCompletionTypes.js';
import { IVSCloneModelSelection, IVSCloneThreadModelSelectionService, IVSCloneModelSelectionChangeEvent } from '../../common/backend/vscloneThreadModelSelectionService.js';

class MutableSelectionService implements IVSCloneThreadModelSelectionService {
	declare readonly _serviceBrand: undefined;

	private readonly emitter = new Emitter<IVSCloneModelSelectionChangeEvent>();
	readonly onDidChangeSelection = this.emitter.event;

	constructor(private selection: IVSCloneModelSelection) { }

	async initialize(): Promise<void> { }
	getCurrentSelectionForThread(): IVSCloneModelSelection | undefined { return this.selection; }
	async setSelectionForThread(_threadId: string, selection: IVSCloneModelSelection): Promise<void> {
		const previous = this.selection;
		this.selection = selection;
		this.emitter.fire({
			threadId: undefined,
			previous,
			current: selection,
			reason: 'user',
		});
	}
	async switchToNextModel(): Promise<IVSCloneModelSelection | undefined> { return undefined; }
	async resetSelectionForThread(): Promise<void> { }
	hasSelectionForThread(): boolean { return true; }
	getRecentModelIdentifiers(): readonly string[] { return [this.selection.modelIdentifier]; }
}

class StaticModelCatalogService implements IVSCloneModelCatalogService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeCatalog = Event.None;

	constructor(private readonly models: readonly IVSCloneModelCatalogModelDescriptor[]) { }

	async refreshCatalog(): Promise<void> { }
	getState(): IVSCloneModelCatalogState {
		const providers: IVSCloneModelCatalogProviderDescriptor[] = [
			{ vendor: 'openai', displayName: 'OpenAI', status: 'available', modelCount: this.models.length },
		];
		return { status: 'ready', providers, models: this.models };
	}
	getProviders(): readonly IVSCloneModelCatalogProviderDescriptor[] { return this.getState().providers; }
	getModels(): readonly IVSCloneModelCatalogModelDescriptor[] { return this.models; }
	getModel(identifier: string): IVSCloneModelCatalogModelDescriptor | undefined {
		return this.models.find(model => model.identifier === identifier);
	}
	getSelectableModels(): readonly IVSCloneModelCatalogModelDescriptor[] {
		return this.models.filter(model => model.isSelectable);
	}
}

class RecordingCompletionApiService implements IVSCloneCompletionApiService {
	declare readonly _serviceBrand: undefined;
	readonly calls: string[] = [];

	async complete(_envelope: IVSCloneCompletionPromptEnvelope, selection: IVSCloneModelSelection, _token: CancellationToken): Promise<string | undefined> {
		this.calls.push(selection.modelIdentifier);
		return selection.modelIdentifier === 'openai/gpt-5.3-codex-spark' ? 'sparkCompletion' : 'nanoCompletion';
	}
}

function createLanguageFeaturesService(): ILanguageFeaturesService {
	return {
		inlineCompletionsProvider: {
			register: () => Disposable.None,
		},
	} as unknown as ILanguageFeaturesService;
}

function createTextModel(content: string, resource = URI.file('/workspace/test.ts'), languageId = 'typescript'): ITextModel {
	const lines = content.split('\n');

	return {
		uri: resource,
		getLanguageId: () => languageId,
		getVersionId: () => 1,
		getLineCount: () => lines.length,
		getLineMaxColumn: (lineNumber: number) => (lines[lineNumber - 1] ?? '').length + 1,
		getValueInRange: range => {
			const startLine = range.startLineNumber - 1;
			const endLine = range.endLineNumber - 1;
			if (startLine === endLine) {
				return (lines[startLine] ?? '').slice(range.startColumn - 1, range.endColumn - 1);
			}

			const chunks = [(lines[startLine] ?? '').slice(range.startColumn - 1)];
			for (let line = startLine + 1; line < endLine; line++) {
				chunks.push(lines[line] ?? '');
			}
			chunks.push((lines[endLine] ?? '').slice(0, range.endColumn - 1));
			return chunks.join('\n');
		},
	} as unknown as ITextModel;
}

function createSelection(modelIdentifier: string, modelId: string): IVSCloneModelSelection {
	return {
		threadId: undefined,
		location: 'editorInline',
		modelIdentifier,
		vendor: 'openai',
		modelId,
		modelName: modelId,
		selectedAt: Date.now(),
	};
}

suite('VSCloneAutocompleteIntegration', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('switching the editorInline model should invalidate cached ghost text and requery the backend', async () => {
		const testDisposables = store.add(new DisposableStore());
		const selectionService = new MutableSelectionService(createSelection('openai/gpt-5.3-codex-spark', 'gpt-5.3-codex-spark'));
		const catalogService = new StaticModelCatalogService([
			{
				identifier: 'openai/gpt-5.3-codex-spark',
				vendor: 'openai',
				modelId: 'gpt-5.3-codex-spark',
				modelName: 'GPT-5.3-Codex-Spark',
				supportsImages: false,
				isSelectable: true,
				reasoningEffortLevels: ['lite'],
				defaultReasoningEffort: 'lite',
			},
			{
				identifier: 'openai/gpt-5-nano',
				vendor: 'openai',
				modelId: 'gpt-5-nano',
				modelName: 'GPT-5 Nano',
				supportsImages: false,
				isSelectable: true,
				reasoningEffortLevels: ['none'],
				defaultReasoningEffort: 'none',
			},
		]);
		const apiService = new RecordingCompletionApiService();
		const backend = new VSCloneCompletionBackendService(
			selectionService,
			catalogService,
			new VSCloneCompletionPromptService() as IVSCloneCompletionPromptService,
			apiService,
			new NullLogService(),
		);
		const service = testDisposables.add(new VSCloneAutocompleteService(
			backend,
			{
				_serviceBrand: undefined,
				gatherContext: () => [],
			} as IVSCloneCompletionContextService,
			createLanguageFeaturesService(),
			new TestConfigurationService({ 'vsclone.autocomplete.debounceMs': 0 }),
			new MockContextKeyService(),
			new NullLogService(),
			selectionService,
		));
		const model = createTextModel('const value = ');
		const position = new Position(1, 'const value = '.length + 1);

		const firstResult = await service.provideInlineCompletions(model, position, {} as never, CancellationToken.None);
		assert.strictEqual(firstResult?.items[0].insertText, 'sparkCompletion');
		assert.deepStrictEqual(apiService.calls, ['openai/gpt-5.3-codex-spark']);

		await selectionService.setSelectionForThread('', createSelection('openai/gpt-5-nano', 'gpt-5-nano'));
		const secondResult = await service.provideInlineCompletions(model, position, {} as never, CancellationToken.None);

		assert.strictEqual(secondResult?.items[0].insertText, 'nanoCompletion');
		assert.deepStrictEqual(apiService.calls, ['openai/gpt-5.3-codex-spark', 'openai/gpt-5-nano']);
	});
});
