/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-any-casts */
// These Electron loopback tests use partial Node and Electron doubles so the assertions can exercise the
// request-routing behavior directly without reimplementing full server, request, and shell objects.

import assert from 'assert';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { EventEmitter } from 'events';
import * as sinon from 'sinon';
import { VSCloneOAuthLoopbackChannel, vscloneOAuthLoopbackRuntime } from '../../electron-main/vscloneOAuthLoopbackChannel.js';
import {
	IVSCloneOAuthLoopbackStartRequest,
	IVSCloneOAuthLoopbackStopRequest,
	IVSCloneOAuthLoopbackWaitRequest,
	IVSCloneOAuthLoopbackWaitResponse,
	IVSCloneOAuthTokenExchangeRequest,
	IVSCloneOAuthTokenExchangeResponse,
	VSCLONE_OAUTH_COMMAND_OPEN_EXTERNAL,
	VSCLONE_OAUTH_COMMAND_START_LOOPBACK,
	VSCLONE_OAUTH_COMMAND_STOP_LOOPBACK,
	VSCLONE_OAUTH_COMMAND_TOKEN_EXCHANGE,
	VSCLONE_OAUTH_COMMAND_WAIT_FOR_LOOPBACK,
} from '../../common/vscloneOAuthIpc.js';

function createLogService(sandbox: sinon.SinonSandbox): ILogService {
	return {
		info: sandbox.spy(),
		warn: sandbox.spy(),
		error: sandbox.spy(),
		debug: sandbox.spy(),
		trace: sandbox.spy(),
	} as unknown as ILogService;
}

function createChannel(sandbox: sinon.SinonSandbox, store: Pick<DisposableStore, 'add'>) {
	const testDisposables = store.add(new DisposableStore());
	const logService = createLogService(sandbox);
	const channel = testDisposables.add(new VSCloneOAuthLoopbackChannel(logService));

	return {
		channel,
		channelAny: channel as any,
		logService,
		testDisposables,
	};
}

function createRecorder() {
	let body = '';
	const response = {
		statusCode: undefined as number | undefined,
		headers: undefined as Record<string, string> | undefined,
		writeHead(statusCode: number, headers: Record<string, string>) {
			response.statusCode = statusCode;
			response.headers = headers;
		},
		end(chunk?: string) {
			if (typeof chunk === 'string') {
				body += chunk;
			}
		},
	};

	return {
		response,
		get body() {
			return body;
		},
	};
}

function createDeferredSession(sandbox: sinon.SinonSandbox) {
	const result = new DeferredPromise<IVSCloneOAuthLoopbackWaitResponse>();
	const server = {
		listening: true,
		close: sandbox.spy((callback: (error?: Error) => void) => callback()),
	};

	return {
		result,
		server,
	};
}

