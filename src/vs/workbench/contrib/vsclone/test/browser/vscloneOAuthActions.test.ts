/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IVSCloneOAuthService } from '../../common/vscloneOAuthService.js';
import { defaultOAuthProviderConfig, displayInfoOfOAuthProvider, IVSCloneOAuthProviderState, IVSCloneOAuthState, VSCloneModelVendor } from '../../common/vscloneOAuthTypes.js';
import { registerVSCloneOAuthActions, VSCloneOAuthCommandIds } from '../../browser/vscloneOAuthActions.js';

interface IVendorPick extends IQuickPickItem {
	readonly vendor: VSCloneModelVendor;
}

function labelOf(value: string | { value: string } | undefined): string {
	return typeof value === 'string' ? value : value?.value ?? '';
}

function createProviderState(vendor: VSCloneModelVendor, status: IVSCloneOAuthProviderState['status'], userDisplayName?: string, errorMessage?: string): IVSCloneOAuthProviderState {
	return {
		vendor,
		displayName: defaultOAuthProviderConfig[vendor].displayName,
		status,
		userDisplayName,
		errorMessage,
		isReady: status === 'signed_in',
	};
}

function createOAuthServiceStub(state: IVSCloneOAuthState) {
	return {
		_serviceBrand: undefined,
		initializeCalls: 0,
		signInCalls: [] as VSCloneModelVendor[],
		signOutCalls: [] as VSCloneModelVendor[],
		state,
		async initialize() {
			this.initializeCalls += 1;
		},
		async signIn(vendor: VSCloneModelVendor) {
			this.signInCalls.push(vendor);
		},
		async signOut(vendor: VSCloneModelVendor) {
			this.signOutCalls.push(vendor);
		},
	} as IVSCloneOAuthService & {
		initializeCalls: number;
		signInCalls: VSCloneModelVendor[];
		signOutCalls: VSCloneModelVendor[];
	};
}

function createQuickInputServiceStub(selection: (items: readonly IQuickPickItem[]) => IQuickPickItem | undefined) {
	const pickCalls: Array<{
		items: readonly IQuickPickItem[];
		options: Parameters<IQuickInputService['pick']>[1];
	}> = [];

	return {
		_serviceBrand: undefined,
		pickCalls,
		async pick<T extends IQuickPickItem>(items: readonly T[], options: Parameters<IQuickInputService['pick']>[1]) {
			pickCalls.push({ items, options });
			return selection(items) as T | undefined;
		},
	} as IQuickInputService & {
		pickCalls: Array<{
			items: readonly IQuickPickItem[];
			options: Parameters<IQuickInputService['pick']>[1];
		}>;
	};
}

function createAccessor(oAuthService: IVSCloneOAuthService, quickInputService: IQuickInputService): ServicesAccessor {
	return {
		get<T>(serviceIdentifier: unknown): T {
			if (serviceIdentifier === IVSCloneOAuthService) {
				return oAuthService as T;
			}

			if (serviceIdentifier === IQuickInputService) {
				return quickInputService as T;
			}

			throw new Error(`Unexpected service requested: ${String(serviceIdentifier)}`);
		},
	} as ServicesAccessor;
}

function ensureOAuthActionsRegistered(): void {
	registerVSCloneOAuthActions();
	registerVSCloneOAuthActions();
}

function hasCommandPaletteEntry(commandId: string): boolean {
	return MenuRegistry.getMenuItems(MenuId.CommandPalette).some(item => isIMenuItem(item) && item.command.id === commandId);
}

