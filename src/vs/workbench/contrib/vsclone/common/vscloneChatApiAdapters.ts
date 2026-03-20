/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defaultOAuthProviderConfig, VSCloneModelVendor } from './vscloneOAuthTypes.js';
import type { VSCloneReasoningEffortLevel } from './vscloneModelCatalogService.js';

// -- Public types --

export interface IVSCloneApiSubmitOptions {
	readonly threadId: string;
	readonly turnId: string;
	readonly sequence: number;
	readonly sessionResource: string;
	readonly promptText: string;
	readonly vendor: VSCloneModelVendor;
	readonly modelId: string;
	readonly modelIdentifier: string;
	readonly reasoningEffort?: VSCloneReasoningEffortLevel;
	readonly previousTurns?: readonly { role: 'user' | 'assistant'; content: string }[];
	readonly systemMessage?: string;
}

export interface IVSCloneVendorAdapterParsedLine {
	readonly type: 'delta' | 'done' | 'error';
	readonly text?: string;
	readonly message?: string;
}

export interface IVSCloneVendorAdapter {
	buildRequest(options: IVSCloneApiSubmitOptions): { url: string; body: Record<string, unknown> };
	parseLine(line: string, currentEventType: string | undefined): IVSCloneVendorAdapterParsedLine | undefined;
}

// -- Catalog-to-API model ID mappings --

const anthropicModelMap: Record<string, string> = {
	'claude-opus-4.5': 'claude-opus-4-5-latest',
	'claude-sonnet-4.5': 'claude-sonnet-4-5-latest',
	'claude-sonnet-4.0': 'claude-sonnet-4-20250514',
};

const googleModelMap: Record<string, string> = {
	'gemini-3-pro': 'gemini-3.0-pro',
	'gemini-2.5-pro': 'gemini-2.5-pro',
	'gemini-2.5-flash': 'gemini-2.5-flash',
	'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
};

function resolveApiModelId(vendor: VSCloneModelVendor, catalogModelId: string): string {
	switch (vendor) {
		case 'anthropic': return anthropicModelMap[catalogModelId] ?? catalogModelId;
		case 'google': return googleModelMap[catalogModelId] ?? catalogModelId;
		default: return catalogModelId;
	}
}

// -- Per-vendor adapters --

function buildMessages(options: IVSCloneApiSubmitOptions): { role: string; content: string }[] {
	const messages: { role: string; content: string }[] = [];
	if (options.previousTurns) {
		for (const turn of options.previousTurns) {
			messages.push({ role: turn.role, content: turn.content });
		}
	}
	messages.push({ role: 'user', content: options.promptText });
	return messages;
}

const defaultSystemMessage = 'You are VSClone, a helpful coding assistant. Answer clearly and concisely.';

/**
 * The OpenAI API only accepts these reasoning effort values.
 * UI-level aliases (e.g. 'standard', 'lite') must be mapped before sending.
 */
type OpenAIReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

function toOpenAIReasoningEffort(level: VSCloneReasoningEffortLevel): OpenAIReasoningEffort {
	switch (level) {
		case 'xhigh': return 'xhigh';
		case 'max': return 'xhigh';
		case 'high': return 'high';
		case 'medium': return 'medium';
		case 'standard': return 'medium';
		case 'low': return 'low';
		case 'minimal': return 'minimal';
		case 'lite': return 'low';
		case 'none': return 'none';
	}
}

const openaiAdapter: IVSCloneVendorAdapter = {
	buildRequest(options: IVSCloneApiSubmitOptions) {
		const apiModelId = resolveApiModelId('openai', options.modelId);
		const input = buildMessages(options).map(m => ({ role: m.role, content: m.content }));
		// The Codex backend rejects requests without a non-empty instructions field.
		// We always provide one so routing stays vendor-agnostic for callers.
		const instructions = options.systemMessage?.trim() || defaultSystemMessage;
		const body: Record<string, unknown> = {
			model: apiModelId,
			instructions,
			// Codex backend for this endpoint explicitly requires opting out of storage.
			store: false,
			input,
			stream: true,
		};

		// Reasoning controls are opt-in and model-gated in the catalog, so we only forward a validated value.
		if (options.reasoningEffort) {
			body.reasoning = { effort: toOpenAIReasoningEffort(options.reasoningEffort) };
		}

		return {
			url: defaultOAuthProviderConfig.openai.apiEndpoint,
			body,
		};
	},

	parseLine(line: string): IVSCloneVendorAdapterParsedLine | undefined {
		if (!line.startsWith('data:')) {
			return undefined;
		}

		const payload = line.slice(5).trim();
		if (payload === '[DONE]') {
			return { type: 'done' };
		}

		try {
			const parsed = JSON.parse(payload);
			if (parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
				return { type: 'delta', text: parsed.delta };
			}
			if (parsed.type === 'response.completed') {
				return { type: 'done' };
			}
			if (parsed.error) {
				return { type: 'error', message: parsed.error.message ?? JSON.stringify(parsed.error) };
			}
		} catch {
			// Unparseable line - ignore
		}

		return undefined;
	},
};

