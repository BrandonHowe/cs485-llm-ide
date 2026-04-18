/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { VSCloneViewId } from '../../browser/vsclone.js';
import { registerVSCloneThreadActions, VSCloneThreadCommandIds } from '../../browser/vscloneThreadActions.js';
import { IVSCloneChatThreadService } from '../../browser/vscloneChatThreadService.js';

type TestView = {
	focus(): void;
	focusInput(): void;
	focusRail(): void;
	toggleRail(): void;
	copyPrompt(): Promise<void>;
	copyResponse(): Promise<void>;
	reusePrompt(): void;
	openSession(): Promise<void>;
	deleteActiveThread(): Promise<void>;
};

function ensureThreadActionsRegistered(): void {
	registerVSCloneThreadActions();
	registerVSCloneThreadActions();
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

function createViewRecorder(): { view: TestView; calls: string[] } {
	const calls: string[] = [];
	return {
		view: {
			focus: () => calls.push('focus'),
			focusInput: () => calls.push('focusInput'),
			focusRail: () => calls.push('focusRail'),
			toggleRail: () => calls.push('toggleRail'),
			copyPrompt: async () => { calls.push('copyPrompt'); },
			copyResponse: async () => { calls.push('copyResponse'); },
			reusePrompt: () => calls.push('reusePrompt'),
			openSession: async () => { calls.push('openSession'); },
			deleteActiveThread: async () => { calls.push('deleteActiveThread'); },
		},
		calls,
	};
}

function createViewsService(existingView: TestView | undefined, openedView: TestView | undefined = existingView): { service: IViewsService; openCalls: Array<{ id: string; focus: boolean }> } {
	const openCalls: Array<{ id: string; focus: boolean }> = [];
	return {
		service: {
			_serviceBrand: undefined,
			getViewWithId: (id: string) => id === VSCloneViewId ? existingView : undefined,
			openView: async <T>(id: string, focus: boolean) => {
				openCalls.push({ id, focus });
				return openedView as T | undefined;
			},
		} as unknown as IViewsService,
		openCalls,
	};
}

async function runCommand(commandId: string, accessor: { get<T>(id: unknown): T }): Promise<void> {
	const command = CommandsRegistry.getCommand(commandId);
	assert.ok(command);
	await command?.handler(accessor as never);
}

function hasCommandPaletteEntry(commandId: string): boolean {
	return MenuRegistry.getMenuItems(MenuId.CommandPalette).some(item => isIMenuItem(item) && item.command.id === commandId);
}

suite('VSCloneThreadActions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registers the thread commands with the expected metadata and command-palette entries', () => {
		ensureThreadActionsRegistered();

		const expectedTitles = new Map<string, string>([
			[VSCloneThreadCommandIds.open, 'Open VSClone Chat'],
			[VSCloneThreadCommandIds.focusRail, 'Focus VSClone Thread Rail'],
			[VSCloneThreadCommandIds.toggleRail, 'Toggle VSClone Thread Rail'],
			[VSCloneThreadCommandIds.copyPrompt, 'Copy Prompt From VSClone Thread'],
			[VSCloneThreadCommandIds.copyResponse, 'Copy Response From VSClone Thread'],
			[VSCloneThreadCommandIds.reusePrompt, 'Reuse Prompt From VSClone Thread'],
			[VSCloneThreadCommandIds.openSession, 'Open Selected VSClone Thread'],
			[VSCloneThreadCommandIds.deleteThread, 'Delete Selected VSClone Thread'],
			[VSCloneThreadCommandIds.clearAllWorkspace, 'Clear VSClone Workspace Threads'],
		]);

		for (const [commandId, title] of expectedTitles) {
			const command = CommandsRegistry.getCommand(commandId);
			assert.ok(command, commandId);
			assert.deepStrictEqual(command?.metadata?.description, {
				value: title,
				original: title,
			});
			assert.ok(MenuRegistry.getCommand(commandId), commandId);
			assert.ok(hasCommandPaletteEntry(commandId), commandId);
		}
	});

	test('opens the view and focuses the input when the open chat action needs to open the pane', async () => {
		ensureThreadActionsRegistered();

		const recorder = createViewRecorder();
		const { service, openCalls } = createViewsService(undefined, recorder.view);
		const accessor = createAccessor(new Map([[IViewsService, service]]));

		await runCommand(VSCloneThreadCommandIds.open, accessor);

		assert.deepStrictEqual(openCalls, [{ id: VSCloneViewId, focus: true }]);
		assert.deepStrictEqual(recorder.calls, ['focusInput']);
	});

	test('focuses an existing view before dispatching the view-backed thread actions', async () => {
		ensureThreadActionsRegistered();

		const cases = [
			[VSCloneThreadCommandIds.focusRail, ['focus', 'focusRail']],
			[VSCloneThreadCommandIds.toggleRail, ['focus', 'toggleRail']],
			[VSCloneThreadCommandIds.copyPrompt, ['focus', 'copyPrompt']],
			[VSCloneThreadCommandIds.copyResponse, ['focus', 'copyResponse']],
			[VSCloneThreadCommandIds.reusePrompt, ['focus', 'reusePrompt']],
			[VSCloneThreadCommandIds.openSession, ['focus', 'openSession']],
			[VSCloneThreadCommandIds.deleteThread, ['focus', 'deleteActiveThread']],
		] as const;

		for (const [commandId, expectedCalls] of cases) {
			const recorder = createViewRecorder();
			const { service, openCalls } = createViewsService(recorder.view);
			const accessor = createAccessor(new Map([[IViewsService, service]]));

			await runCommand(commandId, accessor);

			assert.deepStrictEqual(openCalls, [], commandId);
			assert.deepStrictEqual(recorder.calls, expectedCalls, commandId);
		}
	});

	test('delegates clearing workspace threads to the chat-thread service', async () => {
		ensureThreadActionsRegistered();

		let clearCalls = 0;
		const chatThreadService = {
			_serviceBrand: undefined,
			clearAll: async () => {
				clearCalls += 1;
			},
		};
		const accessor = createAccessor(new Map([
			[IVSCloneChatThreadService, chatThreadService],
		]));

		await runCommand(VSCloneThreadCommandIds.clearAllWorkspace, accessor);

		assert.strictEqual(clearCalls, 1);
	});
});
