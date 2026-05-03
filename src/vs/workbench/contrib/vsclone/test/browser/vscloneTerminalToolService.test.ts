/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
// The terminal tests use partial terminal service fakes whose runtime surface is deliberately much
// smaller than the full workbench interfaces they stand in for.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ICreateTerminalOptions, ITerminalInstance, ITerminalService } from '../../../terminal/browser/terminal.js';
import { idOfPersistentTerminalName, persistentTerminalNameOfId, VSCloneTerminalToolService } from '../../browser/vscloneTerminalToolService.js';

class TestCommandDetectionCapability extends Disposable {
	private readonly _onCommandFinished = this._register(new Emitter<{ exitCode?: number; getOutput(): string | undefined }>());
	readonly onCommandFinished = this._onCommandFinished.event;

	fire(exitCode: number | undefined, output: string | undefined): void {
		this._onCommandFinished.fire({ exitCode, getOutput: () => output });
	}
}

class TestTerminalInstance extends Disposable {
	readonly onExitEmitter = this._register(new Emitter<void>());
	readonly onExit = this.onExitEmitter.event;
	readonly onDataEmitter = this._register(new Emitter<string>());
	readonly onData = this.onDataEmitter.event;
	readonly sentText: Array<{ text: string; addNewLine: boolean }> = [];
	readonly capability = this._register(new TestCommandDetectionCapability());
	readonly capabilityAddEmitter = this._register(new Emitter<{ id: TerminalCapability; capability: TestCommandDetectionCapability }>());
	readonly capabilities = {
		get: (id: TerminalCapability) => id === TerminalCapability.CommandDetection ? this.capability : undefined,
		onDidAddCapability: this.capabilityAddEmitter.event,
	};

	xterm: { getBufferReverseIterator(): Iterable<string> } | undefined;

	constructor(readonly title: string, private readonly outputAfterSend?: string) {
		super();
	}

	override dispose(): void {
		// Consumers remove terminal bookkeeping from onExit, so the test double must publish the
		// lifecycle signal before tearing down the emitter that delivers it.
		this.onExitEmitter.fire();
		super.dispose();
	}

	async sendText(text: string, addNewLine: boolean): Promise<void> {
		this.sentText.push({ text, addNewLine });
		if (this.outputAfterSend !== undefined) {
			// Shell integration reports completion asynchronously in the workbench, so the stub does
			// the same to verify the service registers its listener before sending text.
			queueMicrotask(() => this.capability.fire(7, this.outputAfterSend));
		}
	}
}

class TestTerminalService extends Disposable {
	readonly createdOptions: ICreateTerminalOptions[] = [];
	readonly focusCalls: ITerminalInstance[] = [];
	readonly activeInstances: ITerminalInstance[] = [];
	readonly onDidCreateInstanceEmitter = this._register(new Emitter<ITerminalInstance>());
	readonly onDidCreateInstance = this.onDidCreateInstanceEmitter.event;
	readonly whenConnected = Promise.resolve();
	instances: ITerminalInstance[] = [];
	nextTerminal: TestTerminalInstance | undefined;

	async createTerminal(options: ICreateTerminalOptions): Promise<ITerminalInstance> {
		this.createdOptions.push(options);
		const terminal = this.nextTerminal ?? new TestTerminalInstance(options.config?.name ?? options.config?.title ?? 'terminal');
		this.nextTerminal = undefined;
		this._register(terminal);
		this.instances.push(terminal as unknown as ITerminalInstance);
		this.onDidCreateInstanceEmitter.fire(terminal as unknown as ITerminalInstance);
		return terminal as unknown as ITerminalInstance;
	}

	setActiveInstance(instance: ITerminalInstance): void {
		this.activeInstances.push(instance);
	}

	async focusActiveInstance(): Promise<void> {
		this.focusCalls.push(this.activeInstances[this.activeInstances.length - 1]);
	}
}

function createWorkspaceContextService(folders: readonly URI[]): IWorkspaceContextService {
	return {
		getWorkspace: () => ({ folders: folders.map(uri => ({ uri })) }),
	} as unknown as IWorkspaceContextService;
}

function createService(
	disposables: DisposableStore,
	options: { workspaceFolders?: readonly URI[]; terminalService?: TestTerminalService } = {},
): { service: VSCloneTerminalToolService; terminalService: TestTerminalService } {
	const terminalService = disposables.add(options.terminalService ?? new TestTerminalService());
	const service = disposables.add(new VSCloneTerminalToolService(
		terminalService as unknown as ITerminalService,
		createWorkspaceContextService(options.workspaceFolders ?? [URI.file('/workspace')]),
	));
	return { service, terminalService };
}

