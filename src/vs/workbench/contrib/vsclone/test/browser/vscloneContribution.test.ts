/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { decodeKeybinding } from '../../../../../base/common/keybindings.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { OS } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry, ConfigurationScope } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../../common/views.js';
import { VSCloneViewContainerId, VSCloneViewId } from '../../browser/vsclone.js';
import { VSCloneUnifiedChatViewPane } from '../../browser/vscloneUnifiedChatViewPane.js';
import { VSCloneThreadCommandIds } from '../../browser/vscloneThreadActions.js';
import { VSCloneModelSwitcherCommandIds } from '../../browser/vscloneModelSwitcherActions.js';
import { VSCloneOAuthCommandIds } from '../../browser/vscloneOAuthActions.js';
import { VSCloneAutocompleteDebounceMsSetting, VSCloneAutocompleteEnabledSetting } from '../../browser/vscloneAutocompleteService.js';
import { VSCloneChatRailWidthSetting } from '../../common/vscloneChatViewSettings.js';

function assertCommandRegistered(commandId: string): void {
	assert.ok(CommandsRegistry.getCommand(commandId), `expected command ${commandId} to be registered`);
}

function hasCommandPaletteEntry(commandId: string): boolean {
	return MenuRegistry.getMenuItems(MenuId.CommandPalette).some(item => isIMenuItem(item) && item.command.id === commandId);
}

suite('VSCloneContribution', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suiteSetup(async () => {
		// Import the contribution only when this suite executes so unrelated suites do not inherit
		// its global registrations merely because this test module was loaded.
		await import('../../browser/vsclone.contribution.js');
	});

	test('registers the VSClone container, view, and configuration schema', () => {
		const viewContainersRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
		const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
		const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

		const viewContainer = viewContainersRegistry.get(VSCloneViewContainerId);
		assert.ok(viewContainer, 'expected the VSClone view container to be registered');
		assert.strictEqual(viewContainer?.id, VSCloneViewContainerId);
		assert.strictEqual(viewContainer?.storageId, VSCloneViewContainerId);
		assert.strictEqual(viewContainer?.hideIfEmpty, false);
		assert.strictEqual(viewContainer?.minimumWidth, 300);
		assert.strictEqual(viewContainer?.openCommandActionDescriptor, undefined);
		assert.strictEqual(viewContainersRegistry.getViewContainerLocation(viewContainer!), ViewContainerLocation.Sidebar);

		const viewDescriptor = viewsRegistry.getViews(viewContainer!).find(view => view.id === VSCloneViewId);
		assert.ok(viewDescriptor, 'expected the VSClone view descriptor to be registered');
		assert.strictEqual(viewDescriptor?.id, VSCloneViewId);
		assert.ok(viewDescriptor?.name.value);
		assert.strictEqual(viewDescriptor?.containerIcon, viewContainer?.icon);
		assert.strictEqual(viewDescriptor?.containerTitle, viewContainer?.title.value);
		assert.strictEqual(viewDescriptor?.singleViewPaneContainerTitle, viewContainer?.title.value);
		assert.strictEqual(viewDescriptor?.canToggleVisibility, true);
		assert.strictEqual(viewDescriptor?.canMoveView, false);
		assert.strictEqual(viewDescriptor?.ctorDescriptor.ctor, VSCloneUnifiedChatViewPane);

		const configurationNode = configurationRegistry.getConfigurations().find(node => node.id === 'vsclone');
		assert.ok(configurationNode, 'expected the VSClone configuration node to be registered');
		assert.strictEqual(configurationNode?.type, 'object');

		const properties = configurationRegistry.getConfigurationProperties();
		assert.strictEqual(properties[VSCloneChatRailWidthSetting]?.type, 'number');
		assert.strictEqual(properties[VSCloneChatRailWidthSetting]?.default, 320);
		assert.strictEqual(properties[VSCloneChatRailWidthSetting]?.minimum, 220);
		assert.strictEqual(properties[VSCloneChatRailWidthSetting]?.maximum, 520);
		assert.strictEqual(properties[VSCloneChatRailWidthSetting]?.scope, ConfigurationScope.WINDOW);

		assert.strictEqual(properties['vsclone.modelSwitcher.enabled']?.type, 'boolean');
		assert.strictEqual(properties['vsclone.modelSwitcher.enabled']?.default, true);
		assert.strictEqual(properties['vsclone.modelSwitcher.enabled']?.scope, ConfigurationScope.WINDOW);

		assert.strictEqual(properties[VSCloneAutocompleteEnabledSetting]?.type, 'boolean');
		assert.strictEqual(properties[VSCloneAutocompleteEnabledSetting]?.default, true);
		assert.strictEqual(properties[VSCloneAutocompleteEnabledSetting]?.scope, ConfigurationScope.WINDOW);

		assert.strictEqual(properties[VSCloneAutocompleteDebounceMsSetting]?.type, 'number');
		assert.strictEqual(properties[VSCloneAutocompleteDebounceMsSetting]?.default, 500);
		assert.strictEqual(properties[VSCloneAutocompleteDebounceMsSetting]?.minimum, 0);
		assert.strictEqual(properties[VSCloneAutocompleteDebounceMsSetting]?.scope, ConfigurationScope.WINDOW);
	});

	test('registers representative action side effects and the Tab keybinding', () => {
		// The dedicated action suites own exact command metadata. This contribution test only
		// verifies that the module wires each action family into the global registries at all.
		assertCommandRegistered(VSCloneThreadCommandIds.open);
		assertCommandRegistered(VSCloneModelSwitcherCommandIds.openPicker);
		assertCommandRegistered(VSCloneOAuthCommandIds.signIn);
		assertCommandRegistered('vsclone.autocomplete.acceptInlineCompletionOnTab');

		assert.ok(hasCommandPaletteEntry(VSCloneThreadCommandIds.open));
		assert.ok(hasCommandPaletteEntry(VSCloneModelSwitcherCommandIds.openPicker));
		assert.ok(hasCommandPaletteEntry(VSCloneOAuthCommandIds.signIn));
		assert.strictEqual(hasCommandPaletteEntry('vsclone.autocomplete.acceptInlineCompletionOnTab'), false);

		const tabKeybinding = KeybindingsRegistry.getDefaultKeybindings().find(binding => binding.command === 'vsclone.autocomplete.acceptInlineCompletionOnTab');
		assert.ok(tabKeybinding, 'expected the Tab accept keybinding to be registered');
		assert.ok(tabKeybinding?.keybinding?.equals(decodeKeybinding(KeyCode.Tab, OS)));
	});
});
