/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IVSCloneApiSubmitOptions } from '../../common/vscloneChatApiAdapters.js';
import {
	IVSCloneChatApiAbortedEvent,
	IVSCloneChatApiCompleteEvent,
	IVSCloneChatApiDeltaEvent,
	IVSCloneChatApiErrorEvent,
	VSCLONE_CHAT_API_COMMAND_ABORT,
	VSCLONE_CHAT_API_COMMAND_SUBMIT,
	VSCLONE_CHAT_API_EVENT_ABORTED,
	VSCLONE_CHAT_API_EVENT_COMPLETE,
	VSCLONE_CHAT_API_EVENT_DELTA,
	VSCLONE_CHAT_API_EVENT_ERROR,
} from '../../common/vscloneChatApiIpc.js';
import { IVSCloneModelEligibilityService, IVSCloneModelIneligibilityRecord } from '../../common/vscloneModelEligibilityService.js';
import { IVSCloneOAuthService } from '../../common/vscloneOAuthService.js';
import { IVSCloneOAuthState, IVSCloneOAuthTokenSet, VSCloneModelVendor } from '../../common/vscloneOAuthTypes.js';
import {
	detectEligibilityFailureReason,
	IVSCloneApiStreamObserver,
	VSCloneChatApiService,
} from '../../browser/vscloneChatApiService.js';

interface IRecordedCall {
	readonly command: string;
	readonly arg: unknown;
}

class TestChannel implements IChannel {
	readonly calls: IRecordedCall[] = [];
	private readonly emitters = new Map<string, Emitter<unknown>>();
	private readonly callHandlers = new Map<string, (arg: unknown) => unknown | Promise<unknown>>();

	call<T>(command: string, arg?: unknown): Promise<T> {
		this.calls.push({ command, arg });
		const handler = this.callHandlers.get(command);
		return Promise.resolve((handler ? handler(arg) : undefined) as T);
	}

	listen<T>(event: string): Event<T> {
		return this.getEmitter<T>(event).event;
	}

	setCallHandler(command: string, handler: (arg: unknown) => unknown | Promise<unknown>): void {
		this.callHandlers.set(command, handler);
	}

	fireDelta(event: IVSCloneChatApiDeltaEvent): void {
		this.getEmitter<IVSCloneChatApiDeltaEvent>(VSCLONE_CHAT_API_EVENT_DELTA).fire(event);
	}

	fireComplete(event: IVSCloneChatApiCompleteEvent): void {
		this.getEmitter<IVSCloneChatApiCompleteEvent>(VSCLONE_CHAT_API_EVENT_COMPLETE).fire(event);
	}

	fireError(event: IVSCloneChatApiErrorEvent): void {
		this.getEmitter<IVSCloneChatApiErrorEvent>(VSCLONE_CHAT_API_EVENT_ERROR).fire(event);
	}

	fireAborted(event: IVSCloneChatApiAbortedEvent): void {
		this.getEmitter<IVSCloneChatApiAbortedEvent>(VSCLONE_CHAT_API_EVENT_ABORTED).fire(event);
	}

	private getEmitter<T>(event: string): Emitter<T> {
		let emitter = this.emitters.get(event) as Emitter<T> | undefined;
		if (!emitter) {
			emitter = new Emitter<T>();
			this.emitters.set(event, emitter as unknown as Emitter<unknown>);
		}
		return emitter;
	}
}

class TestEligibilityService implements IVSCloneModelEligibilityService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeEligibility = Event.None;
	readonly markedIneligible: Array<{ modelIdentifier: string; reason: string }> = [];
	private readonly records = new Map<string, IVSCloneModelIneligibilityRecord>();

	async initialize(): Promise<void> { }
	isIneligible(modelIdentifier: string): boolean { return this.records.has(modelIdentifier); }
	getIneligibilityRecord(modelIdentifier: string): IVSCloneModelIneligibilityRecord | undefined { return this.records.get(modelIdentifier); }
	markIneligible(modelIdentifier: string, reason: string): void {
		this.markedIneligible.push({ modelIdentifier, reason });
		this.records.set(modelIdentifier, { modelIdentifier, reason, markedAt: Date.now() });
	}
	clearForVendor(_vendor: VSCloneModelVendor): void { }
	clearAll(): void { this.records.clear(); }
}

