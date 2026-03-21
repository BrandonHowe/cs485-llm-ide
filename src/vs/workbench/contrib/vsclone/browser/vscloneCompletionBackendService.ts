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

const defaultCompletionRequestTimeoutMs = 8_000;

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

			const envelope = this.promptService.buildPromptEnvelope(request, selection);
			const rawText = await this.apiService.complete(envelope, selection, requestCts.token);
			const normalized = this.normalizeBackendResult(rawText, request, selection);
			return normalized?.insertText;
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
