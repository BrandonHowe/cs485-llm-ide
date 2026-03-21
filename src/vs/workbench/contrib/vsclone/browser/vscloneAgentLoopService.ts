/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IVSCloneApiRequestHandle, IVSCloneChatApiService } from './vscloneChatApiService.js';
import { IVSCloneChatHistoryService } from '../common/backend/vscloneChatHistoryService.js';
import type { VSCloneReasoningEffortLevel } from '../common/vscloneModelCatalogService.js';
import { VSCloneModelVendor } from '../common/vscloneOAuthTypes.js';
import { type VSCloneChatMode } from '../common/vsclonePlanModeTypes.js';
import { sanitizeAgentModelOutput } from '../common/vscloneAgentTranscriptSanitizer.js';
import { formatToolResult } from '../common/vscloneToolDefinitions.js';
import { parseToolCalls } from '../common/vscloneToolCallParser.js';
import { IVSCloneToolExecutionService } from './vscloneToolExecutionService.js';

const maxAgentIterations = 25;
const maxToolUsageReprompts = 2;

export const IVSCloneAgentLoopService = createDecorator<IVSCloneAgentLoopService>('vscloneAgentLoopService');

export interface IVSCloneAgentLoopService {
	readonly _serviceBrand: undefined;
	runAgentLoop(options: IVSCloneAgentLoopOptions): IVSCloneAgentLoopHandle;
}

export interface IVSCloneAgentLoopOptions {
	readonly threadId: string;
	readonly turnId: string;
	readonly sequence: number;
	readonly sessionResource: string;
	readonly promptText: string;
	readonly mode: VSCloneChatMode;
	readonly vendor: VSCloneModelVendor;
	readonly modelId: string;
	readonly modelIdentifier: string;
	readonly reasoningEffort?: VSCloneReasoningEffortLevel;
	readonly previousTurns?: readonly { role: 'user' | 'assistant'; content: string }[];
	readonly systemMessage?: string;
}

export interface IVSCloneAgentLoopHandle {
	readonly done: Promise<void>;
	cancel(): void;
}

interface ILoopState {
	cancelled: boolean;
	finished: boolean;
	activeRequest: IVSCloneApiRequestHandle | undefined;
}

interface ILoopMessage {
	readonly role: 'user' | 'assistant';
	readonly content: string;
}

interface ILoopIterationResult {
	readonly responseText: string;
	readonly errorMessage?: string;
	readonly aborted: boolean;
}

type VSCloneAgentTraceType = 'thinking' | 'tool' | 'tool_result';
type VSCloneAgentTraceStatus = 'start' | 'success' | 'error';

