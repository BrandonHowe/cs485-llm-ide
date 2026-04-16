/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, raceTimeout } from '../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IVSCloneApiRequestHandle, IVSCloneChatApiService } from './vscloneChatApiService.js';
import type { IVSCloneApiConversationMessage } from '../common/vscloneChatApiAdapters.js';
import type { VSCloneReasoningEffortLevel } from '../common/vscloneModelCatalogService.js';
import { type VSCloneModelVendor } from '../common/vscloneOAuthTypes.js';
import { type VSCloneChatMode } from '../common/vsclonePlanModeTypes.js';
import { sanitizeAgentModelOutput } from '../common/vscloneAgentTranscriptSanitizer.js';
import { formatToolResult } from '../common/vscloneToolDefinitions.js';
import { parseToolCalls } from '../common/vscloneToolCallParser.js';
import type { IVSCloneImageAttachment } from '../common/vscloneImageAttachmentTypes.js';
import type { VSCloneThreadToolApprovalDecision } from '../common/vscloneThreadRuntimeTypes.js';
import { IVSCloneToolExecutionResult, IVSCloneToolExecutionService } from './vscloneToolExecutionService.js';

const maxAgentIterations = 25;
const maxToolUsageReprompts = 2;
// Tools that legitimately take a long time (large search, large edit) should still finish well
// under this cap. Anything beyond it is treated as a hung call so the agent loop can recover
// instead of leaving the chat permanently stuck on a single tool invocation.
const toolExecutionTimeoutMs = 90_000;

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
	readonly previousTurns?: readonly IVSCloneApiConversationMessage[];
	readonly systemMessage?: string;
	readonly imageAttachments?: readonly IVSCloneImageAttachment[];
	readonly observer?: IVSCloneAgentLoopObserver;
}

export interface IVSCloneAgentLoopObserver {
	readonly onResponseDelta?: (delta: string) => void;
	readonly onResponseReplace?: (responseText: string) => void;
	readonly onToolRequested?: (toolName: string, params: Record<string, string>) => VSCloneThreadToolApprovalDecision | Promise<VSCloneThreadToolApprovalDecision>;
	readonly onToolResult?: (toolName: string, params: Record<string, string>, result: IVSCloneToolExecutionResult) => void;
	readonly onComplete?: () => void;
	readonly onError?: (message: string) => void;
	readonly onCancel?: () => void;
}

export interface IVSCloneAgentLoopHandle {
	readonly done: Promise<void>;
	cancel(): void;
}

interface ILoopState {
	cancelled: boolean;
	finished: boolean;
	activeRequest: IVSCloneApiRequestHandle | undefined;
	activeToolTokenSource: CancellationTokenSource | undefined;
}

interface ILoopMessage {
	readonly role: 'user' | 'assistant';
	readonly content: string;
	readonly imageAttachments?: readonly IVSCloneImageAttachment[];
}

