/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VSCloneReasoningEffortLevel } from './vscloneModelCapabilities.js';
import type { IVSCloneCompletionPromptEnvelope } from './vscloneCompletionTypes.js';
import type { VSCloneModelVendor } from './vscloneOAuthTypes.js';
import type { VSCloneChatMode } from './vsclonePlanModeTypes.js';

/**
 * This transport intentionally sits one layer below the higher-level chat runtime. Callers hand
 * it already-resolved OAuth auth material from the renderer so the main-process bridge never needs
 * to know about provider settings, secret storage, or token refresh rules.
 */
export const VSCLONE_LLM_MESSAGE_CHANNEL_NAME = 'vscloneLLMMessage';

export const VSCLONE_LLM_MESSAGE_COMMAND_SUBMIT = 'submit';
export const VSCLONE_LLM_MESSAGE_COMMAND_ABORT = 'abort';

export const VSCLONE_LLM_MESSAGE_EVENT_ON_TEXT = 'onText';
export const VSCLONE_LLM_MESSAGE_EVENT_ON_FINAL_MESSAGE = 'onFinalMessage';
export const VSCLONE_LLM_MESSAGE_EVENT_ON_ERROR = 'onError';
export const VSCLONE_LLM_MESSAGE_EVENT_ON_ABORT = 'onAbort';

/**
 * The renderer owns OAuth refresh and per-provider header construction. The transport only needs
 * the final auth material that should be applied to the outgoing network request.
 */
export interface IVSCloneLLMMessageAuthMaterial {
	readonly vendor: VSCloneModelVendor;
	readonly headers: Readonly<Record<string, string>>;
}

export interface IVSCloneOpenAIInputTextContent {
	readonly type: 'text';
	readonly text: string;
}

export interface IVSCloneOpenAIInputImageContent {
	readonly type: 'image_url';
	readonly image_url: {
		readonly url: string;
		readonly detail: 'auto';
	};
}

export interface IVSCloneOpenAILLMToolCall {
	readonly type: 'function';
	readonly id: string;
	readonly function: {
		readonly name: string;
		readonly arguments: string;
	};
}

/**
 * Prepared chat messages deliberately match the provider-native transcript shapes instead of the
 * older `previousTurns + promptText` envelope. That lets the browser convert XML-era history once
 * and keeps the main-process transport focused on OAuth headers plus SDK invocation.
 */
export type IVSCloneOpenAILLMChatMessage =
	| {
		readonly role: 'system' | 'user' | 'developer';
		readonly content: string | readonly (IVSCloneOpenAIInputTextContent | IVSCloneOpenAIInputImageContent)[];
	}
	| {
		readonly role: 'assistant';
		readonly content: string | readonly (IVSCloneLLMMessageReasoningBlock | { readonly type: 'text'; readonly text: string })[];
		readonly tool_calls?: readonly IVSCloneOpenAILLMToolCall[];
	}
	| {
		readonly role: 'tool';
		readonly content: string;
		readonly tool_call_id: string;
	};

export type IVSCloneAnthropicLLMChatMessage =
	| {
		readonly role: 'assistant';
		readonly content: string | readonly (
			| IVSCloneLLMMessageReasoningBlock
			| { readonly type: 'text'; readonly text: string }
			| { readonly type: 'tool_use'; readonly name: string; readonly input: Readonly<Record<string, string>>; readonly id: string }
		)[];
	}
	| {
		readonly role: 'user';
		readonly content: string | readonly (
			| { readonly type: 'text'; readonly text: string }
			| { readonly type: 'image'; readonly source: { readonly type: 'base64'; readonly media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; readonly data: string } }
			| { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string }
		)[];
	};

export type IVSCloneGeminiLLMChatMessage =
	| {
		readonly role: 'model';
		readonly parts: readonly (
			| { readonly text: string }
			| { readonly functionCall: { readonly id: string; readonly name: string; readonly args: Readonly<Record<string, string>> } }
		)[];
	}
	| {
		readonly role: 'user';
		readonly parts: readonly (
			| { readonly text: string }
			| { readonly inlineData: { readonly mimeType: string; readonly data: string } }
			| { readonly functionResponse: { readonly id: string; readonly name: string; readonly response: { readonly output: string } } }
		)[];
	};

export type IVSCloneLLMChatMessage =
	| IVSCloneOpenAILLMChatMessage
	| IVSCloneAnthropicLLMChatMessage
	| IVSCloneGeminiLLMChatMessage;

