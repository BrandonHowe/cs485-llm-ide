/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { removeAnsiEscapeCodes } from '../../../../base/common/strings.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { TerminalCapability, type ITerminalCapabilityImplMap } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { type ICreateTerminalOptions, type ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { VSCloneTerminalResolveReason } from '../common/vscloneToolRuntimeTypes.js';

const MAX_TERMINAL_CHARS = 100_000;
const MAX_TERMINAL_INACTIVE_TIME_SECONDS = 8;
const MAX_TERMINAL_BG_COMMAND_TIME_SECONDS = 5;

export interface IVSCloneTerminalToolService {
	readonly _serviceBrand: undefined;
	listPersistentTerminalIds(): string[];
	runCommand(command: string, opts:
		| { readonly type: 'persistent'; readonly persistentTerminalId: string }
		| { readonly type: 'temporary'; readonly cwd: string | null; readonly terminalId: string },
	): Promise<{ interrupt: () => void; resPromise: Promise<{ result: string; resolveReason: VSCloneTerminalResolveReason }> }>;
	focusPersistentTerminal(terminalId: string): Promise<void>;
	persistentTerminalExists(terminalId: string): boolean;
	readTerminal(terminalId: string): Promise<string>;
	createPersistentTerminal(opts: { cwd: string | null }): Promise<string>;
	killPersistentTerminal(terminalId: string): Promise<void>;
	getPersistentTerminal(terminalId: string): ITerminalInstance | undefined;
	getTemporaryTerminal(terminalId: string): ITerminalInstance | undefined;
}

export const IVSCloneTerminalToolService = createDecorator<IVSCloneTerminalToolService>('vscloneTerminalToolService');

/**
 * Persistent terminal IDs are intentionally tiny so the model can refer to them without copying a
 * long workspace path or terminal title into the prompt.
 */
export const persistentTerminalNameOfId = (id: string): string => {
	if (id === '1') {
		return 'VSClone Tool Terminal';
	}
	return `VSClone Tool Terminal (${id})`;
};

export const idOfPersistentTerminalName = (name: string): string | null => {
	if (name === 'VSClone Tool Terminal') {
		return '1';
	}

	const match = name.match(/VSClone Tool Terminal \((\d+)\)/);
	if (!match) {
		return null;
	}

	const parsedId = Number.parseInt(match[1], 10);
	if (!Number.isInteger(parsedId) || parsedId < 1) {
		return null;
	}

	return String(parsedId);
};

export class VSCloneTerminalToolService extends Disposable implements IVSCloneTerminalToolService {
	declare readonly _serviceBrand: undefined;

	private readonly persistentTerminalInstanceOfId: Record<string, ITerminalInstance> = Object.create(null);
	private readonly temporaryTerminalInstanceOfId: Record<string, ITerminalInstance> = Object.create(null);

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();

		const initializeTerminal = (terminal: ITerminalInstance) => {
			// Persistent terminals can be reopened across tool calls, so the service keeps a small
			// ID map keyed by the human-readable title. Temp terminals are tracked separately because
			// they are created per command and discarded once the command resolves.
			const exitListener = terminal.onExit(() => {
				const terminalId = idOfPersistentTerminalName(terminal.title);
				if (terminalId !== null) {
					delete this.persistentTerminalInstanceOfId[terminalId];
				}
				exitListener.dispose();
			});
		};

		for (const terminal of terminalService.instances) {
			const terminalId = idOfPersistentTerminalName(terminal.title);
			if (terminalId !== null) {
				this.persistentTerminalInstanceOfId[terminalId] = terminal;
			}
			initializeTerminal(terminal);
		}

