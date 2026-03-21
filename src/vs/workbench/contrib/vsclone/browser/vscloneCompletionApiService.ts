/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IVSCloneCompletionPromptEnvelope } from '../common/vscloneCompletionTypes.js';
import {
	IVSCloneCompletionAbortRequest,
	IVSCloneCompletionSubmitRequest,
	IVSCloneCompletionSubmitResponse,
	VSCLONE_COMPLETION_CHANNEL_NAME,
	VSCLONE_COMPLETION_COMMAND_ABORT,
	VSCLONE_COMPLETION_COMMAND_SUBMIT,
} from '../common/backend/vscloneCompletionApiIpc.js';
import { IVSCloneModelSelection } from '../common/vscloneModelSelectionTypes.js';
import { IVSCloneOAuthService } from '../common/vscloneOAuthService.js';

export const IVSCloneCompletionApiService = createDecorator<IVSCloneCompletionApiService>('vscloneCompletionApiService');

export interface IVSCloneCompletionApiService {
	readonly _serviceBrand: undefined;
	complete(envelope: IVSCloneCompletionPromptEnvelope, selection: IVSCloneModelSelection, token: CancellationToken): Promise<string | undefined>;
}

/**
 * The renderer owns auth lookup and cancellation wiring while the main process owns the network
 * fetch itself. That keeps secrets and CORS-sensitive work out of the editor hot path.
 */
export class VSCloneCompletionApiService extends Disposable implements IVSCloneCompletionApiService {
	declare readonly _serviceBrand: undefined;

	private readonly channel: IChannel;

	constructor(
		@IVSCloneOAuthService private readonly oauthService: IVSCloneOAuthService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.channel = mainProcessService.getChannel(VSCLONE_COMPLETION_CHANNEL_NAME);
	}

	async complete(envelope: IVSCloneCompletionPromptEnvelope, selection: IVSCloneModelSelection, token: CancellationToken): Promise<string | undefined> {
		if (token.isCancellationRequested) {
			return undefined;
		}

		const headers = await this.oauthService.getApiHeaders(selection.vendor);
		if (!headers || token.isCancellationRequested) {
			return undefined;
		}

		const requestId = generateUuid();
		const cancellationListener = token.onCancellationRequested(() => {
			// Renderer-side cancellation must explicitly reach the main process so aborted suggestions
			// stop consuming provider quota as soon as a newer keystroke supersedes them.
			void this.channel.call<void>(VSCLONE_COMPLETION_COMMAND_ABORT, { requestId } satisfies IVSCloneCompletionAbortRequest).catch(error => {
				this.logService.debug('[VSCloneCompletionApi] Failed to abort request in main process', error);
			});
		});

		try {
			const response = await this.submitToMainProcess({
				requestId,
				envelope,
				selection,
				headers,
			}, token);
			return response?.rawText;
		} catch (error) {
			if (isCancellationError(error) || token.isCancellationRequested) {
				return undefined;
			}

			this.logService.debug('[VSCloneCompletionApi] Completion request failed.', error);
			return undefined;
		} finally {
			cancellationListener.dispose();
		}
	}

	private async submitToMainProcess(request: IVSCloneCompletionSubmitRequest, token: CancellationToken): Promise<IVSCloneCompletionSubmitResponse | undefined> {
		const response = await this.channel.call<IVSCloneCompletionSubmitResponse>(VSCLONE_COMPLETION_COMMAND_SUBMIT, request, token);
		return token.isCancellationRequested ? undefined : response;
	}
}