export interface IVSCloneLLMPreparedChatPayload {
	readonly vendor: VSCloneModelVendor;
	readonly modelId: string;
	readonly modelIdentifier: string;
	readonly mode: VSCloneChatMode;
	readonly reasoningEffort?: VSCloneReasoningEffortLevel;
	/**
	 * Anthropic-style extended thinking opt-in. Defaults to "follow the model's default"; set to
	 * `false` when the caller wants to explicitly suppress the thinking channel even on a capable
	 * model. Separate from `reasoningEffort` so effort-slider models (OpenAI) keep a single field.
	 */
	readonly reasoningEnabled?: boolean;
	/**
	 * Anthropic-style reasoning budget in tokens. Mirrors Void's `ModelSelectionOptions.reasoningBudget`;
	 * routed into Anthropic's `{ thinking: { type: 'enabled', budget_tokens } }` and Gemini's
	 * `thinkingConfig.thinkingBudget`.
	 */
	readonly reasoningBudget?: number;
	readonly messages: readonly IVSCloneLLMChatMessage[];
	readonly separateSystemMessage?: string;
}

export interface IVSCloneLLMMessageChatRequest {
	readonly kind: 'chat';
	readonly auth: IVSCloneLLMMessageAuthMaterial;
	readonly prepared: IVSCloneLLMPreparedChatPayload;
}

/**
 * FIM requests are prepared in the browser for the same reason chat requests are: the editor-side
 * caller already owns prompt shaping, feature policy, and any trimming heuristics, while the main
 * process should stay focused on OAuth headers plus provider I/O.
 */
export interface IVSCloneLLMPreparedFIMPayload {
	readonly vendor: VSCloneModelVendor;
	readonly modelId: string;
	readonly modelIdentifier: string;
	readonly reasoningEffort?: VSCloneReasoningEffortLevel;
	readonly prompt: Pick<
		IVSCloneCompletionPromptEnvelope,
		| 'prefix'
		| 'suffix'
		| 'maxTokens'
		| 'temperature'
		| 'stopTokens'
		| 'systemMessage'
		| 'promptText'
	>;
}

export interface IVSCloneLLMMessageFIMRequest {
	readonly kind: 'fim';
	readonly auth: IVSCloneLLMMessageAuthMaterial;
	readonly prepared: IVSCloneLLMPreparedFIMPayload;
}

export type IVSCloneLLMMessageRequest =
	| IVSCloneLLMMessageChatRequest
	| IVSCloneLLMMessageFIMRequest;

export interface IVSCloneLLMMessageSubmitRequest {
	readonly requestId: string;
	readonly request: IVSCloneLLMMessageRequest;
}

export interface IVSCloneLLMMessageAbortRequest {
	readonly requestId: string;
}

/**
 * Phase 1.2 needs the transport to carry more than plain text so a Void-shaped thread service can
 * react to reasoning/tool metadata without reopening the IPC contract. The current runtime loop
 * still mostly consumes text, but the richer fields keep the transport aligned with Void's shape
 * ahead of the final message-conversion cleanup.
 */
export interface IVSCloneLLMMessageToolCall {
	readonly name: string;
	readonly rawParams: Readonly<Record<string, string>>;
	readonly doneParams: readonly string[];
	readonly id: string;
	readonly isDone: boolean;
}

export type IVSCloneLLMMessageReasoningBlock =
	| {
		readonly type: 'thinking';
		readonly thinking: string;
		readonly signature: string;
	}
	| {
		readonly type: 'redacted_thinking';
		readonly data: unknown;
	};

/**
 * Browser-side observers do not need the request id because the service already routes events back
 * to the matching handle. The IPC event variants below add the request id at the boundary.
 */
export interface IVSCloneLLMMessageTextPayload {
	readonly text: string;
	readonly fullText: string;
	readonly fullReasoning: string;
	readonly toolCall?: IVSCloneLLMMessageToolCall;
}

export interface IVSCloneLLMMessageFinalPayload {
	readonly fullText: string;
	readonly fullReasoning: string;
	readonly toolCall?: IVSCloneLLMMessageToolCall;
	readonly anthropicReasoning: readonly IVSCloneLLMMessageReasoningBlock[] | null;
}

export interface IVSCloneLLMMessageErrorPayload {
	readonly message: string;
}

export interface IVSCloneLLMMessageTextEvent extends IVSCloneLLMMessageTextPayload {
	readonly requestId: string;
}

export interface IVSCloneLLMMessageFinalEvent extends IVSCloneLLMMessageFinalPayload {
	readonly requestId: string;
}

export interface IVSCloneLLMMessageErrorEvent extends IVSCloneLLMMessageErrorPayload {
	readonly requestId: string;
}

export interface IVSCloneLLMMessageAbortEvent {
	readonly requestId: string;
}

export interface IVSCloneLLMMessageObserver {
	readonly onText?: (payload: IVSCloneLLMMessageTextPayload) => void;
	readonly onFinalMessage?: (payload: IVSCloneLLMMessageFinalPayload) => void;
	readonly onError?: (payload: IVSCloneLLMMessageErrorPayload) => void;
	readonly onAbort?: () => void;
}

export interface IVSCloneLLMMessageRequestHandle {
	readonly requestId: string;
	readonly done: Promise<void>;
	cancel(): void;
}
