/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	IVSCloneOAuthLoopbackStartRequest,
	IVSCloneOAuthLoopbackStartResponse,
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
} from '../common/vscloneOAuthIpc.js';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { shell } from 'electron';

const LOOPBACK_PORT_PLACEHOLDER = '{port}';
const DEFAULT_WAIT_TIMEOUT_MS = 180_000;

interface IVSCloneLoopbackSession {
	readonly callbackPath: string;
	readonly result: DeferredPromise<IVSCloneOAuthLoopbackWaitResponse>;
	readonly server: Server;
}

function htmlEscape(input: string): string {
	return input
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function renderCompletionPage(errorMessage: string | undefined): string {
	const escapedError = errorMessage ? htmlEscape(errorMessage) : '';
	const isError = !!errorMessage;
	const title = isError ? 'VSClone Sign-In Failed' : 'VSClone Sign-In Complete';
	const heading = isError
		? 'Sign-in did not complete.'
		: 'You are all set.';
	const body = isError
		? 'Return to VSClone and try sign-in again.'
		: 'You can close this page and return to VSClone.';

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${title}</title>
	<style>
		html, body { height: 100%; margin: 0; }
		body {
			font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			background: #1e1e1e;
			color: #f3f3f3;
			display: grid;
			place-items: center;
			padding: 24px;
		}
		main {
			max-width: 520px;
			border: 1px solid #3f3f46;
			border-radius: 12px;
			padding: 24px;
			background: #252526;
		}
		h1 { margin: 0 0 8px; font-size: 22px; }
		p { margin: 0; color: #d4d4d4; }
		.error {
			margin-top: 12px;
			padding: 10px 12px;
			border-radius: 8px;
			background: #451f1f;
			color: #ffb4b4;
			word-break: break-word;
		}
	</style>
</head>
<body>
	<main>
		<h1>${heading}</h1>
		<p>${body}</p>
		${isError ? `<div class="error">${escapedError}</div>` : ''}
	</main>
</body>
</html>`;
}

function resolveRedirectTemplate(redirectUriTemplate: string, port: number): string {
	if (!redirectUriTemplate.includes(LOOPBACK_PORT_PLACEHOLDER)) {
		return redirectUriTemplate;
	}
	return redirectUriTemplate.replace(LOOPBACK_PORT_PLACEHOLDER, String(port));
}

export class VSCloneOAuthLoopbackChannel extends Disposable implements IServerChannel {

	private readonly sessions = new Map<string, IVSCloneLoopbackSession>();

	constructor(
		private readonly logService: ILogService,
	) {
		super();
	}

	listen<T>(_context: string, event: string, _arg?: unknown): Event<T> {
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_: string, command: string, arg?: unknown, _cancellationToken: CancellationToken = CancellationToken.None): Promise<T> {
		switch (command) {
			case VSCLONE_OAUTH_COMMAND_START_LOOPBACK:
				return await this.startLoopback(arg as IVSCloneOAuthLoopbackStartRequest) as T;
			case VSCLONE_OAUTH_COMMAND_WAIT_FOR_LOOPBACK:
				return await this.waitForLoopback(arg as IVSCloneOAuthLoopbackWaitRequest) as T;
			case VSCLONE_OAUTH_COMMAND_STOP_LOOPBACK:
				await this.stopLoopback((arg as IVSCloneOAuthLoopbackStopRequest).sessionId, false);
				return undefined as T;
			case VSCLONE_OAUTH_COMMAND_TOKEN_EXCHANGE:
				return await this.tokenExchange(arg as IVSCloneOAuthTokenExchangeRequest) as T;
			case VSCLONE_OAUTH_COMMAND_OPEN_EXTERNAL:
				await shell.openExternal(arg as string);
				return undefined as T;
			default:
				throw new Error(`Call not found: ${command}`);
		}
	}

	override dispose(): void {
		for (const sessionId of this.sessions.keys()) {
			void this.stopLoopback(sessionId, true);
		}
		super.dispose();
	}

	private async tokenExchange(req: IVSCloneOAuthTokenExchangeRequest): Promise<IVSCloneOAuthTokenExchangeResponse> {
		const parsed = new URL(req.url);
		return new Promise<IVSCloneOAuthTokenExchangeResponse>((resolve, reject) => {
			const outgoing = httpsRequest(
				{
					hostname: parsed.hostname,
					port: parsed.port || 443,
					path: parsed.pathname + parsed.search,
					method: 'POST',
					headers: {
						'Content-Type': req.contentType,
						'Accept': 'application/json',
						'Content-Length': Buffer.byteLength(req.body),
					},
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on('data', (chunk: Buffer) => chunks.push(chunk));
					res.on('end', () => {
						resolve({
							statusCode: res.statusCode ?? 0,
							body: Buffer.concat(chunks).toString('utf8'),
						});
					});
				}
			);
			outgoing.on('error', (err) => reject(err));
			outgoing.write(req.body);
			outgoing.end();
		});
	}

	private async startLoopback(request: IVSCloneOAuthLoopbackStartRequest): Promise<IVSCloneOAuthLoopbackStartResponse> {
		await this.stopLoopback(request.sessionId, true);

		// Parse host/path from a deterministic URI so the loopback listener and redirect URI stay aligned.
		const templateForParsing = resolveRedirectTemplate(
			request.redirectUriTemplate,
			request.preferredPort > 0 ? request.preferredPort : 1
		);
		const parsedTemplateUri = new URL(templateForParsing);
		const host = parsedTemplateUri.hostname;
		const callbackPath = parsedTemplateUri.pathname || '/';
		const listenPort = request.preferredPort > 0 ? request.preferredPort : 0;

		const result = new DeferredPromise<IVSCloneOAuthLoopbackWaitResponse>();
		const server = createServer((incomingRequest, response) => {
			this.handleLoopbackRequest(request.sessionId, incomingRequest, response);
		});

		await this.listenServer(server, listenPort, host);
		const actualPort = this.getBoundPort(server);
		const redirectUri = resolveRedirectTemplate(request.redirectUriTemplate, actualPort);

		const session: IVSCloneLoopbackSession = {
			callbackPath,
			result,
			server,
		};

		this.sessions.set(request.sessionId, session);
		this.logService.info(`[VSCloneOAuthLoopback] Started session ${request.sessionId} on ${redirectUri}`);
		return { redirectUri };
	}

	private async waitForLoopback(request: IVSCloneOAuthLoopbackWaitRequest): Promise<IVSCloneOAuthLoopbackWaitResponse> {
		const session = this.sessions.get(request.sessionId);
		if (!session) {
			throw new Error('Loopback session not found.');
		}

		const timeoutMs = request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_WAIT_TIMEOUT_MS;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		try {
			return await Promise.race([
				session.result.p,
				new Promise<IVSCloneOAuthLoopbackWaitResponse>((_resolve, reject) => {
					timeout = setTimeout(() => reject(new Error('Timed out waiting for OAuth callback.')), timeoutMs);
				}),
			]);
		} finally {
			if (timeout) {
				clearTimeout(timeout);
			}
		}
	}

	private async stopLoopback(sessionId: string, silent: boolean): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		this.sessions.delete(sessionId);

		if (!session.result.isSettled) {
			await session.result.error(new Error('OAuth callback listener was closed before sign-in completed.'));
		}

		await this.closeServer(session.server);

		if (!silent) {
			this.logService.info(`[VSCloneOAuthLoopback] Stopped session ${sessionId}`);
		}
	}

	private async listenServer(server: Server, port: number, host: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const onListening = () => {
				server.off('error', onError);
				resolve();
			};
			const onError = (error: Error) => {
				server.off('listening', onListening);
				reject(error);
			};

			server.once('listening', onListening);
			server.once('error', onError);
			server.listen(port, host);
		});
	}

	private getBoundPort(server: Server): number {
		const address = server.address();
		if (address && typeof address === 'object') {
			return address.port;
		}
		throw new Error('Failed to determine loopback listener port.');
	}

	private async closeServer(server: Server): Promise<void> {
		if (!server.listening) {
			return;
		}
		await new Promise<void>((resolve, reject) => {
			server.close(error => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	}

	private handleLoopbackRequest(sessionId: string, request: IncomingMessage, response: ServerResponse): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			response.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
			response.end(renderCompletionPage('This sign-in session has expired.'));
			return;
		}

		const hostHeader = request.headers.host || 'localhost';
		const incomingUrl = new URL(request.url || '/', `http://${hostHeader}`);

		if (incomingUrl.pathname !== session.callbackPath) {
			if (incomingUrl.pathname === '/favicon.ico') {
				response.writeHead(204);
				response.end();
				return;
			}
			response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
			response.end(renderCompletionPage('This endpoint only accepts the OAuth callback path.'));
			return;
		}

		const oauthError = incomingUrl.searchParams.get('error');
		const oauthErrorDescription = incomingUrl.searchParams.get('error_description');
		if (oauthError) {
			const errorMessage = oauthErrorDescription
				? `${oauthError}: ${oauthErrorDescription}`
				: oauthError;
			response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
			response.end(renderCompletionPage(errorMessage));
			void session.result.error(new Error(errorMessage));
			void this.stopLoopback(sessionId, true);
			return;
		}

		const code = incomingUrl.searchParams.get('code');
		const state = incomingUrl.searchParams.get('state');
		if (!code || !state) {
			response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
			response.end(renderCompletionPage('Missing OAuth code or state in callback URL.'));
			void session.result.error(new Error('Missing OAuth code or state in callback URL.'));
			void this.stopLoopback(sessionId, true);
			return;
		}

		response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
		response.end(renderCompletionPage(undefined));

		void session.result.complete({
			code,
			state,
			callbackUrl: incomingUrl.toString(),
		});

		void this.stopLoopback(sessionId, true);
	}
}
