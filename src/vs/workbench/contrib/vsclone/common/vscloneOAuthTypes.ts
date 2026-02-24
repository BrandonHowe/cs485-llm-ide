/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSCloneModelVendor } from './vscloneMockProviderService.js';

// -- Status & Events --

export type VSCloneOAuthStatus = 'signed_out' | 'signing_in' | 'signed_in' | 'refreshing' | 'error';

export interface IVSCloneOAuthStateChangeEvent {
	readonly vendor: VSCloneModelVendor;
	readonly previous: VSCloneOAuthStatus;
	readonly current: VSCloneOAuthStatus;
}

// -- Token storage shape --

export interface IVSCloneOAuthTokenSet {
	readonly vendor: VSCloneModelVendor;
	readonly accessToken: string;
	readonly refreshToken: string | undefined;
	readonly idToken: string | undefined;
	readonly expiresAt: number | undefined;       // Unix ms
	readonly scopes: readonly string[];
	readonly providerMetadata: Readonly<Record<string, string>>;
}

// -- Per-provider snapshot (read by UI) --

export interface IVSCloneOAuthProviderState {
	readonly vendor: VSCloneModelVendor;
	readonly displayName: string;
	readonly status: VSCloneOAuthStatus;
	readonly userDisplayName: string | undefined;
	readonly errorMessage: string | undefined;
	/** Derived: true when status is 'signed_in' and token is not expired */
	readonly isReady: boolean;
}

// -- Full immutable state (Void-style readonly state pattern) --

export interface IVSCloneOAuthState {
	readonly providers: Readonly<Record<VSCloneModelVendor, IVSCloneOAuthProviderState>>;
}

// -- Static provider config registry (Void-style const-as-source-of-truth) --

export type VSCloneOAuthRedirectStrategy = 'loopback' | 'manual_paste';

export interface IVSCloneOAuthProviderConfig {
	readonly vendor: VSCloneModelVendor;
	readonly displayName: string;
	readonly clientId: string;
	readonly clientSecret: string | undefined;
	readonly authUrl: string;
	readonly tokenUrl: string;
	readonly scopes: readonly string[];
	readonly redirectStrategy: VSCloneOAuthRedirectStrategy;
	/** For loopback: template with {port}. For manual_paste: the fixed redirect URI. */
	readonly redirectUriTemplate: string;
	/** 0 = dynamic port assignment */
	readonly preferredPort: number;
	/** Extra query params added to the authorize URL */
	readonly extraAuthorizeParams: Readonly<Record<string, string>>;
	/** Extra body params added to the token exchange POST */
	readonly extraTokenParams: Readonly<Record<string, string>>;
	/** The API endpoint this provider's tokens grant access to */
	readonly apiEndpoint: string;
}

/** Single source of truth - add new providers here */
export const defaultOAuthProviderConfig: Readonly<Record<VSCloneModelVendor, IVSCloneOAuthProviderConfig>> = {
	openai: {
		vendor: 'openai',
		displayName: 'OpenAI',
		clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
		clientSecret: undefined,
		authUrl: 'https://auth.openai.com/oauth/authorize',
		tokenUrl: 'https://auth.openai.com/oauth/token',
		scopes: ['openid', 'profile', 'email', 'offline_access'],
		redirectStrategy: 'loopback',
		redirectUriTemplate: 'http://localhost:{port}/auth/callback',
		preferredPort: 1455,
		extraAuthorizeParams: {},
		extraTokenParams: {},
		apiEndpoint: 'https://chatgpt.com/backend-api/codex/responses',
	},
	anthropic: {
		vendor: 'anthropic',
		displayName: 'Anthropic',
		clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
		clientSecret: undefined,
		authUrl: 'https://claude.ai/oauth/authorize',
		tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
		scopes: ['org:create_api_key', 'user:profile', 'user:inference'],
		redirectStrategy: 'manual_paste',
		redirectUriTemplate: 'https://console.anthropic.com/oauth/code/callback',
		preferredPort: 0,
		extraAuthorizeParams: {},
		extraTokenParams: {},
		apiEndpoint: 'https://api.anthropic.com/v1/messages',
	},
	google: {
		vendor: 'google',
		displayName: 'Google',
		clientId: 'vsclone-google-client-id',
		clientSecret: undefined,
		authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		scopes: [
			'https://www.googleapis.com/auth/cloud-platform',
			'https://www.googleapis.com/auth/userinfo.email',
			'https://www.googleapis.com/auth/userinfo.profile',
		],
		redirectStrategy: 'loopback',
		redirectUriTemplate: 'http://127.0.0.1:{port}/oauth2callback',
		preferredPort: 0,
		extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
		extraTokenParams: {},
		apiEndpoint: 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
	},
} as const;

/** Display helpers (Void-style displayInfoOf pattern) */
export interface IVSCloneOAuthDisplayInfo {
	readonly title: string;
	readonly description: string;
	readonly signInLabel: string;
}

export function displayInfoOfOAuthProvider(vendor: VSCloneModelVendor): IVSCloneOAuthDisplayInfo {
	switch (vendor) {
		case 'openai': return {
			title: 'OpenAI',
			description: 'Sign in with your ChatGPT Plus/Pro account',
			signInLabel: 'Sign In with OpenAI',
		};
		case 'anthropic': return {
			title: 'Anthropic',
			description: 'Sign in with your Claude Pro/Max account',
			signInLabel: 'Sign In with Anthropic',
		};
		case 'google': return {
			title: 'Google',
			description: 'Sign in with your Google account for Gemini',
			signInLabel: 'Sign In with Google',
		};
	}
}

/** Secret storage key helper */
export const VSCLONE_OAUTH_SECRET_PREFIX = 'vsclone.oauth.tokens.';
export function oauthSecretKey(vendor: VSCloneModelVendor): string {
	return `${VSCLONE_OAUTH_SECRET_PREFIX}${vendor}`;
}
