/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { getClaimsFromJWT, IAuthorizationTokenResponse, isAuthorizationErrorResponse, isAuthorizationTokenResponse } from '../../../../base/common/oauth.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IVSCloneMockProviderService, VSCloneModelVendor } from '../common/vscloneMockProviderService.js';
import { IVSCloneOAuthService } from '../common/vscloneOAuthService.js';
import {
	IVSCloneOAuthLoopbackStartResponse,
	IVSCloneOAuthLoopbackWaitResponse,
	VSCLONE_OAUTH_CHANNEL_NAME,
	VSCLONE_OAUTH_COMMAND_START_LOOPBACK,
	VSCLONE_OAUTH_COMMAND_STOP_LOOPBACK,
	VSCLONE_OAUTH_COMMAND_WAIT_FOR_LOOPBACK,
} from '../common/vscloneOAuthIpc.js';
import {
	defaultOAuthProviderConfig,
	displayInfoOfOAuthProvider,
	IVSCloneOAuthProviderConfig,
	IVSCloneOAuthProviderState,
	IVSCloneOAuthState,
	IVSCloneOAuthStateChangeEvent,
	IVSCloneOAuthTokenSet,
	oauthSecretKey,
	VSCloneOAuthStatus,
} from '../common/vscloneOAuthTypes.js';

const allVendors: readonly VSCloneModelVendor[] = ['openai', 'anthropic', 'google'];

// -- PKCE Utilities --

function generateCodeVerifier(): string {
	const array = new Uint8Array(32);
	globalThis.crypto.getRandomValues(array);
	return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hash = await globalThis.crypto.subtle.digest('SHA-256', data);
	const hashArray = new Uint8Array(hash);
	let binary = '';
	for (const byte of hashArray) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function generateState(): string {
	const array = new Uint8Array(16);
	globalThis.crypto.getRandomValues(array);
	return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

// -- Code Extraction --

interface IParsedOAuthInput {
	readonly code: string;
	readonly state: string | undefined;
}

const FALLBACK_LOOPBACK_PORT = 33418;
const LOOPBACK_WAIT_TIMEOUT_MS = 180_000;

/**
 * Extracts authorization values from user input.
 * The user may paste a raw code string, or the full redirect URL
 * (e.g. `http://localhost:1455/auth/callback?code=abc&state=xyz`).
 */
function parseOAuthInput(input: string): IParsedOAuthInput {
	const trimmed = input.trim();

	// Try to parse as a URL with `code` and optional `state` query parameters.
	try {
		const url = new URL(trimmed);
		const code = url.searchParams.get('code');
		if (code) {
			return {
				code,
				state: url.searchParams.get('state') || undefined,
			};
		}
	} catch {
		// Not a URL - treat as raw code
	}

	return {
		code: trimmed,
		state: undefined,
	};
}

/**
 * Builds a deterministic redirect URI for manual loopback fallback.
 * This is only used when the automatic loopback listener is unavailable.
 */
function getLoopbackRedirectUri(config: IVSCloneOAuthProviderConfig): string {
	const port = config.preferredPort || FALLBACK_LOOPBACK_PORT;
	return config.redirectUriTemplate.replace('{port}', String(port));
}

// -- Token Operations --

async function exchangeCodeForTokens(
	config: IVSCloneOAuthProviderConfig,
	code: string,
	redirectUri: string,
	codeVerifier: string
): Promise<IAuthorizationTokenResponse> {
	const params = new URLSearchParams();
	params.set('grant_type', 'authorization_code');
	params.set('code', code);
	params.set('redirect_uri', redirectUri);
	params.set('client_id', config.clientId);
	params.set('code_verifier', codeVerifier);

	if (config.clientSecret) {
		params.set('client_secret', config.clientSecret);
	}

	for (const [key, value] of Object.entries(config.extraTokenParams)) {
		params.set(key, value);
	}

	const response = await fetch(config.tokenUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: params.toString(),
	});

	const body = await response.json();

	if (!response.ok || isAuthorizationErrorResponse(body)) {
		const errorBody = body as { error?: string; error_description?: string };
		throw new Error(`Token exchange failed: ${errorBody.error_description || errorBody.error || response.statusText}`);
	}

	if (!isAuthorizationTokenResponse(body)) {
		throw new Error('Invalid token response from provider');
	}

	return body;
}

async function refreshAccessToken(
	config: IVSCloneOAuthProviderConfig,
	refreshToken: string
): Promise<IAuthorizationTokenResponse> {
	const params = new URLSearchParams();
	params.set('grant_type', 'refresh_token');
	params.set('refresh_token', refreshToken);
	params.set('client_id', config.clientId);

	if (config.clientSecret) {
		params.set('client_secret', config.clientSecret);
	}

	const response = await fetch(config.tokenUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: params.toString(),
	});

	const body = await response.json();

	if (!response.ok || isAuthorizationErrorResponse(body)) {
		const errorBody = body as { error?: string; error_description?: string };
		throw new Error(`Token refresh failed: ${errorBody.error_description || errorBody.error || response.statusText}`);
	}

	if (!isAuthorizationTokenResponse(body)) {
		throw new Error('Invalid token refresh response from provider');
	}

	return body;
}