class TestOAuthService implements IVSCloneOAuthService {
	declare readonly _serviceBrand: undefined;
	readonly state = { providers: {} } as unknown as IVSCloneOAuthState;
	readonly onDidChangeState = Event.None;

	headersByVendor = new Map<string, Record<string, string> | undefined>([
		['openai', { Authorization: 'Bearer openai-token' }],
		['anthropic', { Authorization: 'Bearer anthropic-token' }],
		['google', { Authorization: 'Bearer google-token' }],
	]);

	async initialize(): Promise<void> { }
	async signIn(): Promise<void> { }
	async signOut(): Promise<void> { }
	async getAccessToken(): Promise<string | undefined> { return undefined; }
	async getTokenSet(): Promise<IVSCloneOAuthTokenSet | undefined> { return undefined; }
	async getApiHeaders(vendor: 'openai' | 'anthropic' | 'google'): Promise<Record<string, string> | undefined> {
		return this.headersByVendor.get(vendor);
	}
	isSignedIn(): boolean { return false; }
}

function createObserverRecorder(): { observer: IVSCloneApiStreamObserver; deltas: string[]; errors: string[]; aborted: number; completed: number } {
	const deltas: string[] = [];
	const errors: string[] = [];
	let aborted = 0;
	let completed = 0;
	return {
		observer: {
			onDelta: text => deltas.push(text),
			onError: message => errors.push(message),
			onAborted: () => {
				aborted += 1;
			},
			onComplete: () => {
				completed += 1;
			},
		},
		deltas,
		errors,
		get aborted() {
			return aborted;
		},
		get completed() {
			return completed;
		},
	};
}

function createSubmitOptions(overrides: Partial<IVSCloneApiSubmitOptions> = {}): IVSCloneApiSubmitOptions {
	return {
		threadId: 'thread-1',
		turnId: 'thread-1:turn-1',
		sequence: 1,
		sessionResource: 'vsclone://api/thread-1',
		promptText: 'Explain this bug',
		vendor: 'openai',
		modelId: 'gpt-5.3-codex',
		modelIdentifier: 'openai/gpt-5.3-codex',
		...overrides,
	};
}

function createMainProcessService(channel: IChannel): IMainProcessService {
	return {
		_serviceBrand: undefined,
		getChannel: (_channelName: string) => channel,
		registerChannel: (_channelName: string) => undefined,
	};
}

function getRecordedCall(channel: TestChannel, command: string): IRecordedCall | undefined {
	return channel.calls.find(call => call.command === command);
}

