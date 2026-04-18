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
import {
	VSCLONE_OAUTH_COMMAND_OPEN_EXTERNAL,
	VSCLONE_OAUTH_COMMAND_START_LOOPBACK,
	VSCLONE_OAUTH_COMMAND_STOP_LOOPBACK,
	VSCLONE_OAUTH_COMMAND_TOKEN_EXCHANGE,
	VSCLONE_OAUTH_COMMAND_WAIT_FOR_LOOPBACK,
} from '../../common/vscloneOAuthIpc.js';
import { defaultOAuthProviderConfig, IVSCloneOAuthProviderConfig, IVSCloneOAuthState, IVSCloneOAuthTokenSet, oauthSecretKey, VSCloneModelVendor, VSCloneOAuthStatus } from '../../common/vscloneOAuthTypes.js';

interface IVSCloneOAuthServiceInternals {
	_acquireManualAuthorizationCode(
		vendor: VSCloneModelVendor,
		config: IVSCloneOAuthProviderConfig,
		expectedState: string,
		codeChallenge: string,
	): Promise<{ code: string; redirectUri: string } | undefined>;
	_acquireLoopbackAuthorizationCode(
		vendor: VSCloneModelVendor,
		config: IVSCloneOAuthProviderConfig,
		expectedState: string,
		codeChallenge: string,
	): Promise<{ code: string; redirectUri: string } | undefined>;
	_buildInitialState(): IVSCloneOAuthState;
	_setProviderStatus(
		vendor: VSCloneModelVendor,
		status: VSCloneOAuthStatus,
		extra?: { userDisplayName?: string; errorMessage?: string },
	): void;
	_recomputeDerivedState(): void;
	_doRefresh(vendor: VSCloneModelVendor, tokenSet: IVSCloneOAuthTokenSet, authEpoch: number): Promise<void>;
	_extractUserDisplayNameFromTokenSet(tokenSet: IVSCloneOAuthTokenSet): string | undefined;
	readonly _tokenSets: Map<VSCloneModelVendor, IVSCloneOAuthTokenSet>;
}

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

function createUnavailableMainProcessService() {
	let getChannelCalls = 0;

	return {
		service: {
			_serviceBrand: undefined,
			getChannel: (_channelName: string) => {
				getChannelCalls += 1;
				// Throw instead of returning a stub so the service sees the same missing-desktop-bridge
				// failure mode it would hit outside Electron.
				throw new Error('OAuth transport channel is unavailable');
			},
			registerChannel: (_channelName: string) => undefined,
		},
		getChannelCalls: () => getChannelCalls,
	};
}

function createNotificationService(): INotificationService {
	return {} as unknown as INotificationService;
}

function createQuickInputService(): IQuickInputService {
	return {} as unknown as IQuickInputService;
}

function createRecordingQuickInputService(inputResult?: string, pickResult?: unknown) {
	const inputCalls: unknown[] = [];
	const pickCalls: unknown[] = [];

	return {
		inputCalls,
		pickCalls,
		input: async (options: unknown) => {
			inputCalls.push(options);
			return inputResult;
		},
		pick: async (items: unknown, options: unknown) => {
			pickCalls.push({ items, options });
			return pickResult;
		},
	} as IQuickInputService & {
		inputCalls: unknown[];
		pickCalls: unknown[];
	};
}

