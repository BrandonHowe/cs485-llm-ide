/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { LRUCache, ResourceMap } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { InlineCompletion, InlineCompletionContext, InlineCompletions, InlineCompletionsProvider } from '../../../../editor/common/languages.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { localize } from '../../../../nls.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import type {
	IVSCloneCompletionCrossFileContext,
	IVSCloneCompletionPromptEnvelope,
	IVSCloneCompletionRequest,
	VSCloneCompletionPredictionType,
} from '../common/vscloneCompletionTypes.js';
import { type VSCloneReasoningEffortLevel } from '../common/vscloneModelCapabilities.js';
import type { IVSCloneModelSelection } from '../common/vscloneModelSelectionTypes.js';
import { IVSCloneOAuthService } from '../common/vscloneOAuthService.js';
import { IVSCloneSettingsService } from '../common/vscloneSettingsService.js';
import type { IVSCloneSettingsModelState } from '../common/vscloneSettingsTypes.js';
import { IVSCloneConvertToLLMMessageService } from './vscloneConvertToLLMMessageService.js';
import { IVSCloneLLMMessageService } from './vscloneLLMMessageService.js';

export const VSCloneAutocompleteEnabledSetting = 'vsclone.autocomplete.enabled';
export const VSCloneAutocompleteDebounceMsSetting = 'vsclone.autocomplete.debounceMs';
export const VSCloneAutocompleteDebounceMsMaximum = 2000;
export const VSCloneInlineSuggestionVisibleContextKey = new RawContextKey<boolean>('vsclone.inlineSuggestionVisible', false, localize('vsclone.inlineSuggestionVisible', "Whether a VSClone inline suggestion is visible."));

const defaultDebounceMs = 500;
const triggerCharacterDebounceMs = 250;
const emptyLineDebounceMs = 300;
const identifierDebounceMs = 325;
const fillMiddleDebounceMs = 400;
const defaultEnabled = true;
const cacheEntryLimitPerDocument = 20;
const cacheEntryMaxAgeMs = 30_000;
const maxConcurrentRequestsPerDocument = 2;
const maxPrefixContextLines = 120;
const maxSuffixContextLines = 80;
const maxPrefixContextCharacters = 8_000;
const maxSuffixContextCharacters = 2_000;
const maxCrossFileContextSnippets = 2;
const maxCrossFileContextCharsPerSnippet = 1_000;
const maxTotalCrossFileContextChars = 5_000;
const maxSingleLinePromptPrefixChars = 4_000;
const maxMultiLinePromptPrefixChars = 8_000;
const minPromptPrefixChars = 2_500;
const maxSingleLinePromptSuffixChars = 1_000;
const maxMultiLinePromptSuffixChars = 2_500;
const maxPromptCrossFileContextChars = 2_500;
const maxSingleLineOutputTokens = 96;
const maxMultiLineOutputTokens = 192;
const completionTemperature = 0.01;
const singleLineStopTokens = ['\r\n', '\n'];
const multiLineStopTokens = ['\n\n'];
const defaultCompletionRequestTimeoutMs = 8_000;
const completionTriggerCharacters = new Set(['.', '(', '{', ':', '=']);
const identifierAtEndOfLinePattern = /[A-Za-z_$][A-Za-z0-9_$]*$/;
const openingBrackets = new Set(['(', '[', '{']);
const closingToOpeningBracket = new Map<string, string>([
	[')', '('],
	[']', '['],
	['}', '{'],
]);
const holeFillerSystemMessage = [
	'You are a code completion engine. You will be given source code with a <CURSOR> marker.',
	'Return ONLY the exact text to insert at <CURSOR>. No markdown, no backticks, no explanation.',
	'',
	'Example:',
	'Input: const x = Math.max(<CURSOR>);',
	'Output: a, b',
	'',
	'Rules:',
	'- Match surrounding indentation and style.',
	'- For single-line: produce only the rest of the current line.',
	'- For multi-line: produce a natural continuation, stop before repeating suffix content.',
	'- Never repeat code already present after <CURSOR>.',
].join('\n');

type VSClonePredictionMode = 'single-line-redo-suffix' | 'single-line-fill-middle' | 'multi-line' | 'do-not-predict';

interface IVSCloneCompletionContext {
	readonly prefix: string;
	readonly suffix: string;
	readonly linePrefix: string;
	readonly lineSuffix: string;
}

interface IVSCloneCachedCompletion {
	readonly prefix: string;
	readonly insertText: string;
	readonly timestamp: number;
}

interface IVSCloneActiveBackendRequest {
	readonly id: number;
	readonly createdAt: number;
	readonly cts: CancellationTokenSource;
}

interface IVSCloneBackendRequestHandle {
	readonly token: CancellationToken;
	dispose(): void;
}

interface ICompletionContextCandidate {
	readonly resource: URI;
	readonly model: ITextModel;
	readonly filePath: string;
	readonly languageId: string;
	readonly score: number;
	readonly size: number;
	readonly editorOrder: number;
}

interface IVSCloneInlineCompletionFallbackCandidate {
	readonly modelIdentifier: string;
	readonly reasoningEffort?: VSCloneReasoningEffortLevel;
}

