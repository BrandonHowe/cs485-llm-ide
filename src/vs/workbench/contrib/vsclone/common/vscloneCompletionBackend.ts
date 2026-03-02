/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export type VSCloneCompletionPredictionType = 'single-line' | 'multi-line';

export interface IVSCloneCompletionRequest {
	readonly prefix: string;
	readonly suffix: string;
	readonly languageId: string;
	readonly filePath: string;
	readonly predictionType: VSCloneCompletionPredictionType;
	readonly maxTokens: number;
}

export interface IVSCloneCompletionBackend {
	readonly _serviceBrand: undefined;
	complete(request: IVSCloneCompletionRequest, token: CancellationToken): Promise<string | undefined>;
}

export const IVSCloneCompletionBackend = createDecorator<IVSCloneCompletionBackend>('vscloneCompletionBackend');
