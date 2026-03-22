/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */
// Preserve provider wire constants verbatim here because model ids, SSE event names, roles, and
// endpoint fragments are protocol data. Localizing or abstracting them away would make drift from
// the upstream APIs harder to detect.

import {
	defaultOAuthProviderConfig,
	VSCloneModelVendor,
} from "./vscloneOAuthTypes.js";
import type { VSCloneReasoningEffortLevel } from "./vscloneModelCatalogService.js";
import type { IVSCloneImageAttachment } from "./vscloneImageAttachmentTypes.js";

// -- Public types --

export interface IVSCloneApiConversationMessage {
	readonly role: "user" | "assistant";
	readonly content: string;
	readonly imageAttachments?: readonly IVSCloneImageAttachment[];
}

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
	readonly previousTurns?: readonly IVSCloneApiConversationMessage[];
	readonly systemMessage?: string;
	readonly imageAttachments?: readonly IVSCloneImageAttachment[];
}

export interface IVSCloneVendorAdapterParsedLine {
	readonly type: "delta" | "done" | "error";
	readonly text?: string;
	readonly message?: string;
}

export interface IVSCloneVendorAdapter {
	buildRequest(options: IVSCloneApiSubmitOptions): {
		url: string;
		body: Record<string, unknown>;
	};
	parseLine(
		line: string,
		currentEventType: string | undefined,
	): IVSCloneVendorAdapterParsedLine | undefined;
}

// -- Catalog-to-API model ID mappings --

const anthropicModelMap: Record<string, string> = {
	// Keep translating older picker IDs to Anthropic's current provider-facing model IDs so restored
	// selections and completion transports do not depend on legacy aliases that the live API no
	// longer documents in `/v1/models`.
	"claude-opus-4.6": "claude-opus-4-6",
	"claude-sonnet-4.6": "claude-sonnet-4-6",
	"claude-sonnet-4.0": "claude-sonnet-4-20250514",
	"claude-haiku-4.5": "claude-haiku-4-5-20251001",
};

const googleModelMap: Record<string, string> = {
	// Keep the legacy picker/storage id stable so existing thread selections continue to resolve
	// after Google's March 2026 shutdown of Gemini 3 Pro Preview. The live provider-facing model
	// id is the 3.1 replacement, so requests must target that newer preview name instead.
	"gemini-3.1-pro-preview": "gemini-3.1-pro-preview",
	// Google's current public Flash entry is still exposed under a preview-flavored model id, so
	// the picker keeps a stable catalog id while the transport targets the live provider alias.
	"gemini-3-flash-preview": "gemini-3-flash-preview",
	"gemini-3.1-flash-lite-preview": "gemini-3.1-flash-lite-preview",
	"gemini-2.5-pro": "gemini-2.5-pro",
	"gemini-2.5-flash": "gemini-2.5-flash",
	"gemini-2.5-flash-lite": "gemini-2.5-flash-lite",
};

const supportedAnthropicOAuthMessagesModelIds = new Set<string>([
	"claude-haiku-4-5-20251001",
	"claude-3-haiku-20240307",
]);

/**
 * Provider-facing IDs occasionally drift from the catalog IDs exposed in the picker. Keeping the
 * translation in one shared helper prevents chat and inline completion transports from disagreeing
 * about which concrete model should receive a request.
 */
export function resolveVSCloneApiModelId(
	vendor: VSCloneModelVendor,
	catalogModelId: string,
): string {
	switch (vendor) {
		case "anthropic":
			return anthropicModelMap[catalogModelId] ?? catalogModelId;
		case "google":
			return googleModelMap[catalogModelId] ?? catalogModelId;
		default:
			return catalogModelId;
	}
}

/**
 * VSClone's Anthropic integration currently authenticates through the OAuth beta rather than
 * standard API keys. Live probing shows that this path accepts Haiku models but rejects the
 * Claude 4 Sonnet/Opus families with a generic 400, so we fail fast with an actionable message
 * whenever a stale selection bypasses catalog reconciliation.
 */
