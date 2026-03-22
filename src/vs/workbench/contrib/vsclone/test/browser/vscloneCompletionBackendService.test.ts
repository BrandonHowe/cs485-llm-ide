/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { VSCloneCompletionBackendService } from '../../browser/vscloneCompletionBackendService.js';
import { IVSCloneCompletionApiService } from '../../browser/vscloneCompletionApiService.js';
import { IVSCloneCompletionRequest, IVSCloneCompletionPromptEnvelope } from '../../common/vscloneCompletionTypes.js';
import { IVSCloneModelCatalogProviderDescriptor, IVSCloneModelCatalogModelDescriptor, IVSCloneModelCatalogService, IVSCloneModelCatalogState } from '../../common/vscloneModelCatalogService.js';
import { IVSCloneCompletionPromptService } from '../../common/vscloneCompletionPromptService.js';
import { IVSCloneModelSelection, IVSCloneThreadModelSelectionService } from '../../common/backend/vscloneThreadModelSelectionService.js';

class TestSelectionService implements IVSCloneThreadModelSelectionService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeSelection = Event.None;
	initializeCallCount = 0;
	readonly requestedSelections: Array<{ threadId: string; location: 'chat' | 'editorInline' | 'notebook' | 'terminal' }> = [];

	constructor(private readonly selection: IVSCloneModelSelection | undefined) { }

	async initialize(): Promise<void> {
		this.initializeCallCount += 1;
	}

	getCurrentSelectionForThread(threadId: string, location: 'chat' | 'editorInline' | 'notebook' | 'terminal'): IVSCloneModelSelection | undefined {
		this.requestedSelections.push({ threadId, location });
		return this.selection;
	}

	async setSelectionForThread(_threadId: string, _selection: IVSCloneModelSelection): Promise<void> { }
	async switchToNextModel(_threadId: string, _location: 'chat' | 'editorInline' | 'notebook' | 'terminal'): Promise<IVSCloneModelSelection | undefined> { return undefined; }
	async resetSelectionForThread(_threadId: string): Promise<void> { }
	hasSelectionForThread(_threadId: string): boolean { return false; }
	getRecentModelIdentifiers(_limit?: number): readonly string[] { return []; }
}

class TestModelCatalogService implements IVSCloneModelCatalogService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeCatalog = Event.None;
	refreshCallCount = 0;

	state: IVSCloneModelCatalogState = {
		status: 'idle',
		providers: [],
		models: [],
	};

	async refreshCatalog(): Promise<void> {
		this.refreshCallCount += 1;
		this.state = {
			...this.state,
			status: 'ready',
		};
	}

	getState(): IVSCloneModelCatalogState {
		return this.state;
	}

	getProviders(): readonly IVSCloneModelCatalogProviderDescriptor[] {
		return this.state.providers;
	}

	getModels(_providerId?: 'openai' | 'anthropic' | 'google'): readonly IVSCloneModelCatalogModelDescriptor[] {
		return this.state.models;
	}

	getModel(_identifier: string): IVSCloneModelCatalogModelDescriptor | undefined {
		return this.state.models.find(model => model.identifier === _identifier);
	}

	getSelectableModels(): readonly IVSCloneModelCatalogModelDescriptor[] {
		return this.state.models.filter(model => model.isSelectable);
	}
}

class TestPromptService implements IVSCloneCompletionPromptService {
	declare readonly _serviceBrand: undefined;
	lastEnvelope: IVSCloneCompletionPromptEnvelope | undefined;

	buildPromptEnvelope(request: IVSCloneCompletionRequest, _selection: IVSCloneModelSelection): IVSCloneCompletionPromptEnvelope {
		this.lastEnvelope = {
			prefix: request.prefix,
			suffix: request.suffix,
			languageId: request.languageId,
			filePath: request.filePath,
			predictionType: request.predictionType,
			maxTokens: request.maxTokens,
			temperature: 0.01,
			stopTokens: [],
			systemMessage: 'system',
			promptText: 'prompt',
		};
		return this.lastEnvelope;
	}
}

class TestCompletionApiService implements IVSCloneCompletionApiService {
	declare readonly _serviceBrand: undefined;
	readonly requests: string[] = [];

	constructor(
		private readonly rawText: string | undefined,
		private readonly failingModelIdentifiers: readonly string[] = [],
	) { }

	async complete(_envelope: IVSCloneCompletionPromptEnvelope, selection: IVSCloneModelSelection): Promise<string | undefined> {
		this.requests.push(selection.modelIdentifier);
		if (this.failingModelIdentifiers.includes(selection.modelIdentifier)) {
			throw new Error(`Rejected ${selection.modelIdentifier}`);
		}

		return this.rawText;
	}
}