// -- Per-Provider Helpers --

/**
 * Build API headers for a given vendor using the token set.
 * Dispatches on vendor for provider-specific header requirements.
 */
function buildApiHeaders(vendor: VSCloneModelVendor, tokenSet: IVSCloneOAuthTokenSet): Record<string, string> {
	const headers: Record<string, string> = {
		'Authorization': `Bearer ${tokenSet.accessToken}`,
	};

	switch (vendor) {
		case 'openai': {
			const accountId = tokenSet.providerMetadata['chatgpt-account-id'];
			if (accountId) {
				headers['ChatGPT-Account-Id'] = accountId;
			}
			headers['OpenAI-Beta'] = 'responses=v1';
			headers['OpenAI-Originator'] = 'codex';
			break;
		}
		case 'anthropic': {
			headers['anthropic-beta'] = 'oauth-2025-04-20,interleaved-thinking-2025-05-14';
			break;
		}
		case 'google': {
			headers['User-Agent'] = 'antigravity/1.0.0';
			headers['Client-Metadata'] = JSON.stringify({
				ideType: 'VSCLONE',
				platform: typeof process !== 'undefined' ? process.platform : 'unknown',
			});
			break;
		}
	}

	return headers;
}

/**
 * Extract user-facing metadata from the token response.
 * Uses JWT decoding for providers that return JWTs.
 */
function extractMetadata(
	vendor: VSCloneModelVendor,
	tokenResponse: IAuthorizationTokenResponse
): { userDisplayName: string | undefined; providerMetadata: Record<string, string> } {
	const metadata: Record<string, string> = {};
	let userDisplayName: string | undefined;

	try {
		switch (vendor) {
			case 'openai': {
				// Decode access_token JWT for chatgpt-account-id
				try {
					const accessClaims = getClaimsFromJWT(tokenResponse.access_token);
					const accountId = accessClaims['https://api.openai.com/auth']
						? (accessClaims['https://api.openai.com/auth'] as Record<string, string>)['chatgpt_account_id']
						: undefined;
					if (accountId) {
						metadata['chatgpt-account-id'] = String(accountId);
					}
				} catch {
					// Access token may not be a JWT for all OpenAI flows
				}

				// Decode id_token for email/name
				if (tokenResponse.id_token) {
					try {
						const idClaims = getClaimsFromJWT(tokenResponse.id_token);
						userDisplayName = idClaims.email || idClaims.name || idClaims.preferred_username;
					} catch {
						// id_token decoding failure is non-fatal
					}
				}
				break;
			}
			case 'anthropic': {
				// Decode id_token for email if present
				if (tokenResponse.id_token) {
					try {
						const idClaims = getClaimsFromJWT(tokenResponse.id_token);
						userDisplayName = idClaims.email || idClaims.name;
					} catch {
						// Non-fatal
					}
				}
				break;
			}
			case 'google': {
				// Decode id_token for email and name
				if (tokenResponse.id_token) {
					try {
						const idClaims = getClaimsFromJWT(tokenResponse.id_token);
						userDisplayName = idClaims.email || idClaims.name;
						if (idClaims.email) {
							metadata['email'] = String(idClaims.email);
						}
					} catch {
						// Non-fatal
					}
				}
				break;
			}
		}
	} catch {
		// Metadata extraction is best-effort
	}

	return { userDisplayName, providerMetadata: metadata };
}