export function assertSupportsAnthropicOAuthMessagesModel(
	modelId: string,
): void {
	if (!supportedAnthropicOAuthMessagesModelIds.has(modelId)) {
		throw new Error(
			"Anthropic OAuth messages currently support only Claude Haiku 4.5 and Claude Haiku 3 in VSClone. Re-select an Anthropic Haiku model.",
		);
	}
}

// -- Per-vendor adapters --

function buildMessages(
	options: IVSCloneApiSubmitOptions,
): IVSCloneApiConversationMessage[] {
	const messages: IVSCloneApiConversationMessage[] = [];
	if (options.previousTurns) {
		for (const turn of options.previousTurns) {
			messages.push({
				role: turn.role,
				content: turn.content,
				imageAttachments: turn.imageAttachments,
			});
		}
	}
	// The transport rebuilds the whole conversation on every request, so the current user message
	// keeps its attachments here instead of relying on a parallel "latest only" channel.
	messages.push({
		role: "user",
		content: options.promptText,
		imageAttachments: options.imageAttachments,
	});
	return messages;
}

function buildOpenAIMultimodalContent(
	text: string,
	images: readonly IVSCloneImageAttachment[],
): unknown[] {
	const parts: unknown[] = [{
		type: "input_text",
		text: `${buildImageAttachmentNotice(images.length)}\n\n${text}`,
	}];
	for (const img of images) {
		parts.push({
			type: "input_image",
			image_url: `data:${img.mimeType};base64,${img.base64Data}`,
			detail: "auto",
		});
	}
	return parts;
}

function buildAnthropicMultimodalContent(
	text: string,
	images: readonly IVSCloneImageAttachment[],
): unknown[] {
	const parts: unknown[] = [];
	for (const img of images) {
		parts.push({
			type: "image",
			source: { type: "base64", media_type: img.mimeType, data: img.base64Data },
		});
	}
	parts.push({
		type: "text",
		text: `${buildImageAttachmentNotice(images.length)}\n\n${text}`,
	});
	return parts;
}

function buildGoogleMultimodalParts(
	text: string,
	images: readonly IVSCloneImageAttachment[],
): unknown[] {
	const parts: unknown[] = [];
	for (const img of images) {
		parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64Data } });
	}
	parts.push({ text: `${buildImageAttachmentNotice(images.length)}\n\n${text}` });
	return parts;
}

function buildImageAttachmentNotice(imageCount: number): string {
	const noun = imageCount === 1 ? "image attachment" : "image attachments";
	const pronoun = imageCount === 1 ? "it" : "them";
	return `This user turn includes ${imageCount} ${noun}. Inspect ${pronoun} directly when answering.`;
}

const defaultSystemMessage =
	[
		"You are VSClone, a helpful coding assistant. Answer clearly and concisely.",
		"User turns may include image attachments in addition to text. Inspect attached images directly when they are present.",
		"Do not claim a request was text-only unless no image attachments were provided or the runtime reports an image-processing failure.",
	].join(" ");

/**
 * The OpenAI API only accepts these reasoning effort values.
 * UI-level aliases (e.g. 'standard', 'lite') must be mapped before sending.
 */
type OpenAIReasoningEffort =
	| "none"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

export function toOpenAIReasoningEffort(
	level: VSCloneReasoningEffortLevel,
): OpenAIReasoningEffort {
	switch (level) {
		case "xhigh":
			return "xhigh";
		case "max":
			return "xhigh";
		case "high":
			return "high";
		case "medium":
			return "medium";
		case "standard":
			return "medium";
		case "low":
			return "low";
		case "minimal":
			return "minimal";
		case "lite":
			return "low";
		case "none":
			return "none";
	}
}