/**
 * Retries stay aligned with the inline model policy so transient provider failures degrade to the
 * next cheapest viable model instead of turning every transport blip into an empty suggestion.
 */
const editorInlineCompletionFallbackCandidates: readonly IVSCloneInlineCompletionFallbackCandidate[] = [
	{ modelIdentifier: 'openai/gpt-5.3-codex-spark', reasoningEffort: 'lite' },
	{ modelIdentifier: 'openai/gpt-5-nano', reasoningEffort: 'none' },
	{ modelIdentifier: 'google/gemini-3.1-flash-lite-preview', reasoningEffort: 'minimal' },
	{ modelIdentifier: 'anthropic/claude-haiku-4-5-20251001' },
];

function trimSuffixOverlap(text: string, suffix: string): string {
	if (!text || !suffix) {
		return text;
	}

	const maxOverlap = Math.min(text.length, suffix.length);
	for (let overlap = maxOverlap; overlap > 0; overlap--) {
		if (text.slice(text.length - overlap) === suffix.slice(0, overlap)) {
			return text.slice(0, text.length - overlap);
		}
	}

	return text;
}

function stripMarkdownWrapper(text: string): string {
	const normalized = text.replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');

	if (lines.length > 0 && lines[0].trimStart().startsWith('```')) {
		lines.shift();
	}
	if (lines.length > 0 && lines[lines.length - 1].trim() === '```') {
		lines.pop();
	}

	return lines.join('\n').replace(/^`+/, '').replace(/`+$/, '');
}

function decodeEscapedMultilineText(text: string, predictionType: VSCloneCompletionPredictionType): string {
	if (!text.includes('\\n')) {
		return text;
	}

	const trimmed = text.trim();
	const escapedNewlineCount = text.match(/\\n/g)?.length ?? 0;
	const looksLikeEscapedBlock = text.startsWith('\\n')
		|| text.includes('\\n ')
		|| text.includes('\\n\t')
		|| text.includes('\\n}')
		|| text.includes('\\n]');

	if (escapedNewlineCount < 2 && !trimmed.startsWith('"')) {
		return text;
	}

	if (predictionType !== 'multi-line' && !looksLikeEscapedBlock && !trimmed.startsWith('"')) {
		return text;
	}

	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed === 'string') {
				return parsed;
			}
		} catch {
			// Fall through to the narrower newline/tab decoding below.
		}
	}

	return text
		.replace(/\\r\\n/g, '\n')
		.replace(/\\n/g, '\n')
		.replace(/\\t/g, '\t');
}

function getCurrentLinePrefix(prefix: string): string {
	const newlineOffset = prefix.lastIndexOf('\n');
	return newlineOffset >= 0 ? prefix.slice(newlineOffset + 1) : prefix;
}

function normalizeLeadingWhitespace(text: string, prefix: string): string {
	let result = text.replace(/^\n+/, '');
	const currentLinePrefix = getCurrentLinePrefix(prefix);
	const currentLineIndentation = currentLinePrefix.match(/^\s*/)?.[0] ?? '';

	if (currentLinePrefix.trim().length === 0 && currentLineIndentation.length > 0 && result.startsWith(currentLineIndentation)) {
		result = result.slice(currentLineIndentation.length);
	}

	return result;
}

function truncateAtSuffixLineMatch(text: string, suffix: string): string {
	if (!text || !suffix) {
		return text;
	}

	const suffixLines = suffix.replace(/\r\n/g, '\n').split('\n').slice(0, 5).map(line => line.trim());
	if (suffixLines.length === 0) {
		return text;
	}

	const lines = text.replace(/\r\n/g, '\n').split('\n');
	for (let index = 0; index < lines.length; index++) {
		if (suffixLines.includes(lines[index].trim())) {
			return lines.slice(0, index).join('\n');
		}
	}

	return text;
}

function truncateForSingleLine(text: string): string {
	const newlineOffset = text.indexOf('\n');
	return newlineOffset < 0 ? text : text.slice(0, newlineOffset);
}

function buildBracketStack(prefix: string): string[] {
	const stack: string[] = [];
	for (const char of prefix) {
		if (openingBrackets.has(char)) {
			stack.push(char);
			continue;
		}

		const expectedOpeningBracket = closingToOpeningBracket.get(char);
		if (!expectedOpeningBracket) {
			continue;
		}

		if (stack[stack.length - 1] === expectedOpeningBracket) {
			stack.pop();
		}
	}
	return stack;
}

function truncateOnUnbalancedClosingBracket(text: string, prefix: string): string {
	const stack = buildBracketStack(prefix);
	let result = '';

	for (const char of text) {
		if (openingBrackets.has(char)) {
			stack.push(char);
			result += char;
			continue;
		}

		const expectedOpeningBracket = closingToOpeningBracket.get(char);
		if (!expectedOpeningBracket) {
			result += char;
			continue;
		}

		if (stack.length === 0 || stack[stack.length - 1] !== expectedOpeningBracket) {
			break;
		}

		stack.pop();
		result += char;
	}

	return result;
}

