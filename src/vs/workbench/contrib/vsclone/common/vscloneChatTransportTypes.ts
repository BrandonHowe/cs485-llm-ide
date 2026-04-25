/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IVSCloneContextSelection } from './vscloneContextSelectionTypes.js';
import type { IVSCloneLLMMessageReasoningBlock } from './vscloneLLMMessageTypes.js';
import type { VSCloneReasoningEffortLevel } from './vscloneModelCapabilities.js';
import type { VSCloneModelVendor } from './vscloneOAuthTypes.js';
import type { VSCloneChatMode } from './vsclonePlanModeTypes.js';
import type { IVSCloneToolDefinition } from './vscloneToolDefinitions.js';

/**
 * Image attachments are persisted as base64 payloads so restored runtime turns can reconstruct
 * the exact multimodal prompt the model originally received without depending on transient blob
 * URLs. The type now lives on the shared transport seam because images are part of that seam.
 */
export interface IVSCloneImageAttachment {
	readonly mimeType: string;
	readonly base64Data: string;
}

export function toVSCloneImageDataUrl(image: IVSCloneImageAttachment): string {
	return `data:${image.mimeType};base64,${image.base64Data}`;
}

/**
 * This is the renderer/runtime-side chat transcript seam that survives after the old chat API
 * facade was removed. It deliberately stays transport-focused and auth-blind: callers resolve the
 * model/vendor/system prompt first, then pass the already-shaped conversation here for conversion
 * into provider-native LLM payloads.
 */
export type IVSCloneChatTransportConversationMessage =
	| {
		readonly role: 'user';
		readonly content: string;
		readonly imageAttachments?: readonly IVSCloneImageAttachment[];
		/**
		 * User-picked context (files, folders, code selections) attached to this turn. Preserved on the
		 * transport message so replay of previous turns keeps chip metadata without re-parsing the
		 * serialized SELECTIONS block back out of `content`.
		 */
		readonly contextSelections?: readonly IVSCloneContextSelection[];
	}
	| {
		readonly role: 'assistant';
		readonly content: string;
		/**
		 * Anthropic-specific signed reasoning blocks. Mirrors Void's assistant-turn
		 * `anthropicReasoning` field. When present, the convert seam prepends them as `thinking`/
		 * `redacted_thinking` content blocks on Anthropic requests so the server-issued signatures
		 * stay intact across follow-up iterations.
		 */
		readonly anthropicReasoning?: readonly IVSCloneLLMMessageReasoningBlock[] | null;
	}
	| {
		// Tool history is now carried structurally instead of being re-inferred from assistant XML.
		// The same tool/result tuple can therefore be replayed across providers without reparsing the
		// assistant transcript on every follow-up send.
		readonly role: 'tool';
		readonly id: string;
		readonly name: string;
		readonly rawParams: Readonly<Record<string, string>>;
		readonly content: string;
	};

/**
 * The current turn is explicit because runtime loops can now continue from either a new user
 * prompt or a just-finished tool result. Keeping that union in one seam avoids pushing provider-
 * specific tool-result replay logic back into the runtime service.
 */
export interface IVSCloneChatTransportRequestOptions {
	readonly threadId: string;
	readonly turnId: string;
	readonly sequence: number;
	readonly sessionResource: string;
	readonly mode: VSCloneChatMode;
	readonly vendor: VSCloneModelVendor;
	readonly modelId: string;
	readonly modelIdentifier: string;
	readonly reasoningEffort?: VSCloneReasoningEffortLevel;
	/**
	 * Mirrors Void's `ModelSelectionOptions.reasoningEnabled`. Forwarded from the selection so the
	 * prepared payload can surface it to the provider adapter that decides whether to include a
	 * `thinking` or `reasoning` fragment on the request.
	 */
	readonly reasoningEnabled?: boolean;
	/**
	 * Mirrors Void's `ModelSelectionOptions.reasoningBudget` for raw budget-slider providers. Haiku
	 * and Gemini use preset model selections now, so this is usually undefined for built-in models.
	 */
	readonly reasoningBudget?: number;
	readonly previousTurns?: readonly IVSCloneChatTransportConversationMessage[];
	readonly currentTurn: IVSCloneChatTransportConversationMessage;
	readonly systemMessage?: string;
	readonly toolDefinitions?: readonly IVSCloneToolDefinition[];
}
