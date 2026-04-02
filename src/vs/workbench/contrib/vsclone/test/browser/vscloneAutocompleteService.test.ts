/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
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
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import {
	VSCloneAutocompleteDebounceMsSetting,
	VSCloneAutocompleteService,
	VSCloneInlineSuggestionVisibleContextKey,
} from '../../browser/vscloneAutocompleteService.js';
import { IVSCloneCompletionBackend, IVSCloneCompletionRequest } from '../../common/vscloneCompletionTypes.js';
import { IVSCloneCompletionContextService } from '../../browser/vscloneCompletionContextService.js';

interface IAutocompleteServiceInternals {
	getDebounceMs(): number;
	getAdaptiveDebounceMs(context: { readonly linePrefix: string; readonly lineSuffix: string }, mode: 'single-line-redo-suffix' | 'single-line-fill-middle' | 'multi-line' | 'do-not-predict'): number;
	getPredictionMode(linePrefix: string, lineSuffix: string): 'single-line-redo-suffix' | 'single-line-fill-middle' | 'multi-line' | 'do-not-predict';
	getReplaceRange(model: ITextModel, position: Position, mode: 'single-line-redo-suffix' | 'single-line-fill-middle' | 'multi-line' | 'do-not-predict'): Range;
	getCachedCompletion(resource: URI, prefix: string, suffix: string): string | undefined;
	addToCache(resource: URI, prefix: string, insertText: string): void;
	evictExpiredEntries(cache: LRUCache<string, { readonly timestamp: number }>, now: number): void;
	beginBackendRequest(resource: URI, parentToken: CancellationTokenSource['token']): { readonly token: CancellationTokenSource['token']; dispose(): void };
	endBackendRequest(resource: URI, requestId: number): void;
	debounce(resource: URI, context: { readonly linePrefix: string; readonly lineSuffix: string }, mode: 'single-line-redo-suffix' | 'single-line-fill-middle' | 'multi-line' | 'do-not-predict', token: CancellationTokenSource['token']): Promise<boolean>;
}

