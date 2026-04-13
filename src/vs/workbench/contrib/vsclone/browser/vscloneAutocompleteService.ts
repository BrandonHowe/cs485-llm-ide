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
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { localize } from '../../../../nls.js';
import { IVSCloneCompletionBackend, VSCloneCompletionPredictionType } from '../common/vscloneCompletionTypes.js';
import { IVSCloneThreadModelSelectionService } from '../common/backend/vscloneThreadModelSelectionService.js';
import { IVSCloneCompletionContextService } from './vscloneCompletionContextService.js';

export const VSCloneAutocompleteEnabledSetting = 'vsclone.autocomplete.enabled';
export const VSCloneAutocompleteDebounceMsSetting = 'vsclone.autocomplete.debounceMs';
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
const completionTriggerCharacters = new Set(['.', '(', '{', ':', '=']);
const identifierAtEndOfLinePattern = /[A-Za-z_$][A-Za-z0-9_$]*$/;

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

export class VSCloneAutocompleteService extends Disposable implements IWorkbenchContribution, InlineCompletionsProvider {
	static readonly ID = 'workbench.contrib.vsclone.autocompleteService';

	private readonly cacheByResource = new ResourceMap<LRUCache<string, IVSCloneCachedCompletion>>();
	private readonly latestRequestTimestampByResource = new ResourceMap<number>();
	private readonly activeRequestsByResource = new ResourceMap<IVSCloneActiveBackendRequest[]>();
	private readonly shownCompletionLists = new Set<InlineCompletions>();
	private readonly inlineSuggestionVisibleContextKey: IContextKey<boolean>;
	private requestIdPool = 0;

	constructor(
		@IVSCloneCompletionBackend private readonly backend: IVSCloneCompletionBackend,
		@IVSCloneCompletionContextService private readonly completionContextService: IVSCloneCompletionContextService,
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
		@IVSCloneThreadModelSelectionService selectionService: IVSCloneThreadModelSelectionService,
	) {
		super();
		this.inlineSuggestionVisibleContextKey = VSCloneInlineSuggestionVisibleContextKey.bindTo(contextKeyService);
		this._register(languageFeaturesService.inlineCompletionsProvider.register({ pattern: '**' }, this));
		this._register(selectionService.onDidChangeSelection(event => {
			if (event.current?.location !== 'editorInline' && event.previous?.location !== 'editorInline') {
				return;
			}
			// Completion cache entries are only valid for the inline model that generated them.
			// Clear every document cache when the editorInline selection changes so the next request
			// re-enters backend selection resolution instead of replaying stale ghost text.
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
			return {
				items: [{ insertText: cachedInsertText, range }],
			};
		}

		if (!(await this.debounce(model.uri, completionContext, predictionMode, token)) || token.isCancellationRequested) {
			return undefined;
		}

		const predictionType = this.toBackendPredictionType(predictionMode);
		// Single-line inline suggestions need to win on latency first. Cross-file context is reserved
		// for multi-line continuations where the added semantic signal is more likely to offset cost.
		const crossFileContext = predictionType === 'multi-line'
			? this.completionContextService.gatherContext(
				model.uri,
				model.getLanguageId(),
				maxCrossFileContextSnippets,
				maxCrossFileContextCharsPerSnippet,
			)
			: [];
		const requestHandle = this.beginBackendRequest(model.uri, token);
		let rawCompletion: string | undefined;
		try {
			rawCompletion = await this.backend.complete({
				prefix: completionContext.prefix,
				suffix: completionContext.suffix,
				languageId: model.getLanguageId(),
				filePath: model.uri.fsPath,
				predictionType,
				maxTokens: predictionType === 'multi-line' ? 160 : 64,
				crossFileContext,
			}, requestHandle.token);
		} catch (error) {
			if (!isCancellationError(error)) {
				this.logService.error('[VSCloneAutocomplete] Completion backend failed.', error);
			}
			return undefined;
		} finally {
			requestHandle.dispose();
		}

		if (!rawCompletion || token.isCancellationRequested) {
			return undefined;
		}

		// The backend already applies deterministic normalization so cache reuse and UI insertion stay
		// aligned with the exact text that was shown to the user as ghost text.
		this.addToCache(model.uri, completionContext.prefix, rawCompletion);

		const range = this.getReplaceRange(model, position, predictionMode);
		const item: InlineCompletion = {
			insertText: rawCompletion,
			range,
		};

		return { items: [item] };
	}

	handleItemDidShow(completions: InlineCompletions, _item: InlineCompletion): void {
		// The editor does not expose provider-specific context keys, so we track when a VSClone result
		// is the visible ghost text and use that to scope the Tab override narrowly to VSClone items.
		if (this.shownCompletionLists.has(completions)) {
			return;
		}

		this.shownCompletionLists.add(completions);
		this.inlineSuggestionVisibleContextKey.set(true);
	}

	disposeInlineCompletions(completions: InlineCompletions): void {
		// Visibility is reference-counted by completion list so a stale dispose cannot clear the key
		// while a newer VSClone suggestion is still visible.
		this.shownCompletionLists.delete(completions);
		this.inlineSuggestionVisibleContextKey.set(this.shownCompletionLists.size > 0);
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

	/**
	 * Lower prompt budgets and a smaller inline model reduce backend latency enough that we can
	 * afford more responsive debounce values again without falling back into constant cancellations.
	 */
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

		// Bounded extraction keeps requests responsive in very large files while preserving nearby context quality.
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
			// Multi-line inserts must terminate at EOL by API contract when containing newlines.
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