suite('VSCloneTerminalToolService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('maps compact persistent terminal IDs to stable user-visible names', () => {
		assert.strictEqual(persistentTerminalNameOfId('1'), 'VSClone Tool Terminal');
		assert.strictEqual(persistentTerminalNameOfId('2'), 'VSClone Tool Terminal (2)');
		assert.strictEqual(idOfPersistentTerminalName('VSClone Tool Terminal'), '1');
		assert.strictEqual(idOfPersistentTerminalName('VSClone Tool Terminal (12)'), '12');
		assert.strictEqual(idOfPersistentTerminalName('VSClone Tool Terminal (0)'), null);
		assert.strictEqual(idOfPersistentTerminalName('unrelated'), null);
	});

	test('adopts existing persistent terminals and forgets them on exit', () => {
		const disposables = store.add(new DisposableStore());
		const existing = disposables.add(new TestTerminalInstance('VSClone Tool Terminal (3)'));
		const terminalService = disposables.add(new TestTerminalService());
		terminalService.instances = [existing as unknown as ITerminalInstance];

		const { service } = createService(disposables, { terminalService });

		assert.deepStrictEqual(service.listPersistentTerminalIds(), ['3']);
		assert.strictEqual(service.getPersistentTerminal('3'), existing as unknown as ITerminalInstance);

		existing.dispose();

		assert.deepStrictEqual(service.listPersistentTerminalIds(), []);
	});

	test('creates persistent terminals with the first free ID and resolves relative cwd against the workspace', async () => {
		const disposables = store.add(new DisposableStore());
		const { service, terminalService } = createService(disposables);
		terminalService.nextTerminal = new TestTerminalInstance('VSClone Tool Terminal');

		const terminalId = await service.createPersistentTerminal({ cwd: 'packages/app' });

		assert.strictEqual(terminalId, '1');
		assert.strictEqual(service.persistentTerminalExists('1'), true);
		assert.strictEqual(terminalService.createdOptions[0].cwd?.toString(), URI.file('/workspace/packages/app').toString());
		assert.deepStrictEqual(terminalService.createdOptions[0].config, {
			name: 'VSClone Tool Terminal',
			forceShellIntegration: true,
			hideFromUser: undefined,
			title: 'VSClone Tool Terminal',
		});
	});

	test('readTerminal returns rendered content without ANSI escapes', async () => {
		const disposables = store.add(new DisposableStore());
		const { service, terminalService } = createService(disposables);
		terminalService.nextTerminal = new TestTerminalInstance('VSClone Tool Terminal');
		const terminalId = await service.createPersistentTerminal({ cwd: null });
		const terminal = service.getPersistentTerminal(terminalId) as TestTerminalInstance;
		terminal.xterm = {
			// The xterm helper iterates from newest to oldest line; readTerminal reverses that back
			// into the prompt order used by tool output.
			getBufferReverseIterator: () => ['\x1b[32msecond\x1b[0m', 'first'],
		};

		assert.strictEqual(await service.readTerminal(terminalId), 'first\nsecond');
	});

	test('runCommand focuses persistent terminals and resolves with command-detection output', async () => {
		const disposables = store.add(new DisposableStore());
		const terminal = disposables.add(new TestTerminalInstance('VSClone Tool Terminal', '\x1b[31mfinished\x1b[0m'));
		const terminalService = disposables.add(new TestTerminalService());
		terminalService.instances = [terminal as unknown as ITerminalInstance];
		const { service } = createService(disposables, { terminalService });

		const execution = await service.runCommand('npm test', { type: 'persistent', persistentTerminalId: '1' });
		const result = await execution.resPromise;

		assert.deepStrictEqual(terminal.sentText, [{ text: 'npm test', addNewLine: true }]);
		assert.strictEqual(terminalService.activeInstances[0], terminal as unknown as ITerminalInstance);
		assert.deepStrictEqual(result, {
			result: 'finished',
			resolveReason: { type: 'done', exitCode: 7 },
		});
	});

	test('runCommand creates hidden temporary terminals and disposes them after successful completion', async () => {
		const disposables = store.add(new DisposableStore());
		const { service, terminalService } = createService(disposables);
		const terminal = disposables.add(new TestTerminalInstance('temp', 'hello'));
		terminalService.nextTerminal = terminal;

		const execution = await service.runCommand('echo hello', { type: 'temporary', cwd: '/tmp', terminalId: 'tmp-1' });
		assert.strictEqual(service.getTemporaryTerminal('tmp-1'), terminal as unknown as ITerminalInstance);

		const result = await execution.resPromise;

		assert.strictEqual(service.getTemporaryTerminal('tmp-1'), undefined);
		assert.strictEqual(terminalService.createdOptions[0].config?.hideFromUser, true);
		assert.strictEqual(terminalService.createdOptions[0].cwd?.toString(), URI.file('/tmp').toString());
		assert.deepStrictEqual(result, {
			result: '$ echo hello\nhello',
			resolveReason: { type: 'done', exitCode: 7 },
		});
	});
});
