/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

type VSCloneModelVendor = 'openai' | 'anthropic' | 'google';

interface ICompiledOAuthProviderConfig {
	readonly vendor: VSCloneModelVendor;
	readonly clientId: string;
	readonly clientSecret: string | undefined;
	readonly tokenUrl: string;
	readonly scopes: readonly string[];
}

interface ICompiledOAuthTypesModule {
	readonly defaultOAuthProviderConfig: Record<VSCloneModelVendor, ICompiledOAuthProviderConfig>;
}

interface ICompiledOAuthHelpersModule {
	readonly getClaimsFromJWT: (token: string) => Record<string, unknown>;
}

interface IOAuthTokenResponse {
	readonly access_token?: string;
	readonly refresh_token?: string;
	readonly expires_in?: number;
	readonly id_token?: string;
	readonly scope?: string;
	readonly error?: string;
	readonly error_description?: string;
}

interface ILiveProviderSpec {
	readonly vendor: VSCloneModelVendor;
	readonly refreshTokenEnvKey: string;
	readonly accessTokenEnvKey: string;
	readonly headersEnvKey: string;
}

const root = path.dirname(path.dirname(path.dirname(import.meta.dirname)));
const githubEnvPath = process.env['GITHUB_ENV'];
const requiredVendors = parseRequiredVendors(process.env['VSCODE_VSCLONE_E2E_REQUIRED_VENDORS']);
const liveProviderSpecs: readonly ILiveProviderSpec[] = [
	{
		vendor: 'openai',
		refreshTokenEnvKey: 'VSCODE_VSCLONE_E2E_OPENAI_REFRESH_TOKEN',
		accessTokenEnvKey: 'VSCODE_VSCLONE_E2E_OPENAI_ACCESS_TOKEN',
		headersEnvKey: 'VSCODE_VSCLONE_E2E_OPENAI_HEADERS_JSON',
	},
	{
		vendor: 'anthropic',
		refreshTokenEnvKey: 'VSCODE_VSCLONE_E2E_ANTHROPIC_REFRESH_TOKEN',
		accessTokenEnvKey: 'VSCODE_VSCLONE_E2E_ANTHROPIC_ACCESS_TOKEN',
		headersEnvKey: 'VSCODE_VSCLONE_E2E_ANTHROPIC_HEADERS_JSON',
	},
	{
		vendor: 'google',
		refreshTokenEnvKey: 'VSCODE_VSCLONE_E2E_GOOGLE_REFRESH_TOKEN',
		accessTokenEnvKey: 'VSCODE_VSCLONE_E2E_GOOGLE_ACCESS_TOKEN',
		headersEnvKey: 'VSCODE_VSCLONE_E2E_GOOGLE_HEADERS_JSON',
	},
] as const;

/**
 * The workflow transpiles VSClone before running this helper so CI can reuse the same provider
 * registry and JWT parsing helpers that the product itself uses, instead of hand-copying endpoints.
 */
async function loadCompiledOAuthModules(): Promise<{
	readonly oauthTypesModule: ICompiledOAuthTypesModule;
	readonly oauthHelpersModule: ICompiledOAuthHelpersModule;
}> {
	const oauthTypesModule = await import(pathToFileURL(path.join(root, 'out/vs/workbench/contrib/vsclone/common/vscloneOAuthTypes.js')).href) as ICompiledOAuthTypesModule;
	const oauthHelpersModule = await import(pathToFileURL(path.join(root, 'out/vs/base/common/oauth.js')).href) as ICompiledOAuthHelpersModule;
	return { oauthTypesModule, oauthHelpersModule };
}

/**
 * GitHub-hosted runners start with no VSClone secrets in their environment, so the helper supports
 * both "required vendor" mode for CI and best-effort local dry runs with no configured providers.
 */
function parseRequiredVendors(rawValue: string | undefined): readonly VSCloneModelVendor[] {
	if (!rawValue) {
		return [];
	}

	const requestedVendors = rawValue
		.split(',')
		.map(entry => entry.trim())
		.filter((entry): entry is string => entry.length > 0);
	const validVendors = new Set<VSCloneModelVendor>(['openai', 'anthropic', 'google']);

	for (const vendor of requestedVendors) {
		if (!validVendors.has(vendor as VSCloneModelVendor)) {
			throw new Error(`Unsupported VSClone live-provider vendor "${vendor}" in VSCODE_VSCLONE_E2E_REQUIRED_VENDORS.`);
		}
	}

	return requestedVendors as readonly VSCloneModelVendor[];
}

