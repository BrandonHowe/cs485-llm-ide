/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSCloneModelVendor } from './vscloneMockProviderService.js';
import { defaultOAuthProviderConfig } from './vscloneOAuthTypes.js';
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
	'claude-3.5-sonnet': 'claude-sonnet-4-20250514',
	'claude-3-opus': 'claude-opus-4-20250514',
	'claude-3-haiku': 'claude-3-5-haiku-20241022',
};

const googleModelMap: Record<string, string> = {
	'gemini-pro-2.0': 'gemini-2.0-pro',
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
			body.reasoning = { effort: options.reasoningEffort };
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

const anthropicAdapter: IVSCloneVendorAdapter = {
	buildRequest(options: IVSCloneApiSubmitOptions) {
		const apiModelId = resolveApiModelId('anthropic', options.modelId);
		const nonSystemMessages = buildMessages(options);

		const body: Record<string, unknown> = {
			model: apiModelId,
			messages: nonSystemMessages,
			max_tokens: 4096,
			stream: true,
		};

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
