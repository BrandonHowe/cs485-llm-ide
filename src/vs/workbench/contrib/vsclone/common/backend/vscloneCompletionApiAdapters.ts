/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVSCloneCompletionPromptEnvelope } from '../vscloneCompletionTypes.js';
import { IVSCloneModelSelection } from '../vscloneModelSelectionTypes.js';
import { assertSupportsAnthropicOAuthMessagesModel, getVendorAdapter, resolveVSCloneApiModelId, toOpenAIReasoningEffort } from '../vscloneChatApiAdapters.js';
import { defaultOAuthProviderConfig, VSCloneModelVendor } from '../vscloneOAuthTypes.js';

export type VSCloneCompletionEndpointMode = 'sse';

export interface IVSCloneCompletionAdapterRequest {
	readonly url: string;
	readonly body: Record<string, unknown>;
}

export interface IVSCloneCompletionParsedText {
	readonly type: 'delta' | 'done' | 'error';
	readonly text?: string;
	readonly message?: string;
}

/**
 * Inline completion keeps a dedicated transport path, but it reuses the existing SSE line parsers
 * because the provider stream envelopes are identical to chat for the same vendor endpoints.
 */
export function parseText(vendor: VSCloneModelVendor, payload: string, currentEventType: string | undefined): IVSCloneCompletionParsedText | undefined {
	return getVendorAdapter(vendor).parseLine(payload, currentEventType);
}

/**
 * Dedicated completion requests all use SSE today so the transport can return as soon as the
 * provider stops. Keeping the mode explicit leaves room for future native non-streaming FIM APIs.
 */
export function getEndpointMode(_selection: IVSCloneModelSelection): VSCloneCompletionEndpointMode {
	return 'sse';
}

export function buildRequest(envelope: IVSCloneCompletionPromptEnvelope, selection: IVSCloneModelSelection): IVSCloneCompletionAdapterRequest {
	switch (selection.vendor) {
		case 'openai':
			return buildOpenAIRequest(envelope, selection);
		case 'anthropic':
			return buildAnthropicRequest(envelope, selection);
		case 'google':
			return buildGoogleRequest(envelope, selection);
	}
}

/**
 * GPT-5/Codex-style Responses models reject temperature on this path, so we only forward it for
 * OpenAI families that still expose classical sampling controls.
 */
function supportsOpenAICompletionTemperature(selection: IVSCloneModelSelection): boolean {
	return !selection.modelId.startsWith('gpt-5');
}

function buildOpenAIRequest(envelope: IVSCloneCompletionPromptEnvelope, selection: IVSCloneModelSelection): IVSCloneCompletionAdapterRequest {
	const apiModelId = resolveVSCloneApiModelId('openai', selection.modelId);
	const body: Record<string, unknown> = {
		model: apiModelId,
		instructions: envelope.systemMessage,
		store: false,
		input: [{ role: 'user', content: envelope.promptText }],
		stream: true,
	};

	if (supportsOpenAICompletionTemperature(selection) && envelope.temperature !== undefined) {
		body.temperature = envelope.temperature;
	}
	if (selection.reasoningEffort) {
		body.reasoning = { effort: toOpenAIReasoningEffort(selection.reasoningEffort) };
	}

	return {
		url: defaultOAuthProviderConfig.openai.apiEndpoint,
		body,
	};
}

function buildAnthropicRequest(envelope: IVSCloneCompletionPromptEnvelope, selection: IVSCloneModelSelection): IVSCloneCompletionAdapterRequest {
	const apiModelId = resolveVSCloneApiModelId('anthropic', selection.modelId);
	assertSupportsAnthropicOAuthMessagesModel(apiModelId);
	const stopSequences = sanitizeAnthropicStopSequences(envelope.stopTokens);

	// Anthropic rejects stop sequences that contain only whitespace, which is exactly what the
	// single-line completion prompt uses to stop at the next newline. Sanitize that vendor-specific
	// constraint here so prompt construction can stay transport-agnostic across providers.
	const body: Record<string, unknown> = {
		model: apiModelId,
		system: envelope.systemMessage,
		messages: [{ role: 'user', content: envelope.promptText }],
		max_tokens: envelope.maxTokens,
		temperature: envelope.temperature,
		stream: true,
	};
	if (stopSequences.length > 0) {
		body.stop_sequences = stopSequences;
	}

	return {
		url: defaultOAuthProviderConfig.anthropic.apiEndpoint,
		body,
	};
}

function sanitizeAnthropicStopSequences(stopTokens: readonly string[]): readonly string[] {
	return stopTokens.filter(stopToken => stopToken.trim().length > 0);
}

function buildGoogleRequest(envelope: IVSCloneCompletionPromptEnvelope, selection: IVSCloneModelSelection): IVSCloneCompletionAdapterRequest {
	const apiModelId = resolveVSCloneApiModelId('google', selection.modelId);
	const baseUrl = defaultOAuthProviderConfig.google.apiEndpoint;
	const url = `${baseUrl}/${apiModelId}:streamGenerateContent?alt=sse`;

	return {
		url,
		body: {
			// The public Gemini REST API accepts a dedicated `systemInstruction` block, which avoids
			// polluting the user prompt with transport-only scaffolding.
			systemInstruction: {
				parts: [{
					text: envelope.systemMessage,
				}],
			},
			contents: [{
				role: 'user',
				parts: [{
					text: envelope.promptText,
				}],
			}],
			generationConfig: {
				maxOutputTokens: envelope.maxTokens,
				temperature: envelope.temperature,
				stopSequences: [...envelope.stopTokens],
			},
		},
	};
}