function truncateRepetition(text: string): string {
	if (!text) {
		return text;
	}

	const lines = text.replace(/\r\n/g, '\n').split('\n');
	let runStart = 0;
	while (runStart < lines.length) {
		const normalizedLine = lines[runStart].trim();
		let runEnd = runStart + 1;
		while (runEnd < lines.length && lines[runEnd].trim() === normalizedLine) {
			runEnd++;
		}

		const runLength = runEnd - runStart;
		if (runLength >= 8) {
			return '';
		}
		if (runLength >= 4) {
			return lines.slice(0, runStart + 2).join('\n');
		}

		runStart = runEnd;
	}

	return text;
}

function getIndentationWidth(line: string): number {
	return line.match(/^\s*/)?.[0].length ?? 0;
}

function startsWithClosingBracket(text: string): boolean {
	return /^[)\]}]/.test(text);
}

function truncateAtScopeExit(text: string, prefix: string): string {
	if (!text.includes('\n')) {
		return text;
	}

	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const cursorIndentation = getIndentationWidth(getCurrentLinePrefix(prefix));
	for (let index = 1; index < lines.length; index++) {
		const trimmedLine = lines[index].trim();
		if (!trimmedLine) {
			continue;
		}

		if (getIndentationWidth(lines[index]) < cursorIndentation && !startsWithClosingBracket(trimmedLine)) {
			return lines.slice(0, index).join('\n');
		}
	}

	return text;
}

function postProcessCompletion(
	rawCompletion: string,
	prefix: string,
	suffix: string,
	predictionType: VSCloneCompletionPredictionType,
): string | undefined {
	let processed = stripMarkdownWrapper(rawCompletion);
	processed = decodeEscapedMultilineText(processed, predictionType);
	processed = normalizeLeadingWhitespace(processed, prefix);
	processed = trimSuffixOverlap(processed, suffix);
	processed = truncateAtSuffixLineMatch(processed, suffix);

	if (predictionType === 'single-line') {
		processed = truncateForSingleLine(processed);
	}

	processed = truncateOnUnbalancedClosingBracket(processed, prefix);
	processed = truncateRepetition(processed);
	if (predictionType === 'multi-line') {
		processed = truncateAtScopeExit(processed, prefix);
	}
	processed = processed.replace(/[ \t]+$/g, '').replace(/\n+$/g, '');

	return processed.trim().length > 0 ? processed : undefined;
}

export class VSCloneAutocompleteService extends Disposable implements IWorkbenchContribution, InlineCompletionsProvider {
	static readonly ID = 'workbench.contrib.vsclone.autocompleteService';

	private readonly cacheByResource = new ResourceMap<LRUCache<string, IVSCloneCachedCompletion>>();
	private readonly latestRequestTimestampByResource = new ResourceMap<number>();
	private readonly activeRequestsByResource = new ResourceMap<IVSCloneActiveBackendRequest[]>();
	private readonly shownCompletionLists = new Set<InlineCompletions>();
	private readonly inlineSuggestionVisibleContextKey: IContextKey<boolean>;
	private readonly requestTimeoutMs = defaultCompletionRequestTimeoutMs;
	private lastAutocompleteSelectionCacheKey: string | undefined;
	private requestIdPool = 0;

	constructor(
		@IVSCloneSettingsService private readonly settingsService: IVSCloneSettingsService,
		@IVSCloneConvertToLLMMessageService private readonly convertToLLMMessageService: IVSCloneConvertToLLMMessageService,
		@IVSCloneLLMMessageService private readonly llmMessageService: IVSCloneLLMMessageService,
		@IVSCloneOAuthService private readonly oauthService: IVSCloneOAuthService,
		@IEditorService private readonly editorService: IEditorService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.inlineSuggestionVisibleContextKey = VSCloneInlineSuggestionVisibleContextKey.bindTo(contextKeyService);
		this._register(languageFeaturesService.inlineCompletionsProvider.register({ pattern: '**' }, this));
		this.lastAutocompleteSelectionCacheKey = this.getAutocompleteSelectionCacheKey();
		this._register(this.settingsService.onDidChangeState(() => {
			const nextSelectionCacheKey = this.getAutocompleteSelectionCacheKey();
			if (nextSelectionCacheKey === this.lastAutocompleteSelectionCacheKey) {
				return;
			}

			this.lastAutocompleteSelectionCacheKey = nextSelectionCacheKey;
			// Completion cache entries are only valid for the inline model that generated them.
			// Clear every document cache when the editorInline selection changes so the next request
			// re-enters selection resolution instead of replaying stale ghost text from another model.
			this.cacheByResource.clear();
		}));
	}

	override dispose(): void {
		for (const [, requests] of this.activeRequestsByResource) {
			for (const request of requests) {
				request.cts.cancel();
				request.cts.dispose();
			}
		}
		this.activeRequestsByResource.clear();
		this.cacheByResource.clear();
		this.latestRequestTimestampByResource.clear();
		this.shownCompletionLists.clear();
		this.inlineSuggestionVisibleContextKey.reset();
		super.dispose();
	}