export class VSCloneAgentLoopService extends Disposable implements IVSCloneAgentLoopService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IVSCloneChatApiService private readonly apiService: IVSCloneChatApiService,
		@IVSCloneToolExecutionService private readonly toolExecutionService: IVSCloneToolExecutionService,
		@IVSCloneChatHistoryService private readonly historyService: IVSCloneChatHistoryService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	runAgentLoop(options: IVSCloneAgentLoopOptions): IVSCloneAgentLoopHandle {
		const done = new DeferredPromise<void>();
		const state: ILoopState = {
			cancelled: false,
			finished: false,
			activeRequest: undefined,
		};

		void this.runLoop(options, state).then(() => {
			done.complete();
		}).catch(error => {
			this.logService.error('[VSCloneAgentLoop] Unhandled loop failure', error);
			done.complete();
		});

		return {
			done: done.p,
			cancel: () => {
				if (state.cancelled || state.finished) {
					return;
				}
				state.cancelled = true;
				state.activeRequest?.cancel();
			},
		};
	}

	private async runLoop(options: IVSCloneAgentLoopOptions, state: ILoopState): Promise<void> {
		this.logTrace('info', `Starting agent loop for thread ${options.threadId} (turn ${options.turnId})`);
		this.historyService.applyTurnUpdate({
			threadId: options.threadId,
			turnId: options.turnId,
			sequence: options.sequence,
			sessionResource: options.sessionResource,
			phase: 'prompt',
			occurredAt: Date.now(),
			promptText: options.promptText,
			executionMode: options.mode,
			modelIdentifier: options.modelIdentifier,
			providerId: options.vendor,
		});

		const messages: ILoopMessage[] = [...(options.previousTurns ?? []), { role: 'user', content: options.promptText }];
		let toolUsageRepromptCount = 0;
		for (let iteration = 1; iteration <= maxAgentIterations; iteration++) {
			this.logTrace('debug', `Agent iteration ${iteration} for thread ${options.threadId}`);
			if (state.cancelled) {
				this.applyCancel(options, state);
				return;
			}

			if (iteration > 1) {
				this.appendAssistantDelta(options, `\n\n---\n[Agent iteration ${iteration}]\n`);
			}

			// Each model iteration streams raw text into the turn before we know whether the model
			// obeyed the tool protocol. Capture the transcript prefix now so we can replace only this
			// iteration's segment with a sanitized version once the model finishes.
			const responsePrefix = this.getCurrentTurnResponseText(options.threadId, options.turnId);
			const iterationResult = await this.runModelIteration(options, messages, state);
			if (iterationResult.errorMessage) {
				this.applyError(options, state, iterationResult.errorMessage);
				return;
			}
			if (state.cancelled || iterationResult.aborted) {
				this.applyCancel(options, state);
				return;
			}

			const sanitizedIteration = sanitizeAgentModelOutput(iterationResult.responseText);
			if (sanitizedIteration.sanitizedText !== iterationResult.responseText) {
				this.replaceCurrentIterationTranscript(options, responsePrefix, sanitizedIteration.sanitizedText);
				const sanitizerEffects: string[] = [];
				if (sanitizedIteration.removedFakeToolResults) {
					sanitizerEffects.push('removed fabricated tool_result blocks');
				}
				if (sanitizedIteration.truncatedAfterAttemptCompletion) {
					sanitizerEffects.push('dropped prose after attempt_completion');
				}
				this.logTrace('warn', `Sanitized invalid model tool transcript for thread ${options.threadId}: ${sanitizerEffects.join(', ')}`);
			}

			const parsedCalls = parseToolCalls(sanitizedIteration.sanitizedText);
			if (parsedCalls.toolCalls.length === 0) {
				if (this.shouldRepromptForToolUse(options.promptText, sanitizedIteration.sanitizedText, toolUsageRepromptCount)) {
					toolUsageRepromptCount += 1;
					const reprompt = this.createToolUsageReprompt(options.mode);
					this.emitAgentTrace(
						options,
						'thinking',
						options.mode === 'plan'
							? 'I already have read-only workspace tool access, so I will inspect the codebase instead of asking the user for files.'
							: 'I already have workspace tool access, so I will proceed by calling tools instead of asking the user for file access.',
					);
					this.logTrace('warn', 'Model responded without tool calls for a file-operation prompt; sending corrective tool-usage reprompt.');
					messages.push({ role: 'assistant', content: sanitizedIteration.sanitizedText });
					messages.push({ role: 'user', content: reprompt });
					continue;
				}
				this.applyComplete(options, state);
				return;
			}

			const toolResults: string[] = [];
			for (const toolCall of parsedCalls.toolCalls) {
				if (state.cancelled) {
					this.applyCancel(options, state);
					return;
				}

				const thinkingTrace = this.describeToolThinkingTrace(toolCall.name, toolCall.params, options.mode);
				if (thinkingTrace) {
					this.emitAgentTrace(options, 'thinking', thinkingTrace);
				}
				const toolAttemptTrace = this.describeToolAttemptTrace(toolCall.name, toolCall.params);
				this.emitAgentTrace(options, 'tool', toolAttemptTrace, 'start');
				this.logTrace('info', `[Tool Attempt] ${toolAttemptTrace}`);
				const toolResult = await this.toolExecutionService.executeTool(toolCall.name, toolCall.params, options.mode);
				const formattedToolResult = formatToolResult(toolCall.name, toolResult);
				toolResults.push(formattedToolResult);
				const toolResultTrace = this.describeToolResultTrace(toolCall.name, toolResult.success);
				this.emitAgentTrace(options, 'tool_result', toolResultTrace, toolResult.success ? 'success' : 'error');
				this.logTrace(toolResult.success ? 'info' : 'warn', `[Tool Result] ${toolResultTrace}`);
				this.appendAssistantDelta(options, `\n${formattedToolResult}\n`);

				if (toolCall.name === 'attempt_completion') {
					this.applyComplete(options, state);
					return;
				}
			}

			messages.push({ role: 'assistant', content: sanitizedIteration.sanitizedText });
			messages.push({ role: 'user', content: toolResults.join('\n\n') });
		}

		this.applyError(options, state, `Agent loop exceeded the safety limit of ${maxAgentIterations} iterations.`);
	}

	private async runModelIteration(options: IVSCloneAgentLoopOptions, messages: readonly ILoopMessage[], state: ILoopState): Promise<ILoopIterationResult> {
		const lastMessage = messages.at(-1);
		if (!lastMessage || lastMessage.role !== 'user') {
			return {
				responseText: '',
				errorMessage: 'Agent loop requires a user message before each model call.',
				aborted: false,
			};
		}

		let responseText = '';
		let errorMessage: string | undefined;
		let aborted = false;

		const request = this.apiService.submitApiPromptForAgentLoop({
			threadId: options.threadId,
			turnId: options.turnId,
			sequence: options.sequence,
			sessionResource: options.sessionResource,
			promptText: lastMessage.content,
			vendor: options.vendor,
			modelId: options.modelId,
			modelIdentifier: options.modelIdentifier,
			reasoningEffort: options.reasoningEffort,
			previousTurns: messages.slice(0, -1),
			systemMessage: options.systemMessage,
		}, {
			onDelta: delta => {
				responseText += delta;
				this.appendAssistantDelta(options, delta);
			},
			onError: message => {
				errorMessage = message;
			},
			onAborted: () => {
				aborted = true;
			},
		});

		state.activeRequest = request;
		await request.done;
		state.activeRequest = undefined;

		return {
			responseText,
			errorMessage,
			aborted,
		};
	}

	private appendAssistantDelta(options: IVSCloneAgentLoopOptions, delta: string): void {
		if (!delta) {
			return;
		}

		this.historyService.applyTurnUpdate({
			threadId: options.threadId,
			turnId: options.turnId,
			sequence: options.sequence,
			sessionResource: options.sessionResource,
			phase: 'stream',
			occurredAt: Date.now(),
			promptText: options.promptText,
			executionMode: options.mode,
			modelIdentifier: options.modelIdentifier,
			providerId: options.vendor,
			responsePlainTextDelta: delta,
			responseMarkdownDelta: delta,
		});
	}

	/**
	 * The history reducer stores one flat assistant transcript per turn, so post-iteration cleanup
	 * has to rewrite the whole transcript rather than patching a substring in place. We rebuild the
	 * current response from the stable prefix plus the sanitized iteration text before any canonical
	 * trace/result records for the next step are appended.
	 */
	private replaceCurrentIterationTranscript(options: IVSCloneAgentLoopOptions, responsePrefix: string, sanitizedIterationText: string): void {
		this.historyService.applyTurnUpdate({
			threadId: options.threadId,
			turnId: options.turnId,
			sequence: options.sequence,
			sessionResource: options.sessionResource,
			phase: 'stream',
			occurredAt: Date.now(),
			promptText: options.promptText,
			executionMode: options.mode,
			modelIdentifier: options.modelIdentifier,
			providerId: options.vendor,
			responsePlainTextReplace: `${responsePrefix}${sanitizedIterationText}`,
			responseMarkdownReplace: `${responsePrefix}${sanitizedIterationText}`,
		});
	}

	private getCurrentTurnResponseText(threadId: string, turnId: string): string {
		const currentTurn = this.historyService.getTurns(threadId).find(turn => turn.turnId === turnId);
		return currentTurn ? (currentTurn.responsePlainText || currentTurn.responseMarkdown) : '';
	}

	private applyComplete(options: IVSCloneAgentLoopOptions, state: ILoopState): void {
		if (state.finished) {
			return;
		}
		state.finished = true;
		this.logTrace('info', `Agent loop completed for thread ${options.threadId} (turn ${options.turnId})`);
		this.historyService.applyTurnUpdate({
			threadId: options.threadId,
			turnId: options.turnId,
			sequence: options.sequence,
			sessionResource: options.sessionResource,
			phase: 'complete',
			occurredAt: Date.now(),
			promptText: options.promptText,
			executionMode: options.mode,
			modelIdentifier: options.modelIdentifier,
			providerId: options.vendor,
		});
	}

	private applyError(options: IVSCloneAgentLoopOptions, state: ILoopState, message: string): void {
		if (state.finished) {
			return;
		}
		state.finished = true;
		this.logTrace('error', `Agent loop failed for thread ${options.threadId}: ${message}`);
		this.historyService.applyTurnUpdate({
			threadId: options.threadId,
			turnId: options.turnId,
			sequence: options.sequence,
			sessionResource: options.sessionResource,
			phase: 'error',
			occurredAt: Date.now(),
			promptText: options.promptText,
			executionMode: options.mode,
			errorCode: 'api_error',
			modelIdentifier: options.modelIdentifier,
			providerId: options.vendor,
			responsePlainTextReplace: message,
			responseMarkdownReplace: message,
		});
	}

	private applyCancel(options: IVSCloneAgentLoopOptions, state: ILoopState): void {
		if (state.finished) {
			return;
		}
		state.finished = true;
		this.logTrace('info', `Agent loop cancelled for thread ${options.threadId} (turn ${options.turnId})`);
		this.historyService.applyTurnUpdate({
			threadId: options.threadId,
			turnId: options.turnId,
			sequence: options.sequence,
			sessionResource: options.sessionResource,
			phase: 'cancel',
			occurredAt: Date.now(),
			promptText: options.promptText,
			executionMode: options.mode,
			modelIdentifier: options.modelIdentifier,
			providerId: options.vendor,
		});
	}

	/**
	 * Tool traces are emitted as explicit XML markers so the UI can style them as lightweight
	 * activity logs without mixing them into model-authored prose.
	 */
	private emitAgentTrace(
		options: IVSCloneAgentLoopOptions,
		type: VSCloneAgentTraceType,
		message: string,
		status?: VSCloneAgentTraceStatus,
	): void {
		const statusAttribute = status ? ` status="${escapeXmlAttribute(status)}"` : '';
		const tracePayload = `<agent_trace type="${escapeXmlAttribute(type)}"${statusAttribute}>${escapeXmlText(message)}</agent_trace>`;
		this.appendAssistantDelta(options, `\n${tracePayload}\n`);
	}

	private describeToolThinkingTrace(toolName: string, params: Record<string, string>, mode: VSCloneChatMode): string {
		switch (toolName) {
			case 'read_file':
				return `I will inspect ${formatPathForTrace(params.path)} before making changes.`;
			case 'list_directory':
				return `I need to scan ${formatPathForTrace(params.path)} to understand the project structure.`;
			case 'search_files':
				return `I will search ${formatPathForTrace(params.path)} for ${formatPatternForTrace(params.pattern)} to locate relevant code.`;
			case 'edit_file':
				return `I will apply targeted SEARCH/REPLACE edits in ${formatPathForTrace(params.path)}.`;
			case 'create_file':
				return `I will create ${formatPathForTrace(params.path)} with the requested content.`;
			case 'attempt_completion':
				return mode === 'plan'
					? 'I have enough context and will finalize the implementation plan summary.'
					: 'I have enough context and will finalize the task summary.';
			default:
				return `I will run ${toolName} to continue.`;
		}
	}

	private describeToolAttemptTrace(toolName: string, params: Record<string, string>): string {
		switch (toolName) {
			case 'read_file':
				return `Read ${formatPathForTrace(params.path)}`;
			case 'list_directory':
				return `Listed ${formatPathForTrace(params.path)}${toBoolean(params.recursive) ? ' (recursive)' : ''}`;
			case 'search_files': {
				const globSuffix = params.file_glob ? ` with glob ${params.file_glob}` : '';
				return `Searched ${formatPathForTrace(params.path)} for ${formatPatternForTrace(params.pattern)}${globSuffix}`;
			}
			case 'edit_file':
				return `Edited ${formatPathForTrace(params.path)}`;
			case 'create_file':
				return `Created ${formatPathForTrace(params.path)}`;
			case 'attempt_completion':
				// The structured tool_result already carries the full completion markdown for the UI.
				return 'Attempted completion';
			default:
				return `Executed ${toolName}`;
		}
	}

	private describeToolResultTrace(toolName: string, success: boolean): string {
		const statusLabel = success ? 'succeeded' : 'failed';
		return `${toolName} ${statusLabel}`;
	}

	private shouldRepromptForToolUse(promptText: string, responseText: string, currentRepromptCount: number): boolean {
		if (currentRepromptCount >= maxToolUsageReprompts) {
			return false;
		}

		const requiresWorkspaceMutation = /\b(edit|change|update|modify|fix|add|remove|create|delete|rename|refactor|implement)\b/i.test(promptText);
		const requiresWorkspaceInspection = /\b(read|search|find|list|inspect|scan|look at|analy[sz]e|summari[sz]e)\b/i.test(promptText)
			&& /\b(file|folder|directory|project|repo|code|codebase|app)\b/i.test(promptText);
		const requestsManualAccess = /(please|can you|could you).*(open|share|provide|send|allow|paste).*(file|contents?|code|path)/i.test(responseText)
			|| /(cannot|can't|unable|need to).*(access|read|see).*(file|code|project)/i.test(responseText)
			|| /after checking the file/i.test(responseText);

		return requiresWorkspaceMutation || (requiresWorkspaceInspection && requestsManualAccess);
	}

	private createToolUsageReprompt(mode: VSCloneChatMode): string {
		if (mode === 'plan') {
			// Plan mode keeps the same corrective pressure as act mode, but redirects it toward
			// read-only inspection so "please fix X" prompts still produce researched plans.
			return [
				'System reminder: you already have direct read-only workspace tool access.',
				'Do not ask the user to open/share/provide files.',
				'Use the available XML tools now (read_file, list_directory, search_files, attempt_completion).',
				'Do not edit or create files in plan mode.',
				'Inspect the codebase first, then call attempt_completion with your plan.',
			].join(' ');
		}

		return [
			'System reminder: you already have direct workspace tool access.',
			'Do not ask the user to open/share/provide files.',
			'Use the available XML tools now (read_file, list_directory, search_files, edit_file, create_file), then continue.',
			'When complete, call attempt_completion.',
		].join(' ');
	}

	private logTrace(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
		const formatted = `[VSCloneAgentLoop] ${message}`;
		switch (level) {
			case 'debug':
				this.logService.debug(formatted);
				console.debug(formatted);
				break;
			case 'info':
				this.logService.info(formatted);
				console.info(formatted);
				break;
			case 'warn':
				this.logService.warn(formatted);
				console.warn(formatted);
				break;
			case 'error':
				this.logService.error(formatted);
				console.error(formatted);
				break;
		}
	}
}

function formatPathForTrace(value: string | undefined): string {
	return value?.trim() ? value.trim() : '(missing path)';
}

function formatPatternForTrace(value: string | undefined): string {
	return value?.trim() ? `/${value.trim()}/` : '(missing pattern)';
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function escapeXmlText(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function toBoolean(value: string | undefined): boolean {
	if (!value) {
		return false;
	}
	const normalized = value.trim().toLowerCase();
	return normalized === 'true' || normalized === '1' || normalized === 'yes';
}