const openaiAdapter: IVSCloneVendorAdapter = {
	buildRequest(options: IVSCloneApiSubmitOptions) {
		const apiModelId = resolveVSCloneApiModelId("openai", options.modelId);
		const rawMessages = buildMessages(options);
		const input = rawMessages.map(m => {
			const hasImages = m.role === "user" && !!m.imageAttachments?.length;
			return {
				type: "message" as const,
				role: m.role,
				content: hasImages
					? buildOpenAIMultimodalContent(m.content, m.imageAttachments!)
					: m.content,
			};
		});
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
			body.reasoning = {
				effort: toOpenAIReasoningEffort(options.reasoningEffort),
			};
		}

		return {
			url: defaultOAuthProviderConfig.openai.apiEndpoint,
			body,
		};
	},

	parseLine(line: string): IVSCloneVendorAdapterParsedLine | undefined {
		if (!line.startsWith("data:")) {
			return undefined;
		}

		const payload = line.slice(5).trim();
		if (payload === "[DONE]") {
			return { type: "done" };
		}

		try {
			const parsed = JSON.parse(payload);
			if (
				parsed.type === "response.output_text.delta" &&
				typeof parsed.delta === "string"
			) {
				return { type: "delta", text: parsed.delta };
			}
			if (parsed.type === "response.completed") {
				return { type: "done" };
			}
			if (parsed.error) {
				return {
					type: "error",
					message: parsed.error.message ?? JSON.stringify(parsed.error),
				};
			}
		} catch {
			// Unparseable line - ignore
		}

		return undefined;
	},
};

const anthropicAdapter: IVSCloneVendorAdapter = {
	buildRequest(options: IVSCloneApiSubmitOptions) {
		const apiModelId = resolveVSCloneApiModelId("anthropic", options.modelId);
		assertSupportsAnthropicOAuthMessagesModel(apiModelId);
		const rawMessages = buildMessages(options);
		const nonSystemMessages = rawMessages.map(m => {
			const hasImages = m.role === "user" && !!m.imageAttachments?.length;
			return {
				role: m.role,
				content: hasImages
					? buildAnthropicMultimodalContent(m.content, m.imageAttachments!)
					: m.content,
			};
		});

		const systemText = options.systemMessage?.trim() || defaultSystemMessage;
		const body: Record<string, unknown> = {
			model: apiModelId,
			messages: nonSystemMessages,
			max_tokens: 16384,
			stream: true,
			// Keep the default chat transport on the stable Messages shape until we preserve Anthropic
			// thinking/tool blocks end-to-end. Sending `thinking` here opts every request into a more
			// complex response contract that the rest of this pipeline does not yet round-trip safely.
			system: systemText,
		};

		return {
			url: defaultOAuthProviderConfig.anthropic.apiEndpoint,
			body,
		};
	},

	parseLine(
		line: string,
		currentEventType: string | undefined,
	): IVSCloneVendorAdapterParsedLine | undefined {
		if (!line.startsWith("data:")) {
			return undefined;
		}

		const payload = line.slice(5).trim();
		if (!payload) {
			return undefined;
		}

		try {
			const parsed = JSON.parse(payload);

			// Handle content_block_start with initial text
			if (currentEventType === "content_block_start") {
				const textContent = parsed.content_block;
				if (
					textContent &&
					textContent.type === "text" &&
					typeof textContent.text === "string" &&
					textContent.text.length > 0
				) {
					return { type: "delta", text: textContent.text };
				}
				return undefined;
			}

			// Handle content_block_delta
			if (currentEventType === "content_block_delta") {
				if (
					parsed.delta?.type === "text_delta" &&
					typeof parsed.delta.text === "string"
				) {
					return { type: "delta", text: parsed.delta.text };
				}
				return undefined;
			}

			// Handle message_stop
			if (currentEventType === "message_stop") {
				return { type: "done" };
			}

			// Handle error events
			if (currentEventType === "error") {
				return {
					type: "error",
					message: parsed.error?.message ?? JSON.stringify(parsed),
				};
			}
		} catch {
			// Unparseable line - ignore
		}

		return undefined;
	},
};