/**
 * The smoke suite already reads token/header material from environment variables, so the helper
 * writes directly to `GITHUB_ENV` rather than inventing a second handoff mechanism.
 */
function appendGitHubEnv(key: string, value: string): void {
	if (!githubEnvPath) {
		throw new Error('GITHUB_ENV must be set before minting VSClone live-provider tokens.');
	}

	const heredocMarker = `VSCLONE_${key}_EOF`;
	fs.appendFileSync(githubEnvPath, `${key}<<${heredocMarker}\n${value}\n${heredocMarker}\n`);
}

/**
 * Minted access tokens are not repository secrets, so Actions would otherwise print them back in
 * failing command traces. Masking them immediately keeps the live smoke workflow safe to inspect.
 */
function maskSecret(value: string | undefined): void {
	if (!value) {
		return;
	}

	console.log(`::add-mask::${value}`);
}

function readOptionalEnv(key: string): string | undefined {
	const rawValue = process.env[key]?.trim();
	return rawValue && rawValue.length > 0 ? rawValue : undefined;
}

function parseOptionalHeaders(key: string): Record<string, string> {
	const rawValue = readOptionalEnv(key);
	if (!rawValue) {
		return {};
	}

	let parsedValue: unknown;
	try {
		parsedValue = JSON.parse(rawValue);
	} catch (error) {
		throw new Error(`${key} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
		throw new Error(`${key} must contain a JSON object with string header values.`);
	}

	return Object.fromEntries(
		Object.entries(parsedValue).map(([headerName, headerValue]) => [headerName, String(headerValue)]),
	);
}

function selectVendorsToMint(): readonly ILiveProviderSpec[] {
	if (requiredVendors.length > 0) {
		return liveProviderSpecs.filter(spec => requiredVendors.includes(spec.vendor));
	}

	return liveProviderSpecs.filter(spec => readOptionalEnv(spec.refreshTokenEnvKey));
}

async function refreshProviderAccessToken(
	config: ICompiledOAuthProviderConfig,
	refreshToken: string,
): Promise<IOAuthTokenResponse> {
	let body: string;
	let contentType: string;

	// The workflow intentionally mirrors the renderer refresh contract so CI exercises the same
	// provider-specific token endpoint shapes that production uses for background token refresh.
	if (config.vendor === 'anthropic') {
		body = JSON.stringify({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: config.clientId,
			scope: config.scopes.join(' '),
		});
		contentType = 'application/json';
	} else {
		const params = new URLSearchParams();
		params.set('grant_type', 'refresh_token');
		params.set('refresh_token', refreshToken);
		params.set('client_id', config.clientId);

		if (config.clientSecret) {
			params.set('client_secret', config.clientSecret);
		}

		body = params.toString();
		contentType = 'application/x-www-form-urlencoded';
	}

	const response = await fetch(config.tokenUrl, {
		method: 'POST',
		headers: {
			'Accept': 'application/json',
			'Content-Type': contentType,
		},
		body,
	});
	const responseText = await response.text();
	const responseBody = parseOAuthResponseBody(responseText);

	if (!response.ok) {
		throw new Error(`${config.vendor} token refresh failed with ${response.status}: ${describeOAuthFailure(responseBody, response.statusText)}`);
	}

	if (!responseBody.access_token) {
		throw new Error(`${config.vendor} token refresh did not return an access_token.`);
	}

	return responseBody;
}

/**
 * Google is the only provider whose repository defaults are intentionally placeholders, so fail
 * before the network request when the workflow forgot to supply the real desktop OAuth client.
 */
function validateProviderConfig(config: ICompiledOAuthProviderConfig): void {
	if (config.vendor !== 'google') {
		return;
	}

	if (config.clientId === 'vsclone-google-client-id') {
		throw new Error('Missing VSCODE_VSCLONE_GOOGLE_CLIENT_ID for Google live-provider smoke runs.');
	}

	if (!config.clientSecret) {
		throw new Error('Missing VSCODE_VSCLONE_GOOGLE_CLIENT_SECRET for Google live-provider smoke runs.');
	}
}

function parseOAuthResponseBody(responseText: string): IOAuthTokenResponse {
	if (!responseText) {
		return {};
	}

	try {
		return JSON.parse(responseText) as IOAuthTokenResponse;
	} catch {
		return { error_description: responseText };
	}
}

function describeOAuthFailure(responseBody: IOAuthTokenResponse, fallbackStatusText: string): string {
	return responseBody.error_description || responseBody.error || fallbackStatusText || 'unknown error';
}

/**
 * OpenAI requests can require `ChatGPT-Account-Id`, but the canonical source for that value is the
 * refreshed access token itself. Decoding it here keeps CI aligned with the normal sign-in flow.
 */
function extractOpenAIHeaders(
	getClaimsFromJWT: ICompiledOAuthHelpersModule['getClaimsFromJWT'],
	accessToken: string,
): Record<string, string> {
	try {
		const claims = getClaimsFromJWT(accessToken);
		const authClaims = claims['https://api.openai.com/auth'];
		if (!authClaims || typeof authClaims !== 'object' || Array.isArray(authClaims)) {
			return {};
		}

		const accountId = (authClaims as Record<string, unknown>)['chatgpt_account_id'];
		return typeof accountId === 'string' && accountId.length > 0
			? { 'ChatGPT-Account-Id': accountId }
			: {};
	} catch {
		return {};
	}
}

function warnOnRefreshTokenRotation(vendor: VSCloneModelVendor, currentRefreshToken: string, response: IOAuthTokenResponse): void {
	if (!response.refresh_token || response.refresh_token === currentRefreshToken) {
		return;
	}

	// GitHub Actions cannot mutate repository secrets from the job, so emit a warning instead of
	// silently discarding the rotated credential and leaving the next scheduled run to fail later.
	console.log(`::warning::${vendor} returned a rotated refresh token. Update the GitHub secret for ${vendor} live-provider smoke runs.`);
}

async function main(): Promise<void> {
	const selectedSpecs = selectVendorsToMint();
	if (selectedSpecs.length === 0) {
		console.log('No VSClone live-provider refresh tokens were configured; skipping token minting.');
		return;
	}

	const { oauthTypesModule, oauthHelpersModule } = await loadCompiledOAuthModules();
	const mintedVendors: VSCloneModelVendor[] = [];

	for (const spec of selectedSpecs) {
		const refreshToken = readOptionalEnv(spec.refreshTokenEnvKey);
		if (!refreshToken) {
			throw new Error(`Missing required refresh token environment variable ${spec.refreshTokenEnvKey}.`);
		}

		const config = oauthTypesModule.defaultOAuthProviderConfig[spec.vendor];
		validateProviderConfig(config);
		const refreshed = await refreshProviderAccessToken(config, refreshToken);
		const accessToken = refreshed.access_token!;
		const configuredHeaders = parseOptionalHeaders(spec.headersEnvKey);
		const dynamicHeaders = spec.vendor === 'openai'
			? extractOpenAIHeaders(oauthHelpersModule.getClaimsFromJWT, accessToken)
			: {};
		const mergedHeaders = { ...dynamicHeaders, ...configuredHeaders };

		maskSecret(accessToken);
		appendGitHubEnv(spec.accessTokenEnvKey, accessToken);
		if (Object.keys(mergedHeaders).length > 0) {
			appendGitHubEnv(spec.headersEnvKey, JSON.stringify(mergedHeaders));
		}

		warnOnRefreshTokenRotation(spec.vendor, refreshToken, refreshed);
		mintedVendors.push(spec.vendor);
		console.log(`Minted ${spec.vendor} access token for VSClone live-provider smoke tests.`);
	}

	appendGitHubEnv('VSCODE_VSCLONE_E2E_LIVE_PROVIDER_TESTS', '1');
	appendGitHubEnv('VSCODE_VSCLONE_E2E_MINTED_VENDORS', mintedVendors.join(','));
}

// This helper is only invoked as a build script from CI, so execute it eagerly instead of relying
// on `import.meta.main`, which is not consistently populated across Node's TypeScript execution modes.
main().catch(error => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