interface IAutocompleteServiceSetup {
	service: VSCloneAutocompleteService;
	contextKeyService: MockContextKeyService;
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

function createTextModel(content: string, resource = URI.file('/workspace/test.ts'), languageId = 'typescript'): ITextModel {
	const lines = content.split('\n');

	return {
		uri: resource,
		getLanguageId: () => languageId,
		getVersionId: () => 1,
		getLineCount: () => lines.length,
		getLineMaxColumn: (lineNumber: number) => (lines[lineNumber - 1] ?? '').length + 1,
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

function createAutocompleteService(
	options: {
		configuration?: Record<string, unknown>;
		complete?: IVSCloneCompletionBackend['complete'];
		gatherContext?: IVSCloneCompletionContextService['gatherContext'];
		onRegister?: (selector: unknown, provider: unknown) => void;
	} = {},
): IAutocompleteServiceSetup {
	const contextKeyService = new MockContextKeyService();
	const service = new VSCloneAutocompleteService(
		{
			_serviceBrand: undefined,
			complete: options.complete ?? (async () => undefined),
		} as IVSCloneCompletionBackend,
		{
			_serviceBrand: undefined,
			gatherContext: options.gatherContext ?? (() => []),
		} as IVSCloneCompletionContextService,
		createLanguageFeaturesService(options.onRegister),
		new TestConfigurationService(options.configuration ?? Object.create(null)),
		contextKeyService,
		new NullLogService(),
	);

	return { service, contextKeyService };
}

suite('VSCloneAutocompleteService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('registers itself as an inline completions provider and binds the visibility key', () => {
		const testDisposables = store.add(new DisposableStore());
		let registeredSelector: unknown;
		let registeredProvider: unknown;
		const { service, contextKeyService } = createAutocompleteService({
			onRegister: (selector, provider) => {
				registeredSelector = selector;
				registeredProvider = provider;
			},
		});
		testDisposables.add(service);

		assert.deepStrictEqual(registeredSelector, { pattern: '**' });
		assert.strictEqual(registeredProvider, service);
		assert.strictEqual(contextKeyService.getContextKeyValue(VSCloneInlineSuggestionVisibleContextKey.key), false);
	});

	test('sets the VSClone visibility context key while a shown completion list is alive', () => {
		const testDisposables = store.add(new DisposableStore());
		const { service, contextKeyService } = createAutocompleteService();
		testDisposables.add(service);
		const item = { insertText: 'completion' } as InlineCompletion;
		const completions = { items: [item] } as InlineCompletions;

		service.handleItemDidShow(completions, item);
		assert.strictEqual(contextKeyService.getContextKeyValue(VSCloneInlineSuggestionVisibleContextKey.key), true);

		service.disposeInlineCompletions(completions);
		assert.strictEqual(contextKeyService.getContextKeyValue(VSCloneInlineSuggestionVisibleContextKey.key), false);
	});

	test('keeps the visibility context key set until the last shown completion list is disposed', () => {
		const testDisposables = store.add(new DisposableStore());
		const { service, contextKeyService } = createAutocompleteService();
		testDisposables.add(service);
		const firstItem = { insertText: 'first' } as InlineCompletion;
		const secondItem = { insertText: 'second' } as InlineCompletion;
		const firstCompletions = { items: [firstItem] } as InlineCompletions;
		const secondCompletions = { items: [secondItem] } as InlineCompletions;

		service.handleItemDidShow(firstCompletions, firstItem);
		service.handleItemDidShow(secondCompletions, secondItem);
		service.disposeInlineCompletions(firstCompletions);

		assert.strictEqual(contextKeyService.getContextKeyValue(VSCloneInlineSuggestionVisibleContextKey.key), true);

		service.disposeInlineCompletions(secondCompletions);
		assert.strictEqual(contextKeyService.getContextKeyValue(VSCloneInlineSuggestionVisibleContextKey.key), false);
	});

	test('disposes backend requests, clears cache state, and resets the visibility key', () => {
		const testDisposables = store.add(new DisposableStore());
		const { service, contextKeyService } = createAutocompleteService();
		testDisposables.add(service);
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

	test('classifies prediction modes, debounce windows, and replacement ranges', () => {
		const testDisposables = store.add(new DisposableStore());
		const defaultSetup = createAutocompleteService();
		testDisposables.add(defaultSetup.service);
		const configuredSetup = createAutocompleteService({
			configuration: { [VSCloneAutocompleteDebounceMsSetting]: 125 },
		});
		testDisposables.add(configuredSetup.service);
		const negativeSetup = createAutocompleteService({
			configuration: { [VSCloneAutocompleteDebounceMsSetting]: -25 },
		});
		testDisposables.add(negativeSetup.service);
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

	test('reuses cached completions and trims overlapping suffixes', () => {
		const testDisposables = store.add(new DisposableStore());
		const { service } = createAutocompleteService();
		testDisposables.add(service);
		const internals = service as unknown as IAutocompleteServiceInternals;
		const resource = URI.file('/workspace/sample.ts');

		internals.addToCache(resource, '  abc  ', 'defghi');
		internals.addToCache(resource, 'abcde', 'fghi');

		// The longest cached prefix must win so the test can distinguish prefix-selection from
		// simple string prefix matching.
		assert.strictEqual(internals.getCachedCompletion(resource, 'abcdef', ''), 'ghi');

		internals.addToCache(resource, 'foo', 'bar)');
		assert.strictEqual(internals.getCachedCompletion(resource, 'foo', 'ar)'), 'b');

		internals.addToCache(resource, 'foo', 'ar)');
		assert.strictEqual(internals.getCachedCompletion(resource, 'foo', 'ar)'), undefined);
		assert.strictEqual(internals.getCachedCompletion(resource, '   ', ''), undefined);
	});

	test('evicts only cache entries older than the 30 second boundary', () => {
		const testDisposables = store.add(new DisposableStore());
		const { service } = createAutocompleteService();
		testDisposables.add(service);
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
		const { service } = createAutocompleteService({
			configuration: { [VSCloneAutocompleteDebounceMsSetting]: 1 },
		});
		testDisposables.add(service);
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

	test('tracks backend request lifetimes and parent cancellation', () => {
		const testDisposables = store.add(new DisposableStore());
		const { service } = createAutocompleteService();
		testDisposables.add(service);
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

	test('returns cached inline completions immediately and bypasses the backend', async () => {
		const testDisposables = store.add(new DisposableStore());
		let backendCalled = false;
		const { service } = createAutocompleteService({
			configuration: { [VSCloneAutocompleteDebounceMsSetting]: 0 },
			complete: async () => {
				backendCalled = true;
				return 'ignored';
			},
		});
		testDisposables.add(service);
		const internals = service as unknown as IAutocompleteServiceInternals;
		const resource = URI.file('/workspace/sample.ts');
		const model = createTextModel('fooBa', resource);

		internals.addToCache(resource, 'foo', 'BarBaz()');
		const completions = await service.provideInlineCompletions(model, new Position(1, 6), {} as never, new CancellationTokenSource().token);

		assert.strictEqual(backendCalled, false);
		assert.strictEqual(completions?.items.length, 1);
		assert.strictEqual(completions?.items[0].insertText, 'rBaz()');
		assert.deepStrictEqual(completions?.items[0].range, new Range(1, 6, 1, 6));
	});

	test('requests multi-line completions with cross-file context and caches the result', async () => {
		const testDisposables = store.add(new DisposableStore());
		let backendRequest: IVSCloneCompletionRequest | undefined;
		let gatherContextArgs: unknown[] | undefined;
		const { service } = createAutocompleteService({
			configuration: { [VSCloneAutocompleteDebounceMsSetting]: 0 },
			complete: async request => {
				backendRequest = request;
				return 'const value = 1;\nreturn value;';
			},
			gatherContext: (...args) => {
				gatherContextArgs = args;
				return [
					{ filePath: '/workspace/helper.ts', languageId: 'typescript', content: 'export const helper = true;' },
					{ filePath: '/workspace/other.ts', languageId: 'typescript', content: 'export const other = true;' },
				];
			},
		});
		testDisposables.add(service);
		const model = createTextModel('function f() {\n    \n}', URI.file('/workspace/sample.ts'));

		const completions = await service.provideInlineCompletions(model, new Position(2, 5), {} as never, new CancellationTokenSource().token);

		assert.ok(gatherContextArgs);
		assert.strictEqual((gatherContextArgs![0] as URI).toString(), URI.file('/workspace/sample.ts').toString());
		assert.deepStrictEqual(gatherContextArgs!.slice(1), ['typescript', 2, 1_000]);
		assert.strictEqual(backendRequest?.predictionType, 'multi-line');
		assert.strictEqual(backendRequest?.maxTokens, 160);
		assert.deepStrictEqual(backendRequest?.crossFileContext, [
			{ filePath: '/workspace/helper.ts', languageId: 'typescript', content: 'export const helper = true;' },
			{ filePath: '/workspace/other.ts', languageId: 'typescript', content: 'export const other = true;' },
		]);
		assert.strictEqual(completions?.items[0].insertText, 'const value = 1;\nreturn value;');
		assert.deepStrictEqual(completions?.items[0].range, new Range(2, 5, 2, 5));
	});
});
