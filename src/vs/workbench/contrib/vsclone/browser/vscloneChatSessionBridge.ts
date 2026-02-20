/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { ResponseModelState } from '../../chat/common/chatService/chatService.js';
import { IChatModel, IChatRequestModel, IChatResponseModel } from '../../chat/common/model/chatModel.js';
import { getPromptText } from '../../chat/common/requestParser/chatParserTypes.js';
import { deriveThreadId } from '../common/vscloneChatHistoryModel.js';
import { IVSCloneChatTurnUpdate, VSCloneChatTurnPhase } from '../common/vscloneChatHistoryService.js';

interface IRequestState {
	sequence: number;
	lastPlainText: string;
	lastMarkdown: string;
	lastPhase: VSCloneChatTurnPhase | undefined;
	responseListener: IDisposable | undefined;
}

function toPromptText(request: IChatRequestModel): string {
	const parsedPrompt = getPromptText(request.message).message;
	if (parsedPrompt.trim().length > 0) {
		return parsedPrompt;
	}

	return request.message.text.trim();
}

function toThreadTitle(model: IChatModel): string | undefined {
	if (model.hasCustomTitle && model.title.trim().length > 0) {
		return model.title.trim();
	}

	return undefined;
}

function toPhase(response: IChatResponseModel): VSCloneChatTurnPhase {
	switch (response.state) {
		case ResponseModelState.Complete:
			return 'complete';
		case ResponseModelState.Cancelled:
			return 'cancel';
		case ResponseModelState.Failed:
			return 'error';
		case ResponseModelState.Pending:
		case ResponseModelState.NeedsInput:
		default:
			return 'stream';
	}
}

function toOccurredAt(request: IChatRequestModel, response: IChatResponseModel): number {
	if (response.completedAt) {
		return response.completedAt;
	}

	return Math.max(request.timestamp, Date.now());
}

export class VSCloneChatSessionBridge extends Disposable {
	private readonly _onDidEmitTurnUpdate = this._register(new Emitter<IVSCloneChatTurnUpdate>());
	readonly onDidEmitTurnUpdate: Event<IVSCloneChatTurnUpdate> = this._onDidEmitTurnUpdate.event;

	private readonly requestStateById = new Map<string, IRequestState>();
	private nextSequence = 1;

	constructor(
		private readonly model: IChatModel,
	) {
		super();

		this.initializeFromModel();
		this._register(this.model.onDidChange(event => this.onModelDidChange(event.kind)));
	}

	private initializeFromModel(): void {
		for (const request of this.model.getRequests()) {
			this.ensureRequestState(request);
			this.emitPrompt(request);
			this.ensureResponseListener(request);
			this.emitResponseSnapshot(request);
		}
	}

	private onModelDidChange(kind: string): void {
		switch (kind) {
			case 'addRequest':
			case 'changedRequest':
			case 'completedRequest':
			case 'addResponse': {
				for (const request of this.model.getRequests()) {
					this.ensureRequestState(request);
					this.emitPrompt(request);
					this.ensureResponseListener(request);
					this.emitResponseSnapshot(request);
				}
				break;
			}
			case 'removeRequest': {
				const liveRequestIds = new Set(this.model.getRequests().map(request => request.id));
				for (const [requestId, state] of [...this.requestStateById]) {
					if (!liveRequestIds.has(requestId)) {
						state.responseListener?.dispose();
						this.requestStateById.delete(requestId);
					}
				}
				break;
			}
		}
	}

	private ensureRequestState(request: IChatRequestModel): IRequestState {
		let state = this.requestStateById.get(request.id);
		if (state) {
			return state;
		}

		state = {
			sequence: this.nextSequence++,
			lastPlainText: '',
			lastMarkdown: '',
			lastPhase: undefined,
			responseListener: undefined,
		};
		this.requestStateById.set(request.id, state);
		return state;
	}

	private ensureResponseListener(request: IChatRequestModel): void {
		const response = request.response;
		if (!response) {
			return;
		}

		const state = this.ensureRequestState(request);
		if (state.responseListener) {
			return;
		}

		state.responseListener = this._register(response.onDidChange(() => {
			this.emitResponseSnapshot(request);
		}));
	}

	private emitPrompt(request: IChatRequestModel): void {
		const state = this.ensureRequestState(request);
		if (state.lastPhase) {
			return;
		}

		const sessionResource = request.session.sessionResource.toString();
		const threadId = deriveThreadId(sessionResource);
		this._onDidEmitTurnUpdate.fire({
			threadId,
			turnId: request.id,
			sequence: state.sequence,
			sessionResource,
			phase: 'prompt',
			occurredAt: request.timestamp,
			promptText: toPromptText(request),
			threadTitle: toThreadTitle(request.session),
			modelIdentifier: request.modelId,
		});
		state.lastPhase = 'prompt';
	}

	private emitResponseSnapshot(request: IChatRequestModel): void {
		const response = request.response;
		if (!response) {
			return;
		}

		const state = this.ensureRequestState(request);
		const phase = toPhase(response);
		const plainText = response.response.toString();
		const markdown = response.response.getMarkdown();
		const plainTextChanged = plainText !== state.lastPlainText;
		const markdownChanged = markdown !== state.lastMarkdown;
		const phaseChanged = phase !== state.lastPhase;

		if (!plainTextChanged && !markdownChanged && !phaseChanged) {
			return;
		}

		const sessionResource = request.session.sessionResource.toString();
		const threadId = deriveThreadId(sessionResource);
		const update: IVSCloneChatTurnUpdate = {
			threadId,
			turnId: request.id,
			sequence: state.sequence,
			sessionResource,
			phase,
			occurredAt: toOccurredAt(request, response),
			promptText: toPromptText(request),
			threadTitle: toThreadTitle(request.session),
			modelIdentifier: request.modelId,
		};

		if (plainTextChanged) {
			if (plainText.startsWith(state.lastPlainText)) {
				update.responsePlainTextDelta = plainText.slice(state.lastPlainText.length);
			} else {
				update.responsePlainTextReplace = plainText;
			}
		}

		if (markdownChanged) {
			if (markdown.startsWith(state.lastMarkdown)) {
				update.responseMarkdownDelta = markdown.slice(state.lastMarkdown.length);
			} else {
				update.responseMarkdownReplace = markdown;
			}
		}

		this._onDidEmitTurnUpdate.fire(update);
		state.lastPlainText = plainText;
		state.lastMarkdown = markdown;
		state.lastPhase = phase;
	}
}
