/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { VSCloneOAuthService } from '../../browser/vscloneOAuthService.js';
import {
	VSCLONE_OAUTH_CHANNEL_NAME,
	VSCLONE_OAUTH_COMMAND_TOKEN_EXCHANGE,
	IVSCloneOAuthTokenExchangeResponse,
} from '../../common/vscloneOAuthIpc.js';
import { defaultOAuthProviderConfig, IVSCloneOAuthTokenSet, oauthSecretKey } from '../../common/vscloneOAuthTypes.js';

function createNotificationService(): INotificationService {
	return {
		info: () => undefined,
		warn: () => undefined,
		error: () => undefined,
	} as unknown as INotificationService;
}

function createQuickInputService(): IQuickInputService {
	return {
		input: async () => undefined,
		pick: async () => undefined,
	} as unknown as IQuickInputService;
}

function createRecordingQuickInputService(inputResult: string | undefined) {
	const inputCalls: unknown[] = [];

	return {
		inputCalls,
		service: {
			input: async (options: unknown) => {
				inputCalls.push(options);
				return inputResult;
			},
			pick: async () => undefined,
		} as unknown as IQuickInputService,
	};
}

function createChannel(
	handlers: Partial<Record<string, (payload: unknown) => unknown | Promise<unknown>>> = {},
) {
	const calls: Array<{ command: string; payload: unknown }> = [];
	const channel: IChannel = {
		call: async <T>(command: string, payload: unknown) => {
			calls.push({ command, payload });
			const handler = handlers[command];
			if (!handler) {
				throw new Error(`Unexpected channel command: ${command}`);
			}
			return handler(payload) as Promise<T> | T;
		},
		listen: () => Event.None,
	};

	return { channel, calls };
}

function createMainProcessService(channel: IChannel) {
	let getChannelCalls = 0;

	return {
		service: {
			_serviceBrand: undefined,
			getChannel: (channelName: string) => {
				getChannelCalls += 1;
				assert.strictEqual(channelName, VSCLONE_OAUTH_CHANNEL_NAME);
				return channel;
			},
			registerChannel: () => undefined,
		},
		getChannelCalls: () => getChannelCalls,
	};
}

function createTokenSet(overrides: Partial<IVSCloneOAuthTokenSet> = {}): IVSCloneOAuthTokenSet {
	return {
		vendor: 'openai',
		accessToken: 'openai-access-token',
		refreshToken: 'refresh-token-1',
		idToken: undefined,
		expiresAt: Date.now() + 30_000,
		scopes: ['openid'],
		providerMetadata: {},
		...overrides,
	};
}

