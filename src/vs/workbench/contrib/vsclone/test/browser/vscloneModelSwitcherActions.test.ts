/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { VSCloneViewId } from '../../browser/vsclone.js';
import { registerVSCloneModelSwitcherActions, VSCloneModelSwitcherCommandIds } from '../../browser/vscloneModelSwitcherActions.js';

interface IViewPaneStub {
	focus(): void;
	openModelPicker(): void;
	refreshModelCatalog(): Promise<void>;
	manageProviders(): Promise<void>;
	openSettingsPage(): void;
	resetModelSelection(): Promise<void>;
	switchToNextModel(): Promise<void>;
}

function labelOf(value: string | { value: string } | undefined): string {
	return typeof value === 'string' ? value : value?.value ?? '';
}

function createPaneStub() {
	const calls = {
		focus: 0,
		openModelPicker: 0,
		refreshModelCatalog: 0,
		manageProviders: 0,
		openSettingsPage: 0,
		resetModelSelection: 0,
		switchToNextModel: 0,
	};

	const pane: IViewPaneStub = {
		focus: () => {
			calls.focus += 1;
		},
		openModelPicker: () => {
			calls.openModelPicker += 1;
		},
		async refreshModelCatalog() {
			calls.refreshModelCatalog += 1;
		},
		async manageProviders() {
			calls.manageProviders += 1;
		},
		openSettingsPage: () => {
			calls.openSettingsPage += 1;
		},
		async resetModelSelection() {
			calls.resetModelSelection += 1;
		},
		async switchToNextModel() {
			calls.switchToNextModel += 1;
		},
	};

	return { pane, calls };
}

function createViewsServiceStub(options: {
	readonly existingView?: IViewPaneStub;
	readonly openedView?: IViewPaneStub;
}) {
	const calls = {
		getViewWithId: [] as string[],
		openView: [] as Array<{ id: string; focus: boolean }>,
	};

	const service = {
		_serviceBrand: undefined,
		getViewWithId: (id: string) => {
			calls.getViewWithId.push(id);
			return options.existingView;
		},
		openView: async <T>(id: string, focus: boolean) => {
			calls.openView.push({ id, focus });
			return (options.openedView ?? undefined) as T | undefined;
		},
	} as unknown as IViewsService;

	return { service, calls };
}

function createAccessor(viewsService: IViewsService): ServicesAccessor {
	return {
		get<T>(serviceIdentifier: unknown): T {
			if (serviceIdentifier === IViewsService) {
				return viewsService as T;
			}

			throw new Error(`Unexpected service requested: ${String(serviceIdentifier)}`);
		},
	} as ServicesAccessor;
}

function ensureModelSwitcherActionsRegistered(): void {
	registerVSCloneModelSwitcherActions();
	registerVSCloneModelSwitcherActions();
}

function hasCommandPaletteEntry(commandId: string): boolean {
	return MenuRegistry.getMenuItems(MenuId.CommandPalette).some(item => isIMenuItem(item) && item.command.id === commandId);
}

suite('VSCloneModelSwitcherActions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registers the commands as palette entries with the expected titles', () => {
		ensureModelSwitcherActionsRegistered();

		const commands = [
			[VSCloneModelSwitcherCommandIds.openPicker, 'Open VSClone Model Picker'],
			[VSCloneModelSwitcherCommandIds.refreshCatalog, 'Refresh VSClone Model Catalog'],
			[VSCloneModelSwitcherCommandIds.manageProviders, 'Manage VSClone Providers'],
			[VSCloneModelSwitcherCommandIds.openSettings, 'Open VSClone Settings'],
			[VSCloneModelSwitcherCommandIds.resetSelection, 'Reset VSClone Model Selection'],
			[VSCloneModelSwitcherCommandIds.switchToNextModel, 'Switch VSClone To Next Model'],
		] as const;

		for (const [id, title] of commands) {
			const command = CommandsRegistry.getCommand(id);
			const menuCommand = MenuRegistry.getCommand(id);
			assert.ok(command, `Expected command registration for ${id}`);
			assert.ok(menuCommand, `Expected menu registration for ${id}`);
			assert.strictEqual(command?.id, id);
			assert.strictEqual(menuCommand?.id, id);
			assert.strictEqual(labelOf(command?.metadata?.description as string | { value: string } | undefined), title);
			assert.strictEqual(labelOf(menuCommand?.title), title);
			assert.ok(hasCommandPaletteEntry(id), `Expected command palette entry for ${id}`);
		}
	});

	test('routes the registered handlers through the current view when it is already open', async () => {
		ensureModelSwitcherActionsRegistered();

		const { pane, calls } = createPaneStub();
		const { service, calls: viewCalls } = createViewsServiceStub({ existingView: pane });
		const accessor = createAccessor(service);

		const cases = [
			[VSCloneModelSwitcherCommandIds.openPicker, 'openModelPicker', 'openModelPicker'] as const,
			[VSCloneModelSwitcherCommandIds.refreshCatalog, 'refreshModelCatalog', 'refreshModelCatalog'] as const,
			[VSCloneModelSwitcherCommandIds.manageProviders, 'manageProviders', 'manageProviders'] as const,
			[VSCloneModelSwitcherCommandIds.openSettings, 'openSettingsPage', 'openSettingsPage'] as const,
			[VSCloneModelSwitcherCommandIds.resetSelection, 'resetModelSelection', 'resetModelSelection'] as const,
			[VSCloneModelSwitcherCommandIds.switchToNextModel, 'switchToNextModel', 'switchToNextModel'] as const,
		];

		for (const [id, callName, counterName] of cases) {
			const command = CommandsRegistry.getCommand(id);
			assert.ok(command, `Expected command handler for ${id}`);
			await command!.handler(accessor);
			assert.strictEqual((calls as Record<string, number>)[counterName], 1, `${id} should invoke ${callName}`);
			assert.strictEqual(calls.focus, 1, `${id} should focus the view before invoking ${callName}`);
			assert.deepStrictEqual(viewCalls.openView, [], `${id} should reuse the existing view`);
			(calls as Record<string, number>)[counterName] = 0;
			calls.focus = 0;
		}
	});

	test('opens the view only when needed and then runs the open-picker command', async () => {
		ensureModelSwitcherActionsRegistered();

		const { pane: openedPane, calls: paneCalls } = createPaneStub();
		const { service, calls: viewCalls } = createViewsServiceStub({ openedView: openedPane });
		const accessor = createAccessor(service);

		const command = CommandsRegistry.getCommand(VSCloneModelSwitcherCommandIds.openPicker);
		assert.ok(command);
		await command!.handler(accessor);

		assert.deepStrictEqual(viewCalls.getViewWithId, [VSCloneViewId]);
		assert.deepStrictEqual(viewCalls.openView, [{ id: VSCloneViewId, focus: true }]);
		assert.strictEqual(paneCalls.openModelPicker, 1);
		assert.strictEqual(paneCalls.focus, 0);
	});
});