suite('VSCloneCompletionBackendService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('refreshes model policy and returns normalized inline completion text', async () => {
		const selection: IVSCloneModelSelection = {
			location: 'editorInline',
			modelIdentifier: 'openai/gpt-5.3-codex',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelName: 'GPT-5.3-Codex',
			selectedAt: Date.now(),
		};
		const selectionService = new TestSelectionService(selection);
		const catalogService = new TestModelCatalogService();
		const promptService = new TestPromptService();
		const apiService = new TestCompletionApiService('```ts\nconsole.log(value);\n```');
		const service = new VSCloneCompletionBackendService(
			selectionService,
			catalogService,
			promptService,
			apiService,
			new NullLogService(),
		);

		const result = await service.complete({
			prefix: 'console.',
			suffix: '',
			languageId: 'typescript',
			filePath: '/workspace/src/app.ts',
			predictionType: 'single-line',
			maxTokens: 128,
		}, CancellationToken.None);

		assert.strictEqual(result, 'console.log(value);');
		assert.strictEqual(selectionService.initializeCallCount, 1);
		assert.strictEqual(catalogService.refreshCallCount, 1);
		assert.deepStrictEqual(selectionService.requestedSelections, [{ threadId: '', location: 'editorInline' }]);
		assert.strictEqual(promptService.lastEnvelope?.promptText, 'prompt');
	});

	test('retries Spark failures with gpt-5-nano for inline completions', async () => {
		const selection: IVSCloneModelSelection = {
			location: 'editorInline',
			modelIdentifier: 'openai/gpt-5.3-codex-spark',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex-spark',
			modelName: 'GPT-5.3-Codex-Spark',
			reasoningEffort: 'lite',
			selectedAt: Date.now(),
		};
		const selectionService = new TestSelectionService(selection);
		const catalogService = new TestModelCatalogService();
		catalogService.state = {
			status: 'ready',
			providers: [],
			models: [
				{
					identifier: 'openai/gpt-5.3-codex-spark',
					vendor: 'openai',
					modelId: 'gpt-5.3-codex-spark',
					modelName: 'GPT-5.3-Codex-Spark',
					reasoningEffortLevels: ['standard', 'lite'],
					defaultReasoningEffort: 'standard',
					isSelectable: true,
				},
				{
					identifier: 'openai/gpt-5-nano',
					vendor: 'openai',
					modelId: 'gpt-5-nano',
					modelName: 'GPT-5 Nano',
					reasoningEffortLevels: ['high', 'low', 'none'],
					defaultReasoningEffort: 'high',
					isSelectable: true,
				},
			],
		};
		const promptService = new TestPromptService();
		const apiService = new TestCompletionApiService(
			'```ts\nconsole.log(value);\n```',
			['openai/gpt-5.3-codex-spark'],
		);
		const service = new VSCloneCompletionBackendService(
			selectionService,
			catalogService,
			promptService,
			apiService,
			new NullLogService(),
		);

		const result = await service.complete({
			prefix: 'console.',
			suffix: '',
			languageId: 'typescript',
			filePath: '/workspace/src/app.ts',
			predictionType: 'single-line',
			maxTokens: 128,
		}, CancellationToken.None);

		assert.strictEqual(result, 'console.log(value);');
		assert.deepStrictEqual(apiService.requests, ['openai/gpt-5.3-codex-spark', 'openai/gpt-5-nano']);
	});

	test('retries Google inline completion failures with Anthropic when Gemini is next in the fallback chain', async () => {
		const selection: IVSCloneModelSelection = {
			location: 'editorInline',
			modelIdentifier: 'google/gemini-3.1-flash-lite-preview',
			vendor: 'google',
			modelId: 'gemini-3.1-flash-lite-preview',
			modelName: 'Gemini 3.1 Flash Lite',
			reasoningEffort: 'minimal',
			selectedAt: Date.now(),
		};
		const selectionService = new TestSelectionService(selection);
		const catalogService = new TestModelCatalogService();
		catalogService.state = {
			status: 'ready',
			providers: [],
			models: [
				{
					identifier: 'google/gemini-3.1-flash-lite-preview',
					vendor: 'google',
					modelId: 'gemini-3.1-flash-lite-preview',
					modelName: 'Gemini 3.1 Flash Lite',
					reasoningEffortLevels: ['high', 'medium', 'low', 'minimal'],
					defaultReasoningEffort: 'medium',
					isSelectable: true,
				},
				{
					identifier: 'anthropic/claude-haiku-4-5-20251001',
					vendor: 'anthropic',
					modelId: 'claude-haiku-4-5-20251001',
					modelName: 'Haiku 4.5',
					isSelectable: true,
				},
			],
		};
		const promptService = new TestPromptService();
		const apiService = new TestCompletionApiService(
			'```ts\nconsole.log(value);\n```',
			['google/gemini-3.1-flash-lite-preview'],
		);
		const service = new VSCloneCompletionBackendService(
			selectionService,
			catalogService,
			promptService,
			apiService,
			new NullLogService(),
		);

		const result = await service.complete({
			prefix: 'console.',
			suffix: '',
			languageId: 'typescript',
			filePath: '/workspace/src/app.ts',
			predictionType: 'single-line',
			maxTokens: 128,
		}, CancellationToken.None);

		assert.strictEqual(result, 'console.log(value);');
		assert.deepStrictEqual(apiService.requests, ['google/gemini-3.1-flash-lite-preview', 'anthropic/claude-haiku-4-5-20251001']);
	});
});
