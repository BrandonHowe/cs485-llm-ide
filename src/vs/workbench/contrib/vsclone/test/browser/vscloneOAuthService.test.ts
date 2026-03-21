/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { VSCloneOAuthService } from '../../browser/vscloneOAuthService.js';
import { defaultOAuthProviderConfig, IVSCloneOAuthTokenSet, oauthSecretKey } from '../../common/vscloneOAuthTypes.js';

function createMainProcessService(): IMainProcessService {
	const channel: IChannel = {
		call: async <T>() => undefined as T,
		listen: () => Event.None,
	};

	return {
		_serviceBrand: undefined,
		getChannel: (_channelName: string) => channel,
		registerChannel: (_channelName: string) => undefined,
	};
}

function createNotificationService(): INotificationService {
	return {} as unknown as INotificationService;
}

function createQuickInputService(): IQuickInputService {
	return {} as unknown as IQuickInputService;
}

function createTokenSet(overrides: Partial<IVSCloneOAuthTokenSet> = {}): IVSCloneOAuthTokenSet {
	return {
		vendor: 'openai',
		accessToken: 'openai-access-token',
		refreshToken: undefined,
		idToken: undefined,
		expiresAt: Date.now() + 60_000,
		scopes: ['openid'],
		providerMetadata: {},
		...overrides,
	};
}

suite('VSCloneOAuthService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('anthropic provider config matches the current Claude Code OAuth endpoints', () => {
		assert.deepStrictEqual(
			{
				authUrl: defaultOAuthProviderConfig.anthropic.authUrl,
				tokenUrl: defaultOAuthProviderConfig.anthropic.tokenUrl,
				redirectUriTemplate: defaultOAuthProviderConfig.anthropic.redirectUriTemplate,
				scopes: defaultOAuthProviderConfig.anthropic.scopes,
				extraAuthorizeParams: defaultOAuthProviderConfig.anthropic.extraAuthorizeParams,
			},
			{
				authUrl: 'https://claude.ai/oauth/authorize',
				tokenUrl: 'https://platform.claude.com/v1/oauth/token',
				redirectUriTemplate: 'http://localhost:{port}/callback',
				scopes: ['org:create_api_key', 'user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'],
				extraAuthorizeParams: { code: 'true' },
			}
		);
	});

	test('initialize restores a persisted token and marks the provider ready', async () => {
		const testDisposables = store.add(new DisposableStore());
		const secretStorageService = testDisposables.add(new TestSecretStorageService());
		await secretStorageService.set(oauthSecretKey('openai'), JSON.stringify(createTokenSet({
			providerMetadata: { email: 'user@example.com' },
		})));

		const service = testDisposables.add(new VSCloneOAuthService(
			secretStorageService,
			new NullLogService(),
			createNotificationService(),
			createQuickInputService(),
			createMainProcessService(),
		));

		await service.initialize();

		assert.strictEqual(service.isSignedIn('openai'), true);
		assert.strictEqual(service.state.providers.openai.isReady, true);
		assert.strictEqual(service.state.providers.openai.userDisplayName, 'user@example.com');
	});

	test('signOut removes persisted secrets and marks provider unavailable', async () => {
		const testDisposables = store.add(new DisposableStore());
		const secretStorageService = testDisposables.add(new TestSecretStorageService());
		await secretStorageService.set(oauthSecretKey('openai'), JSON.stringify(createTokenSet()));

		const service = testDisposables.add(new VSCloneOAuthService(
			secretStorageService,
			new NullLogService(),
			createNotificationService(),
			createQuickInputService(),
			createMainProcessService(),
		));

		await service.initialize();
		await service.signOut('openai');

		assert.strictEqual(await secretStorageService.get(oauthSecretKey('openai')), undefined);
		assert.strictEqual(service.isSignedIn('openai'), false);
		assert.strictEqual(service.state.providers.openai.status, 'signed_out');
	});

	test('initialize keeps expired tokens signed out when no refresh token exists', async () => {
		const testDisposables = store.add(new DisposableStore());
		const secretStorageService = testDisposables.add(new TestSecretStorageService());
		await secretStorageService.set(oauthSecretKey('openai'), JSON.stringify(createTokenSet({
			expiresAt: Date.now() - 1_000,
		})));

		const service = testDisposables.add(new VSCloneOAuthService(
			secretStorageService,
			new NullLogService(),
			createNotificationService(),
			createQuickInputService(),
			createMainProcessService(),
		));

		await service.initialize();

		assert.strictEqual(service.isSignedIn('openai'), false);
		assert.strictEqual(service.state.providers.openai.status, 'signed_out');
	});
});
