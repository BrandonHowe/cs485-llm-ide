/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { LRUCache } from '../../../../../base/common/map.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { InlineCompletion, InlineCompletions } from '../../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { VSCloneAutocompleteDebounceMsSetting, VSCloneAutocompleteService, VSCloneInlineSuggestionVisibleContextKey } from '../../browser/vscloneAutocompleteService.js';
import { IVSCloneConvertToLLMMessageService } from '../../browser/vscloneConvertToLLMMessageService.js';
import { IVSCloneLLMMessageService } from '../../browser/vscloneLLMMessageService.js';
import type { IVSCloneChatTransportRequestOptions } from '../../common/vscloneChatTransportTypes.js';
import { VSCloneSettingsService } from '../../common/vscloneSettingsService.js';
import type { IVSCloneCompletionPromptEnvelope } from '../../common/vscloneCompletionTypes.js';
import type { IVSCloneLLMMessageObserver, IVSCloneLLMMessageRequest } from '../../common/vscloneLLMMessageTypes.js';
import type { IVSCloneModelSelection } from '../../common/vscloneModelSelectionTypes.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { TestVSCloneOAuthService } from '../common/vscloneTestOAuthService.js';
import { TestVSCloneUnifiedChatBackendService } from '../common/vscloneTestUnifiedChatBackendService.js';

interface IAutocompleteServiceInternals {
	getDebounceMs(): number;
	getAdaptiveDebounceMs(context: { readonly linePrefix: string; readonly lineSuffix: string }, mode: 'single-line-redo-suffix' | 'single-line-fill-middle' | 'multi-line' | 'do-not-predict'): number;
	getPredictionMode(linePrefix: string, lineSuffix: string): 'single-line-redo-suffix' | 'single-line-fill-middle' | 'multi-line' | 'do-not-predict';
	getReplaceRange(model: ITextModel, position: Position, mode: 'single-line-redo-suffix' | 'single-line-fill-middle' | 'multi-line' | 'do-not-predict'): Range;
	getCachedCompletion(resource: URI, prefix: string, suffix: string): string | undefined;
	addToCache(resource: URI, prefix: string, insertText: string): void;
	evictExpiredEntries(cache: LRUCache<string, { readonly timestamp: number }>, now: number): void;
	beginBackendRequest(resource: URI, parentToken: CancellationToken): { readonly token: CancellationToken; dispose(): void };
	endBackendRequest(resource: URI, requestId: number): void;
	debounce(resource: URI, context: { readonly linePrefix: string; readonly lineSuffix: string }, mode: 'single-line-redo-suffix' | 'single-line-fill-middle' | 'multi-line' | 'do-not-predict', token: CancellationToken): Promise<boolean>;
}

class TestConvertToLLMMessageService implements IVSCloneConvertToLLMMessageService {
	declare readonly _serviceBrand: undefined;

	prepareChatRequest(_options: IVSCloneChatTransportRequestOptions): never {
		throw new Error('Chat conversion is not used in autocomplete tests.');
	}

	prepareFIMRequest(
		selection: Pick<IVSCloneModelSelection, 'vendor' | 'modelId' | 'modelIdentifier' | 'reasoningEffort'>,
		envelope: Pick<IVSCloneCompletionPromptEnvelope, 'prefix' | 'suffix' | 'maxTokens' | 'temperature' | 'stopTokens' | 'systemMessage' | 'promptText'>,
	) {
		return {
			vendor: selection.vendor,
			modelId: selection.modelId,
			modelIdentifier: selection.modelIdentifier,
			reasoningEffort: selection.reasoningEffort,
			prompt: { ...envelope },
		};
	}
}

class RecordingLLMMessageService implements IVSCloneLLMMessageService {
	declare readonly _serviceBrand: undefined;
	readonly requests: IVSCloneLLMMessageRequest[] = [];

	constructor(private readonly resolveText: (request: IVSCloneLLMMessageRequest) => string = () => 'completion') { }

	sendRequest(request: IVSCloneLLMMessageRequest, observer: IVSCloneLLMMessageObserver = {}) {
		this.requests.push(request);
		queueMicrotask(() => {
			observer.onFinalMessage?.({
				fullText: this.resolveText(request),
				fullReasoning: '',
				toolCall: undefined,
				anthropicReasoning: null,
			});
		});

		return {
			requestId: `request-${this.requests.length}`,
			done: Promise.resolve(),
			cancel: () => {
				observer.onAbort?.();
			},
		};
	}