// -- Build authorization URL --

function buildAuthUrl(
	config: IVSCloneOAuthProviderConfig,
	state: string,
	codeChallenge: string,
	redirectUri: string
): string {
	const url = new URL(config.authUrl);
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('client_id', config.clientId);
	url.searchParams.set('redirect_uri', redirectUri);
	url.searchParams.set('scope', config.scopes.join(' '));
	url.searchParams.set('state', state);
	url.searchParams.set('code_challenge', codeChallenge);
	url.searchParams.set('code_challenge_method', 'S256');

	for (const [key, value] of Object.entries(config.extraAuthorizeParams)) {
		url.searchParams.set(key, value);
	}

	return url.toString();
}

// -- Service Implementation --

export class VSCloneOAuthService extends Disposable implements IVSCloneOAuthService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<IVSCloneOAuthStateChangeEvent>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private _state: IVSCloneOAuthState;
	private readonly _tokenSets = new Map<VSCloneModelVendor, IVSCloneOAuthTokenSet>();
	private readonly _refreshPromises = new Map<VSCloneModelVendor, DeferredPromise<void>>();
	private _initialized = false;
	private loopbackChannel: IChannel | undefined;

	constructor(
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@ILogService private readonly logService: ILogService,
		@IOpenerService private readonly openerService: IOpenerService,
		@INotificationService private readonly notificationService: INotificationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IVSCloneMockProviderService private readonly mockProviderService: IVSCloneMockProviderService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
	) {
		super();
		this._state = this._buildInitialState();
	}

	get state(): IVSCloneOAuthState {
		return this._state;
	}

	// -- Initialization --

	async initialize(): Promise<void> {
		if (this._initialized) {
			return;
		}
		this._initialized = true;

		await this.mockProviderService.initialize();

		for (const vendor of allVendors) {
			try {
				const raw = await this.secretStorageService.get(oauthSecretKey(vendor));
				if (!raw) {
					continue;
				}

				const tokenSet = JSON.parse(raw) as IVSCloneOAuthTokenSet;
				if (!tokenSet.accessToken) {
					continue;
				}

				// Check if token is expired
				if (tokenSet.expiresAt && tokenSet.expiresAt < Date.now()) {
					// Token expired - try to refresh if we have a refresh token
					if (tokenSet.refreshToken) {
						this._setProviderStatus(vendor, 'refreshing');
						try {
							await this._doRefresh(vendor, tokenSet);
							continue;
						} catch {
							this.logService.warn(`[VSCloneOAuth] Failed to refresh expired token for ${vendor}`);
							this._setProviderStatus(vendor, 'signed_out');
							continue;
						}
					}
					// No refresh token and expired - signed out
					this._setProviderStatus(vendor, 'signed_out');
					continue;
				}

				// Token is valid
				this._tokenSets.set(vendor, tokenSet);
				this._setProviderStatus(vendor, 'signed_in', {
					userDisplayName: this._extractUserDisplayNameFromTokenSet(tokenSet),
				});
			} catch (err) {
				this.logService.warn(`[VSCloneOAuth] Failed to restore tokens for ${vendor}:`, err);
			}
		}

		this._recomputeDerivedState();
	}

	// -- Sign In --

	async signIn(vendor: VSCloneModelVendor): Promise<void> {
		await this.initialize();

		const currentStatus = this._state.providers[vendor].status;
		if (currentStatus === 'signing_in') {
			return; // Already signing in
		}

		const config = defaultOAuthProviderConfig[vendor];
		this._setProviderStatus(vendor, 'signing_in');

		try {
			// Generate PKCE
			const codeVerifier = generateCodeVerifier();
			const codeChallenge = await generateCodeChallenge(codeVerifier);
			const state = generateState();
			const authorization = config.redirectStrategy === 'loopback'
				? await this._acquireLoopbackAuthorizationCode(vendor, config, state, codeChallenge)
				: await this._acquireManualAuthorizationCode(vendor, config, state, codeChallenge);

			if (!authorization) {
				this._setProviderStatus(vendor, 'signed_out');
				return;
			}

			const { code, redirectUri } = authorization;

			// Exchange code for tokens
			const tokenResponse = await exchangeCodeForTokens(config, code, redirectUri, codeVerifier);

			// Extract metadata
			const { userDisplayName, providerMetadata } = extractMetadata(vendor, tokenResponse);

			// Build token set
			const tokenSet: IVSCloneOAuthTokenSet = {
				vendor,
				accessToken: tokenResponse.access_token,
				refreshToken: tokenResponse.refresh_token,
				idToken: tokenResponse.id_token,
				expiresAt: tokenResponse.expires_in
					? Date.now() + tokenResponse.expires_in * 1000
					: undefined,
				scopes: tokenResponse.scope
					? tokenResponse.scope.split(' ')
					: [...config.scopes],
				providerMetadata,
			};

			// Store tokens
			this._tokenSets.set(vendor, tokenSet);
			await this.secretStorageService.set(oauthSecretKey(vendor), JSON.stringify(tokenSet));

			this._setProviderStatus(vendor, 'signed_in', { userDisplayName });
			this._recomputeDerivedState();

			const displayInfo = displayInfoOfOAuthProvider(vendor);
			const signedInMsg = userDisplayName
				? localize('vsclone.oauth.signedIn.withName', 'Signed in to {0} as {1}', displayInfo.title, userDisplayName)
				: localize('vsclone.oauth.signedIn', 'Signed in to {0}', displayInfo.title);
			this.notificationService.info(signedInMsg);
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			this.logService.error(`[VSCloneOAuth] Sign-in failed for ${vendor}:`, err);
			this._setProviderStatus(vendor, 'error', { errorMessage });
			this._recomputeDerivedState();
			this.notificationService.error(
				localize('vsclone.oauth.signInFailed', 'Failed to sign in to {0}: {1}', displayInfoOfOAuthProvider(vendor).title, errorMessage)
			);
		}
	}

	private async _acquireManualAuthorizationCode(
		vendor: VSCloneModelVendor,
		config: IVSCloneOAuthProviderConfig,
		expectedState: string,
		codeChallenge: string
	): Promise<{ code: string; redirectUri: string } | undefined> {
		const redirectUri = config.redirectUriTemplate;
		const authUrl = buildAuthUrl(config, expectedState, codeChallenge, redirectUri);
		await this.openerService.open(URI.parse(authUrl));

		const code = await this._promptForAuthorizationCode(vendor, config, expectedState);
		if (!code) {
			return undefined;
		}

		return { code, redirectUri };
	}

	private async _acquireLoopbackAuthorizationCode(
		vendor: VSCloneModelVendor,
		config: IVSCloneOAuthProviderConfig,
		expectedState: string,
		codeChallenge: string
	): Promise<{ code: string; redirectUri: string } | undefined> {
		let redirectUri = getLoopbackRedirectUri(config);
		let browserOpened = false;
		let sessionId: string | undefined;
		const loopbackChannel = this._getLoopbackChannel();

		// Try automatic localhost callback capture first so the user sees a completion page
		// instead of a browser network error. If this path fails, fall back to manual paste.
		if (loopbackChannel) {
			sessionId = generateUuid();
			try {
				const startResponse = await loopbackChannel.call<IVSCloneOAuthLoopbackStartResponse>(
					VSCLONE_OAUTH_COMMAND_START_LOOPBACK,
					{
						sessionId,
						redirectUriTemplate: config.redirectUriTemplate,
						preferredPort: config.preferredPort,
					}
				);

				redirectUri = startResponse.redirectUri;
				const authUrl = buildAuthUrl(config, expectedState, codeChallenge, redirectUri);
				await this.openerService.open(URI.parse(authUrl));
				browserOpened = true;

				const callback = await loopbackChannel.call<IVSCloneOAuthLoopbackWaitResponse>(
					VSCLONE_OAUTH_COMMAND_WAIT_FOR_LOOPBACK,
					{
						sessionId,
						timeoutMs: LOOPBACK_WAIT_TIMEOUT_MS,
					}
				);

				if (callback.state !== expectedState) {
					throw new Error('Returned OAuth state did not match the sign-in request.');
				}

				return { code: callback.code, redirectUri };
			} catch (err) {
				this.logService.warn(`[VSCloneOAuth] Loopback callback flow failed for ${vendor}; falling back to manual code entry.`, err);
			} finally {
				await this._stopLoopbackSession(sessionId);
			}
		}

		// Fallback path preserves the previous manual copy/paste behavior.
		if (!browserOpened) {
			const authUrl = buildAuthUrl(config, expectedState, codeChallenge, redirectUri);
			await this.openerService.open(URI.parse(authUrl));
		}

		const code = await this._promptForAuthorizationCode(vendor, config, expectedState);
		if (!code) {
			return undefined;
		}

		return { code, redirectUri };
	}

	private async _promptForAuthorizationCode(
		vendor: VSCloneModelVendor,
		config: IVSCloneOAuthProviderConfig,
		expectedState: string
	): Promise<string | undefined> {
		const displayInfo = displayInfoOfOAuthProvider(vendor);
		const promptMessage = config.redirectStrategy === 'loopback'
			? localize(
				'vsclone.oauth.pasteUrl',
				'After authorizing in your browser, copy the full URL from the address bar and paste it here')
			: localize(
				'vsclone.oauth.pasteCode',
				'Paste the authorization code from {0}',
				displayInfo.title);

		const pastedValue = await this.quickInputService.input({
			prompt: promptMessage,
			placeHolder: config.redirectStrategy === 'loopback'
				? localize('vsclone.oauth.pasteUrl.placeholder', 'Paste URL or authorization code')
				: localize('vsclone.oauth.pasteCode.placeholder', 'Authorization code'),
			ignoreFocusLost: true,
		});

		if (!pastedValue) {
			return undefined;
		}

		const parsed = parseOAuthInput(pastedValue);
		if (!parsed.code) {
			throw new Error('Authorization code was empty.');
		}

		if (parsed.state && parsed.state !== expectedState) {
			throw new Error('Returned OAuth state did not match the sign-in request.');
		}

		return parsed.code;
	}

	private async _stopLoopbackSession(sessionId: string | undefined): Promise<void> {
		const loopbackChannel = this._getLoopbackChannel();
		if (!sessionId || !loopbackChannel) {
			return;
		}

		try {
			await loopbackChannel.call<void>(VSCLONE_OAUTH_COMMAND_STOP_LOOPBACK, { sessionId });
		} catch {
			// Cleanup is best-effort; the next session startup always replaces stale listeners.
		}
	}

	private _getLoopbackChannel(): IChannel | undefined {
		if (this.loopbackChannel) {
			return this.loopbackChannel;
		}

		// This channel only exists in desktop/electron. When unavailable, sign-in falls back
		// to manual URL/code paste so OAuth still works in less capable environments.
		try {
			this.loopbackChannel = this.mainProcessService.getChannel(VSCLONE_OAUTH_CHANNEL_NAME);
		} catch {
			this.loopbackChannel = undefined;
		}

		return this.loopbackChannel;
	}

	// -- Sign Out --

	async signOut(vendor: VSCloneModelVendor): Promise<void> {
		await this.initialize();

		this._tokenSets.delete(vendor);
		this._refreshPromises.delete(vendor);
		await this.secretStorageService.delete(oauthSecretKey(vendor));
		this._setProviderStatus(vendor, 'signed_out');
		this._recomputeDerivedState();
	}

	// -- Token Access --

	async getAccessToken(vendor: VSCloneModelVendor): Promise<string | undefined> {
		await this.initialize();

		const tokenSet = this._tokenSets.get(vendor);
		if (!tokenSet) {
			return undefined;
		}

		// Check if token is near expiry (within 60s)
		if (tokenSet.expiresAt && tokenSet.expiresAt - 60_000 < Date.now()) {
			if (tokenSet.refreshToken) {
				await this._ensureRefreshed(vendor, tokenSet);
				const refreshed = this._tokenSets.get(vendor);
				return refreshed?.accessToken;
			}
			return undefined;
		}

		return tokenSet.accessToken;
	}

	async getTokenSet(vendor: VSCloneModelVendor): Promise<IVSCloneOAuthTokenSet | undefined> {
		await this.initialize();

		// Trigger refresh if needed via getAccessToken
		await this.getAccessToken(vendor);
		return this._tokenSets.get(vendor);
	}

	async getApiHeaders(vendor: VSCloneModelVendor): Promise<Record<string, string> | undefined> {
		const tokenSet = await this.getTokenSet(vendor);
		if (!tokenSet) {
			return undefined;
		}
		return buildApiHeaders(vendor, tokenSet);
	}

	isSignedIn(vendor: VSCloneModelVendor): boolean {
		return this._state.providers[vendor].status === 'signed_in';
	}

	// -- Private: State Management --

	private _buildInitialState(): IVSCloneOAuthState {
		const providers: Record<string, IVSCloneOAuthProviderState> = {};
		for (const vendor of allVendors) {
			const config = defaultOAuthProviderConfig[vendor];
			providers[vendor] = {
				vendor,
				displayName: config.displayName,
				status: 'signed_out',
				userDisplayName: undefined,
				errorMessage: undefined,
				isReady: false,
			};
		}
		return { providers: providers as Record<VSCloneModelVendor, IVSCloneOAuthProviderState> };
	}

	private _setProviderStatus(
		vendor: VSCloneModelVendor,
		status: VSCloneOAuthStatus,
		extra?: { userDisplayName?: string; errorMessage?: string }
	): void {
		const previous = this._state.providers[vendor].status;
		if (previous === status && !extra) {
			return;
		}

		const config = defaultOAuthProviderConfig[vendor];
		const isReady = status === 'signed_in' && this._isTokenValid(vendor);

		const newProviderState: IVSCloneOAuthProviderState = {
			vendor,
			displayName: config.displayName,
			status,
			userDisplayName: extra?.userDisplayName ?? (status === 'signed_in' ? this._state.providers[vendor].userDisplayName : undefined),
			errorMessage: extra?.errorMessage ?? (status === 'error' ? this._state.providers[vendor].errorMessage : undefined),
			isReady,
		};

		const newProviders = { ...this._state.providers, [vendor]: newProviderState };
		this._state = { providers: newProviders as Record<VSCloneModelVendor, IVSCloneOAuthProviderState> };

		if (previous !== status) {
			this._onDidChangeState.fire({ vendor, previous, current: status });
		}
	}

	private _isTokenValid(vendor: VSCloneModelVendor): boolean {
		const tokenSet = this._tokenSets.get(vendor);
		if (!tokenSet) {
			return false;
		}
		if (tokenSet.expiresAt && tokenSet.expiresAt < Date.now()) {
			return false;
		}
		return true;
	}

	/**
	 * Void-style derived state recomputation.
	 * Syncs OAuth readiness to the mock provider service.
	 */
	private _recomputeDerivedState(): void {
		for (const vendor of allVendors) {
			const providerState = this._state.providers[vendor];
			const isReady = providerState.status === 'signed_in' && this._isTokenValid(vendor);

			// Update isReady if it changed
			if (providerState.isReady !== isReady) {
				const newProviderState: IVSCloneOAuthProviderState = { ...providerState, isReady };
				const newProviders = { ...this._state.providers, [vendor]: newProviderState };
				this._state = { providers: newProviders as Record<VSCloneModelVendor, IVSCloneOAuthProviderState> };
			}

			// Sync to mock provider service
			this.mockProviderService.setProviderConfigured(vendor, isReady);
			this.mockProviderService.setProviderEnabled(vendor, isReady);
		}
	}

	// -- Private: Token Refresh --

	/**
	 * Ensures the token for a vendor is refreshed, coalescing concurrent requests.
	 */
	private async _ensureRefreshed(vendor: VSCloneModelVendor, tokenSet: IVSCloneOAuthTokenSet): Promise<void> {
		// Coalesce concurrent refresh requests
		const existing = this._refreshPromises.get(vendor);
		if (existing) {
			return existing.p;
		}

		const deferred = new DeferredPromise<void>();
		this._refreshPromises.set(vendor, deferred);

		try {
			await this._doRefresh(vendor, tokenSet);
			deferred.complete();
		} catch (err) {
			deferred.error(err instanceof Error ? err : new Error(String(err)));
			throw err;
		} finally {
			this._refreshPromises.delete(vendor);
		}
	}

	private async _doRefresh(vendor: VSCloneModelVendor, tokenSet: IVSCloneOAuthTokenSet): Promise<void> {
		if (!tokenSet.refreshToken) {
			throw new Error('No refresh token available');
		}

		const config = defaultOAuthProviderConfig[vendor];
		this._setProviderStatus(vendor, 'refreshing');

		try {
			const tokenResponse = await refreshAccessToken(config, tokenSet.refreshToken);
			const { userDisplayName, providerMetadata } = extractMetadata(vendor, tokenResponse);

			const newTokenSet: IVSCloneOAuthTokenSet = {
				vendor,
				accessToken: tokenResponse.access_token,
				refreshToken: tokenResponse.refresh_token ?? tokenSet.refreshToken,
				idToken: tokenResponse.id_token ?? tokenSet.idToken,
				expiresAt: tokenResponse.expires_in
					? Date.now() + tokenResponse.expires_in * 1000
					: undefined,
				scopes: tokenResponse.scope
					? tokenResponse.scope.split(' ')
					: [...tokenSet.scopes],
				providerMetadata: { ...tokenSet.providerMetadata, ...providerMetadata },
			};

			this._tokenSets.set(vendor, newTokenSet);
			await this.secretStorageService.set(oauthSecretKey(vendor), JSON.stringify(newTokenSet));

			this._setProviderStatus(vendor, 'signed_in', {
				userDisplayName: userDisplayName ?? this._state.providers[vendor].userDisplayName,
			});
			this._recomputeDerivedState();

			this.logService.info(`[VSCloneOAuth] Token refreshed for ${vendor}`);
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			this.logService.error(`[VSCloneOAuth] Token refresh failed for ${vendor}:`, err);
			this._setProviderStatus(vendor, 'error', { errorMessage });
			this._recomputeDerivedState();
			this.notificationService.error(
				localize('vsclone.oauth.refreshFailed', 'Failed to refresh {0} session: {1}', displayInfoOfOAuthProvider(vendor).title, errorMessage)
			);
			throw err;
		}
	}

	// -- Private: Helpers --

	private _extractUserDisplayNameFromTokenSet(tokenSet: IVSCloneOAuthTokenSet): string | undefined {
		if (tokenSet.providerMetadata['email']) {
			return tokenSet.providerMetadata['email'];
		}
		// Try to decode id_token for display name
		if (tokenSet.idToken) {
			try {
				const claims = getClaimsFromJWT(tokenSet.idToken);
				return claims.email || claims.name || claims.preferred_username;
			} catch {
				// Non-fatal
			}
		}
		return undefined;
	}
}