suite('VSCloneOAuthLoopbackChannel', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('constructs with an empty session map', async () => {
		await withSandbox(async sandbox => {
			const { channelAny, logService } = createChannel(sandbox, store);

			assert.strictEqual(channelAny.sessions.size, 0);
			assert.strictEqual((logService.info as sinon.SinonSpy).called, false);
			assert.strictEqual((logService.error as sinon.SinonSpy).called, false);
		});
	});

	test('dispatches supported IPC commands and rejects unknown commands', async () => {
		await withSandbox(async sandbox => {
			const { channel, channelAny } = createChannel(sandbox, store);
			const startResult: IVSCloneOAuthLoopbackStartRequest = {
				sessionId: 'session-start',
				redirectUriTemplate: 'http://127.0.0.1:{port}/auth/callback',
				preferredPort: 0,
			};
			const waitResult: IVSCloneOAuthLoopbackWaitRequest = {
				sessionId: 'session-wait',
				timeoutMs: 5,
			};
			const stopResult: IVSCloneOAuthLoopbackStopRequest = {
				sessionId: 'session-stop',
			};
			const tokenResult: IVSCloneOAuthTokenExchangeRequest = {
				url: 'https://example.com/oauth/token',
				body: 'grant_type=authorization_code',
				contentType: 'application/x-www-form-urlencoded',
			};

			channelAny.startLoopback = sandbox.stub().resolves({ redirectUri: 'http://127.0.0.1:4321/auth/callback' });
			channelAny.waitForLoopback = sandbox.stub().resolves({ code: 'code', state: 'state', callbackUrl: 'http://127.0.0.1/callback' });
			channelAny.stopLoopback = sandbox.stub().resolves();
			channelAny.tokenExchange = sandbox.stub().resolves({ statusCode: 200, body: '{}' } as IVSCloneOAuthTokenExchangeResponse);
			const openExternal = sandbox.stub(vscloneOAuthLoopbackRuntime, 'openExternal').resolves();

			assert.deepStrictEqual(await channel.call('', VSCLONE_OAUTH_COMMAND_START_LOOPBACK, startResult), { redirectUri: 'http://127.0.0.1:4321/auth/callback' });
			assert.deepStrictEqual(await channel.call('', VSCLONE_OAUTH_COMMAND_WAIT_FOR_LOOPBACK, waitResult), { code: 'code', state: 'state', callbackUrl: 'http://127.0.0.1/callback' });
			assert.strictEqual(await channel.call('', VSCLONE_OAUTH_COMMAND_STOP_LOOPBACK, stopResult), undefined);
			assert.deepStrictEqual(await channel.call('', VSCLONE_OAUTH_COMMAND_TOKEN_EXCHANGE, tokenResult), { statusCode: 200, body: '{}' });
			assert.strictEqual(await channel.call('', VSCLONE_OAUTH_COMMAND_OPEN_EXTERNAL, 'https://example.com'), undefined);
			await assert.rejects(channel.call('', 'unknown-command' as any), /Call not found: unknown-command/);

			assert.ok((channelAny.startLoopback as sinon.SinonSpy).calledOnceWithExactly(startResult));
			assert.ok((channelAny.waitForLoopback as sinon.SinonSpy).calledOnceWithExactly(waitResult));
			assert.ok((channelAny.stopLoopback as sinon.SinonSpy).calledOnceWithExactly('session-stop', false));
			assert.ok((channelAny.tokenExchange as sinon.SinonSpy).calledOnceWithExactly(tokenResult));
			assert.ok(openExternal.calledOnceWithExactly('https://example.com'));
		});
	});

	test('translates token exchange requests into HTTPS POSTs and propagates transport errors', async () => {
		await withSandbox(async sandbox => {
			const { channelAny } = createChannel(sandbox, store);
			const request: IVSCloneOAuthTokenExchangeRequest = {
				url: 'https://example.com:8443/oauth/token?tenant=alpha',
				body: 'grant_type=authorization_code&code=123',
				contentType: 'application/x-www-form-urlencoded',
			};

			const responseEmitter = new EventEmitter();
			const outgoing = new EventEmitter() as any;
			outgoing.write = sandbox.spy();
			outgoing.end = sandbox.spy();

			const requestStub = sandbox.stub(vscloneOAuthLoopbackRuntime, 'httpsRequest').callsFake(((options: any, callback: (response: any) => void) => {
				assert.deepStrictEqual(options, {
					hostname: 'example.com',
					port: '8443',
					path: '/oauth/token?tenant=alpha',
					method: 'POST',
					headers: {
						'Content-Type': 'application/x-www-form-urlencoded',
						'Accept': 'application/json',
						'Content-Length': Buffer.byteLength(request.body),
					},
				});

				queueMicrotask(() => {
					callback(responseEmitter);
					responseEmitter.emit('data', Buffer.from('{"access_token":"abc"'));
					responseEmitter.emit('data', Buffer.from(',"token_type":"bearer"}'));
					responseEmitter.emit('end');
				});

				return outgoing;
			}) as typeof vscloneOAuthLoopbackRuntime.httpsRequest);

			(responseEmitter as any).statusCode = 200;

			const result = await channelAny.tokenExchange(request);
			assert.deepStrictEqual(result, {
				statusCode: 200,
				body: '{"access_token":"abc","token_type":"bearer"}',
			});
			assert.ok(requestStub.calledOnce);
			assert.ok((outgoing.write as sinon.SinonSpy).calledOnceWithExactly(request.body));
			assert.ok((outgoing.end as sinon.SinonSpy).calledOnce);

			requestStub.restore();

			const transportError = new Error('socket closed');
			const errorOutgoing = new EventEmitter() as any;
			errorOutgoing.write = sandbox.spy();
			errorOutgoing.end = sandbox.spy(() => {
				queueMicrotask(() => errorOutgoing.emit('error', transportError));
			});

			sandbox.stub(vscloneOAuthLoopbackRuntime, 'httpsRequest').callsFake(() => errorOutgoing);
			await assert.rejects(channelAny.tokenExchange(request), /socket closed/);
		});
	});

	test('starts loopback sessions with deterministic redirect URIs and records the callback path', async () => {
		await withSandbox(async sandbox => {
			const { channelAny, logService } = createChannel(sandbox, store);
			const createServerStub = sandbox.stub(vscloneOAuthLoopbackRuntime, 'createServer').returns({} as any);
			channelAny.stopLoopback = sandbox.stub().resolves();
			channelAny.listenServer = sandbox.stub().resolves();
			channelAny.getBoundPort = sandbox.stub().returns(4321);

			const placeholderRequest: IVSCloneOAuthLoopbackStartRequest = {
				sessionId: 'session-1',
				redirectUriTemplate: 'http://127.0.0.1:{port}/auth/callback',
				preferredPort: 0,
			};
			const staticRequest: IVSCloneOAuthLoopbackStartRequest = {
				sessionId: 'session-2',
				redirectUriTemplate: 'http://127.0.0.1:7777/auth/callback',
				preferredPort: 4567,
			};

			const placeholderResult = await channelAny.startLoopback(placeholderRequest);
			const staticResult = await channelAny.startLoopback(staticRequest);

			assert.deepStrictEqual(placeholderResult, { redirectUri: 'http://127.0.0.1:4321/auth/callback' });
			assert.deepStrictEqual(staticResult, { redirectUri: 'http://127.0.0.1:7777/auth/callback' });
			assert.strictEqual(channelAny.sessions.get('session-1').callbackPath, '/auth/callback');
			assert.strictEqual(channelAny.sessions.get('session-2').callbackPath, '/auth/callback');
			assert.ok(createServerStub.calledTwice);
			assert.ok((channelAny.stopLoopback as sinon.SinonSpy).calledWithExactly('session-1', true));
			assert.ok((channelAny.stopLoopback as sinon.SinonSpy).calledWithExactly('session-2', true));
			assert.ok((channelAny.listenServer as sinon.SinonSpy).calledWithExactly(createServerStub.firstCall.returnValue, 0, '127.0.0.1'));
			assert.ok((channelAny.listenServer as sinon.SinonSpy).calledWithExactly(createServerStub.secondCall.returnValue, 4567, '127.0.0.1'));
			assert.ok((channelAny.getBoundPort as sinon.SinonSpy).calledTwice);
			assert.ok((logService.info as sinon.SinonSpy).calledTwice);
		});
	});

	test('waits for loopback callbacks and rejects on timeout', async () => {
		await withSandbox(async sandbox => {
			const { channelAny } = createChannel(sandbox, store);
			const deferred = new DeferredPromise<IVSCloneOAuthLoopbackWaitResponse>();
			channelAny.sessions.set('session-1', {
				callbackPath: '/auth/callback',
				result: deferred,
				server: {} as any,
			});

			const clearTimeoutSpy = sandbox.spy(globalThis, 'clearTimeout');
			const waitPromise = channelAny.waitForLoopback({
				sessionId: 'session-1',
				timeoutMs: 5_000,
			});
			deferred.complete({
				code: 'abc',
				state: 'state',
				callbackUrl: 'http://127.0.0.1/auth/callback?code=abc&state=state',
			});

			assert.deepStrictEqual(await waitPromise, {
				code: 'abc',
				state: 'state',
				callbackUrl: 'http://127.0.0.1/auth/callback?code=abc&state=state',
			});
			assert.ok(clearTimeoutSpy.calledOnce);

			const clock = sandbox.useFakeTimers();
			const timeoutDeferred = new DeferredPromise<IVSCloneOAuthLoopbackWaitResponse>();
			channelAny.sessions.set('session-timeout', {
				callbackPath: '/auth/callback',
				result: timeoutDeferred,
				server: {} as any,
			});

			const timeoutPromise = channelAny.waitForLoopback({
				sessionId: 'session-timeout',
				timeoutMs: 5,
			});
			const timeoutAssertion = assert.rejects(timeoutPromise, /Timed out waiting for OAuth callback\./);
			await clock.tickAsync(5);
			await timeoutAssertion;
		});
	});

	test('stops loopback sessions without touching unrelated ids', async () => {
		await withSandbox(async sandbox => {
			const { channelAny, logService } = createChannel(sandbox, store);
			const missingResult = channelAny.stopLoopback('missing-session', false);
			await missingResult;

			const loudSession = createDeferredSession(sandbox);
			channelAny.sessions.set('session-loud', loudSession as any);
			const loudRejection = loudSession.result.p.catch(error => error as Error);

			await channelAny.stopLoopback('session-loud', false);
			const loudError = await loudRejection as Error;

			assert.strictEqual(channelAny.sessions.has('session-loud'), false);
			assert.match(loudError.message, /closed before sign-in completed/);
			assert.ok((loudSession.server.close as sinon.SinonSpy).calledOnce);
			assert.ok((logService.info as sinon.SinonSpy).calledOnceWithExactly('[VSCloneOAuthLoopback] Stopped session session-loud'));

			const quietSession = createDeferredSession(sandbox);
			channelAny.sessions.set('session-quiet', quietSession as any);
			const quietRejection = quietSession.result.p.catch(error => error as Error);
			await channelAny.stopLoopback('session-quiet', true);
			await quietRejection;

			assert.strictEqual(channelAny.sessions.has('session-quiet'), false);
			assert.ok((quietSession.server.close as sinon.SinonSpy).calledOnce);
			assert.strictEqual((logService.info as sinon.SinonSpy).calledOnce, true);
		});
	});

	test('validates listener registration, server address parsing, and close handling', async () => {
		await withSandbox(async sandbox => {
			const { channelAny } = createChannel(sandbox, store);

			const listeningServer = new EventEmitter() as any;
			listeningServer.listen = sandbox.spy(() => {
				queueMicrotask(() => listeningServer.emit('listening'));
				return listeningServer;
			});

			await channelAny.listenServer(listeningServer, 3000, '127.0.0.1');
			assert.ok((listeningServer.listen as sinon.SinonSpy).calledOnceWithExactly(3000, '127.0.0.1'));

			const failingServer = new EventEmitter() as any;
			failingServer.listen = sandbox.spy(() => {
				queueMicrotask(() => failingServer.emit('error', new Error('listen failed')));
				return failingServer;
			});

			await assert.rejects(channelAny.listenServer(failingServer, 0, '127.0.0.1'), /listen failed/);

			assert.strictEqual(channelAny.getBoundPort({ address: () => ({ port: 3000 }) } as any), 3000);
			assert.throws(() => channelAny.getBoundPort({ address: () => null } as any), /Failed to determine loopback listener port\./);

			const notListeningServer = { listening: false, close: sandbox.spy() } as any;
			await channelAny.closeServer(notListeningServer);
			assert.strictEqual((notListeningServer.close as sinon.SinonSpy).called, false);

			const closingServer = {
				listening: true,
				close: sandbox.spy((callback: (error?: Error) => void) => callback()),
			} as any;
			await channelAny.closeServer(closingServer);
			assert.ok((closingServer.close as sinon.SinonSpy).calledOnce);

			const failingCloseServer = {
				listening: true,
				close: sandbox.spy((callback: (error?: Error) => void) => callback(new Error('close failed'))),
			} as any;
			await assert.rejects(channelAny.closeServer(failingCloseServer), /close failed/);
		});
	});

	test('returns escaped completion pages for expired, wrong-path, provider-error, and success callbacks', async () => {
		await withSandbox(async sandbox => {
			const { channelAny } = createChannel(sandbox, store);
			channelAny.stopLoopback = sandbox.stub().resolves();

			const expiredRecorder = createRecorder();
			channelAny.handleLoopbackRequest('missing-session', {
				headers: { host: '127.0.0.1' },
				url: '/auth/callback',
			} as any, expiredRecorder.response as any);

			assert.strictEqual(expiredRecorder.response.statusCode, 410);
			assert.match(expiredRecorder.body, /VSClone Sign-In Failed/);
			assert.match(expiredRecorder.body, /This sign-in session has expired\./);
			assert.match(expiredRecorder.body, /<div class="error">/);

			channelAny.sessions.set('session-1', {
				callbackPath: '/auth/callback',
				result: {
					isSettled: false,
					complete: sandbox.spy(),
					error: sandbox.spy(),
				},
				server: {} as any,
			});

			const wrongPathRecorder = createRecorder();
			channelAny.handleLoopbackRequest('session-1', {
				headers: { host: '127.0.0.1' },
				url: '/favicon.ico',
			} as any, wrongPathRecorder.response as any);

			assert.strictEqual(wrongPathRecorder.response.statusCode, 204);
			assert.strictEqual(wrongPathRecorder.body, '');

			const wrongCallbackRecorder = createRecorder();
			channelAny.handleLoopbackRequest('session-1', {
				headers: { host: '127.0.0.1' },
				url: '/not-the-callback',
			} as any, wrongCallbackRecorder.response as any);

			assert.strictEqual(wrongCallbackRecorder.response.statusCode, 404);
			assert.match(wrongCallbackRecorder.body, /This endpoint only accepts the OAuth callback path\./);

			const errorSession = {
				isSettled: false,
				complete: sandbox.spy(),
				error: sandbox.spy(),
			};
			channelAny.sessions.set('session-error', {
				callbackPath: '/auth/callback',
				result: errorSession,
				server: {} as any,
			});
			const errorRecorder = createRecorder();
			channelAny.handleLoopbackRequest('session-error', {
				headers: { host: '127.0.0.1' },
				url: '/auth/callback?error=access_denied&error_description=%26%20%3C%20%3E%20%22%20%27',
			} as any, errorRecorder.response as any);

			assert.strictEqual(errorRecorder.response.statusCode, 200);
			assert.match(errorRecorder.body, /VSClone Sign-In Failed/);
			assert.match(errorRecorder.body, /access_denied: &amp; &lt; &gt; &quot; &#39;/);
			assert.ok((channelAny.stopLoopback as sinon.SinonSpy).calledWithExactly('session-error', true));
			assert.ok((errorSession.error as sinon.SinonSpy).calledOnce);

			const successSession = {
				isSettled: false,
				complete: sandbox.spy(),
				error: sandbox.spy(),
			};
			channelAny.sessions.set('session-success', {
				callbackPath: '/auth/callback',
				result: successSession,
				server: {} as any,
			});
			const successRecorder = createRecorder();
			channelAny.handleLoopbackRequest('session-success', {
				headers: { host: '127.0.0.1' },
				url: '/auth/callback?code=abc&state=xyz',
			} as any, successRecorder.response as any);

			assert.strictEqual(successRecorder.response.statusCode, 200);
			assert.match(successRecorder.body, /VSClone Sign-In Complete/);
			assert.ok(!successRecorder.body.includes('class="error"'));
			assert.ok((channelAny.stopLoopback as sinon.SinonSpy).calledWithExactly('session-success', true));
			assert.ok((successSession.complete as sinon.SinonSpy).calledOnceWithExactly({
				code: 'abc',
				state: 'xyz',
				callbackUrl: 'http://127.0.0.1/auth/callback?code=abc&state=xyz',
			}));
		});
	});
});

async function withSandbox<T>(callback: (sandbox: sinon.SinonSandbox) => Promise<T> | T): Promise<T> {
	const sandbox = sinon.createSandbox();
	try {
		return await callback(sandbox);
	} finally {
		sandbox.restore();
	}
}