	sendChatRequest(): never {
		throw new Error('Chat requests are not used in autocomplete tests.');
	}

	abort(): void { }
}

interface IAutocompleteServiceSetup {
	disposables: DisposableStore;
	service: VSCloneAutocompleteService;
	settingsService: VSCloneSettingsService;
	contextKeyService: MockContextKeyService;
	llmMessageService: RecordingLLMMessageService;
}

function createLanguageFeaturesService(onRegister?: (selector: unknown, provider: unknown) => void): ILanguageFeaturesService {
	return {
		inlineCompletionsProvider: {
			register: (selector: unknown, provider: unknown) => {
				onRegister?.(selector, provider);
				return Disposable.None;
			},
		},
	} as unknown as ILanguageFeaturesService;
}

function createEditorService(resources: readonly URI[] = []) {
	return {
		editors: resources.map(resource => ({ resource })),
	};
}

function createModelService(models: ReadonlyMap<string, ITextModel>) {
	return {
		getModel(resource: URI) {
			return models.get(resource.toString()) ?? null;
		},
	};
}

function createTextModel(content: string, resource = URI.file('/workspace/test.ts'), languageId = 'typescript', versionId = 1): ITextModel {
	const lines = content.split('\n');

	return {
		uri: resource,
		getLanguageId: () => languageId,
		getVersionId: () => versionId,
		getLineCount: () => lines.length,
		getLineMaxColumn: (lineNumber: number) => (lines[lineNumber - 1] ?? '').length + 1,
		getValueLength: () => content.length,
		getValue: () => content,
		getValueInRange: (range: Range) => {
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

async function createAutocompleteService(
	options: {
		configuration?: Record<string, unknown>;
		onRegister?: (selector: unknown, provider: unknown) => void;
		resolveText?: (request: IVSCloneLLMMessageRequest) => string;
		editorResources?: readonly URI[];
		modelsByResource?: ReadonlyMap<string, ITextModel>;
	} = {},
): Promise<IAutocompleteServiceSetup> {
	const oauthService = new TestVSCloneOAuthService();
	// The helper constructs a real settings stack under the autocomplete service, so the tests
	// need one disposable handle that tears down both the service under test and its storage-backed
	// dependencies. Returning the bundle keeps leak detection honest in the browser harness.
	const disposables = new DisposableStore();
	const settingsService = disposables.add(new VSCloneSettingsService(
		disposables.add(new TestStorageService()),
		oauthService,
		new TestVSCloneUnifiedChatBackendService(),
	));
	await settingsService.initialize();

	const llmMessageService = new RecordingLLMMessageService(options.resolveText);
	const contextKeyService = new MockContextKeyService();
	const service = disposables.add(new VSCloneAutocompleteService(
		settingsService,
		new TestConvertToLLMMessageService(),
		llmMessageService,
		oauthService,
		createEditorService(options.editorResources) as never,
		createModelService(options.modelsByResource ?? new Map()) as never,
		createLanguageFeaturesService(options.onRegister),
		new TestConfigurationService(options.configuration ?? Object.create(null)),
		contextKeyService,
		new NullLogService(),
	));

	return { disposables, service, settingsService, contextKeyService, llmMessageService };
}

suite('VSCloneAutocompleteService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('registers itself as an inline completions provider and binds the visibility key', async () => {
		const testDisposables = store.add(new DisposableStore());
		let registeredSelector: unknown;
		let registeredProvider: unknown;
		const setup = await createAutocompleteService({
			onRegister: (selector, provider) => {
				registeredSelector = selector;
				registeredProvider = provider;
			},
		});
		testDisposables.add(setup.disposables);
		const { service, contextKeyService } = setup;

		assert.deepStrictEqual(registeredSelector, { pattern: '**' });
		assert.strictEqual(registeredProvider, service);
		assert.strictEqual(contextKeyService.getContextKeyValue(VSCloneInlineSuggestionVisibleContextKey.key), false);
	});

	test('sets the VSClone visibility context key while a shown completion list is alive', async () => {
		const testDisposables = store.add(new DisposableStore());
		const setup = await createAutocompleteService();
		testDisposables.add(setup.disposables);
		const { service, contextKeyService } = setup;
		const item = { insertText: 'completion' } as InlineCompletion;
		const completions = { items: [item] } as InlineCompletions;

		service.handleItemDidShow(completions, item);
		assert.strictEqual(contextKeyService.getContextKeyValue(VSCloneInlineSuggestionVisibleContextKey.key), true);

		service.disposeInlineCompletions(completions);
		assert.strictEqual(contextKeyService.getContextKeyValue(VSCloneInlineSuggestionVisibleContextKey.key), false);
	});

	test('disposes active requests, clears cache state, and resets the visibility key', async () => {
		const testDisposables = store.add(new DisposableStore());
		const setup = await createAutocompleteService();
		testDisposables.add(setup.disposables);
		const { service, contextKeyService } = setup;
		const internals = service as unknown as IAutocompleteServiceInternals;
		const resource = URI.file('/workspace/sample.ts');
		const requestHandle = internals.beginBackendRequest(resource, new CancellationTokenSource().token);
		const item = { insertText: 'completion' } as InlineCompletion;
		const completions = { items: [item] } as InlineCompletions;

		internals.addToCache(resource, 'foo', 'bar');
		service.handleItemDidShow(completions, item);
		service.dispose();

		assert.strictEqual(requestHandle.token.isCancellationRequested, true);
		assert.strictEqual(internals.getCachedCompletion(resource, 'foo', ''), undefined);
		assert.strictEqual(contextKeyService.getContextKeyValue(VSCloneInlineSuggestionVisibleContextKey.key), false);
	});

	test('classifies prediction modes, debounce windows, and replacement ranges', async () => {
		const testDisposables = store.add(new DisposableStore());
		const defaultSetup = await createAutocompleteService();
		testDisposables.add(defaultSetup.disposables);
		const configuredSetup = await createAutocompleteService({
			configuration: { [VSCloneAutocompleteDebounceMsSetting]: 125 },
		});
		testDisposables.add(configuredSetup.disposables);
		const negativeSetup = await createAutocompleteService({
			configuration: { [VSCloneAutocompleteDebounceMsSetting]: -25 },
		});
		testDisposables.add(negativeSetup.disposables);
		const defaultService = defaultSetup.service as unknown as IAutocompleteServiceInternals;
		const configuredService = configuredSetup.service as unknown as IAutocompleteServiceInternals;
		const negativeService = negativeSetup.service as unknown as IAutocompleteServiceInternals;
		const model = createTextModel('abcd');

		assert.strictEqual(defaultService.getDebounceMs(), 500);
		assert.strictEqual(configuredService.getDebounceMs(), 125);
		assert.strictEqual(negativeService.getDebounceMs(), 0);
		assert.strictEqual(defaultService.getAdaptiveDebounceMs({ linePrefix: '', lineSuffix: '' }, 'single-line-fill-middle'), 400);
		assert.strictEqual(defaultService.getAdaptiveDebounceMs({ linePrefix: '   ', lineSuffix: '   ' }, 'multi-line'), 300);
		assert.strictEqual(defaultService.getAdaptiveDebounceMs({ linePrefix: 'obj.', lineSuffix: '' }, 'single-line-redo-suffix'), 250);
		assert.strictEqual(defaultService.getAdaptiveDebounceMs({ linePrefix: 'identifier', lineSuffix: '' }, 'single-line-redo-suffix'), 325);
		assert.strictEqual(defaultService.getAdaptiveDebounceMs({ linePrefix: 'x)', lineSuffix: '' }, 'single-line-redo-suffix'), 400);
		assert.strictEqual(defaultService.getPredictionMode('', ''), 'multi-line');
		assert.strictEqual(defaultService.getPredictionMode('   ', '    body'), 'do-not-predict');
		assert.strictEqual(defaultService.getPredictionMode('x', ' )'), 'single-line-redo-suffix');
		assert.strictEqual(defaultService.getPredictionMode('return ', 'foobar();'), 'single-line-fill-middle');
		assert.deepStrictEqual(defaultService.getReplaceRange(model, new Position(1, 3), 'multi-line'), new Range(1, 3, 1, 5));
		assert.deepStrictEqual(defaultService.getReplaceRange(model, new Position(1, 3), 'single-line-fill-middle'), new Range(1, 3, 1, 3));
	});

	test('reuses cached completions and trims overlapping suffixes', async () => {
		const testDisposables = store.add(new DisposableStore());
		const setup = await createAutocompleteService();
		testDisposables.add(setup.disposables);
		const { service } = setup;
		const internals = service as unknown as IAutocompleteServiceInternals;
		const resource = URI.file('/workspace/sample.ts');

		internals.addToCache(resource, '  abc  ', 'defghi');
		internals.addToCache(resource, 'abcde', 'fghi');

		assert.strictEqual(internals.getCachedCompletion(resource, 'abcdef', ''), 'ghi');

		internals.addToCache(resource, 'foo', 'bar)');
		assert.strictEqual(internals.getCachedCompletion(resource, 'foo', 'ar)'), 'b');

		internals.addToCache(resource, 'foo', 'ar)');
		assert.strictEqual(internals.getCachedCompletion(resource, 'foo', 'ar)'), undefined);
		assert.strictEqual(internals.getCachedCompletion(resource, '   ', ''), undefined);
	});

	test('evicts only cache entries older than the 30 second boundary', async () => {
		const testDisposables = store.add(new DisposableStore());
		const setup = await createAutocompleteService();
		testDisposables.add(setup.disposables);
		const { service } = setup;
		const internals = service as unknown as IAutocompleteServiceInternals;
		const cache = new LRUCache<string, { readonly timestamp: number }>(5);
		const now = 10_000;

		cache.set('stale', { timestamp: now - 30_001 });
		cache.set('boundary', { timestamp: now - 30_000 });
		cache.set('fresh', { timestamp: now - 1 });
		internals.evictExpiredEntries(cache, now);

		assert.strictEqual(cache.has('stale'), false);
		assert.strictEqual(cache.has('boundary'), true);
		assert.strictEqual(cache.has('fresh'), true);
	});

	test('honors debounce cancellation and request supersession', async () => {
		const testDisposables = store.add(new DisposableStore());
		const setup = await createAutocompleteService({
			configuration: { [VSCloneAutocompleteDebounceMsSetting]: 1 },
		});
		testDisposables.add(setup.disposables);
		const { service } = setup;
		const internals = service as unknown as IAutocompleteServiceInternals;
		const resource = URI.file('/workspace/sample.ts');
		const originalDateNow = Date.now;
		let now = 10;

		try {
			(Date as { now: () => number }).now = () => now;
			const canceledToken = new CancellationTokenSource();
			canceledToken.cancel();
			assert.strictEqual(await internals.debounce(resource, { linePrefix: 'x', lineSuffix: '' }, 'single-line-fill-middle', canceledToken.token), false);

			const firstToken = new CancellationTokenSource();
			const secondToken = new CancellationTokenSource();
			const first = internals.debounce(resource, { linePrefix: 'x', lineSuffix: '' }, 'single-line-fill-middle', firstToken.token);
			now = 20;
			const second = internals.debounce(resource, { linePrefix: 'x', lineSuffix: '' }, 'single-line-fill-middle', secondToken.token);

			assert.deepStrictEqual(await Promise.all([first, second]), [false, true]);
		} finally {
			(Date as { now: () => number }).now = originalDateNow;
		}
	});

	test('tracks backend request lifetimes and parent cancellation', async () => {
		const testDisposables = store.add(new DisposableStore());
		const setup = await createAutocompleteService();
		testDisposables.add(setup.disposables);
		const { service } = setup;
		const internals = service as unknown as IAutocompleteServiceInternals;
		const resource = URI.file('/workspace/sample.ts');
		const activeRequestsByResource = (internals as unknown as {
			activeRequestsByResource: {
				get(resource: URI): unknown[] | undefined;
				has(resource: URI): boolean;
			};
		}).activeRequestsByResource;
		let now = 10;
		const originalDateNow = Date.now;
		const parentOne = new CancellationTokenSource();
		const parentTwo = new CancellationTokenSource();
		const parentThree = new CancellationTokenSource();
		const parentFour = new CancellationTokenSource();
		testDisposables.add(parentOne);
		testDisposables.add(parentTwo);
		testDisposables.add(parentThree);
		testDisposables.add(parentFour);

		try {
			(Date as { now: () => number }).now = () => now;
			const first = internals.beginBackendRequest(resource, parentOne.token);
			const second = internals.beginBackendRequest(resource, parentTwo.token);
			now = 20;
			const third = internals.beginBackendRequest(resource, parentThree.token);

			assert.strictEqual(first.token.isCancellationRequested, true);
			assert.strictEqual(second.token.isCancellationRequested, false);
			assert.strictEqual(third.token.isCancellationRequested, false);
			assert.strictEqual(activeRequestsByResource.get(resource)?.length, 2);

			internals.endBackendRequest(resource, 999);
			internals.endBackendRequest(URI.file('/workspace/other.ts'), 1);
			assert.strictEqual(activeRequestsByResource.get(resource)?.length, 2);

			second.dispose();
			assert.strictEqual(activeRequestsByResource.get(resource)?.length, 1);

			const parentCancelled = internals.beginBackendRequest(URI.file('/workspace/parent.ts'), parentFour.token);
			parentFour.cancel();
			assert.strictEqual(parentCancelled.token.isCancellationRequested, true);
			parentCancelled.dispose();

			third.dispose();
			assert.strictEqual(activeRequestsByResource.has(resource), false);
		} finally {
			(Date as { now: () => number }).now = originalDateNow;
		}
	});

	test('returns cached inline completions immediately and bypasses the transport', async () => {
		const testDisposables = store.add(new DisposableStore());
		const setup = await createAutocompleteService({
			configuration: { [VSCloneAutocompleteDebounceMsSetting]: 0 },
		});
		testDisposables.add(setup.disposables);
		const { service, llmMessageService } = setup;
		const internals = service as unknown as IAutocompleteServiceInternals;
		const resource = URI.file('/workspace/sample.ts');
		const model = createTextModel('fooBa', resource);

		internals.addToCache(resource, 'foo', 'BarBaz()');
		const completions = await service.provideInlineCompletions(model, new Position(1, 6), {} as never, CancellationToken.None);

		assert.strictEqual(llmMessageService.requests.length, 0);
		assert.strictEqual(completions?.items.length, 1);
		assert.strictEqual(completions?.items[0].insertText, 'rBaz()');
		assert.deepStrictEqual(completions?.items[0].range, new Range(1, 6, 1, 6));
	});

	test('builds multi-line requests with open-tab context and caches the result', async () => {
		const testDisposables = store.add(new DisposableStore());
		const helperResource = URI.file('/workspace/helper.ts');
		const helperModel = createTextModel('export const helper = true;', helperResource, 'typescript', 2);
		const modelsByResource = new Map([[helperResource.toString(), helperModel]]);
		const setup = await createAutocompleteService({
			configuration: { [VSCloneAutocompleteDebounceMsSetting]: 0 },
			editorResources: [helperResource],
			modelsByResource,
			// Multi-line completions keep growing only while subsequent lines stay at or below the
			// cursor indentation depth. Use an indented continuation here so the test exercises the
			// multi-line happy path instead of the scope-exit truncation guard.
			resolveText: () => 'const value = 1;\n    return value;',
		});
		testDisposables.add(setup.disposables);
		const { service, llmMessageService } = setup;
		const model = createTextModel('function f() {\n    \n}', URI.file('/workspace/sample.ts'));

		const completions = await service.provideInlineCompletions(model, new Position(2, 5), {} as never, CancellationToken.None);
		const request = llmMessageService.requests[0] as Extract<IVSCloneLLMMessageRequest, { kind: 'fim' }>;

		assert.strictEqual(request.kind, 'fim');
		assert.strictEqual(request.prepared.prompt.maxTokens, 160);
		assert.ok(request.prepared.prompt.promptText.includes('Related files:'));
		assert.ok(request.prepared.prompt.promptText.includes('/workspace/helper.ts'));
		assert.ok(request.prepared.prompt.promptText.includes('export const helper = true;'));
		assert.strictEqual(completions?.items[0].insertText, 'const value = 1;\n    return value;');
		assert.deepStrictEqual(completions?.items[0].range, new Range(2, 5, 2, 5));

		const second = await service.provideInlineCompletions(model, new Position(2, 5), {} as never, CancellationToken.None);
		assert.strictEqual(second?.items[0].insertText, 'const value = 1;\n    return value;');
		assert.strictEqual(llmMessageService.requests.length, 1);
	});
});