suite('VSCloneOAuthService integration', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('signOut wins over an in-flight refresh token exchange', async () => {
		const testDisposables = store.add(new DisposableStore());
		const secretStorageService = testDisposables.add(new TestSecretStorageService());
		const refreshResponse = new DeferredPromise<IVSCloneOAuthTokenExchangeResponse>();
		const refreshStarted = new DeferredPromise<void>();

		await secretStorageService.set(oauthSecretKey('openai'), JSON.stringify(createTokenSet()));

		const { channel, calls } = createChannel({
			[VSCLONE_OAUTH_COMMAND_TOKEN_EXCHANGE]: (payload) => {
				const request = payload as { url: string; body: string; contentType: string };
				const body = new URLSearchParams(request.body);

				assert.strictEqual(request.url, defaultOAuthProviderConfig.openai.tokenUrl);
				assert.strictEqual(request.contentType, 'application/x-www-form-urlencoded');
				assert.strictEqual(body.get('grant_type'), 'refresh_token');
				assert.strictEqual(body.get('refresh_token'), 'refresh-token-1');
				assert.strictEqual(body.get('client_id'), defaultOAuthProviderConfig.openai.clientId);

				// Hold the backend exchange open so the test can race a real sign-out against the
				// renderer-side refresh completion path.
				refreshStarted.complete();
				return refreshResponse.p;
			},
		});
		const mainProcessService = createMainProcessService(channel);
		const service = testDisposables.add(new VSCloneOAuthService(
			secretStorageService,
			new NullLogService(),
			createNotificationService(),
			createQuickInputService(),
			mainProcessService.service,
		));

		await service.initialize();
		assert.strictEqual(service.state.providers.openai.status, 'signed_in');
		assert.strictEqual(service.state.providers.openai.isReady, true);

		const accessTokenPromise = service.getAccessToken('openai');
		await refreshStarted.p;
		assert.strictEqual(service.state.providers.openai.status, 'refreshing');
		assert.strictEqual(mainProcessService.getChannelCalls(), 1);
		assert.strictEqual(calls.length, 1);

		await service.signOut('openai');
		assert.strictEqual(service.state.providers.openai.status, 'signed_out');
		assert.strictEqual(service.state.providers.openai.isReady, false);
		assert.strictEqual(await secretStorageService.get(oauthSecretKey('openai')), undefined);

		refreshResponse.complete({
			statusCode: 200,
			body: JSON.stringify({
				access_token: 'openai-access-token-refreshed',
				token_type: 'Bearer',
				refresh_token: 'refresh-token-2',
				expires_in: 3600,
				scope: 'openid profile',
			}),
		});

		await accessTokenPromise;

		assert.strictEqual(service.state.providers.openai.status, 'signed_out');
		assert.strictEqual(service.state.providers.openai.isReady, false);
		assert.strictEqual(await secretStorageService.get(oauthSecretKey('openai')), undefined);
	});

	test('signIn falls back to manual code entry when loopback startup fails', async () => {
		const testDisposables = store.add(new DisposableStore());
		const secretStorageService = testDisposables.add(new TestSecretStorageService());
		const quickInputService = createRecordingQuickInputService('manual-auth-code');
		let openedRedirectUri: string | undefined;

		const { channel, calls } = createChannel({
			startLoopback: () => {
				throw new Error('Port already in use');
			},
			openExternal: (payload) => {
				const authUrl = new URL(payload as string);
				openedRedirectUri = authUrl.searchParams.get('redirect_uri') ?? undefined;
				return undefined;
			},
			stopLoopback: () => undefined,
			[VSCLONE_OAUTH_COMMAND_TOKEN_EXCHANGE]: (payload) => {
				const request = payload as { url: string; body: string; contentType: string };
				const body = new URLSearchParams(request.body);

				assert.strictEqual(request.url, defaultOAuthProviderConfig.openai.tokenUrl);
				assert.strictEqual(request.contentType, 'application/x-www-form-urlencoded');
				assert.strictEqual(body.get('grant_type'), 'authorization_code');
				assert.strictEqual(body.get('code'), 'manual-auth-code');
				assert.strictEqual(body.get('redirect_uri'), `http://localhost:${defaultOAuthProviderConfig.openai.preferredPort}/auth/callback`);

				return {
					statusCode: 200,
					body: JSON.stringify({
						access_token: 'manual-access-token',
						token_type: 'Bearer',
						expires_in: 3600,
						scope: 'openid profile',
					}),
				};
			},
		});
		const service = testDisposables.add(new VSCloneOAuthService(
			secretStorageService,
			new NullLogService(),
			createNotificationService(),
			quickInputService.service,
			createMainProcessService(channel).service,
		));

		await service.signIn('openai');

		assert.strictEqual(openedRedirectUri, `http://localhost:${defaultOAuthProviderConfig.openai.preferredPort}/auth/callback`);
		assert.strictEqual(quickInputService.inputCalls.length, 1);
		assert.strictEqual(service.state.providers.openai.status, 'signed_in');
		assert.strictEqual(service.state.providers.openai.isReady, true);
		assert.strictEqual(await secretStorageService.get(oauthSecretKey('openai')) !== undefined, true);
		assert.ok(calls.some(call => call.command === 'startLoopback'));
		assert.ok(calls.some(call => call.command === 'openExternal'));
		assert.ok(!calls.some(call => call.command === 'waitForLoopback'));
	});
});
