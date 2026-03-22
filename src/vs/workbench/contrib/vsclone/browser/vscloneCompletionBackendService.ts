/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IVSCloneModelCatalogService } from '../common/vscloneModelCatalogService.js';
import { IVSCloneCompletionBackend, IVSCloneCompletionRequest, IVSCloneCompletionResponse } from '../common/vscloneCompletionTypes.js';
import { postProcessCompletion } from '../common/vscloneCompletionPostProcessor.js';
import { IVSCloneCompletionPromptService } from '../common/vscloneCompletionPromptService.js';
import { IVSCloneThreadModelSelectionService, IVSCloneModelSelection } from '../common/backend/vscloneThreadModelSelectionService.js';
import { IVSCloneCompletionApiService } from './vscloneCompletionApiService.js';
import { type VSCloneReasoningEffortLevel, type IVSCloneModelCatalogModelDescriptor } from '../common/vscloneModelCatalogService.js';

const defaultCompletionRequestTimeoutMs = 8_000;

interface IVSCloneInlineCompletionFallbackCandidate {
	readonly modelIdentifier: string;
	readonly reasoningEffort?: VSCloneReasoningEffortLevel;
}

/**
 * Runtime retries should mirror the location-default policy for inline completions so a provider
 * error degrades to the next cheapest viable option instead of silently dropping the suggestion.
 */
const editorInlineCompletionFallbackCandidates: readonly IVSCloneInlineCompletionFallbackCandidate[] = [
	{ modelIdentifier: 'openai/gpt-5.3-codex-spark', reasoningEffort: 'lite' },
	{ modelIdentifier: 'openai/gpt-5-nano', reasoningEffort: 'none' },
	{ modelIdentifier: 'google/gemini-3.1-flash-lite-preview', reasoningEffort: 'minimal' },
	{ modelIdentifier: 'anthropic/claude-haiku-4-5-20251001' },
];

/**
 * The completion backend keeps model policy, prompt shaping, timeout enforcement, and deterministic
 * post-processing together so the editor provider only has to manage debounce, cache, and ranges.
 */
export class VSCloneCompletionBackendService implements IVSCloneCompletionBackend {
	declare readonly _serviceBrand: undefined;

	private readonly requestTimeoutMs = defaultCompletionRequestTimeoutMs;

	constructor(
		@IVSCloneThreadModelSelectionService private readonly selectionService: IVSCloneThreadModelSelectionService,
		@IVSCloneModelCatalogService private readonly modelCatalogService: IVSCloneModelCatalogService,
		@IVSCloneCompletionPromptService private readonly promptService: IVSCloneCompletionPromptService,
		@IVSCloneCompletionApiService private readonly apiService: IVSCloneCompletionApiService,
		@ILogService private readonly logService: ILogService,
	) { }

	async complete(request: IVSCloneCompletionRequest, token: CancellationToken): Promise<string | undefined> {
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

					this.logService.info(`[VSCloneCompletionBackend] Retrying inline completion with ${retrySelection.modelId} after ${attemptSelection.modelId} failed.`);
					attemptSelection = retrySelection;
				}
			}
		} catch (error) {
			if (!isCancellationError(error) && !requestCts.token.isCancellationRequested) {
				this.logService.debug('[VSCloneCompletionBackend] Completion backend failed.', error);
			}
			return undefined;
		} finally {
			if (timedOut) {
				this.logService.info(`[VSCloneCompletionBackend] Completion request timed out after ${this.requestTimeoutMs}ms.`);
			}
			clearTimeout(timeoutHandle);
			requestCts.dispose();
		}
	}

	private async resolveCompletionSelection(token: CancellationToken): Promise<IVSCloneModelSelection | undefined> {
		await this.selectionService.initialize();
		if (token.isCancellationRequested) {
			return undefined;
		}

		const catalogState = this.modelCatalogService.getState();
		if (catalogState.status === 'idle' || catalogState.status === 'error') {
			await this.modelCatalogService.refreshCatalog();
		}
		if (token.isCancellationRequested) {
			return undefined;
		}

		return this.selectionService.getCurrentSelectionForThread('', 'editorInline');
	}

	private async completeWithSelection(
		request: IVSCloneCompletionRequest,
		selection: IVSCloneModelSelection,
		token: CancellationToken,
	): Promise<string | undefined> {
		const envelope = this.promptService.buildPromptEnvelope(request, selection);
		const rawText = await this.apiService.complete(envelope, selection, token);
		const normalized = this.normalizeBackendResult(rawText, request, selection);
		return normalized?.insertText;
	}

	/**
	 * Runtime retries are limited to the inline policy chain so provider failures can degrade to the
	 * next configured model without changing the meaning of "no completion text" responses.
	 */
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
			const model = this.modelCatalogService.getModel(candidate.modelIdentifier);
			if (!model?.isSelectable) {
				continue;
			}

			retrySelections.push(this.toRetrySelection(selection, model, candidate.reasoningEffort));
		}

		return retrySelections;
	}

	private toRetrySelection(
		baseSelection: IVSCloneModelSelection,
		model: IVSCloneModelCatalogModelDescriptor,
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

	private normalizeBackendResult(
		rawText: string | undefined,
		request: IVSCloneCompletionRequest,
		selection: IVSCloneModelSelection,
	): IVSCloneCompletionResponse | undefined {
		if (!rawText) {
			return undefined;
		}

		return {
			rawText,
			insertText: postProcessCompletion(rawText, request.prefix, request.suffix, request.predictionType),
			selection,
		};
	}
}