function createRecordingNotificationService() {
	const infos: string[] = [];
	const errors: string[] = [];
	const warns: string[] = [];

	return {
		infos,
		errors,
		warns,
		info: (...args: unknown[]) => {
			infos.push(String(args[0]));
		},
		error: (...args: unknown[]) => {
			errors.push(String(args[0]));
		},
		warn: (...args: unknown[]) => {
			warns.push(String(args[0]));
		},
	} as INotificationService & {
		infos: string[];
		errors: string[];
		warns: string[];
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

function createRecordingMainProcessService(channel: IChannel) {
	let getChannelCalls = 0;

	return {
		service: {
			_serviceBrand: undefined,
			getChannel: (_channelName: string) => {
				getChannelCalls += 1;
				return channel;
			},
			registerChannel: (_channelName: string) => undefined,
		},
		getChannelCalls: () => getChannelCalls,
	};
}

function toBase64Url(value: string): string {
	// These tests run in the browser harness, so they cannot rely on Node's Buffer helpers.
	const encoded = new TextEncoder().encode(value);
	let binary = '';
	for (const byte of encoded) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function createJwt(payload: Record<string, unknown>): string {
	return `${toBase64Url('{"alg":"none","typ":"JWT"}')}.${toBase64Url(JSON.stringify(payload))}.signature`;
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

function createOAuthHarness(options?: {
	inputResult?: string;
	pickResult?: unknown;
	channelHandlers?: Partial<Record<string, (payload: unknown) => unknown | Promise<unknown>>>;
	mainProcessService?: ReturnType<typeof createRecordingMainProcessService> | ReturnType<typeof createUnavailableMainProcessService>;
}, store?: Pick<DisposableStore, 'add'>) {
	if (!store) {
		throw new Error('Expected a suite-scoped disposable store');
	}

	const testDisposables = store.add(new DisposableStore());
	const secretStorageService = testDisposables.add(new TestSecretStorageService());
	const quickInputService = createRecordingQuickInputService(options?.inputResult, options?.pickResult);
	const notificationService = createRecordingNotificationService();
	const { channel, calls } = createChannel(options?.channelHandlers);
	const mainProcessService = options?.mainProcessService ?? createRecordingMainProcessService(channel);
	const service = testDisposables.add(new VSCloneOAuthService(
		secretStorageService,
		new NullLogService(),
		notificationService,
		quickInputService,
		mainProcessService.service,
	));

	return {
		service,
		secretStorageService,
		quickInputService,
		notificationService,
		channel,
		calls,
		mainProcessService,
	};
}

function asOAuthServiceInternals(service: VSCloneOAuthService): IVSCloneOAuthServiceInternals {
	return service as unknown as IVSCloneOAuthServiceInternals;
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

	test('google provider config matches the current Gemini OAuth quickstart', () => {
		assert.deepStrictEqual(
			{
				authUrl: defaultOAuthProviderConfig.google.authUrl,
				tokenUrl: defaultOAuthProviderConfig.google.tokenUrl,
				redirectUriTemplate: defaultOAuthProviderConfig.google.redirectUriTemplate,
				scopes: defaultOAuthProviderConfig.google.scopes,
			},
			{
				authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
				tokenUrl: 'https://oauth2.googleapis.com/token',
				redirectUriTemplate: 'http://127.0.0.1:{port}/oauth2callback',
				scopes: [
					'https://www.googleapis.com/auth/generative-language.retriever',
				],
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

	test('getApiHeaders includes the required Anthropic version header', async () => {
		const testDisposables = store.add(new DisposableStore());
		const secretStorageService = testDisposables.add(new TestSecretStorageService());
		await secretStorageService.set(oauthSecretKey('anthropic'), JSON.stringify(createTokenSet({
			vendor: 'anthropic',
			accessToken: 'anthropic-access-token',
		})));

		const service = testDisposables.add(new VSCloneOAuthService(
			secretStorageService,
			new NullLogService(),
			createNotificationService(),
			createQuickInputService(),
			createMainProcessService(),
		));

		await service.initialize();
		const headers = await service.getApiHeaders('anthropic');

		// Guard the exact header contract so the main-process fetch path cannot regress back to the
		// 400 response Anthropic returns when `anthropic-version` is omitted, while keeping feature
		// betas off the global header contract unless a request path explicitly opts into them.
		assert.strictEqual(headers?.Authorization, 'Bearer anthropic-access-token');
		assert.strictEqual(headers?.['anthropic-version'], '2023-06-01');
		assert.strictEqual(headers?.['anthropic-beta'], 'oauth-2025-04-20');
	});

	test('signIn completes the OpenAI loopback flow and persists account metadata', async () => {
		const accessToken = createJwt({
			'https://api.openai.com/auth': {
				chatgpt_account_id: 'acct-123',
			},
		});
		const idToken = createJwt({ email: 'user@example.com' });
		let expectedState: string | undefined;
		const harness = createOAuthHarness({
			channelHandlers: {
				[VSCLONE_OAUTH_COMMAND_START_LOOPBACK]: () => ({
					redirectUri: 'http://localhost:1455/auth/callback',
				}),
				[VSCLONE_OAUTH_COMMAND_OPEN_EXTERNAL]: (payload) => {
					const url = new URL(String(payload));
					expectedState = url.searchParams.get('state') ?? undefined;
					assert.strictEqual(url.searchParams.get('response_type'), 'code');
					assert.strictEqual(url.searchParams.get('code_challenge_method'), 'S256');
					return undefined;
				},
				[VSCLONE_OAUTH_COMMAND_WAIT_FOR_LOOPBACK]: () => ({
					code: 'auth-code',
					state: expectedState,
				}),
				[VSCLONE_OAUTH_COMMAND_TOKEN_EXCHANGE]: (payload) => {
					const request = payload as { body: string; contentType: string };
					const body = new URLSearchParams(request.body);
					assert.strictEqual(request.contentType, 'application/x-www-form-urlencoded');
					assert.strictEqual(body.get('grant_type'), 'authorization_code');
					assert.strictEqual(body.get('code'), 'auth-code');
					assert.strictEqual(body.get('client_id'), defaultOAuthProviderConfig.openai.clientId);
					return {
						statusCode: 200,
						body: JSON.stringify({
							access_token: accessToken,
							token_type: 'Bearer',
							refresh_token: 'refresh-1',
							id_token: idToken,
							expires_in: 3600,
							scope: 'openid profile',
						}),
					};
				},
				[VSCLONE_OAUTH_COMMAND_STOP_LOOPBACK]: () => undefined,
			},
		}, store);

		await harness.service.signIn('openai');

		assert.strictEqual(harness.service.isSignedIn('openai'), true);
		assert.strictEqual(harness.service.state.providers.openai.userDisplayName, 'user@example.com');
		assert.strictEqual(harness.mainProcessService.getChannelCalls(), 1);
		assert.strictEqual(harness.notificationService.infos.length, 1);

		const stored = await harness.secretStorageService.get(oauthSecretKey('openai'));
		assert.ok(stored);
		const parsed = JSON.parse(stored);
		assert.strictEqual(parsed.providerMetadata['chatgpt-account-id'], 'acct-123');

		const headers = await harness.service.getApiHeaders('openai');
		assert.strictEqual(headers?.Authorization, `Bearer ${accessToken}`);
		assert.strictEqual(headers?.['ChatGPT-Account-Id'], 'acct-123');
		assert.strictEqual(headers?.['OpenAI-Beta'], 'responses=v1');
		assert.strictEqual(headers?.['OpenAI-Originator'], 'codex');
	});

	test('signIn reports token exchange failures and marks the provider errored', async () => {
		let expectedState: string | undefined;
		const harness = createOAuthHarness({
			channelHandlers: {
				[VSCLONE_OAUTH_COMMAND_START_LOOPBACK]: () => ({
					redirectUri: 'http://localhost:1455/auth/callback',
				}),
				[VSCLONE_OAUTH_COMMAND_OPEN_EXTERNAL]: (payload) => {
					const url = new URL(String(payload));
					expectedState = url.searchParams.get('state') ?? undefined;
					return undefined;
				},
				[VSCLONE_OAUTH_COMMAND_WAIT_FOR_LOOPBACK]: () => ({
					code: 'auth-code',
					state: expectedState,
				}),
				[VSCLONE_OAUTH_COMMAND_TOKEN_EXCHANGE]: () => ({
					statusCode: 502,
					body: '<html>bad gateway</html>',
				}),
				[VSCLONE_OAUTH_COMMAND_STOP_LOOPBACK]: () => undefined,
			},
		}, store);

		await harness.service.signIn('openai');

		assert.strictEqual(harness.service.isSignedIn('openai'), false);
		assert.strictEqual(harness.service.state.providers.openai.status, 'error');
		assert.strictEqual(harness.service.state.providers.openai.errorMessage, 'Token exchange failed: <html>bad gateway</html>');
		assert.strictEqual(harness.notificationService.errors.length, 1);
		assert.ok(/Failed to sign in to OpenAI:/.test(harness.notificationService.errors[0]));
	});

	test('manual and fallback authorization helpers parse pasted codes and recover when loopback setup fails', async () => {
		const manualHarness = createOAuthHarness({
			inputResult: 'http://localhost:1455/auth/callback?code=manual-code&state=manual-state',
			channelHandlers: {
				[VSCLONE_OAUTH_COMMAND_OPEN_EXTERNAL]: () => undefined,
			},
		}, store);
		const manualConfig: IVSCloneOAuthProviderConfig = {
			...defaultOAuthProviderConfig.openai,
			redirectStrategy: 'manual_paste',
			redirectUriTemplate: 'http://localhost:1455/auth/callback',
		};
		const manualInternals = asOAuthServiceInternals(manualHarness.service);

		const manualResult = await manualInternals._acquireManualAuthorizationCode('openai', manualConfig, 'manual-state', 'challenge');
		assert.deepStrictEqual(manualResult, {
			code: 'manual-code',
			redirectUri: 'http://localhost:1455/auth/callback',
		});
		assert.strictEqual(manualHarness.calls[0].command, VSCLONE_OAUTH_COMMAND_OPEN_EXTERNAL);
		assert.ok(/code_challenge=challenge/.test(String(manualHarness.calls[0].payload)));

		let stoppedSessionId: string | undefined;
		const fallbackHarness = createOAuthHarness({
			inputResult: 'fallback-code',
			channelHandlers: {
				[VSCLONE_OAUTH_COMMAND_START_LOOPBACK]: () => {
					throw new Error('loopback unavailable');
				},
				[VSCLONE_OAUTH_COMMAND_OPEN_EXTERNAL]: (payload) => {
					const url = new URL(String(payload));
					assert.strictEqual(url.searchParams.get('state'), 'fallback-state');
					return undefined;
				},
				[VSCLONE_OAUTH_COMMAND_STOP_LOOPBACK]: (payload) => {
					stoppedSessionId = (payload as { sessionId: string }).sessionId;
					return undefined;
				},
			},
		}, store);
		const fallbackInternals = asOAuthServiceInternals(fallbackHarness.service);

		const fallbackResult = await fallbackInternals._acquireLoopbackAuthorizationCode(
			'openai',
			defaultOAuthProviderConfig.openai,
			'fallback-state',
			'challenge',
		);

		assert.deepStrictEqual(fallbackResult, {
			code: 'fallback-code',
			redirectUri: 'http://localhost:1455/auth/callback',
		});
		assert.ok(stoppedSessionId);
		assert.strictEqual(fallbackHarness.mainProcessService.getChannelCalls(), 1);
	});

	test('signIn reports a missing OAuth transport channel as a hard failure', async () => {
		// Missing main-process transport is not the same as a loopback callback failure, so this
		// regression test makes sure the service does not quietly fall back to manual paste here.
		const harness = createOAuthHarness({
			inputResult: 'fallback-code',
			mainProcessService: createUnavailableMainProcessService(),
		}, store);

		await harness.service.signIn('openai');

		assert.strictEqual(harness.service.state.providers.openai.status, 'error');
		assert.strictEqual(
			harness.service.state.providers.openai.errorMessage,
			'OAuth requires the desktop VSClone bridge for browser launch and token exchange.'
		);
		assert.strictEqual(harness.notificationService.errors.length, 1);
		assert.match(harness.notificationService.errors[0], /Failed to sign in to OpenAI:/);
		assert.match(harness.notificationService.errors[0], /OAuth requires the desktop VSClone bridge for browser launch and token exchange\./);
	});

	test('refresh fails coherently when the OAuth transport channel is unavailable', async () => {
		// Refresh uses the same main-process bridge as interactive sign-in, so transport loss should
		// surface as a real OAuth failure instead of a null-assertion crash.
		const harness = createOAuthHarness({
			mainProcessService: createUnavailableMainProcessService(),
		}, store);

		await harness.service.initialize();
		const internals = asOAuthServiceInternals(harness.service);
		const tokenSet = createTokenSet({
			expiresAt: Date.now() - 1_000,
			refreshToken: 'refresh-1',
		});
		internals._tokenSets.set('openai', tokenSet);
		internals._setProviderStatus('openai', 'signed_in');

		await assert.rejects(
			internals._doRefresh('openai', tokenSet, 0),
			/OAuth requires the desktop VSClone bridge for browser launch and token exchange\./
		);
		assert.strictEqual(harness.service.state.providers.openai.status, 'error');
		assert.strictEqual(
			harness.service.state.providers.openai.errorMessage,
			'OAuth requires the desktop VSClone bridge for browser launch and token exchange.'
		);
		assert.strictEqual(harness.notificationService.errors.length, 1);
		assert.match(harness.notificationService.errors[0], /Failed to refresh OpenAI session:/);
	});

	test('refreshes near-expiry OpenAI tokens once and coalesces concurrent refreshes', async () => {
		const refreshRequests: Array<{ body: string; contentType: string }> = [];
		let resolveRefresh: ((value: unknown) => void) | undefined;
		const refreshPromise = new Promise((resolve) => {
			resolveRefresh = resolve;
		});
		const harness = createOAuthHarness({
			channelHandlers: {
				[VSCLONE_OAUTH_COMMAND_TOKEN_EXCHANGE]: (payload) => {
					refreshRequests.push(payload as { body: string; contentType: string });
					return refreshPromise;
				},
			},
		}, store);

		await harness.secretStorageService.set(oauthSecretKey('openai'), JSON.stringify(createTokenSet({
			expiresAt: Date.now() + 30_000,
			refreshToken: 'refresh-1',
		})));

		await harness.service.initialize();

		const first = harness.service.getAccessToken('openai');
		const second = harness.service.getAccessToken('openai');
		await Promise.resolve();
		await Promise.resolve();
		assert.strictEqual(refreshRequests.length, 1);

		resolveRefresh?.({
			statusCode: 200,
			body: JSON.stringify({
				access_token: createJwt({
					'https://api.openai.com/auth': {
						chatgpt_account_id: 'acct-refresh',
					},
				}),
				token_type: 'Bearer',
				refresh_token: 'refresh-2',
				id_token: createJwt({ email: 'fresh@example.com' }),
				expires_in: 3600,
				scope: 'openid profile',
			}),
		});

		const [firstAccessToken, secondAccessToken] = await Promise.all([first, second]);
		assert.strictEqual(firstAccessToken, secondAccessToken);
		assert.ok(firstAccessToken);

		const request = refreshRequests[0];
		const body = new URLSearchParams(request.body);
		assert.strictEqual(request.contentType, 'application/x-www-form-urlencoded');
		assert.strictEqual(body.get('grant_type'), 'refresh_token');
		assert.strictEqual(body.get('refresh_token'), 'refresh-1');
		assert.strictEqual(body.get('client_id'), defaultOAuthProviderConfig.openai.clientId);

		const tokenSet = await harness.service.getTokenSet('openai');
		assert.strictEqual(tokenSet?.refreshToken, 'refresh-2');
		assert.strictEqual(harness.service.state.providers.openai.userDisplayName, 'fresh@example.com');

		const headers = await harness.service.getApiHeaders('openai');
		assert.strictEqual(headers?.['ChatGPT-Account-Id'], 'acct-refresh');
		assert.strictEqual(headers?.Authorization, `Bearer ${firstAccessToken}`);
	});

	test('refreshes expired Anthropic tokens with the JSON refresh body and keeps derived state in sync', async () => {
		const refreshRequests: Array<{ body: string; contentType: string }> = [];
		let resolveRefresh: ((value: unknown) => void) | undefined;
		const refreshPromise = new Promise((resolve) => {
			resolveRefresh = resolve;
		});
		const harness = createOAuthHarness({
			channelHandlers: {
				[VSCLONE_OAUTH_COMMAND_TOKEN_EXCHANGE]: (payload) => {
					refreshRequests.push(payload as { body: string; contentType: string });
					return refreshPromise;
				},
			},
		}, store);

		await harness.secretStorageService.set(oauthSecretKey('anthropic'), JSON.stringify(createTokenSet({
			vendor: 'anthropic',
			accessToken: 'anthropic-old-access',
			refreshToken: 'anthropic-refresh-1',
			expiresAt: Date.now() - 1_000,
		})));

		const initPromise = harness.service.initialize();
		await Promise.resolve();
		await Promise.resolve();
		assert.strictEqual(refreshRequests.length, 1);
		assert.strictEqual(harness.service.state.providers.anthropic.status, 'refreshing');

		resolveRefresh?.({
			statusCode: 200,
			body: JSON.stringify({
				access_token: 'anthropic-new-access',
				token_type: 'Bearer',
				refresh_token: 'anthropic-refresh-2',
				id_token: createJwt({ name: 'Anthropic User' }),
				expires_in: 1800,
				scope: 'org:create_api_key user:profile',
			}),
		});

		await initPromise;

		const request = refreshRequests[0];
		assert.strictEqual(request.contentType, 'application/json');
		assert.deepStrictEqual(JSON.parse(request.body), {
			grant_type: 'refresh_token',
			refresh_token: 'anthropic-refresh-1',
			client_id: defaultOAuthProviderConfig.anthropic.clientId,
			scope: defaultOAuthProviderConfig.anthropic.scopes.join(' '),
		});

		assert.strictEqual(harness.service.isSignedIn('anthropic'), true);
		assert.strictEqual(harness.service.state.providers.anthropic.status, 'signed_in');
		assert.strictEqual(harness.service.state.providers.anthropic.userDisplayName, 'Anthropic User');

		const headers = await harness.service.getApiHeaders('anthropic');
		assert.strictEqual(headers?.Authorization, 'Bearer anthropic-new-access');
		assert.strictEqual(headers?.['anthropic-version'], '2023-06-01');
		assert.strictEqual(headers?.['anthropic-beta'], 'oauth-2025-04-20');
	});

	test('tracks provider state helpers and Google API headers', async () => {
		const harness = createOAuthHarness(undefined, store);
		const internals = asOAuthServiceInternals(harness.service);
		const initialState = internals._buildInitialState();

		assert.deepStrictEqual(Object.keys(initialState.providers), ['openai', 'anthropic', 'google']);
		assert.strictEqual(initialState.providers.openai.status, 'signed_out');
		assert.strictEqual(initialState.providers.anthropic.status, 'signed_out');
		assert.strictEqual(initialState.providers.google.status, 'signed_out');

		const openaiTokenSet = createTokenSet({
			providerMetadata: { email: 'openai@example.com' },
		});
		const anthropicTokenSet = createTokenSet({
			vendor: 'anthropic',
			accessToken: 'anthropic-access',
			idToken: createJwt({ email: 'anthropic@example.com' }),
		});
		const googleTokenSet = createTokenSet({
			vendor: 'google',
			accessToken: 'google-access',
			providerMetadata: { email: 'google@example.com' },
		});

		assert.strictEqual(internals._extractUserDisplayNameFromTokenSet(openaiTokenSet), 'openai@example.com');
		assert.strictEqual(internals._extractUserDisplayNameFromTokenSet(anthropicTokenSet), 'anthropic@example.com');
		assert.strictEqual(internals._extractUserDisplayNameFromTokenSet(googleTokenSet), 'google@example.com');

		internals._tokenSets.set('google', { ...googleTokenSet, expiresAt: Date.now() + 60_000 });
		internals._setProviderStatus('google', 'signed_in');
		assert.strictEqual(harness.service.state.providers.google.isReady, true);

		internals._tokenSets.set('google', { ...googleTokenSet, expiresAt: Date.now() - 1_000 });
		internals._recomputeDerivedState();
		assert.strictEqual(harness.service.state.providers.google.isReady, false);

		internals._setProviderStatus('openai', 'error', { errorMessage: 'boom' });
		assert.strictEqual(harness.service.state.providers.openai.status, 'error');
		assert.strictEqual(harness.service.state.providers.openai.errorMessage, 'boom');

		const originalQuotaProject = defaultOAuthProviderConfig.google.quotaProject;
		assert.strictEqual(Reflect.set(defaultOAuthProviderConfig.google, 'quotaProject', '12345'), true);
		try {
			internals._tokenSets.set('google', { ...googleTokenSet, expiresAt: Date.now() + 60_000 });
			internals._setProviderStatus('google', 'signed_in');
			const headers = await harness.service.getApiHeaders('google');
			assert.strictEqual(headers?.Authorization, 'Bearer google-access');
			assert.strictEqual(headers?.['x-goog-user-project'], '12345');
		} finally {
			assert.strictEqual(Reflect.set(defaultOAuthProviderConfig.google, 'quotaProject', originalQuotaProject), true);
		}
	});
});
