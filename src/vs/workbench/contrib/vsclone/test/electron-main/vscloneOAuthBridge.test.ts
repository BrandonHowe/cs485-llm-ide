/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'http';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IChannel, IServerChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { VSCloneOAuthService } from '../../common/vscloneOAuthServiceImpl.js';
import { VSCloneOAuthLoopbackChannel, vscloneOAuthLoopbackRuntime } from '../../electron-main/vscloneOAuthLoopbackChannel.js';
import { defaultOAuthProviderConfig, oauthSecretKey } from '../../common/vscloneOAuthTypes.js';

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

function createClientChannel(serverChannel: IServerChannel<string>): IChannel {
	// The renderer service only depends on `IChannel`, while the loopback implementation is an
	// `IServerChannel`. Adapting the real server channel keeps the production command handlers in
	// play without requiring the full workbench IPC host.
	return {
		call: <T>(command: string, payload: unknown) => serverChannel.call<T>('', command, payload),
		listen: <T>(event: string) => serverChannel.listen<T>('', event),
	};
}

function createMainProcessService(channel: IChannel): IMainProcessService {
	return {
		_serviceBrand: undefined,
		getChannel: () => channel,
		registerChannel: () => undefined,
	};
}

interface ITestEmitter {
	on(event: string, listener: (...args: readonly unknown[]) => void): this;
	once(event: string, listener: (...args: readonly unknown[]) => void): this;
	off(event: string, listener: (...args: readonly unknown[]) => void): this;
	emit(event: string, ...args: unknown[]): void;
}

function createEmitter<T extends object>(base: T): T & ITestEmitter {
	const listeners = new Map<string, Array<(...args: readonly unknown[]) => void>>();

	return Object.assign(base, {
		on(event: string, listener: (...args: readonly unknown[]) => void) {
			const bucket = listeners.get(event) ?? [];
			bucket.push(listener);
			listeners.set(event, bucket);
			return this;
		},
		once(event: string, listener: (...args: readonly unknown[]) => void) {
			const onceListener = (...args: readonly unknown[]) => {
				this.off(event, onceListener);
				listener(...args);
			};
			return this.on(event, onceListener);
		},
		off(event: string, listener: (...args: readonly unknown[]) => void) {
			const bucket = listeners.get(event);
			if (!bucket) {
				return this;
			}

			const index = bucket.indexOf(listener);
			if (index >= 0) {
				bucket.splice(index, 1);
			}
			if (bucket.length === 0) {
				listeners.delete(event);
			}
			return this;
		},
		emit(event: string, ...args: unknown[]) {
			for (const listener of [...(listeners.get(event) ?? [])]) {
				listener(...args);
			}
		},
	});
}