		this._register(this.terminalService.onDidCreateInstance(terminal => initializeTerminal(terminal)));
	}

	listPersistentTerminalIds(): string[] {
		return Object.keys(this.persistentTerminalInstanceOfId);
	}

	getValidNewTerminalId(): string {
		const existingIds = new Set(this.listPersistentTerminalIds());
		for (let index = 1; index <= existingIds.size + 1; index++) {
			const candidate = String(index);
			if (!existingIds.has(candidate)) {
				return candidate;
			}
		}
		throw new Error('Unable to allocate a persistent terminal identifier.');
	}

	async createPersistentTerminal(opts: { cwd: string | null }): Promise<string> {
		const terminalId = this.getValidNewTerminalId();
		const config = { name: persistentTerminalNameOfId(terminalId), title: persistentTerminalNameOfId(terminalId) };
		const terminal = await this.createTerminal({ cwd: opts.cwd, config });
		this.persistentTerminalInstanceOfId[terminalId] = terminal;
		return terminalId;
	}

	async killPersistentTerminal(terminalId: string): Promise<void> {
		const terminal = this.persistentTerminalInstanceOfId[terminalId];
		if (!terminal) {
			throw new Error(`Kill Terminal: Terminal with ID ${terminalId} did not exist.`);
		}
		terminal.dispose();
		delete this.persistentTerminalInstanceOfId[terminalId];
	}

	persistentTerminalExists(terminalId: string): boolean {
		return this.persistentTerminalInstanceOfId[terminalId] !== undefined;
	}

	getPersistentTerminal(terminalId: string): ITerminalInstance | undefined {
		return this.persistentTerminalInstanceOfId[terminalId];
	}

	getTemporaryTerminal(terminalId: string): ITerminalInstance | undefined {
		return this.temporaryTerminalInstanceOfId[terminalId];
	}

	async focusPersistentTerminal(terminalId: string): Promise<void> {
		const terminal = this.persistentTerminalInstanceOfId[terminalId];
		if (!terminal) {
			return;
		}
		this.terminalService.setActiveInstance(terminal);
		await this.terminalService.focusActiveInstance();
	}

	async readTerminal(terminalId: string): Promise<string> {
		const terminal = this.getPersistentTerminal(terminalId) ?? this.getTemporaryTerminal(terminalId);
		if (!terminal) {
			throw new Error(`Read Terminal: Terminal with ID ${terminalId} does not exist.`);
		}
		if (!terminal.xterm) {
			throw new Error('Read Terminal: The terminal has not rendered yet, so no buffer is available.');
		}

		const lines: string[] = [];
		for (const line of terminal.xterm.getBufferReverseIterator()) {
			lines.unshift(line);
		}

		let result = removeAnsiEscapeCodes(lines.join('\n'));
		if (result.length > MAX_TERMINAL_CHARS) {
			const half = Math.floor(MAX_TERMINAL_CHARS / 2);
			result = `${result.slice(0, half)}\n...\n${result.slice(result.length - half)}`;
		}

		return result;
	}

	async runCommand(
		command: string,
		opts: { type: 'persistent'; persistentTerminalId: string } | { type: 'temporary'; cwd: string | null; terminalId: string },
	): Promise<{ interrupt: () => void; resPromise: Promise<{ result: string; resolveReason: VSCloneTerminalResolveReason }> }> {
		await this.terminalService.whenConnected;

		const isPersistent = opts.type === 'persistent';
		let terminal: ITerminalInstance;
		const disposables: IDisposable[] = [];

		if (isPersistent) {
			terminal = this.persistentTerminalInstanceOfId[opts.persistentTerminalId];
			if (!terminal) {
				throw new Error(`Unexpected internal error: Terminal with ID ${opts.persistentTerminalId} did not exist.`);
			}
		} else {
			terminal = await this.createTerminal({ cwd: opts.cwd, hidden: true });
			this.temporaryTerminalInstanceOfId[opts.terminalId] = terminal;
		}

		const interrupt = () => {
			terminal.dispose();
			if (isPersistent) {
				delete this.persistentTerminalInstanceOfId[opts.persistentTerminalId];
			} else {
				delete this.temporaryTerminalInstanceOfId[opts.terminalId];
			}
		};

		const waitForResult = async () => {
			if (isPersistent) {
				this.terminalService.setActiveInstance(terminal);
				await this.terminalService.focusActiveInstance();
			}

			let result = '';
			let resolveReason: VSCloneTerminalResolveReason | undefined;

			const commandDetection = await this.waitForCommandDetectionCapability(terminal);
			const waitUntilDone = new Promise<void>(resolve => {
				if (!commandDetection) {
					return;
				}

				const listener = commandDetection.onCommandFinished(commandInfo => {
					if (resolveReason) {
						return;
					}
					resolveReason = { type: 'done', exitCode: commandInfo.exitCode ?? 0 };
					result = commandInfo.getOutput() ?? '';
					listener.dispose();
					resolve();
				});
				disposables.push(listener);
			});

			await terminal.sendText(command, true);

			const waitUntilInterrupt = isPersistent
				? new Promise<void>(resolve => {
					setTimeout(() => {
						resolveReason = { type: 'timeout' };
						resolve();
					}, MAX_TERMINAL_BG_COMMAND_TIME_SECONDS * 1000);
				})
				: new Promise<void>(resolve => {
					let inactivityTimeout: ReturnType<typeof setTimeout>;
					const resetTimer = () => {
						clearTimeout(inactivityTimeout);
						inactivityTimeout = setTimeout(() => {
							if (resolveReason) {
								return;
							}
							resolveReason = { type: 'timeout' };
							resolve();
						}, MAX_TERMINAL_INACTIVE_TIME_SECONDS * 1000);
					};

					const dataListener = terminal.onData(() => resetTimer());
					disposables.push(dataListener, toDisposable(() => clearTimeout(inactivityTimeout)));
					resetTimer();
				});

			await Promise.any([waitUntilDone, waitUntilInterrupt]).finally(() => {
				for (const disposable of disposables) {
					disposable.dispose();
				}
			});

			if (resolveReason?.type === 'timeout') {
				const terminalId = isPersistent ? opts.persistentTerminalId : opts.terminalId;
				result = await this.readTerminal(terminalId);
			}

			if (!isPersistent) {
				interrupt();
			}

			if (!resolveReason) {
				throw new Error('Unexpected internal error: terminal execution resolved without a reason.');
			}

			if (!isPersistent) {
				result = `$ ${command}\n${result}`;
			}

			result = removeAnsiEscapeCodes(result);
			if (result.length > MAX_TERMINAL_CHARS) {
				const half = Math.floor(MAX_TERMINAL_CHARS / 2);
				result = `${result.slice(0, half)}\n...\n${result.slice(result.length - half)}`;
			}

			return { result, resolveReason };
		};

		return {
			interrupt,
			resPromise: waitForResult(),
		};
	}

	private async createTerminal(props: { cwd: string | null; config?: ICreateTerminalOptions['config']; hidden?: boolean }): Promise<ITerminalInstance> {
		const cwd = this.resolveCwd(props.cwd);
		const options: ICreateTerminalOptions = {
			cwd,
			location: props.hidden ? undefined : TerminalLocation.Panel,
			config: {
				name: props.config?.name,
				forceShellIntegration: true,
				hideFromUser: props.hidden ? true : undefined,
				...props.config,
			},
			skipContributedProfileCheck: true,
		};

		return this.terminalService.createTerminal(options);
	}

	private resolveCwd(rawCwd: string | null): URI | string | undefined {
		if (!rawCwd) {
			return this.workspaceContextService.getWorkspace().folders[0]?.uri;
		}

		if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(rawCwd)) {
			try {
				return URI.parse(rawCwd);
			} catch {
				return rawCwd;
			}
		}

		if (rawCwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawCwd)) {
			return URI.file(rawCwd);
		}

		const workspaceRoot = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		return workspaceRoot ? joinPath(workspaceRoot, rawCwd) : rawCwd;
	}

	private async waitForCommandDetectionCapability(terminal: ITerminalInstance) {
		const currentCapability = terminal.capabilities.get(TerminalCapability.CommandDetection);
		if (currentCapability) {
			return currentCapability;
		}

		const disposables: IDisposable[] = [];
		const waitTimeout = timeout(10_000);
		const waitForCapability = new Promise<ITerminalCapabilityImplMap[TerminalCapability.CommandDetection]>(resolve => {
			disposables.push(
				terminal.capabilities.onDidAddCapability(event => {
					if (event.id === TerminalCapability.CommandDetection) {
						resolve(event.capability);
					}
				}),
			);
		});

		const capability = await Promise.any([waitTimeout, waitForCapability]).finally(() => {
			for (const disposable of disposables) {
				disposable.dispose();
			}
		});

		return capability ?? undefined;
	}
}
