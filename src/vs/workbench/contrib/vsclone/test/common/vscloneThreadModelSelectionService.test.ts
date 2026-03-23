/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IVSCloneModelCatalogModelDescriptor, IVSCloneModelCatalogProviderDescriptor, IVSCloneModelCatalogService, IVSCloneModelCatalogState, VSCloneModelCatalogService } from '../../common/vscloneModelCatalogService.js';
import { VSCloneProviderPreferencesService } from '../../common/vscloneProviderPreferencesService.js';
import { IVSCloneModelSelection, VSCloneThreadModelSelectionService } from '../../common/backend/vscloneThreadModelSelectionService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { TestVSCloneOAuthService } from './vscloneTestOAuthService.js';
import { TestVSCloneUnifiedChatBackendService } from './vscloneTestUnifiedChatBackendService.js';

suite('VSCloneThreadModelSelectionService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function waitForCatalogToSettle(catalogService: VSCloneModelCatalogService): Promise<void> {
		for (let attempt = 0; attempt < 50; attempt++) {
			if (catalogService.getState().status !== 'loading') {
				return;
			}
			await new Promise<void>(resolve => setTimeout(resolve, 10));
		}
	}

	async function createHarness() {
		const testDisposables = store.add(new DisposableStore());
		const storageService = testDisposables.add(new TestStorageService());
		const providerPreferencesService = testDisposables.add(new VSCloneProviderPreferencesService(storageService));
		const oauthService = new TestVSCloneOAuthService();
		const catalogService = testDisposables.add(new VSCloneModelCatalogService(providerPreferencesService, oauthService));
		const backendService = new TestVSCloneUnifiedChatBackendService();
		const selectionService = testDisposables.add(new VSCloneThreadModelSelectionService(backendService, catalogService));

		await providerPreferencesService.initialize();
		await catalogService.refreshCatalog();
		await selectionService.initialize();

		return { providerPreferencesService, oauthService, catalogService, selectionService, backendService };
	}

	function createSelectableModel(
		identifier: string,
		modelName: string,
		reasoningEffortLevels?: readonly ('none' | 'minimal' | 'lite' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'standard')[],
		defaultReasoningEffort?: IVSCloneModelSelection['reasoningEffort'],
	): IVSCloneModelCatalogModelDescriptor {
		const [vendor, modelId] = identifier.split('/', 2) as [IVSCloneModelSelection['vendor'], string];
		return {
			identifier,
			vendor,
			modelId,
			modelName,
			reasoningEffortLevels,
			defaultReasoningEffort,
			// Tests build public catalog descriptors directly, so they need to mirror the catalog's
			// explicit image-capability flag even when the scenario itself does not exercise images.
			supportsImages: true,
			isSelectable: true,
		};
	}

	/**
	 * The production catalog only gates models at the provider level, so a fake catalog is the
	 * simplest way to exercise the inline fallback order when Spark is intentionally omitted but the
	 * rest of the provider chain still exists.
	 */
	class StaticCatalogService implements IVSCloneModelCatalogService {
		declare readonly _serviceBrand: undefined;
		readonly onDidChangeCatalog = Event.None;

		constructor(private readonly state: IVSCloneModelCatalogState) { }

		async refreshCatalog(): Promise<void> {
			return;
		}

		getState(): IVSCloneModelCatalogState {
			return {
				...this.state,
				providers: [...this.state.providers],
				models: [...this.state.models],
			};
		}

		getProviders(): readonly IVSCloneModelCatalogProviderDescriptor[] {
			return [...this.state.providers];
		}

		getModels(providerId?: IVSCloneModelSelection['vendor']): readonly IVSCloneModelCatalogModelDescriptor[] {
			if (!providerId) {
				return [...this.state.models];
			}

			return this.state.models.filter(model => model.vendor === providerId);
		}

		getModel(identifier: string): IVSCloneModelCatalogModelDescriptor | undefined {
			return this.state.models.find(model => model.identifier === identifier);
		}

		getSelectableModels(): readonly IVSCloneModelCatalogModelDescriptor[] {
			return this.state.models.filter(model => model.isSelectable);
		}
	}

	function toSelection(modelIdentifier: string, vendor: IVSCloneModelSelection['vendor'], modelId: string, modelName: string, reasoningEffort?: 'low' | 'medium' | 'high'): IVSCloneModelSelection {
		return {
			threadId: 'thread-1',
			location: 'chat',
			modelIdentifier,
			vendor,
			modelId,
			modelName,
			reasoningEffort,
			selectedAt: Date.now(),
		};
	}

	test('set/get per-thread selection', async () => {
		const { catalogService, selectionService } = await createHarness();
		const model = catalogService.getSelectableModels()[0];
		assert.ok(model);

		await selectionService.setSelectionForThread('thread-1', toSelection(model.identifier, model.vendor, model.modelId, model.modelName));
		const current = selectionService.getCurrentSelectionForThread('thread-1', 'chat');
		assert.ok(current);
		assert.strictEqual(current?.modelIdentifier, model.identifier);
		assert.strictEqual(current?.vendor, model.vendor);
	});

	test('falls back to location selection for unknown thread', async () => {
		const { catalogService, selectionService } = await createHarness();
		const model = catalogService.getSelectableModels()[1];
		assert.ok(model);

		await selectionService.setSelectionForThread('', toSelection(model.identifier, model.vendor, model.modelId, model.modelName));
		const current = selectionService.getCurrentSelectionForThread('thread-does-not-exist', 'chat');
		assert.ok(current);
		assert.strictEqual(current?.modelIdentifier, model.identifier);
	});

	test('prefers codex spark for editor-inline fallback selection', async () => {
		const { selectionService } = await createHarness();

		const current = selectionService.getCurrentSelectionForThread('', 'editorInline');
		assert.ok(current);
		assert.strictEqual(current?.modelIdentifier, 'openai/gpt-5.3-codex-spark');
		assert.strictEqual(current?.reasoningEffort, 'lite');
	});

	test('falls back to gpt-5-nano when codex spark is not present in the inline policy chain', async () => {
		const backendService = new TestVSCloneUnifiedChatBackendService();
		const selectionService = store.add(new VSCloneThreadModelSelectionService(
			backendService,
			new StaticCatalogService({
				status: 'ready',
				providers: [],
				models: [
					createSelectableModel('openai/gpt-5-nano', 'GPT-5 Nano', ['high', 'low', 'none'], 'high'),
					createSelectableModel('anthropic/claude-haiku-4-5-20251001', 'Haiku 4.5'),
					createSelectableModel('google/gemini-3.1-flash-lite-preview', 'Gemini 3.1 Flash Lite', ['high', 'medium', 'low', 'minimal'], 'medium'),
				],
			}),
		));

		await selectionService.initialize();

		const current = selectionService.getCurrentSelectionForThread('', 'editorInline');
		assert.ok(current);
		assert.strictEqual(current?.modelIdentifier, 'openai/gpt-5-nano');
		assert.strictEqual(current?.reasoningEffort, 'none');
	});

	test('recent model identifiers dedupe and preserve recency', async () => {
		const { catalogService, selectionService } = await createHarness();
		const models = catalogService.getSelectableModels();
		assert.ok(models.length >= 3);

		await selectionService.setSelectionForThread('thread-1', toSelection(models[0].identifier, models[0].vendor, models[0].modelId, models[0].modelName));
		await selectionService.setSelectionForThread('thread-1', toSelection(models[1].identifier, models[1].vendor, models[1].modelId, models[1].modelName));
		await selectionService.setSelectionForThread('thread-1', toSelection(models[0].identifier, models[0].vendor, models[0].modelId, models[0].modelName));
		await selectionService.setSelectionForThread('thread-1', toSelection(models[2].identifier, models[2].vendor, models[2].modelId, models[2].modelName));

		assert.deepStrictEqual(selectionService.getRecentModelIdentifiers(3), [models[2].identifier, models[0].identifier, models[1].identifier]);
	});

	test('reconciles stale thread selection after catalog changes', async () => {
		const { providerPreferencesService, oauthService, catalogService, selectionService } = await createHarness();
		await providerPreferencesService.setProviderEnabled('google', true);
		oauthService.setReady('google', true);
		await catalogService.refreshCatalog();
		await waitForCatalogToSettle(catalogService);

		const googleModel = catalogService.getModels('google')[0];
		assert.ok(googleModel);
		await selectionService.setSelectionForThread('thread-1', toSelection(googleModel.identifier, googleModel.vendor, googleModel.modelId, googleModel.modelName));
		assert.strictEqual(selectionService.getCurrentSelectionForThread('thread-1', 'chat')?.modelIdentifier, googleModel.identifier);

		oauthService.setReady('google', false);
		await catalogService.refreshCatalog();
		await waitForCatalogToSettle(catalogService);

		const next = selectionService.getCurrentSelectionForThread('thread-1', 'chat');
		assert.ok(next);
		assert.notStrictEqual(next?.modelIdentifier, googleModel.identifier);
	});

	test('falls back to Google Flash Lite before Anthropic when OpenAI is unavailable', async () => {
		const { providerPreferencesService, oauthService, catalogService, selectionService } = await createHarness();
		await providerPreferencesService.setProviderEnabled('openai', false);
		await providerPreferencesService.setProviderEnabled('google', true);
		oauthService.setReady('google', true);
		await catalogService.refreshCatalog();
		await waitForCatalogToSettle(catalogService);

		const current = selectionService.getCurrentSelectionForThread('', 'editorInline');
		assert.ok(current);
		assert.strictEqual(current?.modelIdentifier, 'google/gemini-3.1-flash-lite-preview');
		assert.strictEqual(current?.reasoningEffort, 'minimal');
	});

	test('falls back to Anthropic Haiku 4.5 when OpenAI and Google are unavailable', async () => {
		const { providerPreferencesService, oauthService, catalogService, selectionService } = await createHarness();
		await providerPreferencesService.setProviderEnabled('openai', false);
		await providerPreferencesService.setProviderEnabled('google', true);
		oauthService.setReady('google', false);
		await catalogService.refreshCatalog();
		await waitForCatalogToSettle(catalogService);

		const current = selectionService.getCurrentSelectionForThread('', 'editorInline');
		assert.ok(current);
		assert.strictEqual(current?.modelIdentifier, 'anthropic/claude-haiku-4-5-20251001');
		assert.strictEqual(current?.reasoningEffort, undefined);
	});

	test('migrates the legacy editor-inline fallback to codex spark on restore', async () => {
		const { selectionService, backendService, catalogService } = await createHarness();
		await backendService.replaceSelectionState({
			selectedByThread: {},
			selectedByLocation: {
				editorInline: {
					location: 'editorInline',
					modelIdentifier: 'openai/gpt-5.3-codex',
					vendor: 'openai',
					modelId: 'gpt-5.3-codex',
					modelName: 'GPT-5.3-Codex',
					reasoningEffort: 'medium',
					selectedAt: Date.now() - 1_000,
				},
			},
			recentModelIdentifiers: ['openai/gpt-5.3-codex'],
		});

		await catalogService.refreshCatalog();
		await waitForCatalogToSettle(catalogService);
		const current = selectionService.getCurrentSelectionForThread('', 'editorInline');
		assert.ok(current);
		assert.strictEqual(current?.modelIdentifier, 'openai/gpt-5.3-codex-spark');
		assert.strictEqual(current?.reasoningEffort, 'lite');
	});

	test('reconciles stored editor-inline spark selections to lite reasoning on restore', async () => {
		const { selectionService, backendService, catalogService } = await createHarness();
		await backendService.replaceSelectionState({
			selectedByThread: {},
			selectedByLocation: {
				editorInline: {
					location: 'editorInline',
					modelIdentifier: 'openai/gpt-5.3-codex-spark',
					vendor: 'openai',
					modelId: 'gpt-5.3-codex-spark',
					modelName: 'GPT-5.3-Codex-Spark',
					reasoningEffort: 'standard',
					selectedAt: Date.now() - 1_000,
				},
			},
			recentModelIdentifiers: ['openai/gpt-5.3-codex-spark'],
		});

		await catalogService.refreshCatalog();
		await waitForCatalogToSettle(catalogService);
		const current = selectionService.getCurrentSelectionForThread('', 'editorInline');
		assert.ok(current);
		assert.strictEqual(current?.modelIdentifier, 'openai/gpt-5.3-codex-spark');
		assert.strictEqual(current?.reasoningEffort, 'lite');
	});

	test('reset clears explicit thread selection and falls back', async () => {
		const { catalogService, selectionService } = await createHarness();
		const model = catalogService.getSelectableModels()[0];
		assert.ok(model);

		await selectionService.setSelectionForThread('thread-1', toSelection(model.identifier, model.vendor, model.modelId, model.modelName));
		assert.strictEqual(selectionService.hasSelectionForThread('thread-1'), true);

		await selectionService.resetSelectionForThread('thread-1');
		assert.strictEqual(selectionService.hasSelectionForThread('thread-1'), false);
		assert.ok(selectionService.getCurrentSelectionForThread('thread-1', 'chat'));
	});

	test('normalizes reasoning effort for reasoning-capable models', async () => {
		const { catalogService, selectionService } = await createHarness();
		const model = catalogService.getSelectableModels().find(candidate => candidate.vendor === 'openai');
		assert.ok(model);

		await selectionService.setSelectionForThread('thread-1', toSelection(model.identifier, model.vendor, model.modelId, model.modelName, 'high'));
		assert.strictEqual(selectionService.getCurrentSelectionForThread('thread-1', 'chat')?.reasoningEffort, 'high');

		await selectionService.setSelectionForThread('thread-1', {
			...toSelection(model.identifier, model.vendor, model.modelId, model.modelName),
			reasoningEffort: undefined,
		});
		assert.strictEqual(selectionService.getCurrentSelectionForThread('thread-1', 'chat')?.reasoningEffort, 'medium');
	});
});