	async provideInlineCompletions(
		model: ITextModel,
		position: Position,
		_context: InlineCompletionContext,
		token: CancellationToken,
	): Promise<InlineCompletions | undefined> {
		if (!this.isEnabled()) {
			return undefined;
		}

		const completionContext = this.extractCompletionContext(model, position);
		const predictionMode = this.getPredictionMode(completionContext.linePrefix, completionContext.lineSuffix);
		if (predictionMode === 'do-not-predict') {
			return undefined;
		}

		const cachedInsertText = this.getCachedCompletion(model.uri, completionContext.prefix, completionContext.suffix);
		if (cachedInsertText) {
			const range = this.getReplaceRange(model, position, predictionMode);
			return { items: [{ insertText: cachedInsertText, range }] };
		}

		if (!(await this.debounce(model.uri, completionContext, predictionMode, token)) || token.isCancellationRequested) {
			return undefined;
		}

		const requestHandle = this.beginBackendRequest(model.uri, token);
		let insertText: string | undefined;
		try {
			insertText = await this.requestInlineCompletion(model, completionContext, predictionMode, requestHandle.token);
		} catch (error) {
			if (!isCancellationError(error)) {
				this.logService.error('[VSCloneAutocomplete] Completion backend failed.', error);
			}
			return undefined;
		} finally {
			requestHandle.dispose();
		}

		if (!insertText || token.isCancellationRequested) {
			return undefined;
		}

		this.addToCache(model.uri, completionContext.prefix, insertText);

		const range = this.getReplaceRange(model, position, predictionMode);
		const item: InlineCompletion = {
			insertText,
			range,
		};

		return { items: [item] };
	}

	handleItemDidShow(completions: InlineCompletions, _item: InlineCompletion): void {
		if (this.shownCompletionLists.has(completions)) {
			return;
		}

		this.shownCompletionLists.add(completions);
		this.inlineSuggestionVisibleContextKey.set(true);
	}

	disposeInlineCompletions(completions: InlineCompletions): void {
		this.shownCompletionLists.delete(completions);
		this.inlineSuggestionVisibleContextKey.set(this.shownCompletionLists.size > 0);
	}

	/**
	 * The settings service is now the single owner of inline model policy, so cache invalidation
	 * has to compare its projected Autocomplete feature selection instead of listening to the old
	 * thread-selection service directly.
	 */
	private getAutocompleteSelectionCacheKey(): string | undefined {
		const selection = this.settingsService.getFeatureSelection('Autocomplete');
		if (!selection) {
			return undefined;
		}

		return [
			selection.location,
			selection.vendor,
			selection.modelId,
			selection.modelIdentifier,
			selection.reasoningEffort ?? '',
		].join(':');
	}

	/**
	 * Phase 4 flattens the old backend/context/prompt stack into the provider itself so debounce,
	 * selection policy, transport retries, and post-processing are all visible in one hot-path file.
	 */
	private async requestInlineCompletion(
		model: ITextModel,
		completionContext: IVSCloneCompletionContext,
		predictionMode: VSClonePredictionMode,
		token: CancellationToken,
	): Promise<string | undefined> {
		const predictionType = this.toBackendPredictionType(predictionMode);
		const request: IVSCloneCompletionRequest = {
			prefix: completionContext.prefix,
			suffix: completionContext.suffix,
			languageId: model.getLanguageId(),
			filePath: model.uri.fsPath,
			predictionType,
			maxTokens: predictionType === 'multi-line' ? 160 : 64,
			crossFileContext: predictionType === 'multi-line'
				? this.gatherCrossFileContext(
					model.uri,
					model.getLanguageId(),
					maxCrossFileContextSnippets,
					maxCrossFileContextCharsPerSnippet,
				)
				: [],
		};

		const requestCts = new CancellationTokenSource(token);
		let timedOut = false;
		const timeoutHandle = setTimeout(() => {
			timedOut = true;
			requestCts.cancel();
		}, this.requestTimeoutMs);

		try {
			const selection = await this.resolveCompletionSelection(requestCts.token);
			if (!selection || requestCts.token.isCancellationRequested) {
				return undefined;
			}

			let attemptSelection = selection;
			const retrySelections = this.getRetrySelectionsAfterFailure(selection);
			while (true) {
				try {
					return await this.completeWithSelection(request, attemptSelection, requestCts.token);
				} catch (error) {
					if (isCancellationError(error) || requestCts.token.isCancellationRequested) {
						throw error;
					}

					const retrySelection = retrySelections.shift();
					if (!retrySelection) {
						throw error;
					}

					this.logService.info(`[VSCloneAutocomplete] Retrying inline completion with ${retrySelection.modelId} after ${attemptSelection.modelId} failed.`);
					attemptSelection = retrySelection;
				}
			}
		} catch (error) {
			if (!isCancellationError(error) && !requestCts.token.isCancellationRequested) {
				this.logService.debug('[VSCloneAutocomplete] Completion request failed.', error);
			}
			return undefined;
		} finally {
			if (timedOut) {
				this.logService.info(`[VSCloneAutocomplete] Completion request timed out after ${this.requestTimeoutMs}ms.`);
			}
			clearTimeout(timeoutHandle);
			requestCts.dispose();
		}
	}