interface ILoopIterationResult {
	readonly responseText: string;
	readonly responseTranscriptText: string;
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
			activeToolTokenSource: undefined,
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
				// Cancel both the streaming API request and any in-flight tool execution. Without
				// the latter, pressing Stop while a tool is running would do nothing because the
				// active request handle is undefined during tool execution.
				state.activeRequest?.cancel();
				state.activeToolTokenSource?.cancel();
			},
		};
	}

	private async runLoop(options: IVSCloneAgentLoopOptions, state: ILoopState): Promise<void> {
		this.logTrace('info', `Starting agent loop for thread ${options.threadId} (turn ${options.turnId})`);
		const messages: ILoopMessage[] = [
			...(options.previousTurns ?? []),
			{
				role: 'user',
				content: options.promptText,
				imageAttachments: options.imageAttachments,
			},
		];
		let assistantResponseText = '';
		let toolUsageRepromptCount = 0;
		for (let iteration = 1; iteration <= maxAgentIterations; iteration++) {
			this.logTrace('debug', `Agent iteration ${iteration} for thread ${options.threadId}`);
			if (state.cancelled) {
				this.applyCancel(options, state);
				return;
			}

			if (iteration > 1) {
				assistantResponseText = this.appendAssistantDelta(options, assistantResponseText, `\n\n---\n[Agent iteration ${iteration}]\n`);
			}

			// Each model iteration streams raw text into the turn before we know whether the model
			// obeyed the tool protocol. Capture the transcript prefix now so we can replace only this
			// iteration's segment with a sanitized version once the model finishes.
			const responsePrefix = assistantResponseText;
			const iterationResult = await this.runModelIteration(options, messages, state);
			// The runtime observer receives streaming deltas incrementally, so the loop keeps its own
			// flat transcript buffer in sync by appending the latest iteration text to the stable
			// prefix. Without this, the second iteration would accidentally forget everything that
			// streamed before it, and later sanitizer replacements would rewrite against the wrong base.
			assistantResponseText = `${responsePrefix}${iterationResult.responseTranscriptText}`;
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
				assistantResponseText = this.replaceCurrentIterationTranscript(options, responsePrefix, sanitizedIteration.sanitizedText);
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
					assistantResponseText = this.appendAssistantDelta(options, assistantResponseText, this.emitAgentTrace(
						options,
						'thinking',
						options.mode === 'plan'
							? 'I already have read-only workspace tool access, so I will inspect the codebase instead of asking the user for files.'
							: 'I already have workspace tool access, so I will proceed by calling tools instead of asking the user for file access.',
					));
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
					assistantResponseText = this.appendAssistantDelta(options, assistantResponseText, this.emitAgentTrace(options, 'thinking', thinkingTrace));
				}
				let approvalDecision: VSCloneThreadToolApprovalDecision | undefined;
				try {
					approvalDecision = await options.observer?.onToolRequested?.(toolCall.name, toolCall.params);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					this.applyError(options, state, `Tool approval failed for ${toolCall.name}: ${message}`);
					return;
				}
				if (state.cancelled) {
					this.applyCancel(options, state);
					return;
				}
				const toolAttemptTrace = this.describeToolAttemptTrace(toolCall.name, toolCall.params);
				assistantResponseText = this.appendAssistantDelta(options, assistantResponseText, this.emitAgentTrace(options, 'tool', toolAttemptTrace, 'start'));
				this.logTrace('info', `[Tool Attempt] ${toolAttemptTrace}`);
				// Rejections stay on the normal tool-result rail so the model can react to denied
				// access the same way it reacts to any other tool failure. Explicit user cancel still
				// wins because `state.cancelled` is checked above immediately after approval resumes.
				const toolResult = approvalDecision?.kind === 'rejected'
					? {
						success: false,
						output: approvalDecision.reason ?? 'Tool request was rejected.',
					}
					: await this.executeToolWithCancellation(toolCall.name, toolCall.params, options.mode, state);
				options.observer?.onToolResult?.(toolCall.name, toolCall.params, toolResult);
				const formattedToolResult = formatToolResult(toolCall.name, toolResult);
				toolResults.push(formattedToolResult);
				const toolResultTrace = this.describeToolResultTrace(toolCall.name, toolResult.success);
				assistantResponseText = this.appendAssistantDelta(options, assistantResponseText, this.emitAgentTrace(options, 'tool_result', toolResultTrace, toolResult.success ? 'success' : 'error'));
				this.logTrace(toolResult.success ? 'info' : 'warn', `[Tool Result] ${toolResultTrace}`);
				assistantResponseText = this.appendAssistantDelta(options, assistantResponseText, `\n${formattedToolResult}\n`);

				if (state.cancelled) {
					this.applyCancel(options, state);
					return;
				}

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

	/**
	 * Tool execution can hang for several reasons (slow search providers, an extension host that
	 * has not yet finished registering, malformed regex that the underlying engine never reports
	 * back on, etc.). We wrap each call in two safety nets:
	 *
	 * 1. A `CancellationTokenSource` exposed via `state.activeToolTokenSource` so that the user
	 *    pressing Stop on the chat actually reaches the in-flight tool. Without this hook the
	 *    cancel button only aborts the streaming API request, which is undefined while a tool
	 *    is running.
	 * 2. A hard `raceTimeout` ceiling so that even if a tool ignores cancellation entirely, the
	 *    loop still recovers and surfaces a clear error to the model rather than freezing forever.
	 */
	private async executeToolWithCancellation(
		toolName: string,
		params: Record<string, string>,
		mode: VSCloneChatMode,
		state: ILoopState,
	): Promise<IVSCloneToolExecutionResult> {
		const tokenSource = new CancellationTokenSource();
		state.activeToolTokenSource = tokenSource;
		try {
			const execution = this.toolExecutionService.executeTool(toolName, params, mode, tokenSource.token);
			const result = await raceTimeout(execution, toolExecutionTimeoutMs, () => {
				this.logTrace('warn', `Tool ${toolName} exceeded ${toolExecutionTimeoutMs}ms; cancelling and continuing.`);
				tokenSource.cancel();
			});
			if (result) {
				return result;
			}
			return {
				success: false,
				output: `Tool ${toolName} did not finish within ${Math.round(toolExecutionTimeoutMs / 1000)} seconds and was cancelled.`,
			};
		} finally {
			if (state.activeToolTokenSource === tokenSource) {
				state.activeToolTokenSource = undefined;
			}
			tokenSource.dispose();
		}
	}

	private async runModelIteration(
		options: IVSCloneAgentLoopOptions,
		messages: readonly ILoopMessage[],
		state: ILoopState,
	): Promise<ILoopIterationResult> {
		const lastMessage = messages.at(-1);
		if (!lastMessage || lastMessage.role !== 'user') {
			return {
				responseText: '',
				responseTranscriptText: '',
				errorMessage: 'Agent loop requires a user message before each model call.',
				aborted: false,
			};
		}

		let responseText = '';
		let responseTranscriptText = '';
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
			// The current user message owns its attachments. Earlier multimodal turns are replayed from
			// `previousTurns`, which keeps later tool iterations and restored threads aligned.
			imageAttachments: lastMessage.imageAttachments,
		}, {
			onDelta: delta => {
				responseText += delta;
				responseTranscriptText = this.appendAssistantDelta(options, responseTranscriptText, delta);
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
			responseTranscriptText,
			errorMessage,
			aborted,
		};
	}

	private appendAssistantDelta(options: IVSCloneAgentLoopOptions, responseText: string, delta: string): string {
		if (!delta) {
			return responseText;
		}
		options.observer?.onResponseDelta?.(delta);
		return responseText + delta;
	}

	/**
	 * The runtime owns one flat assistant transcript per active turn, so post-iteration cleanup has
	 * to replace the current transcript snapshot rather than patching a substring in place. We
	 * rebuild the response from the stable prefix plus the sanitized iteration text and hand the
	 * whole string back to the runtime observer before later trace/result records are appended.
	 */
	private replaceCurrentIterationTranscript(options: IVSCloneAgentLoopOptions, responsePrefix: string, sanitizedIterationText: string): string {
		const replacementText = `${responsePrefix}${sanitizedIterationText}`;
		options.observer?.onResponseReplace?.(replacementText);
		return replacementText;
	}

	private applyComplete(options: IVSCloneAgentLoopOptions, state: ILoopState): void {
		if (state.finished) {
			return;
		}
		state.finished = true;
		this.logTrace('info', `Agent loop completed for thread ${options.threadId} (turn ${options.turnId})`);
		options.observer?.onComplete?.();
	}

	private applyError(options: IVSCloneAgentLoopOptions, state: ILoopState, message: string): void {
		if (state.finished) {
			return;
		}
		state.finished = true;
		this.logTrace('error', `Agent loop failed for thread ${options.threadId}: ${message}`);
		options.observer?.onError?.(message);
	}

	private applyCancel(options: IVSCloneAgentLoopOptions, state: ILoopState): void {
		if (state.finished) {
			return;
		}
		state.finished = true;
		this.logTrace('info', `Agent loop cancelled for thread ${options.threadId} (turn ${options.turnId})`);
		options.observer?.onCancel?.();
	}

	/**
	 * Tool traces are emitted as explicit XML markers so the UI can style them as lightweight
	 * activity logs without mixing them into model-authored prose.
	 */
	private emitAgentTrace(
		_options: IVSCloneAgentLoopOptions,
		type: VSCloneAgentTraceType,
		message: string,
		status?: VSCloneAgentTraceStatus,
	): string {
		const statusAttribute = status ? ` status="${escapeXmlAttribute(status)}"` : '';
		return `\n<agent_trace type="${escapeXmlAttribute(type)}"${statusAttribute}>${escapeXmlText(message)}</agent_trace>\n`;
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
