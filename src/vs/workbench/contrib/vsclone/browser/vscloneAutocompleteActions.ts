/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode } from '../../../../base/common/keyCodes.js';
import { inlineSuggestCommitId } from '../../../../editor/contrib/inlineCompletions/browser/controller/commandIds.js';
import { InlineCompletionContextKeys } from '../../../../editor/contrib/inlineCompletions/browser/controller/inlineCompletionContextKeys.js';
import { Context as SuggestContext } from '../../../../editor/contrib/suggest/browser/suggest.js';
import { SnippetController2 } from '../../../../editor/contrib/snippet/browser/snippetController2.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { VSCloneInlineSuggestionVisibleContextKey } from './vscloneAutocompleteService.js';

const registrationKey = '__vscloneAutocompleteActionsRegistered__';
type GlobalScope = typeof globalThis & {
	readonly [registrationKey]?: boolean;
};

const vscloneAcceptInlineCompletionOnTabId = 'vsclone.autocomplete.acceptInlineCompletionOnTab';

const vscloneAutocompleteTabWhen = ContextKeyExpr.and(
	EditorContextKeys.writable,
	VSCloneInlineSuggestionVisibleContextKey,
	InlineCompletionContextKeys.inlineSuggestionVisible,
	EditorContextKeys.tabMovesFocus.toNegated(),
	SuggestContext.Visible.toNegated(),
	EditorContextKeys.hoverFocused.toNegated(),
	InlineCompletionContextKeys.hasSelection.toNegated(),
	SnippetController2.InSnippetMode.toNegated(),
);

export function registerVSCloneAutocompleteActions(): void {
	const globalScope = globalThis as GlobalScope;
	if (globalScope[registrationKey]) {
		return;
	}
	(globalScope as { [registrationKey]: boolean })[registrationKey] = true;

	registerAction2(class VSCloneAcceptInlineCompletionOnTabAction extends Action2 {
		constructor() {
			super({
				id: vscloneAcceptInlineCompletionOnTabId,
				title: localize2('vsclone.autocomplete.acceptInlineCompletionOnTab', 'Accept VSClone Inline Completion On Tab'),
				f1: false,
				precondition: vscloneAutocompleteTabWhen,
				keybinding: {
					primary: KeyCode.Tab,
					when: vscloneAutocompleteTabWhen,
					weight: KeybindingWeight.WorkbenchContrib + 1,
				},
			});
		}

		override async run(accessor: import('../../../../platform/instantiation/common/instantiation.js').ServicesAccessor): Promise<void> {
			// Reuse the editor's built-in accept command so VSClone keeps all of the existing inline
			// completion accept behavior and only narrows when Tab should route to that command.
			await accessor.get(ICommandService).executeCommand(inlineSuggestCommitId);
		}
	});
}