	private async resolveCompletionSelection(token: CancellationToken): Promise<IVSCloneModelSelection | undefined> {
		await this.settingsService.initialize();
		if (token.isCancellationRequested) {
			return undefined;
		}

		const settingsState = this.settingsService.getState();
		if (settingsState.status === 'idle' || settingsState.status === 'error') {
			await this.settingsService.refreshState();
		}
		if (token.isCancellationRequested) {
			return undefined;
		}

		return this.settingsService.getCurrentSelectionForFeature('', 'editorInline');
	}

	private async completeWithSelection(
		request: IVSCloneCompletionRequest,
		selection: IVSCloneModelSelection,
		token: CancellationToken,
	): Promise<string | undefined> {
		const envelope = this.buildPromptEnvelope(request);
		const headers = await this.oauthService.getApiHeaders(selection.vendor);
		if (!headers || token.isCancellationRequested) {
			return undefined;
		}

		const rawText = await this.sendPreparedFIMRequest(selection, envelope, headers, token);
		return rawText ? postProcessCompletion(rawText, request.prefix, request.suffix, request.predictionType) : undefined;
	}

	private async sendPreparedFIMRequest(
		selection: IVSCloneModelSelection,
		envelope: IVSCloneCompletionPromptEnvelope,
		headers: Readonly<Record<string, string>>,
		token: CancellationToken,
	): Promise<string | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		return await new Promise<string | undefined>((resolve, reject) => {
			let settled = false;
			let cancellationListener = Disposable.None;
			const finish = (callback: () => void) => {
				if (settled) {
					return;
				}
				settled = true;
				cancellationListener.dispose();
				callback();
			};
			const handle = this.llmMessageService.sendRequest({
				kind: 'fim',
				auth: {
					vendor: selection.vendor,
					headers,
				},
				prepared: this.convertToLLMMessageService.prepareFIMRequest(selection, envelope),
			}, {
				onFinalMessage: ({ fullText }) => {
					finish(() => resolve(fullText));
				},
				onError: ({ message }) => {
					finish(() => reject(new Error(message)));
				},
				onAbort: () => {
					finish(() => resolve(undefined));
				},
			});
			cancellationListener = token.onCancellationRequested(() => {
				handle.cancel();
			});
		});
	}

	private getRetrySelectionsAfterFailure(selection: IVSCloneModelSelection): IVSCloneModelSelection[] {
		if (selection.location !== 'editorInline') {
			return [];
		}

		const currentIndex = editorInlineCompletionFallbackCandidates.findIndex(candidate => candidate.modelIdentifier === selection.modelIdentifier);
		if (currentIndex === -1) {
			return [];
		}

		const retrySelections: IVSCloneModelSelection[] = [];
		for (const candidate of editorInlineCompletionFallbackCandidates.slice(currentIndex + 1)) {
			const model = this.settingsService.getModel(candidate.modelIdentifier);
			if (!model?.isSelectable) {
				continue;
			}

			retrySelections.push(this.toRetrySelection(selection, model, candidate.reasoningEffort));
		}

		return retrySelections;
	}

	private toRetrySelection(
		baseSelection: IVSCloneModelSelection,
		model: IVSCloneSettingsModelState,
		reasoningEffort: VSCloneReasoningEffortLevel | undefined,
	): IVSCloneModelSelection {
		return {
			...baseSelection,
			modelIdentifier: model.identifier,
			vendor: model.vendor,
			modelId: model.modelId,
			modelName: model.modelName,
			reasoningEffort: reasoningEffort && model.reasoningEffortLevels?.includes(reasoningEffort)
				? reasoningEffort
				: model.defaultReasoningEffort ?? model.reasoningEffortLevels?.[0],
		};
	}

	private buildPromptEnvelope(request: IVSCloneCompletionRequest): IVSCloneCompletionPromptEnvelope {
		const crossFileContext = this.trimCrossFileContextForBudget(request.crossFileContext);
		const prefix = this.trimPrefixForBudget(request.prefix, request.predictionType, crossFileContext);
		const suffix = this.prepareSuffixForPrompt(this.trimSuffixForBudget(request.suffix, request.predictionType));

		return {
			prefix,
			suffix,
			languageId: request.languageId,
			filePath: request.filePath,
			predictionType: request.predictionType,
			maxTokens: this.getMaxOutputTokens(request.predictionType, request.maxTokens),
			temperature: completionTemperature,
			stopTokens: this.getStopTokens(request.predictionType),
			crossFileContext: crossFileContext.length > 0 ? crossFileContext : undefined,
			systemMessage: holeFillerSystemMessage,
			promptText: this.buildVendorPrompt(request, prefix, suffix, crossFileContext),
		};
	}

	private getStopTokens(predictionType: VSCloneCompletionPredictionType): readonly string[] {
		return predictionType === 'multi-line' ? multiLineStopTokens : singleLineStopTokens;
	}

	private getMaxOutputTokens(predictionType: VSCloneCompletionPredictionType, requestedMaxTokens: number): number {
		const cap = predictionType === 'multi-line' ? maxMultiLineOutputTokens : maxSingleLineOutputTokens;
		return Math.max(1, Math.min(cap, requestedMaxTokens));
	}

	private trimPrefixForBudget(
		prefix: string,
		predictionType: VSCloneCompletionPredictionType,
		crossFileContext: readonly IVSCloneCompletionCrossFileContext[],
	): string {
		const promptPrefixBudget = this.getPrefixBudgetForCrossFileContext(predictionType, crossFileContext);
		const boundedPrefix = prefix.length <= promptPrefixBudget ? prefix : prefix.slice(-promptPrefixBudget);
		return boundedPrefix.trimEnd();
	}

	private trimSuffixForBudget(suffix: string, predictionType: VSCloneCompletionPredictionType): string {
		const suffixBudget = predictionType === 'multi-line' ? maxMultiLinePromptSuffixChars : maxSingleLinePromptSuffixChars;
		return suffix.length <= suffixBudget ? suffix : suffix.slice(0, suffixBudget);
	}

	private prepareSuffixForPrompt(suffix: string): string {
		return suffix.length > 0 ? suffix : '\n';
	}

	private trimCrossFileContextForBudget(
		crossFileContext: readonly IVSCloneCompletionCrossFileContext[] | undefined,
	): readonly IVSCloneCompletionCrossFileContext[] {
		if (!crossFileContext || crossFileContext.length === 0) {
			return [];
		}

		let remainingChars = maxPromptCrossFileContextChars;
		const boundedContext: IVSCloneCompletionCrossFileContext[] = [];

		for (const snippet of crossFileContext) {
			if (remainingChars <= 0) {
				break;
			}

			const contentBudget = Math.min(remainingChars, snippet.content.length);
			const content = this.trimSnippetContentForBudget(snippet.content, contentBudget);
			if (!content.trim()) {
				continue;
			}

			boundedContext.push({
				filePath: snippet.filePath,
				languageId: snippet.languageId,
				content,
			});
			remainingChars -= content.length;
		}

		return boundedContext;
	}

	private trimSnippetContentForBudget(content: string, maxChars: number): string {
		if (content.length <= maxChars) {
			return content;
		}

		const bounded = content.slice(0, maxChars);
		const lastNewline = bounded.lastIndexOf('\n');
		return lastNewline >= Math.floor(maxChars / 2) ? bounded.slice(0, lastNewline) : bounded;
	}

	private getPrefixBudgetForCrossFileContext(
		predictionType: VSCloneCompletionPredictionType,
		crossFileContext: readonly IVSCloneCompletionCrossFileContext[],
	): number {
		const baseBudget = predictionType === 'multi-line' ? maxMultiLinePromptPrefixChars : maxSingleLinePromptPrefixChars;
		const crossFilePromptCost = crossFileContext.reduce((total, snippet) => total + snippet.filePath.length + snippet.content.length + 12, 0);
		return Math.max(minPromptPrefixChars, baseBudget - crossFilePromptCost);
	}

	private buildVendorPrompt(
		request: IVSCloneCompletionRequest,
		prefix: string,
		suffix: string,
		crossFileContext: readonly IVSCloneCompletionCrossFileContext[],
	): string {
		const promptSections: string[] = [];

		if (crossFileContext.length > 0) {
			promptSections.push('Related files:', '');
			for (const snippet of crossFileContext) {
				promptSections.push(`--- ${snippet.filePath || '(untitled)'} ---`);
				promptSections.push(snippet.content, '');
			}
		}

		promptSections.push(
			'Current file:',
			`Language: ${request.languageId || 'plaintext'}`,
			`File: ${request.filePath || '(untitled)'}`,
			'---',
			`${prefix}<CURSOR>${suffix}`,
		);

		return promptSections.join('\n');
	}

	private gatherCrossFileContext(
		currentUri: URI,
		currentLanguageId: string,
		maxSnippets: number,
		maxCharsPerSnippet: number,
	): readonly IVSCloneCompletionCrossFileContext[] {
		// Single-service context gathering keeps the prompt budget logic and tab sampling heuristic in
		// one place, so later tuning does not drift between a browser helper and the request path.
		if (maxSnippets <= 0 || maxCharsPerSnippet <= 0) {
			return [];
		}

		const seen = new Set<string>([currentUri.toString()]);
		const candidates: ICompletionContextCandidate[] = [];

		for (let index = 0; index < this.editorService.editors.length; index++) {
			const editor = this.editorService.editors[index];
			const resource = EditorResourceAccessor.getOriginalUri(editor, {
				supportSideBySide: SideBySideEditor.ANY,
			});
			if (!resource) {
				continue;
			}

			const resourceKey = resource.toString();
			if (seen.has(resourceKey)) {
				continue;
			}
			seen.add(resourceKey);

			const model = this.modelService.getModel(resource);
			if (!model) {
				continue;
			}

			const fileSize = model.getValueLength();
			if (fileSize === 0) {
				continue;
			}

			candidates.push({
				resource,
				model,
				filePath: resource.fsPath || resource.path || resource.toString(),
				languageId: model.getLanguageId(),
				score: this.scoreContextCandidate(model, currentLanguageId, maxCharsPerSnippet),
				size: fileSize,
				editorOrder: index,
			});
		}

		candidates.sort((left, right) => {
			return right.score - left.score
				|| left.size - right.size
				|| left.editorOrder - right.editorOrder
				|| left.filePath.localeCompare(right.filePath);
		});

		const snippets: IVSCloneCompletionCrossFileContext[] = [];
		let remainingChars = maxTotalCrossFileContextChars;
		for (const candidate of candidates) {
			if (snippets.length >= maxSnippets || remainingChars <= 0) {
				break;
			}

			const snippetBudget = Math.min(maxCharsPerSnippet, remainingChars);
			const content = this.extractContextSnippet(candidate.model, snippetBudget);
			if (!content.trim()) {
				continue;
			}

			snippets.push({
				filePath: candidate.filePath,
				languageId: candidate.languageId,
				content,
			});
			remainingChars -= content.length;
		}

		return snippets;
	}

	private scoreContextCandidate(model: ITextModel, currentLanguageId: string, maxCharsPerSnippet: number): number {
		let score = 0;
		if (model.getLanguageId() === currentLanguageId) {
			score += 2;
		}
		if (model.getVersionId() > 1) {
			score += 1;
		}
		if (model.getValueLength() <= maxCharsPerSnippet) {
			score += 1;
		}
		return score;
	}

	private extractContextSnippet(model: ITextModel, maxChars: number): string {
		try {
			const value = model.getValue();
			if (value.length <= maxChars) {
				return value;
			}

			const bounded = value.slice(0, maxChars);
			const lastNewline = bounded.lastIndexOf('\n');
			return lastNewline >= Math.floor(maxChars / 2) ? bounded.slice(0, lastNewline) : bounded;
		} catch (error) {
			this.logService.debug('[VSCloneAutocomplete] Failed to extract open-tab context.', error);
			return '';
		}
	}

	private isEnabled(): boolean {
		return this.configurationService.getValue<boolean>(VSCloneAutocompleteEnabledSetting) ?? defaultEnabled;
	}

	private getDebounceMs(): number {
		const configured = this.configurationService.getValue<number>(VSCloneAutocompleteDebounceMsSetting);
		if (typeof configured !== 'number' || !Number.isFinite(configured)) {
			return defaultDebounceMs;
		}

		return Math.max(0, configured);
	}

	private getAdaptiveDebounceMs(context: IVSCloneCompletionContext, mode: VSClonePredictionMode): number {
		if (mode === 'single-line-fill-middle') {
			return fillMiddleDebounceMs;
		}

		if (mode === 'multi-line' && context.linePrefix.trim().length === 0 && context.lineSuffix.trim().length === 0) {
			return emptyLineDebounceMs;
		}

		const linePrefixTrimmedRight = context.linePrefix.trimEnd();
		if (context.lineSuffix.length === 0 && linePrefixTrimmedRight.length > 0) {
			const lastCharacter = linePrefixTrimmedRight[linePrefixTrimmedRight.length - 1];
			if (completionTriggerCharacters.has(lastCharacter)) {
				return triggerCharacterDebounceMs;
			}
			if (identifierAtEndOfLinePattern.test(linePrefixTrimmedRight)) {
				return identifierDebounceMs;
			}
		}

		return fillMiddleDebounceMs;
	}

	private async debounce(
		resource: URI,
		context: IVSCloneCompletionContext,
		mode: VSClonePredictionMode,
		token: CancellationToken,
	): Promise<boolean> {
		const debounceMs = Math.min(this.getDebounceMs(), this.getAdaptiveDebounceMs(context, mode));
		if (debounceMs <= 0) {
			return true;
		}

		const requestTimestamp = Date.now();
		this.latestRequestTimestampByResource.set(resource, requestTimestamp);

		try {
			await timeout(debounceMs, token);
		} catch (error) {
			if (isCancellationError(error)) {
				return false;
			}
			throw error;
		}

		return !token.isCancellationRequested && this.latestRequestTimestampByResource.get(resource) === requestTimestamp;
	}

	private extractCompletionContext(model: ITextModel, position: Position): IVSCloneCompletionContext {
		const lineMaxColumn = model.getLineMaxColumn(position.lineNumber);
		const linePrefix = model.getValueInRange(new Range(position.lineNumber, 1, position.lineNumber, position.column));
		const lineSuffix = model.getValueInRange(new Range(position.lineNumber, position.column, position.lineNumber, lineMaxColumn));

		const contextStartLine = Math.max(1, position.lineNumber - maxPrefixContextLines);
		let prefix = model.getValueInRange(new Range(contextStartLine, 1, position.lineNumber, position.column));
		if (prefix.length > maxPrefixContextCharacters) {
			prefix = prefix.slice(-maxPrefixContextCharacters);
		}

		const contextEndLine = Math.min(model.getLineCount(), position.lineNumber + maxSuffixContextLines);
		let suffix = model.getValueInRange(new Range(position.lineNumber, position.column, contextEndLine, model.getLineMaxColumn(contextEndLine)));
		if (suffix.length > maxSuffixContextCharacters) {
			suffix = suffix.slice(0, maxSuffixContextCharacters);
		}

		return {
			prefix,
			suffix,
			linePrefix,
			lineSuffix,
		};
	}

	private getPredictionMode(linePrefix: string, lineSuffix: string): VSClonePredictionMode {
		const linePrefixHasContent = linePrefix.trim().length > 0;
		const lineSuffixTrimmedLength = lineSuffix.trim().length;

		if (!linePrefixHasContent && lineSuffix.length === 0) {
			return 'multi-line';
		}
		if (!linePrefixHasContent && lineSuffixTrimmedLength > 3) {
			return 'do-not-predict';
		}
		if (lineSuffixTrimmedLength <= 3) {
			return 'single-line-redo-suffix';
		}

		return 'single-line-fill-middle';
	}

	private toBackendPredictionType(mode: VSClonePredictionMode): VSCloneCompletionPredictionType {
		return mode === 'multi-line' ? 'multi-line' : 'single-line';
	}

	private getReplaceRange(model: ITextModel, position: Position, mode: VSClonePredictionMode): Range {
		if (mode === 'multi-line') {
			const lineMaxColumn = model.getLineMaxColumn(position.lineNumber);
			return new Range(position.lineNumber, position.column, position.lineNumber, lineMaxColumn);
		}

		return new Range(position.lineNumber, position.column, position.lineNumber, position.column);
	}

	private getCachedCompletion(resource: URI, prefix: string, suffix: string): string | undefined {
		const cache = this.cacheByResource.get(resource);
		if (!cache) {
			return undefined;
		}

		this.evictExpiredEntries(cache, Date.now());
		if (cache.size === 0) {
			return undefined;
		}

		const normalizedPrefix = prefix.trim();
		if (!normalizedPrefix) {
			return undefined;
		}

		let bestMatch: IVSCloneCachedCompletion | undefined;
		for (const [, entry] of cache) {
			if (!normalizedPrefix.startsWith(entry.prefix)) {
				continue;
			}
			if (!bestMatch || entry.prefix.length > bestMatch.prefix.length) {
				bestMatch = entry;
			}
		}
		if (!bestMatch) {
			return undefined;
		}

		const newlyTypedText = normalizedPrefix.slice(bestMatch.prefix.length);
		if (!bestMatch.insertText.startsWith(newlyTypedText)) {
			return undefined;
		}

		let trimmedCandidate = bestMatch.insertText.slice(newlyTypedText.length);
		trimmedCandidate = trimSuffixOverlap(trimmedCandidate, suffix);
		if (trimmedCandidate.trim().length === 0) {
			return undefined;
		}

		return trimmedCandidate;
	}

	private addToCache(resource: URI, prefix: string, insertText: string): void {
		const normalizedPrefix = prefix.trim();
		if (!normalizedPrefix) {
			return;
		}

		let cache = this.cacheByResource.get(resource);
		if (!cache) {
			cache = new LRUCache<string, IVSCloneCachedCompletion>(cacheEntryLimitPerDocument);
			this.cacheByResource.set(resource, cache);
		}

		this.evictExpiredEntries(cache, Date.now());
		cache.set(normalizedPrefix, {
			prefix: normalizedPrefix,
			insertText,
			timestamp: Date.now(),
		});
	}

	private evictExpiredEntries(cache: LRUCache<string, IVSCloneCachedCompletion>, now: number): void {
		const staleKeys: string[] = [];
		for (const [key, entry] of cache) {
			if (now - entry.timestamp > cacheEntryMaxAgeMs) {
				staleKeys.push(key);
			}
		}

		for (const key of staleKeys) {
			cache.delete(key);
		}
	}

	private beginBackendRequest(resource: URI, parentToken: CancellationToken): IVSCloneBackendRequestHandle {
		let activeRequests = this.activeRequestsByResource.get(resource);
		if (!activeRequests) {
			activeRequests = [];
			this.activeRequestsByResource.set(resource, activeRequests);
		}

		const request: IVSCloneActiveBackendRequest = {
			id: ++this.requestIdPool,
			createdAt: Date.now(),
			cts: new CancellationTokenSource(parentToken),
		};
		activeRequests.push(request);

		if (activeRequests.length > maxConcurrentRequestsPerDocument) {
			activeRequests.sort((left, right) => left.createdAt - right.createdAt || left.id - right.id);
			while (activeRequests.length > maxConcurrentRequestsPerDocument) {
				const oldestRequest = activeRequests.shift();
				if (!oldestRequest) {
					break;
				}

				oldestRequest.cts.cancel();
				oldestRequest.cts.dispose();
			}
		}

		return {
			token: request.cts.token,
			dispose: () => this.endBackendRequest(resource, request.id),
		};
	}

	private endBackendRequest(resource: URI, requestId: number): void {
		const activeRequests = this.activeRequestsByResource.get(resource);
		if (!activeRequests) {
			return;
		}

		const index = activeRequests.findIndex(request => request.id === requestId);
		if (index < 0) {
			return;
		}

		const [request] = activeRequests.splice(index, 1);
		request.cts.dispose();
		if (activeRequests.length === 0) {
			this.activeRequestsByResource.delete(resource);
		}
	}
}
