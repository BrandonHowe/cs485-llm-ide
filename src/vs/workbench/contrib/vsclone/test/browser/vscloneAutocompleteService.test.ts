/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InlineCompletion, InlineCompletions } from '../../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { VSCloneAutocompleteService, VSCloneInlineSuggestionVisibleContextKey } from '../../browser/vscloneAutocompleteService.js';
import { IVSCloneCompletionBackend } from '../../common/vscloneCompletionTypes.js';
import { IVSCloneCompletionContextService } from '../../browser/vscloneCompletionContextService.js';

function createLanguageFeaturesService(): ILanguageFeaturesService {
	return {
		inlineCompletionsProvider: {
			register: () => Disposable.None,
		},
	} as unknown as ILanguageFeaturesService;
}

suite('VSCloneAutocompleteService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('sets the VSClone visibility context key while a shown completion list is alive', () => {
		const testDisposables = store.add(new DisposableStore());
		const contextKeyService = new MockContextKeyService();
		const service = testDisposables.add(new VSCloneAutocompleteService(
			{} as IVSCloneCompletionBackend,
			{} as IVSCloneCompletionContextService,
			createLanguageFeaturesService(),
			new TestConfigurationService(),
			contextKeyService,
			new NullLogService(),
		));
		const item = { insertText: 'completion' } as InlineCompletion;
		const completions = { items: [item] } as InlineCompletions;

		service.handleItemDidShow(completions, item);
		assert.strictEqual(contextKeyService.getContextKeyValue(VSCloneInlineSuggestionVisibleContextKey.key), true);

		service.disposeInlineCompletions(completions);
		assert.strictEqual(contextKeyService.getContextKeyValue(VSCloneInlineSuggestionVisibleContextKey.key), false);
	});

	test('keeps the visibility context key set until the last shown completion list is disposed', () => {
		const testDisposables = store.add(new DisposableStore());
		const contextKeyService = new MockContextKeyService();
		const service = testDisposables.add(new VSCloneAutocompleteService(
			{} as IVSCloneCompletionBackend,
			{} as IVSCloneCompletionContextService,
			createLanguageFeaturesService(),
			new TestConfigurationService(),
			contextKeyService,
			new NullLogService(),
		));
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
});