suite('VSCloneOAuth renderer/main-process integration', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('signIn completes the OpenAI loopback flow through the real main-process OAuth channel', async () => {
		const testDisposables = store.add(new DisposableStore());
		const secretStorageService = testDisposables.add(new TestSecretStorageService());
		const loopbackChannel = testDisposables.add(new VSCloneOAuthLoopbackChannel(new NullLogService()));
		const channelAny = loopbackChannel as unknown as {
			readonly sessions: Map<string, { result: { complete(value: { code: string; state: string; callbackUrl: string }): void } }>;
			listenServer: () => Promise<void>;
			getBoundPort: () => number;
			closeServer: () => Promise<void>;
		};
		const originalCreateServer = vscloneOAuthLoopbackRuntime.createServer;
		const originalOpenExternal = vscloneOAuthLoopbackRuntime.openExternal;
		const originalHttpsRequest = vscloneOAuthLoopbackRuntime.httpsRequest;
		const tokenRequestBodies: string[] = [];

		// The integration target is the renderer↔main-process seam, not Node's actual networking
		// stack. These stubs keep the real loopback/session logic active while replacing only the OS
		// and transport primitives that are impractical to invoke in a unit harness.
		channelAny.listenServer = async () => undefined;
		channelAny.getBoundPort = () => 1455;
		channelAny.closeServer = async () => undefined;

		try {
			vscloneOAuthLoopbackRuntime.createServer = (() => ({ listening: false } as unknown as ReturnType<typeof vscloneOAuthLoopbackRuntime.createServer>)) as typeof vscloneOAuthLoopbackRuntime.createServer;
			vscloneOAuthLoopbackRuntime.openExternal = async (url: string) => {
				const state = new URL(url).searchParams.get('state');
				assert.ok(state, 'expected the renderer to include an OAuth state value');
				const resolvedState = state!;

				const [sessionId] = Array.from(channelAny.sessions.keys());
				const session = channelAny.sessions.get(sessionId);
				assert.ok(session, 'expected the real loopback channel to create a live session');

				queueMicrotask(() => {
					session.result.complete({
						code: 'auth-code',
						state: resolvedState,
						callbackUrl: `http://localhost:1455/auth/callback?code=auth-code&state=${resolvedState}`,
					});
				});
			};
			vscloneOAuthLoopbackRuntime.httpsRequest = ((options: string | URL | RequestOptions, callback?: (response: IncomingMessage) => void) => {
				const resolvedOptions = options as RequestOptions;
				assert.strictEqual(resolvedOptions.hostname, 'auth.openai.com');
				assert.strictEqual(resolvedOptions.path, '/oauth/token');
				assert.strictEqual(resolvedOptions.method, 'POST');
				assert.strictEqual((resolvedOptions.headers as Record<string, unknown>)['Content-Type'], 'application/x-www-form-urlencoded');

				const response = createEmitter({ statusCode: 200 });
				const outgoing = createEmitter({
					write(body: string) {
						tokenRequestBodies.push(body);
					},
					end() {
						queueMicrotask(() => {
							callback?.(response as unknown as IncomingMessage);
							response.emit('data', Buffer.from(JSON.stringify({
								access_token: 'openai-access-token',
								token_type: 'Bearer',
								refresh_token: 'refresh-token-1',
								expires_in: 3600,
								scope: 'openid profile',
							})));
							response.emit('end');
						});
					},
				});

				return outgoing as unknown as ClientRequest;
			}) as typeof vscloneOAuthLoopbackRuntime.httpsRequest;

			const service = testDisposables.add(new VSCloneOAuthService(
				secretStorageService,
				new NullLogService(),
				createNotificationService(),
				createQuickInputService(),
				createMainProcessService(createClientChannel(loopbackChannel)),
			));

			await service.signIn('openai');
			const storedTokenSet = JSON.parse((await secretStorageService.get(oauthSecretKey('openai'))) ?? 'null') as {
				readonly vendor: string;
				readonly accessToken: string;
				readonly refreshToken: string;
				readonly scopes?: readonly string[];
				readonly expiresAt?: number;
				readonly providerMetadata?: Record<string, string>;
			} | null;

			assert.strictEqual(service.state.providers.openai.status, 'signed_in');
			assert.strictEqual(service.state.providers.openai.isReady, true);
			assert.strictEqual(tokenRequestBodies.length, 1);
			// The persisted secret intentionally stores the full normalized token set, not just the
			// three fields this harness stubs explicitly. Assert the contract-relevant subset so the
			// bridge test stays aligned with the production persistence shape.
			assert.ok(storedTokenSet, 'expected the OAuth service to persist the exchanged token set');
			assert.strictEqual(storedTokenSet.vendor, 'openai');
			assert.strictEqual(storedTokenSet.accessToken, 'openai-access-token');
			assert.strictEqual(storedTokenSet.refreshToken, 'refresh-token-1');
			assert.deepStrictEqual(storedTokenSet.scopes, ['openid', 'profile']);
			assert.strictEqual(typeof storedTokenSet.expiresAt, 'number');
			assert.ok((storedTokenSet.expiresAt ?? 0) > Date.now(), 'expected the stored token to have a future expiration');
			assert.deepStrictEqual(storedTokenSet.providerMetadata, {});

			const tokenRequestBody = new URLSearchParams(tokenRequestBodies[0]);
			assert.strictEqual(tokenRequestBody.get('grant_type'), 'authorization_code');
			assert.strictEqual(tokenRequestBody.get('code'), 'auth-code');
			assert.strictEqual(tokenRequestBody.get('client_id'), defaultOAuthProviderConfig.openai.clientId);
		} finally {
			vscloneOAuthLoopbackRuntime.createServer = originalCreateServer;
			vscloneOAuthLoopbackRuntime.openExternal = originalOpenExternal;
			vscloneOAuthLoopbackRuntime.httpsRequest = originalHttpsRequest;
		}
	});
});