suite('VSCloneChatApiService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('submits through main-process transport without touching legacy history state', async () => {
		const testDisposables = store.add(new DisposableStore());
		const oauthService = new TestOAuthService();
		const channel = new TestChannel();
		const eligibilityService = new TestEligibilityService();
		const service = testDisposables.add(new VSCloneChatApiService(
			oauthService,
			createMainProcessService(channel),
			new NullLogService(),
			eligibilityService,
		));

		const handle = service.submitApiPrompt(createSubmitOptions());
		await timeout(0);
		const submitCall = getRecordedCall(channel, VSCLONE_CHAT_API_COMMAND_SUBMIT);
		assert.ok(submitCall);
		const request = submitCall?.arg as { requestId: string; headers: Record<string, string>; options: IVSCloneApiSubmitOptions };
		assert.strictEqual(request.options.threadId, 'thread-1');
		assert.strictEqual(request.headers.Authorization, 'Bearer openai-token');

		channel.fireDelta({ requestId: request.requestId, text: 'delta-1' });
		channel.fireComplete({ requestId: request.requestId });
		await handle.done;
	});

	test('reports sign-in errors when no API headers are available', async () => {
		const testDisposables = store.add(new DisposableStore());
		const oauthService = new TestOAuthService();
		oauthService.headersByVendor.set('openai', undefined);
		const channel = new TestChannel();
		const eligibilityService = new TestEligibilityService();
		const recorder = createObserverRecorder();
		const service = testDisposables.add(new VSCloneChatApiService(
			oauthService,
			createMainProcessService(channel),
			new NullLogService(),
			eligibilityService,
		));

		const handle = service.submitApiPromptForAgentLoop(createSubmitOptions(), recorder.observer);
		await handle.done;

		assert.strictEqual(getRecordedCall(channel, VSCLONE_CHAT_API_COMMAND_SUBMIT), undefined);
		assert.deepStrictEqual(recorder.errors, ['Not signed in to openai']);
	});

	test('cancel always issues a main-process abort command', async () => {
		const testDisposables = store.add(new DisposableStore());
		const oauthService = new TestOAuthService();
		const channel = new TestChannel();
		const eligibilityService = new TestEligibilityService();
		const service = testDisposables.add(new VSCloneChatApiService(
			oauthService,
			createMainProcessService(channel),
			new NullLogService(),
			eligibilityService,
		));

		const handle = service.submitApiPrompt(createSubmitOptions());
		handle.cancel();
		await handle.done;

		assert.ok(getRecordedCall(channel, VSCLONE_CHAT_API_COMMAND_ABORT));
	});

	test('raw observer mode emits aborted callback without writing history turns', async () => {
		const testDisposables = store.add(new DisposableStore());
		const oauthService = new TestOAuthService();
		const channel = new TestChannel();
		const eligibilityService = new TestEligibilityService();
		const service = testDisposables.add(new VSCloneChatApiService(
			oauthService,
			createMainProcessService(channel),
			new NullLogService(),
			eligibilityService,
		));

		let abortedCalls = 0;
		const handle = service.submitApiPromptForAgentLoop(createSubmitOptions(), {
			onAborted: () => {
				abortedCalls += 1;
			},
		});

		handle.cancel();
		await handle.done;

		assert.strictEqual(abortedCalls, 1);
		assert.ok(getRecordedCall(channel, VSCLONE_CHAT_API_COMMAND_ABORT));
	});

	test('raw observer mode receives main-process abort events', async () => {
		const testDisposables = store.add(new DisposableStore());
		const oauthService = new TestOAuthService();
		const channel = new TestChannel();
		const eligibilityService = new TestEligibilityService();
		const recorder = createObserverRecorder();
		const service = testDisposables.add(new VSCloneChatApiService(
			oauthService,
			createMainProcessService(channel),
			new NullLogService(),
			eligibilityService,
		));

		const handle = service.submitApiPromptForAgentLoop(createSubmitOptions(), recorder.observer);
		await timeout(0);
		const submitCall = getRecordedCall(channel, VSCLONE_CHAT_API_COMMAND_SUBMIT);
		assert.ok(submitCall);
		const request = submitCall?.arg as { requestId: string };

		channel.fireAborted({ requestId: request.requestId });
		await handle.done;

		assert.strictEqual(recorder.aborted, 1);
	});

	test('records model ineligibility when Codex reports a ChatGPT account entitlement failure', async () => {
		const testDisposables = store.add(new DisposableStore());
		const oauthService = new TestOAuthService();
		const channel = new TestChannel();
		const eligibilityService = new TestEligibilityService();
		const recorder = createObserverRecorder();
		const service = testDisposables.add(new VSCloneChatApiService(
			oauthService,
			createMainProcessService(channel),
			new NullLogService(),
			eligibilityService,
		));

		const handle = service.submitApiPromptForAgentLoop(createSubmitOptions({
			modelId: 'gpt-5.3-codex-spark',
			modelIdentifier: 'openai/gpt-5.3-codex-spark',
		}), recorder.observer);
		await timeout(0);
		const submitCall = getRecordedCall(channel, VSCLONE_CHAT_API_COMMAND_SUBMIT);
		assert.ok(submitCall);
		const request = submitCall?.arg as { requestId: string };

		channel.fireError({
			requestId: request.requestId,
			message: `openai API returned 400: {"detail":"The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account."}`,
		});
		await handle.done;

		assert.deepStrictEqual(eligibilityService.markedIneligible, [{
			modelIdentifier: 'openai/gpt-5.3-codex-spark',
			reason: 'Your ChatGPT account is not entitled to use this model with Codex.',
		}]);
		assert.strictEqual(recorder.errors.length, 1);
	});

	test('detectEligibilityFailureReason ignores unrelated OpenAI errors', () => {
		assert.strictEqual(detectEligibilityFailureReason('openai', 'openai API returned 500: internal error'), undefined);
		assert.strictEqual(detectEligibilityFailureReason('anthropic', `The 'x' model is not supported when using Codex with a ChatGPT account.`), undefined);
		assert.ok(detectEligibilityFailureReason('openai', `openai API returned 400: {"detail":"The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account."}`));
	});
});