suite('VSCloneOAuthActions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registers the OAuth commands in the palette with the expected titles', () => {
		ensureOAuthActionsRegistered();

		const commands = [
			[VSCloneOAuthCommandIds.signIn, 'Sign In to VSClone Provider'],
			[VSCloneOAuthCommandIds.signOut, 'Sign Out of VSClone Provider'],
			[VSCloneOAuthCommandIds.showStatus, 'Show VSClone Auth Status'],
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

	test('sign-in handler filters providers and signs in the selected vendor', async () => {
		ensureOAuthActionsRegistered();

		const oauthService = createOAuthServiceStub({
			providers: {
				openai: createProviderState('openai', 'signed_out'),
				anthropic: createProviderState('anthropic', 'signed_in'),
				google: createProviderState('google', 'signed_out'),
			},
		});
		const quickInputService = createQuickInputServiceStub(items => items.find(item => (item as IVendorPick).vendor === 'google'));
		const accessor = createAccessor(oauthService, quickInputService);

		const command = CommandsRegistry.getCommand(VSCloneOAuthCommandIds.signIn);
		assert.ok(command);
		await command!.handler(accessor);

		const call = quickInputService.pickCalls[0];
		assert.ok(call);
		assert.deepStrictEqual(call.items.map(item => (item as IVendorPick).vendor), ['openai', 'google']);
		assert.deepStrictEqual(call.items.map(item => item.label), [
			displayInfoOfOAuthProvider('openai').signInLabel,
			displayInfoOfOAuthProvider('google').signInLabel,
		]);
		assert.deepStrictEqual(call.items.map(item => item.description), [
			displayInfoOfOAuthProvider('openai').description,
			displayInfoOfOAuthProvider('google').description,
		]);
		assert.deepStrictEqual(call.options, {
			canPickMany: false,
			placeHolder: 'Select a provider to sign in',
			title: 'Sign In to Provider',
		});
		assert.deepStrictEqual(oauthService.signInCalls, ['google']);
		assert.strictEqual(oauthService.initializeCalls, 1);
		assert.deepStrictEqual(oauthService.signOutCalls, []);
	});

	test('sign-out handler filters ready providers and signs out the selected vendor', async () => {
		ensureOAuthActionsRegistered();

		const oauthService = createOAuthServiceStub({
			providers: {
				openai: createProviderState('openai', 'signed_in', 'Ada'),
				anthropic: createProviderState('anthropic', 'signed_out'),
				google: createProviderState('google', 'signed_in'),
			},
		});
		const quickInputService = createQuickInputServiceStub(items => items.find(item => (item as IVendorPick).vendor === 'openai'));
		const accessor = createAccessor(oauthService, quickInputService);

		const command = CommandsRegistry.getCommand(VSCloneOAuthCommandIds.signOut);
		assert.ok(command);
		await command!.handler(accessor);

		const call = quickInputService.pickCalls[0];
		assert.ok(call);
		assert.deepStrictEqual(call.items.map(item => (item as IVendorPick).vendor), ['openai', 'google']);
		assert.deepStrictEqual(call.items.map(item => item.label), [
			'Sign Out of OpenAI',
			'Sign Out of Google',
		]);
		assert.deepStrictEqual(call.items.map(item => item.description), [
			'Signed in as Ada',
			undefined,
		]);
		assert.deepStrictEqual(call.options, {
			canPickMany: false,
			placeHolder: 'Select a provider to sign out',
			title: 'Sign Out of Provider',
		});
		assert.deepStrictEqual(oauthService.signOutCalls, ['openai']);
		assert.strictEqual(oauthService.initializeCalls, 1);
		assert.deepStrictEqual(oauthService.signInCalls, []);
	});

	test('show-status handler renders the current provider states without mutating auth', async () => {
		ensureOAuthActionsRegistered();

		const oauthService = createOAuthServiceStub({
			providers: {
				openai: createProviderState('openai', 'signed_in', 'Ada'),
				anthropic: createProviderState('anthropic', 'refreshing'),
				google: createProviderState('google', 'error', undefined, 'token expired'),
			},
		});
		const quickInputService = createQuickInputServiceStub(() => undefined);
		const accessor = createAccessor(oauthService, quickInputService);

		const command = CommandsRegistry.getCommand(VSCloneOAuthCommandIds.showStatus);
		assert.ok(command);
		await command!.handler(accessor);

		const call = quickInputService.pickCalls[0];
		assert.ok(call);
		assert.deepStrictEqual(call.items.map(item => item.label), [
			defaultOAuthProviderConfig.openai.displayName,
			defaultOAuthProviderConfig.anthropic.displayName,
			defaultOAuthProviderConfig.google.displayName,
		]);
		assert.deepStrictEqual(call.items.map(item => item.description), [
			`${'Signed In'} - Ada`,
			'Refreshing...',
			'Error',
		]);
		assert.deepStrictEqual(call.items.map(item => item.detail), [
			undefined,
			undefined,
			'Error: token expired',
		]);
		assert.deepStrictEqual(call.options, {
			canPickMany: false,
			placeHolder: 'VSClone Provider Authentication Status',
			title: 'Auth Status',
		});
		assert.strictEqual(oauthService.initializeCalls, 1);
		assert.deepStrictEqual(oauthService.signInCalls, []);
		assert.deepStrictEqual(oauthService.signOutCalls, []);
	});
});
