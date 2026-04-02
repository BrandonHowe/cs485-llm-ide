/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { VSCloneProviderConfigurationBridge } from '../../browser/vscloneProviderConfigurationBridge.js';
import { IVSCloneOAuthService } from '../../common/vscloneOAuthService.js';
import { displayInfoOfOAuthProvider, IVSCloneOAuthProviderState, IVSCloneOAuthState, VSCloneModelVendor } from '../../common/vscloneOAuthTypes.js';

interface IProviderActionPick extends IQuickPickItem {
	readonly actionId: string;
	readonly vendor?: VSCloneModelVendor;
}

interface ITestOAuthService {
	initializeCalls: number;
	signInCalls: VSCloneModelVendor[];
	signOutCalls: VSCloneModelVendor[];
	state: IVSCloneOAuthState;
	initialize(): Promise<void>;
	signIn(vendor: VSCloneModelVendor): Promise<void>;
	signOut(vendor: VSCloneModelVendor): Promise<void>;
}

interface ITestQuickInputService {
	pickCalls: Array<{
		items: readonly IProviderActionPick[];
		options: Parameters<IQuickInputService['pick']>[1];
	}>;
	pick<T extends IProviderActionPick>(items: readonly T[], options: Parameters<IQuickInputService['pick']>[1]): Promise<T | undefined>;
}

function createProviderState(vendor: VSCloneModelVendor, isReady: boolean, userDisplayName?: string): IVSCloneOAuthProviderState {
	return {
		vendor,
		displayName: displayInfoOfOAuthProvider(vendor).title,
		status: isReady ? 'signed_in' : 'signed_out',
		userDisplayName,
		errorMessage: undefined,
		isReady,
	};
}

function createOAuthServiceStub(state: IVSCloneOAuthState): ITestOAuthService {
	return {
		initializeCalls: 0,
		signInCalls: [],
		signOutCalls: [],
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
	};
}

function createQuickInputServiceStub(selection: ((items: readonly IProviderActionPick[]) => IProviderActionPick | undefined) | undefined): ITestQuickInputService {
	return {
		pickCalls: [],
		async pick<T extends IProviderActionPick>(items: readonly T[], options: Parameters<IQuickInputService['pick']>[1]) {
			this.pickCalls.push({ items, options });
			return selection ? (selection(items) as T | undefined) : undefined;
		},
	};
}

suite('VSCloneProviderConfigurationBridge', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('constructor stores the injected services without side effects', () => {
		const quickInputService = createQuickInputServiceStub(undefined);
		const oauthService = createOAuthServiceStub({
			providers: {
				openai: createProviderState('openai', false),
				anthropic: createProviderState('anthropic', true, 'alice@example.com'),
				google: createProviderState('google', false),
			},
		});

		const bridge = new VSCloneProviderConfigurationBridge(
			quickInputService as unknown as IQuickInputService,
			oauthService as unknown as IVSCloneOAuthService,
		);

		assert.ok(bridge);
		assert.strictEqual(oauthService.initializeCalls, 0);
		assert.deepStrictEqual(oauthService.signInCalls, []);
		assert.deepStrictEqual(oauthService.signOutCalls, []);
		assert.deepStrictEqual(quickInputService.pickCalls, []);
	});

	test('openManageProvidersPicker signs in the selected provider and builds the expected actions', async () => {
		const oauthState: IVSCloneOAuthState = {
			providers: {
				openai: createProviderState('openai', false),
				anthropic: createProviderState('anthropic', true, 'alice@example.com'),
				google: createProviderState('google', false),
			},
		};
		const oauthService = createOAuthServiceStub(oauthState);
		const quickInputService = createQuickInputServiceStub(items => items.find(item => item.actionId === 'oauthSignIn' && item.vendor === 'openai'));
		const bridge = new VSCloneProviderConfigurationBridge(
			quickInputService as unknown as IQuickInputService,
			oauthService as unknown as IVSCloneOAuthService,
		);

		await bridge.openManageProvidersPicker();

		assert.strictEqual(oauthService.initializeCalls, 1);
		assert.strictEqual(quickInputService.pickCalls.length, 1);
		assert.strictEqual(quickInputService.pickCalls[0].items.length, 3);
		assert.deepStrictEqual(quickInputService.pickCalls[0].items.map(item => [item.actionId, item.vendor]), [
			['oauthSignIn', 'openai'],
			['oauthSignOut', 'anthropic'],
			['oauthSignIn', 'google'],
		]);
		assert.strictEqual(quickInputService.pickCalls[0].items[0].label, displayInfoOfOAuthProvider('openai').signInLabel);
		assert.strictEqual(quickInputService.pickCalls[0].items[1].label, 'Sign Out of Anthropic');
		assert.strictEqual(quickInputService.pickCalls[0].items[1].description, 'Signed in as alice@example.com');
		assert.strictEqual(quickInputService.pickCalls[0].items[2].description, displayInfoOfOAuthProvider('google').description);
		assert.deepStrictEqual(oauthService.signInCalls, ['openai']);
		assert.deepStrictEqual(oauthService.signOutCalls, []);
	});

	test('openManageProvidersPicker signs out a ready provider and leaves cancel alone', async () => {
		const oauthState: IVSCloneOAuthState = {
			providers: {
				openai: createProviderState('openai', false),
				anthropic: createProviderState('anthropic', false),
				google: createProviderState('google', true),
			},
		};
		const oauthService = createOAuthServiceStub(oauthState);
		const quickInputService = createQuickInputServiceStub(items => items.find(item => item.actionId === 'oauthSignOut' && item.vendor === 'google'));
		const bridge = new VSCloneProviderConfigurationBridge(
			quickInputService as unknown as IQuickInputService,
			oauthService as unknown as IVSCloneOAuthService,
		);

		await bridge.openManageProvidersPicker();

		assert.strictEqual(oauthService.initializeCalls, 1);
		assert.strictEqual(quickInputService.pickCalls.length, 1);
		assert.strictEqual(quickInputService.pickCalls[0].items[2].description, 'Currently signed in');
		assert.deepStrictEqual(oauthService.signInCalls, []);
		assert.deepStrictEqual(oauthService.signOutCalls, ['google']);

		const cancelingQuickInputService = createQuickInputServiceStub(() => undefined);
		const cancelBridge = new VSCloneProviderConfigurationBridge(
			cancelingQuickInputService as unknown as IQuickInputService,
			oauthService as unknown as IVSCloneOAuthService,
		);

		await cancelBridge.openManageProvidersPicker();
		assert.strictEqual(cancelingQuickInputService.pickCalls.length, 1);
		assert.deepStrictEqual(oauthService.signInCalls, []);
		assert.deepStrictEqual(oauthService.signOutCalls, ['google']);
	});
});
