/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { VSCloneCompletionApiService } from '../../browser/vscloneCompletionApiService.js';
import { IVSCloneCompletionPromptEnvelope } from '../../common/vscloneCompletionTypes.js';
import {
	IVSCloneCompletionAbortRequest,
	IVSCloneCompletionSubmitRequest,
	IVSCloneCompletionSubmitResponse,
	VSCLONE_COMPLETION_COMMAND_ABORT,
	VSCLONE_COMPLETION_COMMAND_SUBMIT,
} from '../../common/backend/vscloneCompletionApiIpc.js';
import { IVSCloneModelSelection } from '../../common/vscloneModelSelectionTypes.js';
import { IVSCloneOAuthService } from '../../common/vscloneOAuthService.js';
import { IVSCloneOAuthState, IVSCloneOAuthTokenSet } from '../../common/vscloneOAuthTypes.js';

interface IRecordedCall {
	readonly command: string;
	readonly arg: unknown;
}

class TestChannel implements IChannel {
	readonly calls: IRecordedCall[] = [];
	private readonly emitters = new Map<string, Emitter<unknown>>();

	call<T>(command: string, arg?: unknown): Promise<T> {
		this.calls.push({ command, arg });
		if (command === VSCLONE_COMPLETION_COMMAND_SUBMIT) {
			return timeout(10).then(() => ({ rawText: 'completion' } satisfies IVSCloneCompletionSubmitResponse as T));
		}
		return Promise.resolve(undefined as T);
	}

	listen<T>(event: string): Event<T> {
		let emitter = this.emitters.get(event) as Emitter<T> | undefined;
		if (!emitter) {
			emitter = new Emitter<T>();
			this.emitters.set(event, emitter as unknown as Emitter<unknown>);
		}
		return emitter.event;
	}
}

class TestOAuthService implements IVSCloneOAuthService {
	declare readonly _serviceBrand: undefined;
	readonly state = { providers: {} } as unknown as IVSCloneOAuthState;
	readonly onDidChangeState = Event.None;

	async initialize(): Promise<void> { }
	async signIn(): Promise<void> { }
	async signOut(): Promise<void> { }
	async getAccessToken(): Promise<string | undefined> { return undefined; }
	async getTokenSet(): Promise<IVSCloneOAuthTokenSet | undefined> { return undefined; }
	async getApiHeaders(): Promise<Record<string, string> | undefined> {
		return { Authorization: 'Bearer token' };
	}
	isSignedIn(): boolean { return true; }
}

function createMainProcessService(channel: IChannel): IMainProcessService {
	return {
		_serviceBrand: undefined,
		getChannel: () => channel,
		registerChannel: () => undefined,
	};
}

suite('VSCloneCompletionApiService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('forwards cancellation to the main-process transport', async () => {
		const testDisposables = store.add(new DisposableStore());
		const channel = new TestChannel();
		const service = testDisposables.add(new VSCloneCompletionApiService(
			new TestOAuthService(),
			createMainProcessService(channel),
			new NullLogService(),
		));
		const cts = new CancellationTokenSource();
		const envelope: IVSCloneCompletionPromptEnvelope = {
			prefix: 'console.',
			suffix: '',
			languageId: 'typescript',
			filePath: '/workspace/src/app.ts',
			predictionType: 'single-line',
			maxTokens: 96,
			temperature: 0.01,
			stopTokens: ['\n'],
			systemMessage: 'system',
			promptText: 'prompt',
		};
		const selection: IVSCloneModelSelection = {
			location: 'editorInline',
			modelIdentifier: 'openai/gpt-5.3-codex',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelName: 'GPT-5.3-Codex',
			selectedAt: Date.now(),
		};

		const resultPromise = service.complete(envelope, selection, cts.token);
		await timeout(0);
		cts.cancel();
		const result = await resultPromise;

		assert.strictEqual(result, undefined);
		assert.ok(channel.calls.some(call => call.command === VSCLONE_COMPLETION_COMMAND_SUBMIT));
		assert.ok(channel.calls.some(call => call.command === VSCLONE_COMPLETION_COMMAND_ABORT));
		const abortCall = channel.calls.find(call => call.command === VSCLONE_COMPLETION_COMMAND_ABORT);
		assert.ok(abortCall);
		assert.ok((abortCall?.arg as IVSCloneCompletionAbortRequest).requestId);
		const submitCall = channel.calls.find(call => call.command === VSCLONE_COMPLETION_COMMAND_SUBMIT);
		assert.ok((submitCall?.arg as IVSCloneCompletionSubmitRequest).headers.Authorization);
	});
});