/**
 * Anthropic extended thinking is controlled via a token budget rather than a string level.
 * Returns undefined when thinking should be disabled.
 */
function toAnthropicThinkingBudget(level: VSCloneReasoningEffortLevel, maxTokens: number): number | undefined {
	switch (level) {
		case 'max': return Math.round(maxTokens * 0.9);
		case 'high': return Math.round(maxTokens * 0.8);
		case 'medium': return Math.round(maxTokens * 0.5);
		case 'standard': return Math.round(maxTokens * 0.5);
		case 'low': return Math.round(maxTokens * 0.2);
		default: return undefined;
	}
}

const anthropicAdapter: IVSCloneVendorAdapter = {
	buildRequest(options: IVSCloneApiSubmitOptions) {
		const apiModelId = resolveApiModelId('anthropic', options.modelId);
		const nonSystemMessages = buildMessages(options);

		const anthropicMaxTokens = 16000;
		const thinkingBudget = options.reasoningEffort
			? toAnthropicThinkingBudget(options.reasoningEffort, anthropicMaxTokens)
			: undefined;

		const body: Record<string, unknown> = {
			model: apiModelId,
			messages: nonSystemMessages,
			max_tokens: thinkingBudget ? anthropicMaxTokens : 4096,
			stream: true,
		};

		if (thinkingBudget) {
			body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
			body.temperature = 1;
		}

		body.system = options.systemMessage?.trim() || defaultSystemMessage;

		return {
			url: defaultOAuthProviderConfig.anthropic.apiEndpoint,
			body,
		};
	},

	parseLine(line: string, currentEventType: string | undefined): IVSCloneVendorAdapterParsedLine | undefined {
		if (!line.startsWith('data:')) {
			return undefined;
		}

		const payload = line.slice(5).trim();
		if (!payload) {
			return undefined;
		}

		try {
			const parsed = JSON.parse(payload);

			// Handle content_block_start with initial text
			if (currentEventType === 'content_block_start') {
				const textContent = parsed.content_block;
				if (textContent && textContent.type === 'text' && typeof textContent.text === 'string' && textContent.text.length > 0) {
					return { type: 'delta', text: textContent.text };
				}
				return undefined;
			}

			// Handle content_block_delta
			if (currentEventType === 'content_block_delta') {
				if (parsed.delta?.type === 'text_delta' && typeof parsed.delta.text === 'string') {
					return { type: 'delta', text: parsed.delta.text };
				}
				return undefined;
			}

			// Handle message_stop
			if (currentEventType === 'message_stop') {
				return { type: 'done' };
			}

			// Handle error events
			if (currentEventType === 'error') {
				return { type: 'error', message: parsed.error?.message ?? JSON.stringify(parsed) };
			}
		} catch {
			// Unparseable line - ignore
		}

		return undefined;
	},
};

const googleAdapter: IVSCloneVendorAdapter = {
	buildRequest(options: IVSCloneApiSubmitOptions) {
		const apiModelId = resolveApiModelId('google', options.modelId);
		const messages = buildMessages(options);
		const systemPrompt = options.systemMessage?.trim() || defaultSystemMessage;
		// Gemini v1 endpoint has no dedicated system field, so we inject a leading user turn.
		messages.unshift({ role: 'user', content: `[System]\\n${systemPrompt}` });
		const contents = messages.map(m => ({
			role: m.role === 'assistant' ? 'model' : 'user',
			parts: [{ text: m.content }],
		}));

		const baseUrl = defaultOAuthProviderConfig.google.apiEndpoint;
		// Inject model into URL - Google uses path-based model selection
		const url = baseUrl.replace('/v1internal:', `/v1internal/models/${apiModelId}:`);

		return {
			url,
			body: { contents },
		};
	},

	parseLine(line: string): IVSCloneVendorAdapterParsedLine | undefined {
		if (!line.startsWith('data:')) {
			return undefined;
		}

		const payload = line.slice(5).trim();
		if (payload === '[DONE]') {
			return { type: 'done' };
		}

		try {
			const parsed = JSON.parse(payload);
			const candidates = parsed.candidates;
			if (Array.isArray(candidates) && candidates.length > 0) {
				const candidate = candidates[0];
				if (candidate.finishReason === 'STOP') {
					// May still have final text delta
					const text = candidate.content?.parts?.[0]?.text;
					if (typeof text === 'string' && text.length > 0) {
						return { type: 'delta', text };
					}
					return { type: 'done' };
				}
				const text = candidate.content?.parts?.[0]?.text;
				if (typeof text === 'string') {
					return { type: 'delta', text };
				}
			}
			if (parsed.error) {
				return { type: 'error', message: parsed.error.message ?? JSON.stringify(parsed.error) };
			}
		} catch {
			// Unparseable line - ignore
		}

		return undefined;
	},
};

// -- Dispatch --

const vendorAdapters: Record<VSCloneModelVendor, IVSCloneVendorAdapter> = {
	openai: openaiAdapter,
	anthropic: anthropicAdapter,
	google: googleAdapter,
};

export function getVendorAdapter(vendor: VSCloneModelVendor): IVSCloneVendorAdapter {
	return vendorAdapters[vendor];
}