const googleAdapter: IVSCloneVendorAdapter = {
	buildRequest(options: IVSCloneApiSubmitOptions) {
		const apiModelId = resolveVSCloneApiModelId("google", options.modelId);
		const messages = buildMessages(options);
		const systemPrompt = options.systemMessage?.trim() || defaultSystemMessage;
		const contents = messages.map(m => {
			const hasImages = m.role === "user" && !!m.imageAttachments?.length;
			return {
				role: m.role === "assistant" ? "model" : "user",
				parts: hasImages
					? buildGoogleMultimodalParts(m.content, m.imageAttachments!)
					: [{ text: m.content }],
			};
		});

		const baseUrl = defaultOAuthProviderConfig.google.apiEndpoint;
		// The public Gemini REST API addresses models under `/models/{model}:streamGenerateContent`
		// and supports a first-class `systemInstruction`, so we no longer need the legacy
		// Cloud Code-specific URL rewriting or synthetic "[System]" user turn.
		const url = `${baseUrl}/${apiModelId}:streamGenerateContent?alt=sse`;

		return {
			url,
			body: {
				systemInstruction: {
					parts: [{ text: systemPrompt }],
				},
				contents,
			},
		};
	},

	parseLine(line: string): IVSCloneVendorAdapterParsedLine | undefined {
		if (!line.startsWith("data:")) {
			return undefined;
		}

		const payload = line.slice(5).trim();
		if (payload === "[DONE]") {
			return { type: "done" };
		}

		try {
			const parsed = JSON.parse(payload);
			if (parsed.error) {
				return {
					type: "error",
					message: parsed.error.message ?? JSON.stringify(parsed.error) ?? "Google completion request failed.",
				};
			}
			const promptFeedbackMessage = getGooglePromptFeedbackErrorMessage(parsed);
			if (promptFeedbackMessage) {
				return {
					type: "error",
					message: promptFeedbackMessage,
				};
			}
			const candidates = parsed.candidates;
			if (Array.isArray(candidates) && candidates.length > 0) {
				const candidate = candidates[0];
				const text = getGoogleCandidateText(candidate);
				if (candidate.finishReason === "STOP" || candidate.finishReason === "MAX_TOKENS") {
					if (typeof text === "string" && text.length > 0) {
						return { type: "delta", text };
					}
					return { type: "done" };
				}
				if (typeof text === "string" && text.length > 0) {
					return { type: "delta", text };
				}
				const finishReasonMessage = getGoogleFinishReasonErrorMessage(candidate);
				if (finishReasonMessage) {
					return {
						type: "error",
						message: finishReasonMessage,
					};
				}
			}
		} catch {
			// Unparseable line - ignore
		}

		return undefined;
	},
};

function getGoogleCandidateText(
	candidate: { content?: { parts?: Array<{ text?: string }> } } | undefined,
): string | undefined {
	const parts = candidate?.content?.parts;
	if (!Array.isArray(parts) || parts.length === 0) {
		return undefined;
	}

	const text = parts
		.map(part => typeof part.text === "string" ? part.text : "")
		.join("");
	return text.length > 0 ? text : undefined;
}

function getGooglePromptFeedbackErrorMessage(
	parsed: { promptFeedback?: { blockReason?: string; blockReasonMessage?: string } },
): string | undefined {
	const blockReason = parsed.promptFeedback?.blockReason;
	if (!blockReason) {
		return undefined;
	}

	const blockReasonMessage = parsed.promptFeedback?.blockReasonMessage?.trim();
	return blockReasonMessage
		? `Google completion blocked: ${blockReason} (${blockReasonMessage}).`
		: `Google completion blocked: ${blockReason}.`;
}

function getGoogleFinishReasonErrorMessage(
	candidate: { finishReason?: string; finishMessage?: string } | undefined,
): string | undefined {
	const finishReason = candidate?.finishReason;
	if (!finishReason || finishReason === "STOP" || finishReason === "MAX_TOKENS") {
		return undefined;
	}

	const finishMessage = candidate?.finishMessage?.trim();
	return finishMessage
		? `Google completion finished with ${finishReason}: ${finishMessage}.`
		: `Google completion finished with ${finishReason}.`;
}

// -- Dispatch --

const vendorAdapters: Record<VSCloneModelVendor, IVSCloneVendorAdapter> = {
	openai: openaiAdapter,
	anthropic: anthropicAdapter,
	google: googleAdapter,
};

export function getVendorAdapter(
	vendor: VSCloneModelVendor,
): IVSCloneVendorAdapter {
	return vendorAdapters[vendor];
}
