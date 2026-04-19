/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { env } from '../../../../../base/common/process.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IChannel, IServerChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { VSCloneConvertToLLMMessageService } from '../../common/vscloneConvertToLLMMessageService.js';
import { VSCloneLLMMessageService } from '../../common/vscloneLLMMessageService.js';
import { VSCloneLLMMessageChannel } from '../../electron-main/vscloneLLMMessageChannel.js';
import { type IVSCloneLLMMessageChatRequest } from '../../common/vscloneLLMMessageTypes.js';
import { defaultOAuthProviderConfig, type VSCloneModelVendor } from '../../common/vscloneOAuthTypes.js';

interface ILiveProviderConfig {
	readonly vendor: VSCloneModelVendor;
	readonly modelId: string;
	readonly accessTokenEnvKey: string;
	readonly extraHeadersEnvKey: string;
	readonly expectedMarker: string;
}

const runLiveProviderSmokeTests = env['VSCODE_VSCLONE_E2E_LIVE_PROVIDER_TESTS'] === '1';

const liveProviderConfigs: readonly ILiveProviderConfig[] = [
	{
		vendor: 'openai',
		modelId: 'gpt-5.3-codex',
		accessTokenEnvKey: 'VSCODE_VSCLONE_E2E_OPENAI_ACCESS_TOKEN',
		extraHeadersEnvKey: 'VSCODE_VSCLONE_E2E_OPENAI_HEADERS_JSON',
		expectedMarker: 'VSCLONE_OPENAI_LIVE_OK',
	},
	{
		vendor: 'anthropic',
		modelId: 'claude-haiku-4-5-20251001',
		accessTokenEnvKey: 'VSCODE_VSCLONE_E2E_ANTHROPIC_ACCESS_TOKEN',
		extraHeadersEnvKey: 'VSCODE_VSCLONE_E2E_ANTHROPIC_HEADERS_JSON',
		expectedMarker: 'VSCLONE_ANTHROPIC_LIVE_OK',
	},
	{
		vendor: 'google',
		modelId: 'gemini-3.1-flash-lite-preview',
		accessTokenEnvKey: 'VSCODE_VSCLONE_E2E_GOOGLE_ACCESS_TOKEN',
		extraHeadersEnvKey: 'VSCODE_VSCLONE_E2E_GOOGLE_HEADERS_JSON',
		expectedMarker: 'VSCLONE_GOOGLE_LIVE_OK',
	},
] as const;

function createClientChannel(serverChannel: IServerChannel<string>): IChannel {
	// The live smoke suite still goes through the real renderer service so the request crosses the
	// same request-id/event IPC seam as production, even though the test runs in the node harness.
	return {
		call: <T>(command: string, arg?: unknown) => serverChannel.call<T>('', command, arg),
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

function normalizeStringHeaders(value: unknown): Record<string, string> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Expected a JSON object with string header values.');
	}

	return Object.fromEntries(
		Object.entries(value).map(([key, entryValue]) => [key, String(entryValue)]),
	);
}

function readExtraHeaders(envKey: string): Record<string, string> {
	const rawHeaders = env[envKey]?.trim();
	if (!rawHeaders) {
		return {};
	}

	try {
		return normalizeStringHeaders(JSON.parse(rawHeaders));
	} catch (error) {
		throw new Error(`${envKey} must be valid JSON with string header values: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function getDefaultProviderHeaders(config: ILiveProviderConfig): Record<string, string> {
	// The smoke suite intentionally mirrors the browser OAuth service's provider contract instead of
	// relying on contributors to remember invisible required headers such as Anthropic's version or
	// OpenAI's responses opt-in flags.
	switch (config.vendor) {
		case 'openai':
			return {
				'OpenAI-Beta': 'responses=v1',
				'OpenAI-Originator': 'codex',
			};
		case 'anthropic':
			return {
				'anthropic-version': '2023-06-01',
				'anthropic-beta': 'oauth-2025-04-20',
			};
		case 'google': {
			const quotaProject = defaultOAuthProviderConfig.google.quotaProject;
			return quotaProject ? { 'x-goog-user-project': quotaProject } : {};
		}
	}
}

function createChatRequest(config: ILiveProviderConfig, accessToken: string): IVSCloneLLMMessageChatRequest {
	const convertToLLMMessageService = new VSCloneConvertToLLMMessageService();
	// The live suite asks for a deterministic marker so the assertion is about transport integrity,
	// not model quality. Keeping the prompt tiny also minimizes cost when contributors opt in.
	const prepared = convertToLLMMessageService.prepareChatRequest({
		threadId: `live-${config.vendor}-thread`,
		turnId: `live-${config.vendor}-turn`,
		sequence: 1,
		sessionResource: `vsclone://live/${config.vendor}`,
		mode: 'act',
		vendor: config.vendor,
		modelId: config.modelId,
		modelIdentifier: `${config.vendor}/${config.modelId}`,
		previousTurns: [],
		currentTurn: {
			role: 'user',
			content: `Reply with exactly ${config.expectedMarker} and nothing else.`,
		},
		systemMessage: `You are a VSClone live backend smoke test. Reply with exactly ${config.expectedMarker} and nothing else.`,
	});

	return {
		kind: 'chat',
		auth: {
			vendor: config.vendor,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				...getDefaultProviderHeaders(config),
				...readExtraHeaders(config.extraHeadersEnvKey),
			},
		},
		prepared,
	};
}

const liveProviderSuite = runLiveProviderSmokeTests ? suite : suite.skip;

liveProviderSuite('VSCloneLLMMessage live provider transport smoke', function () {
	this.timeout(120_000);

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	for (const config of liveProviderConfigs) {
		(env[config.accessTokenEnvKey] ? test : test.skip)(`${config.vendor} returns a real backend response through the renderer/main-process bridge`, async () => {
			const testDisposables = store.add(new DisposableStore());
			const serverChannel = testDisposables.add(new VSCloneLLMMessageChannel(new NullLogService()));
			const service = testDisposables.add(new VSCloneLLMMessageService(
				createMainProcessService(createClientChannel(serverChannel)),
				new NullLogService(),
			));
			const accessToken = env[config.accessTokenEnvKey]!;
			const textEvents: string[] = [];
			const finalMessages: string[] = [];
			const errors: string[] = [];
			let abortCount = 0;

			const handle = service.sendChatRequest(createChatRequest(config, accessToken), {
				onText: payload => {
					textEvents.push(payload.text);
				},
				onFinalMessage: payload => {
					finalMessages.push(payload.fullText);
				},
				onError: payload => {
					errors.push(payload.message);
				},
				onAbort: () => {
					abortCount += 1;
				},
			});

			await handle.done;

			assert.deepStrictEqual(errors, []);
			assert.strictEqual(abortCount, 0);
			assert.strictEqual(finalMessages.length, 1);
			assert.ok(finalMessages[0].length > 0, 'expected the live provider to return non-empty text');
			assert.ok(
				finalMessages[0].includes(config.expectedMarker),
				`expected ${config.vendor} response to include ${config.expectedMarker}, got: ${finalMessages[0]}`,
			);
			// Streaming behavior differs by vendor SDK and prompt size, so the smoke suite does not
			// require delta events. The array still exists to aid local debugging when a provider does
			// stream partial text before the final callback.
			void textEvents;
		});
	}
});
