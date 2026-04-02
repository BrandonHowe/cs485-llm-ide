/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeKeybinding } from '../../../../../base/common/keybindings.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { OS } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { KeybindingWeight, KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { inlineSuggestCommitId } from '../../../../../editor/contrib/inlineCompletions/browser/controller/commandIds.js';
import { InlineCompletionContextKeys } from '../../../../../editor/contrib/inlineCompletions/browser/controller/inlineCompletionContextKeys.js';
import { Context as SuggestContext } from '../../../../../editor/contrib/suggest/browser/suggest.js';
import { SnippetController2 } from '../../../../../editor/contrib/snippet/browser/snippetController2.js';
import { EditorContextKeys } from '../../../../../editor/common/editorContextKeys.js';
import { registerVSCloneAutocompleteActions } from '../../browser/vscloneAutocompleteActions.js';
import { VSCloneInlineSuggestionVisibleContextKey } from '../../browser/vscloneAutocompleteService.js';

const vscloneAutocompleteAcceptInlineCompletionOnTabId = 'vsclone.autocomplete.acceptInlineCompletionOnTab';

function ensureAutocompleteActionsRegistered(): void {
	registerVSCloneAutocompleteActions();
	registerVSCloneAutocompleteActions();
}

function createAccessor(services: Map<unknown, unknown>): { get<T>(id: unknown): T } {
	return {
		get<T>(id: unknown): T {
			if (!services.has(id)) {
				throw new Error(`Missing service for ${String(id)}`);
			}
			return services.get(id) as T;
		},
	};
}

function hasCommandPaletteEntry(commandId: string): boolean {
	return MenuRegistry.getMenuItems(MenuId.CommandPalette).some(item => isIMenuItem(item) && item.command.id === commandId);
}

suite('VSCloneAutocompleteActions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registers the Tab command with the expected metadata, command palette state, and keybinding', () => {
		ensureAutocompleteActionsRegistered();

		const command = CommandsRegistry.getCommand(vscloneAutocompleteAcceptInlineCompletionOnTabId);
		assert.ok(command);
		assert.deepStrictEqual(command?.metadata?.description, {
			value: 'Accept VSClone Inline Completion On Tab',
			original: 'Accept VSClone Inline Completion On Tab',
		});
		assert.strictEqual(MenuRegistry.getCommand(vscloneAutocompleteAcceptInlineCompletionOnTabId), undefined);
		assert.strictEqual(hasCommandPaletteEntry(vscloneAutocompleteAcceptInlineCompletionOnTabId), false);

		const keybinding = KeybindingsRegistry.getDefaultKeybindings().find(rule => rule.command === vscloneAutocompleteAcceptInlineCompletionOnTabId);
		assert.ok(keybinding);
		assert.ok(keybinding?.keybinding?.equals(decodeKeybinding(KeyCode.Tab, OS)));
		assert.strictEqual(keybinding?.weight1, KeybindingWeight.WorkbenchContrib + 1);
		const when = keybinding?.when?.serialize() ?? '';
		assert.ok(when.includes(VSCloneInlineSuggestionVisibleContextKey.key));
		assert.ok(when.includes(InlineCompletionContextKeys.inlineSuggestionVisible.key));
		assert.ok(when.includes(EditorContextKeys.tabMovesFocus.key));
		assert.ok(when.includes(SuggestContext.Visible.key));
		assert.ok(when.includes(EditorContextKeys.hoverFocused.key));
		assert.ok(when.includes(InlineCompletionContextKeys.hasSelection.key));
		assert.ok(when.includes(SnippetController2.InSnippetMode.key));
	});

	test('executes the built-in inline suggestion accept command', async () => {
		ensureAutocompleteActionsRegistered();

		const executedCommands: string[] = [];
		const commandService = {
			_serviceBrand: undefined,
			executeCommand: async (commandId: string) => {
				executedCommands.push(commandId);
			},
		};
		const accessor = createAccessor(new Map([[ICommandService, commandService]]));

		const command = CommandsRegistry.getCommand(vscloneAutocompleteAcceptInlineCompletionOnTabId);
		assert.ok(command);
		await command?.handler(accessor as never);

		assert.deepStrictEqual(executedCommands, [inlineSuggestCommitId]);
	});

	test('propagates command service failures without swallowing them', async () => {
		ensureAutocompleteActionsRegistered();

		const error = new Error('command failed');
		const commandService = {
			_serviceBrand: undefined,
			executeCommand: async () => {
				throw error;
			},
		};
		const accessor = createAccessor(new Map([[ICommandService, commandService]]));

		const command = CommandsRegistry.getCommand(vscloneAutocompleteAcceptInlineCompletionOnTabId);
		assert.ok(command);

		await assert.rejects(async () => command?.handler(accessor as never), error);
	});
});
