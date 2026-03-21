/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { IVSCloneModelSelection } from './vscloneModelSelectionTypes.js';

export type VSCloneCompletionPredictionType = 'single-line' | 'multi-line';

/**
 * Cross-file snippets stay intentionally small and transport-safe so browser-layer context
 * gathering can enrich completions without leaking editor service dependencies into common code.
 */
export interface IVSCloneCompletionCrossFileContext {
	readonly filePath: string;
	readonly languageId: string;
	readonly content: string;
}

export interface IVSCloneCompletionRequest {
	readonly prefix: string;
	readonly suffix: string;
	readonly languageId: string;
	readonly filePath: string;
	readonly predictionType: VSCloneCompletionPredictionType;
	readonly maxTokens: number;
	readonly crossFileContext?: readonly IVSCloneCompletionCrossFileContext[];
}

/**
 * This envelope is the completion transport contract. It keeps prompt assembly deterministic and
 * transport-agnostic so editor-facing code never has to know how individual vendors expect
 * hole-filler context, related files, or sampling controls to be represented.
 */
export interface IVSCloneCompletionPromptEnvelope {
	readonly prefix: string;
	readonly suffix: string;
	readonly languageId: string;
	readonly filePath: string;
	readonly predictionType: VSCloneCompletionPredictionType;
	readonly maxTokens: number;
	readonly temperature?: number;
	readonly stopTokens: readonly string[];
	readonly crossFileContext?: readonly IVSCloneCompletionCrossFileContext[];
	readonly systemMessage: string;
	readonly promptText: string;
}

/**
 * The backend keeps both the raw provider text and the normalized insert text so transport tests
 * can stay focused on wire payloads while editor tests assert the exact insertion semantics.
 */
export interface IVSCloneCompletionResponse {
	readonly rawText: string;
	readonly insertText: string | undefined;
	readonly selection: IVSCloneModelSelection;
}

export interface IVSCloneCompletionBackend {
	readonly _serviceBrand: undefined;
	complete(request: IVSCloneCompletionRequest, token: CancellationToken): Promise<string | undefined>;
}

export const IVSCloneCompletionBackend = createDecorator<IVSCloneCompletionBackend>('vscloneCompletionBackend');
