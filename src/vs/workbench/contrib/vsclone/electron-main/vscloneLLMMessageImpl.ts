/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { hasKey } from '../../../../base/common/types.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import {
	defaultOAuthProviderConfig,
	type VSCloneModelVendor,
} from '../common/vscloneOAuthTypes.js';
import {
	type IVSCloneAnthropicLLMChatMessage,
	type IVSCloneGeminiLLMChatMessage,
	IVSCloneLLMMessageAuthMaterial,
	IVSCloneLLMMessageErrorPayload,
	IVSCloneLLMMessageFinalPayload,
	type IVSCloneLLMMessageReasoningBlock,
	type IVSCloneLLMMessageToolCall,
	type IVSCloneLLMPreparedFIMPayload,
	type IVSCloneLLMPreparedChatPayload,
	IVSCloneLLMMessageRequest,
	IVSCloneLLMMessageTextPayload,
	type IVSCloneOpenAILLMChatMessage,
} from '../common/vscloneLLMMessageTypes.js';
import {
	getVSCloneProviderReasoningIOSettings,
	getVSCloneReservedOutputTokenSpaceForReasoning,
	getVSCloneSendableReasoningInfo,
	type VSCloneSendableReasoningInfo,
} from '../common/vscloneModelCapabilities.js';
import { getVSCloneVisibleToolDefinitions, toVSCloneToolJsonSchema, type IVSCloneToolJsonSchema } from '../common/vscloneToolDefinitions.js';

interface IVSCloneLLMMessageCallbacks {
	readonly onText: (payload: IVSCloneLLMMessageTextPayload) => void;
	readonly onFinalMessage: (payload: IVSCloneLLMMessageFinalPayload) => void;
	readonly onError: (payload: IVSCloneLLMMessageErrorPayload) => void;
	readonly onAbort: () => void;
}

type VSCloneAnthropicMessage = import('@anthropic-ai/sdk').default.Message;
type VSCloneAnthropicTool = import('@anthropic-ai/sdk').default.Messages.Tool;
type VSCloneAnthropicToolInputSchema = VSCloneAnthropicTool['input_schema'];
type VSCloneGoogleCandidate = NonNullable<import('@google/genai').GenerateContentResponse['candidates']>[number];
type VSCloneGoogleFunctionDeclaration = import('@google/genai').FunctionDeclaration;
type VSCloneGoogleFunctionCallingConfigMode = import('@google/genai').FunctionCallingConfigMode;
type VSCloneGoogleSchema = import('@google/genai').Schema;
type VSCloneGoogleSchemaType = import('@google/genai').Type;
type VSCloneFIMEndpointMode = 'sse';
type VSCloneGoogleGenAIConstructor = typeof import('@google/genai').GoogleGenAI;
type VSCloneOpenAIFunctionTool = import('openai').default.Responses.FunctionTool;
type VSCloneOpenAIResponse = import('openai').default.Responses.Response;
type VSCloneOpenAIResponseOutputItem = import('openai').default.Responses.ResponseOutputItem;

export interface IVSCloneFIMTransportRequest {
	readonly url: string;
	readonly body: Record<string, unknown>;
}

interface IFIMStreamState {
	currentEventType: string | undefined;
}

const anthropicModelMap: Record<string, string> = {
	'claude-opus-4.6': 'claude-opus-4-6',
	'claude-sonnet-4.6': 'claude-sonnet-4-6',
	'claude-sonnet-4.0': 'claude-sonnet-4-20250514',
	'claude-haiku-4.5': 'claude-haiku-4-5-20251001',
};

const googleModelMap: Record<string, string> = {
	'gemini-3.1-pro-preview': 'gemini-3.1-pro-preview',
	'gemini-3-flash-preview': 'gemini-3-flash-preview',
	'gemini-3.1-flash-lite-preview': 'gemini-3.1-flash-lite-preview',
	'gemini-2.5-pro': 'gemini-2.5-pro',
	'gemini-2.5-flash': 'gemini-2.5-flash',
	'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
};

// Mirror the SDK enum payloads locally so the request builders stay serializable without forcing
// renderer-imported tests to eagerly parse the Google SDK just to read constant values.
const googleFunctionCallingConfigModeAuto = 'AUTO' as VSCloneGoogleFunctionCallingConfigMode;
const googleSchemaTypeObject = 'OBJECT' as VSCloneGoogleSchemaType;
const googleSchemaTypeString = 'STRING' as VSCloneGoogleSchemaType;
const googleSchemaTypeNumber = 'NUMBER' as VSCloneGoogleSchemaType;
const googleSchemaTypeInteger = 'INTEGER' as VSCloneGoogleSchemaType;
const googleSchemaTypeBoolean = 'BOOLEAN' as VSCloneGoogleSchemaType;
const googleSchemaTypeArray = 'ARRAY' as VSCloneGoogleSchemaType;

const supportedAnthropicOAuthMessagesModelIds = new Set<string>([
	'claude-haiku-4-5-20251001',
	'claude-3-haiku-20240307',
]);

const defaultSystemMessage =
	[
		'You are VSClone, a helpful coding assistant. Answer clearly and concisely.',
		'User turns may include image attachments in addition to text. Inspect attached images directly when they are present.',
		'Do not claim a request was text-only unless no image attachments were provided or the runtime reports an image-processing failure.',
	].join(' ');

/**
 * Phase 1.1 owns each provider request end-to-end through its native SDK. We still reuse the
 * shared model-id and reasoning helpers from the common adapter layer so chat and completion
 * transports stay aligned, but the live message path no longer wraps the legacy SSE parser.
 */
export async function sendVSCloneLLMMessage(
	request: IVSCloneLLMMessageRequest,
	callbacks: IVSCloneLLMMessageCallbacks,
	signal: AbortSignal,
	logService: ILogService,
): Promise<void> {
	switch (request.kind) {
		case 'chat':
			await sendChatMessage(request, callbacks, signal, logService);
			return;
		case 'fim':
			await sendFIMMessage(request, callbacks, signal, logService);
			return;
	}
}

async function sendChatMessage(
	request: Extract<IVSCloneLLMMessageRequest, { kind: 'chat' }>,
	callbacks: IVSCloneLLMMessageCallbacks,
	signal: AbortSignal,
	logService: ILogService,
): Promise<void> {
	const { auth, prepared } = request;

	if (auth.vendor !== prepared.vendor) {
		callbacks.onError({
			message: localize('vsclone.llmMessage.authVendorMismatch', 'VSClone LLM auth material did not match the selected provider.'),
		});
		return;
	}

	if (Object.keys(auth.headers).length === 0) {
		callbacks.onError({
			message: localize('vsclone.llmMessage.missingAuth', 'VSClone LLM requests require OAuth auth headers from the renderer.'),
		});
		return;
	}

	const startedAt = Date.now();
	logService.info(
		`[VSCloneLLMMessage] Dispatching ${prepared.vendor} chat request for ${prepared.modelId} `
		+ `through the vendor SDK (prepared messages: ${prepared.messages.length}).`
	);
	logService.info(`[VSCloneLLMMessage] Headers: ${JSON.stringify(maskHeadersForLog(auth.headers))}`);

	try {
		switch (prepared.vendor) {
			case 'openai':
				await sendOpenAIChatMessage(auth, prepared, callbacks, signal);
				break;
			case 'anthropic':
				await sendAnthropicChatMessage(auth, prepared, callbacks, signal);
				break;
			case 'google':
				await sendGoogleChatMessage(auth, prepared, callbacks, signal);
				break;
		}

		if (!signal.aborted) {
			logService.info(
				`[VSCloneLLMMessage] Completed ${prepared.vendor} chat request for ${prepared.modelId} `
				+ `in ${Date.now() - startedAt}ms.`
			);
		}
	} catch (error) {
		if (signal.aborted) {
			logService.info(
				`[VSCloneLLMMessage] Aborted ${prepared.vendor} chat request for ${prepared.modelId} `
				+ `after ${Date.now() - startedAt}ms.`
			);
			callbacks.onAbort();
			return;
		}

		const message = error instanceof Error ? error.message : String(error);
		logService.error(`[VSCloneLLMMessage] ${prepared.vendor} chat request failed.`, error);
		callbacks.onError({ message });
	}
}

async function sendFIMMessage(
	request: Extract<IVSCloneLLMMessageRequest, { kind: 'fim' }>,
	callbacks: IVSCloneLLMMessageCallbacks,
	signal: AbortSignal,
	logService: ILogService,
): Promise<void> {
	const { auth, prepared } = request;

	if (auth.vendor !== prepared.vendor) {
		callbacks.onError({
			message: localize('vsclone.llmMessage.authVendorMismatch', 'VSClone LLM auth material did not match the selected provider.'),
		});
		return;
	}

	if (Object.keys(auth.headers).length === 0) {
		callbacks.onError({
			message: localize('vsclone.llmMessage.missingAuth', 'VSClone LLM requests require OAuth auth headers from the renderer.'),
		});
		return;
	}

	const startedAt = Date.now();
	logService.info(
		`[VSCloneLLMMessage] Dispatching ${prepared.vendor} FIM request for ${prepared.modelId} `
		+ `(prefix=${prepared.prompt.prefix.length}, suffix=${prepared.prompt.suffix.length}, `
		+ `maxTokens=${prepared.prompt.maxTokens}, reasoning=${prepared.reasoningEffort ?? 'default'}).`
	);
	logService.info(`[VSCloneLLMMessage] Headers: ${JSON.stringify(maskHeadersForLog(auth.headers))}`);

	try {
		const transportRequest = buildFIMTransportRequest(prepared);
		const endpointMode = getFIMEndpointMode(prepared);
		const response = await fetch(transportRequest.url, {
			method: 'POST',
			headers: {
				...auth.headers,
				'Content-Type': 'application/json',
				'Accept': endpointMode === 'sse' ? 'text/event-stream' : 'application/json',
			},
			body: JSON.stringify(transportRequest.body),
			signal,
		});

		if (!response.ok) {
			let errorBody = '';
			try {
				errorBody = await response.text();
			} catch {
				// Preserve the status-derived message if response extraction also fails.
			}
			throw new Error(`${prepared.vendor} completion API returned ${response.status}: ${errorBody || response.statusText}`);
		}

		if (endpointMode !== 'sse') {
			throw new Error(`Unsupported VSClone FIM endpoint mode: ${endpointMode}`);
		}
		if (!response.body) {
			throw new Error(`${prepared.vendor} completion API returned no response body`);
		}

		await consumeFIMSseText(response.body, prepared.vendor, callbacks, signal);

		if (!signal.aborted) {
			logService.info(
				`[VSCloneLLMMessage] Completed ${prepared.vendor} FIM request for ${prepared.modelId} `
				+ `in ${Date.now() - startedAt}ms.`
			);
		}
	} catch (error) {
		if (signal.aborted) {
			logService.info(
				`[VSCloneLLMMessage] Aborted ${prepared.vendor} FIM request for ${prepared.modelId} `
				+ `after ${Date.now() - startedAt}ms.`
			);
			callbacks.onAbort();
			return;
		}

		const message = error instanceof Error ? error.message : String(error);
		logService.error(`[VSCloneLLMMessage] ${prepared.vendor} FIM request failed.`, error);
		callbacks.onError({ message });
	}
}

async function sendOpenAIChatMessage(
	auth: IVSCloneLLMMessageAuthMaterial,
	prepared: IVSCloneLLMPreparedChatPayload,
	callbacks: IVSCloneLLMMessageCallbacks,
	signal: AbortSignal,
): Promise<void> {
	const OpenAI = await loadOpenAIConstructor();
	const token = requireBearerToken(auth.headers, 'openai');
	const client = new OpenAI({
		apiKey: token,
		baseURL: getOpenAIBaseUrl(),
		defaultHeaders: withoutHeader(auth.headers, 'Authorization'),
		maxRetries: 0,
	});
	// ChatGPT's Codex responses backend accepts the same request body we emit today, but the local
	// SDK typings still lag some OAuth-only fields such as the higher reasoning effort aliases.
	// Keep the runtime payload intact here instead of down-converting the request just to satisfy
	// the current type package.
	const stream = client.responses.stream(
		buildOpenAIChatRequest(prepared) as unknown as Parameters<typeof client.responses.stream>[0],
		{ signal },
	);
	const disposeAbort = bindAbortController(signal, () => stream.controller.abort());

	let fullText = '';
	let fullReasoning = '';
	let toolCall = createEmptyToolCall();
	let toolArgsJson = '';

	try {
		for await (const event of stream) {
			switch (event.type) {
				case 'response.output_text.delta':
					if (!event.delta) {
						continue;
					}

					fullText += event.delta;
					callbacks.onText({
						text: event.delta,
						fullText,
						fullReasoning,
						toolCall: toolCall.name ? toolCall : undefined,
					});
					break;
				case 'response.reasoning.delta': {
					// OpenAI Responses: `delta` is typed as `unknown` in the SDK because the reasoning
					// channel can carry structured updates. Treat a plain string as the textual delta and
					// ignore anything else so we never leak non-string `[object Object]` into the UI.
					const reasoningDelta = typeof event.delta === 'string' ? event.delta : '';
					if (!reasoningDelta) {
						continue;
					}
					fullReasoning += reasoningDelta;
					callbacks.onText({
						text: '',
						fullText,
						fullReasoning,
						toolCall: toolCall.name ? toolCall : undefined,
					});
					break;
				}
				case 'response.reasoning_summary_text.delta':
					if (!event.delta) {
						continue;
					}
					fullReasoning += event.delta;
					callbacks.onText({
						text: '',
						fullText,
						fullReasoning,
						toolCall: toolCall.name ? toolCall : undefined,
					});
					break;
				case 'response.output_item.added':
				case 'response.output_item.done':
					if (event.item.type !== 'function_call') {
						continue;
					}

					toolArgsJson = event.item.arguments || toolArgsJson;
					toolCall = toVSCloneToolCallFromOpenAIEventItem(event.item, toolCall, toolArgsJson);
					break;
				case 'response.function_call_arguments.delta':
					toolArgsJson += event.delta;
					toolCall = updateToolCallFromJsonString(toolCall, {
						id: toolCall.id || event.item_id,
						argsJson: toolArgsJson,
					});
					break;
				case 'response.function_call_arguments.done':
					toolArgsJson = event.arguments;
					toolCall = updateToolCallFromJsonString(toolCall, {
						id: toolCall.id || event.item_id,
						argsJson: toolArgsJson,
						isDone: true,
					});
					break;
				case 'response.failed':
					throw new Error(describeOpenAIProviderError(event.response.error));
				case 'error':
					throw new Error(event.message || localize('vsclone.llmMessage.providerError', 'The provider reported an unknown error.'));
			}
		}
	} finally {
		disposeAbort();
	}

	if (signal.aborted) {
		return;
	}

	const finalResponse = await stream.finalResponse();
	const finalToolCall = toVSCloneToolCallFromOpenAIResponse(finalResponse) ?? (toolCall.name ? toolCall : undefined);
	callbacks.onFinalMessage({
		fullText,
		fullReasoning,
		toolCall: finalToolCall,
		anthropicReasoning: null,
	});
}

async function sendAnthropicChatMessage(
	auth: IVSCloneLLMMessageAuthMaterial,
	prepared: IVSCloneLLMPreparedChatPayload,
	callbacks: IVSCloneLLMMessageCallbacks,
	signal: AbortSignal,
): Promise<void> {
	const Anthropic = await loadAnthropicConstructor();
	const token = requireBearerToken(auth.headers, 'anthropic');
	const client = new Anthropic({
		authToken: token,
		baseURL: new URL(defaultOAuthProviderConfig.anthropic.apiEndpoint).origin,
		defaultHeaders: withoutHeader(auth.headers, 'Authorization'),
		maxRetries: 0,
	});
	// The prepared-message seam uses VSClone-local transcript types that are structurally equivalent
	// to the SDK request payload, but not literally the SDK's exported TypeScript aliases.
	const stream = client.messages.stream(buildAnthropicChatRequest(prepared) as never, { signal });
	const disposeAbort = bindAbortController(signal, () => stream.controller.abort());

	let fullText = '';
	let fullReasoning = '';
	let toolCall = createEmptyToolCall();
	let toolArgsJson = '';

	try {
		for await (const event of stream) {
			switch (event.type) {
				case 'content_block_start':
					if (event.content_block.type === 'tool_use') {
						toolCall = {
							...toolCall,
							id: event.content_block.id,
							name: event.content_block.name,
						};
						continue;
					}
					if (event.content_block.type === 'thinking') {
						// Anthropic streams the `thinking` block as incremental deltas below. Emit the
						// start-block text so the reasoning transcript is not missed when the provider
						// front-loads content on the start event instead of the first delta.
						if (event.content_block.thinking) {
							if (fullReasoning) {
								fullReasoning += '\n\n';
							}
							fullReasoning += event.content_block.thinking;
							callbacks.onText({
								text: '',
								fullText,
								fullReasoning,
								toolCall: toolCall.name ? toolCall : undefined,
							});
						}
						continue;
					}
					if (event.content_block.type === 'redacted_thinking') {
						if (fullReasoning) {
							fullReasoning += '\n\n';
						}
						fullReasoning += '[redacted_thinking]';
						callbacks.onText({
							text: '',
							fullText,
							fullReasoning,
							toolCall: toolCall.name ? toolCall : undefined,
						});
						continue;
					}
					if (event.content_block.type !== 'text' || !event.content_block.text) {
						continue;
					}

					fullText += event.content_block.text;
					callbacks.onText({
						text: event.content_block.text,
						fullText,
						fullReasoning,
						toolCall: toolCall.name ? toolCall : undefined,
					});
					break;
				case 'content_block_delta':
					if (event.delta.type === 'thinking_delta') {
						if (!event.delta.thinking) {
							continue;
						}
						fullReasoning += event.delta.thinking;
						callbacks.onText({
							text: '',
							fullText,
							fullReasoning,
							toolCall: toolCall.name ? toolCall : undefined,
						});
						continue;
					}
					if (event.delta.type !== 'text_delta' || !event.delta.text) {
						if (event.delta.type === 'input_json_delta') {
							toolArgsJson += event.delta.partial_json ?? '';
							toolCall = updateToolCallFromJsonString(toolCall, {
								argsJson: toolArgsJson,
							});
						}
						continue;
					}

					fullText += event.delta.text;
					callbacks.onText({
						text: event.delta.text,
						fullText,
						fullReasoning,
						toolCall: toolCall.name ? toolCall : undefined,
					});
					break;
			}
		}
	} finally {
		disposeAbort();
	}

	if (signal.aborted) {
		return;
	}

	const finalMessage = await stream.finalMessage();
	const finalToolCall = toVSCloneToolCallFromAnthropicMessage(finalMessage) ?? (toolCall.name ? toolCall : undefined);
	const anthropicReasoning = collectAnthropicReasoningBlocks(finalMessage);
	callbacks.onFinalMessage({
		fullText,
		fullReasoning,
		toolCall: finalToolCall,
		anthropicReasoning,
	});
}

// Mirrors Void's `anthropicReasoning` collection out of the final message: keep only the thinking
// and redacted_thinking blocks in their original order so subsequent turns can replay them back
// into Anthropic verbatim with the server-issued signatures intact.
function collectAnthropicReasoningBlocks(
	message: VSCloneAnthropicMessage,
): readonly IVSCloneLLMMessageReasoningBlock[] | null {
	const blocks: IVSCloneLLMMessageReasoningBlock[] = [];
	for (const contentBlock of message.content) {
		if (contentBlock.type === 'thinking') {
			// Signature is required for Anthropic to verify the replayed thinking block on the next
			// turn. The SDK guarantees both fields on a final `thinking` block, so preserve them as-is
			// instead of defaulting to a synthetic empty signature that the server would reject.
			blocks.push({
				type: 'thinking',
				thinking: contentBlock.thinking,
				signature: contentBlock.signature,
			});
		} else if (contentBlock.type === 'redacted_thinking') {
			blocks.push({
				type: 'redacted_thinking',
				data: contentBlock.data,
			});
		}
	}
	return blocks.length > 0 ? blocks : null;
}

async function sendGoogleChatMessage(
	auth: IVSCloneLLMMessageAuthMaterial,
	prepared: IVSCloneLLMPreparedChatPayload,
	callbacks: IVSCloneLLMMessageCallbacks,
	signal: AbortSignal,
): Promise<void> {
	const GoogleGenAI = await loadGoogleGenAIConstructor();
	const client = new GoogleGenAI({
		vertexai: false,
		// PassThroughClient keeps the SDK on its native request path without letting google-auth or
		// API-key plumbing replace the renderer-supplied OAuth headers that VSClone explicitly passes.
		// Load it lazily so renderer-hosted bridge tests can import this Electron module graph without
		// having to resolve the Node-only `google-auth-library` package before any Google request runs.
		// eslint-disable-next-line local/code-no-dangerous-type-assertions
		googleAuthOptions: {
			authClient: await createGooglePassThroughAuthClient(),
		} as never,
		httpOptions: buildGoogleHttpOptions(auth.headers),
	});
	// Google's SDK request types are also nominally separate from the local prepared-message union,
	// so we cast at the boundary instead of leaking SDK types into the browser-side transport seam.
	const stream = await client.models.generateContentStream(buildGoogleChatRequest(prepared, signal) as never);

	let fullText = '';
	let toolCall = createEmptyToolCall();

	for await (const chunk of stream) {
		const promptFeedbackMessage = getGooglePromptFeedbackErrorMessage(chunk);
		if (promptFeedbackMessage) {
			throw new Error(promptFeedbackMessage);
		}

		const newText = chunk.text ?? '';
		const functionCall = chunk.functionCalls?.[0];
		if (functionCall) {
			toolCall = updateToolCallFromJsonString({
				...toolCall,
				id: functionCall.id ?? toolCall.id,
				name: functionCall.name ?? toolCall.name,
			}, {
				argsJson: JSON.stringify(functionCall.args ?? {}),
				isDone: true,
			});
		}
		if (newText.length > 0) {
			fullText += newText;
			callbacks.onText({
				text: newText,
				fullText,
				fullReasoning: '',
				toolCall: toolCall.name ? toolCall : undefined,
			});
			continue;
		}

		const finishReasonMessage = getGoogleFinishReasonErrorMessage(chunk.candidates?.[0]);
		if (finishReasonMessage) {
			throw new Error(finishReasonMessage);
		}
	}

	if (signal.aborted) {
		return;
	}

	callbacks.onFinalMessage({
		fullText,
		fullReasoning: '',
		toolCall: toolCall.name ? toolCall : undefined,
		anthropicReasoning: null,
	});
}

async function createGooglePassThroughAuthClient(): Promise<unknown> {
	// The IPC bridge tests execute inside Electron's renderer process while importing the real
	// main-process request code. Keeping this dependency behind a dynamic import avoids tripping the
	// renderer ESM loader on a server-only package in tests that never exercise the Google path.
	const { PassThroughClient } = await import('google-auth-library');
	return new PassThroughClient();
}

/**
 * The renderer-hosted bridge tests import this module to exercise the real IPC seam, but they do
 * not execute provider SDK paths. Keep those packages lazy so the renderer loader never has to
 * parse Node-oriented SDK entrypoints unless a request for that vendor actually runs.
 */
async function loadOpenAIConstructor(): Promise<typeof import('openai').default> {
	const { default: OpenAI } = await import('openai');
	return OpenAI;
}

async function loadAnthropicConstructor(): Promise<typeof import('@anthropic-ai/sdk').default> {
	const { default: Anthropic } = await import('@anthropic-ai/sdk');
	return Anthropic;
}

async function loadGoogleGenAIConstructor(): Promise<VSCloneGoogleGenAIConstructor> {
	const { GoogleGenAI } = await import('@google/genai');
	return GoogleGenAI;
}

/**
 * The request translators stay next to the SDK callers because the request shape and stream shape
 * now evolve together. That avoids drifting back toward a generic transport wrapper that needs a
 * second parsing layer to recover provider-native events.
 */
function buildOpenAIChatRequest(prepared: IVSCloneLLMPreparedChatPayload) {
	const apiModelId = resolveVSCloneApiModelId('openai', prepared.modelId);
	const baseRequest = {
		model: apiModelId,
		instructions: prepared.separateSystemMessage?.trim() || defaultSystemMessage,
		store: false,
		input: buildOpenAIInput(prepared.messages as readonly IVSCloneOpenAILLMChatMessage[]),
		tools: buildOpenAITools(prepared),
		parallel_tool_calls: false,
		stream: true as const,
	};

	// Mirror Void's IO-settings path: ask the provider adapter what (if anything) to inject. When
	// the adapter returns null (reasoning disabled or not supported), attach no reasoning field at
	// all -- matching Void's `getSendableReasoningInfo` behavior rather than falling back to the raw
	// `reasoningEffort` selection.
	const reasoningFragment = buildProviderReasoningFragment(prepared);
	return reasoningFragment ? { ...baseRequest, ...reasoningFragment } : baseRequest;
}

function buildAnthropicChatRequest(prepared: IVSCloneLLMPreparedChatPayload) {
	const apiModelId = resolveVSCloneApiModelId('anthropic', prepared.modelId);
	assertSupportsAnthropicOAuthMessagesModel(apiModelId);

	const reasoningFragment = buildProviderReasoningFragment(prepared);
	// Mirror Void's `getReservedOutputTokenSpace`: when reasoning is on, reserve the model-specific
	// override; otherwise fall back to Anthropic's required minimum so the request still validates.
	const reservedOutputTokenSpace = getVSCloneReservedOutputTokenSpaceForReasoning(
		prepared.vendor,
		prepared.modelId,
		{ isReasoningEnabled: reasoningFragment !== null },
	);

	const anthropicReasoningFragment = clampAnthropicThinkingBudget(reasoningFragment, reservedOutputTokenSpace ?? 4_096);
	const baseRequest = {
		model: apiModelId,
		messages: prepared.messages as readonly IVSCloneAnthropicLLMChatMessage[],
		max_tokens: reservedOutputTokenSpace ?? 4_096,
		system: prepared.separateSystemMessage?.trim() || defaultSystemMessage,
		tools: buildAnthropicTools(prepared),
		tool_choice: {
			type: 'auto',
			disable_parallel_tool_use: true,
		},
	};

	return anthropicReasoningFragment ? { ...baseRequest, ...anthropicReasoningFragment } : baseRequest;
}

function buildGoogleChatRequest(prepared: IVSCloneLLMPreparedChatPayload, signal: AbortSignal) {
	const apiModelId = resolveVSCloneApiModelId('google', prepared.modelId);
	const googleTools = buildGoogleTools(prepared);
	const reasoningFragment = buildProviderReasoningFragment(prepared);
	return {
		model: apiModelId,
		contents: prepared.messages as readonly IVSCloneGeminiLLMChatMessage[],
		config: {
			systemInstruction: prepared.separateSystemMessage?.trim() || defaultSystemMessage,
			abortSignal: signal,
			...(googleTools.length > 0 ? {
				toolConfig: {
					functionCallingConfig: {
						mode: googleFunctionCallingConfigModeAuto,
					},
				},
				tools: googleTools,
			} : {}),
			...(reasoningFragment ?? {}),
		},
	};
}

/**
 * Mirrors Void's reasoning-injection seam: resolve the sendable info from the prepared payload and
 * ask the provider's IO-settings adapter to return the request-level fragment it wants merged in.
 * VSClone does not carry Void's full `ModelSelectionOptions` on the transport yet, so we synthesize
 * the minimum shape from the already-prepared fields before calling the helper.
 */
function buildProviderReasoningFragment(prepared: IVSCloneLLMPreparedChatPayload): Record<string, unknown> | null {
	const info: VSCloneSendableReasoningInfo = getVSCloneSendableReasoningInfo(
		'Chat',
		prepared.vendor,
		prepared.modelId,
		{
			reasoningEnabled: prepared.reasoningEnabled,
			reasoningBudget: prepared.reasoningBudget,
			reasoningEffort: prepared.reasoningEffort,
		},
	);
	const settings = getVSCloneProviderReasoningIOSettings(prepared.vendor);
	return settings.input?.includeInPayload?.(info) ?? null;
}

function clampAnthropicThinkingBudget(fragment: Record<string, unknown> | null, maxTokens: number): Record<string, unknown> | null {
	const thinking = fragment?.thinking;
	if (!thinking || typeof thinking !== 'object' || !hasKey(thinking, { budget_tokens: true })) {
		return fragment;
	}
	const thinkingPayload = thinking as { readonly budget_tokens?: unknown };
	if (typeof thinkingPayload.budget_tokens !== 'number') {
		return fragment;
	}

	// Anthropic requires `thinking.budget_tokens` to be strictly lower than `max_tokens`. The UI
	// slider can intentionally reach the full reserved output budget, so clamp only the transport
	// payload and leave the persisted user selection unchanged.
	return {
		...fragment,
		thinking: {
			...thinking,
			budget_tokens: Math.min(thinkingPayload.budget_tokens, Math.max(1, maxTokens - 1)),
		},
	};
}

function getFIMEndpointMode(_prepared: IVSCloneLLMPreparedFIMPayload): VSCloneFIMEndpointMode {
	return 'sse';
}

function buildFIMTransportRequest(prepared: IVSCloneLLMPreparedFIMPayload): IVSCloneFIMTransportRequest {
	switch (prepared.vendor) {
		case 'openai':
			return buildOpenAIFIMRequest(prepared);
		case 'anthropic':
			return buildAnthropicFIMRequest(prepared);
		case 'google':
			return buildGoogleFIMRequest(prepared);
	}
}

function supportsOpenAICompletionTemperature(prepared: IVSCloneLLMPreparedFIMPayload): boolean {
	return !prepared.modelId.startsWith('gpt-5');
}

export function buildOpenAIFIMRequest(prepared: IVSCloneLLMPreparedFIMPayload): IVSCloneFIMTransportRequest {
	const apiModelId = resolveVSCloneApiModelId('openai', prepared.modelId);
	const body: Record<string, unknown> = {
		model: apiModelId,
		instructions: prepared.prompt.systemMessage,
		store: false,
		input: [{ role: 'user', content: prepared.prompt.promptText }],
		stream: true,
	};

	if (supportsOpenAICompletionTemperature(prepared) && prepared.prompt.temperature !== undefined) {
		body.temperature = prepared.prompt.temperature;
	}
	// Route FIM through the same gating the Chat path uses so an effort-slider `'none'` (or any off
	// configuration) produces a request body with no `reasoning` property at all. Without this the
	// autocomplete fallback that explicitly asks for `reasoningEffort: 'none'` would still emit
	// `reasoning: { effort: 'minimal' }` via `toVSCloneOpenAIReasoningEffort`.
	const reasoningFragment = buildOpenAIFIMReasoningFragment(prepared);
	if (reasoningFragment) {
		Object.assign(body, reasoningFragment);
	}

	return {
		url: defaultOAuthProviderConfig.openai.apiEndpoint,
		body,
	};
}

/**
 * OpenAI-only FIM reasoning fragment builder. Mirrors Void's provider FIM layout: only the
 * OpenAI-compatible FIM path accepts a `reasoning` field (VSClone's OpenAI FIM routes through the
 * Responses endpoint), so this helper is not shared with the Anthropic or Google FIM builders --
 * Void's Anthropic/Gemini providers declare `sendFIM: null` and have no FIM reasoning pathway at
 * all. Autocomplete only exposes `reasoningEffort` on the selection, so the synthesized
 * `IVSCloneModelSelectionOptions` uses that lone field and relies on
 * `getVSCloneSendableReasoningInfo` to return `null` for effort-slider `'none'` and for any model
 * whose capability shape does not support reasoning.
 */
function buildOpenAIFIMReasoningFragment(prepared: IVSCloneLLMPreparedFIMPayload): Record<string, unknown> | null {
	const info: VSCloneSendableReasoningInfo = getVSCloneSendableReasoningInfo(
		'Chat',
		prepared.vendor,
		prepared.modelId,
		{
			reasoningEffort: prepared.reasoningEffort,
		},
	);
	const settings = getVSCloneProviderReasoningIOSettings(prepared.vendor);
	return settings.input?.includeInPayload?.(info) ?? null;
}

function buildAnthropicFIMRequest(prepared: IVSCloneLLMPreparedFIMPayload): IVSCloneFIMTransportRequest {
	const apiModelId = resolveVSCloneApiModelId('anthropic', prepared.modelId);
	assertSupportsAnthropicOAuthMessagesModel(apiModelId);
	const stopSequences = sanitizeAnthropicStopSequences(prepared.prompt.stopTokens);
	const body: Record<string, unknown> = {
		model: apiModelId,
		system: prepared.prompt.systemMessage,
		messages: [{ role: 'user', content: prepared.prompt.promptText }],
		max_tokens: prepared.prompt.maxTokens,
		temperature: prepared.prompt.temperature,
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

function buildGoogleFIMRequest(prepared: IVSCloneLLMPreparedFIMPayload): IVSCloneFIMTransportRequest {
	const apiModelId = resolveVSCloneApiModelId('google', prepared.modelId);
	const baseUrl = defaultOAuthProviderConfig.google.apiEndpoint;
	const url = `${baseUrl}/${apiModelId}:streamGenerateContent?alt=sse`;

	return {
		url,
		body: {
			systemInstruction: {
				parts: [{
					text: prepared.prompt.systemMessage,
				}],
			},
			contents: [{
				role: 'user',
				parts: [{
					text: prepared.prompt.promptText,
				}],
			}],
			generationConfig: {
				maxOutputTokens: prepared.prompt.maxTokens,
				temperature: prepared.prompt.temperature,
				stopSequences: [...prepared.prompt.stopTokens],
			},
		},
	};
}

async function consumeFIMSseText(
	body: ReadableStream<Uint8Array>,
	vendor: VSCloneModelVendor,
	callbacks: IVSCloneLLMMessageCallbacks,
	signal: AbortSignal,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();

	let bufferedChunk = '';
	let accumulatedText = '';
	const state: IFIMStreamState = {
		currentEventType: undefined,
	};

	try {
		while (true) {
			if (signal.aborted) {
				return;
			}

			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			bufferedChunk += decoder.decode(value, { stream: true });
			const processedChunk = processBufferedFIMText(bufferedChunk, vendor, state, accumulatedText, false, callbacks);
			bufferedChunk = processedChunk.remainder;
			accumulatedText = processedChunk.accumulatedText;
			if (processedChunk.completed) {
				return;
			}
		}

		processBufferedFIMText(bufferedChunk + decoder.decode(), vendor, state, accumulatedText, true, callbacks);
	} finally {
		reader.releaseLock();
	}
}

function processBufferedFIMText(
	bufferedChunk: string,
	vendor: VSCloneModelVendor,
	state: IFIMStreamState,
	accumulatedText: string,
	flushRemainder: boolean,
	callbacks: IVSCloneLLMMessageCallbacks,
): { remainder: string; accumulatedText: string; completed: boolean } {
	const lines = bufferedChunk.split('\n');
	const remainder = flushRemainder ? '' : (lines.pop() ?? '');
	let nextAccumulatedText = accumulatedText;

	for (const rawLine of lines) {
		const parsedLine = processFIMSseLine(rawLine, vendor, state);
		if (!parsedLine) {
			continue;
		}

		if (parsedLine.type === 'delta' && parsedLine.text) {
			nextAccumulatedText += parsedLine.text;
			callbacks.onText({
				text: parsedLine.text,
				fullText: nextAccumulatedText,
				fullReasoning: '',
				toolCall: undefined,
			});
			continue;
		}
		if (parsedLine.type === 'done') {
			callbacks.onFinalMessage({
				fullText: nextAccumulatedText,
				fullReasoning: '',
				toolCall: undefined,
				anthropicReasoning: null,
			});
			return {
				remainder,
				accumulatedText: nextAccumulatedText,
				completed: true,
			};
		}

		throw new Error(parsedLine.message ?? 'Unknown completion API error');
	}

	if (flushRemainder) {
		callbacks.onFinalMessage({
			fullText: nextAccumulatedText,
			fullReasoning: '',
			toolCall: undefined,
			anthropicReasoning: null,
		});
		return {
			remainder,
			accumulatedText: nextAccumulatedText,
			completed: true,
		};
	}

	return {
		remainder,
		accumulatedText: nextAccumulatedText,
		completed: false,
	};
}

function processFIMSseLine(
	rawLine: string,
	vendor: VSCloneModelVendor,
	state: IFIMStreamState,
) {
	const line = rawLine.trimEnd();
	if (line === '') {
		return undefined;
	}
	if (line.startsWith('event:')) {
		state.currentEventType = line.slice('event:'.length).trim();
		return undefined;
	}
	if (!line.startsWith('data:')) {
		return undefined;
	}

	const payload = line.slice('data:'.length).trim();
	return parseFIMSsePayload(vendor, payload, state.currentEventType);
}

function parseFIMSsePayload(
	vendor: VSCloneModelVendor,
	payload: string,
	currentEventType: string | undefined,
) {
	switch (vendor) {
		case 'openai':
			return parseOpenAIFIMPayload(payload);
		case 'anthropic':
			return parseAnthropicFIMPayload(payload, currentEventType);
		case 'google':
			return parseGoogleFIMPayload(payload);
	}
}

function parseOpenAIFIMPayload(payload: string) {
	if (payload === '[DONE]') {
		return { type: 'done' as const };
	}

	try {
		const parsed = JSON.parse(payload);
		if (parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
			return { type: 'delta' as const, text: parsed.delta };
		}
		if (parsed.type === 'response.completed') {
			return { type: 'done' as const };
		}
		if (parsed.error) {
			return {
				type: 'error' as const,
				message: parsed.error.message ?? JSON.stringify(parsed.error),
			};
		}
	} catch {
		// Ignore malformed transport noise and wait for the next SSE line.
	}

	return undefined;
}

function parseAnthropicFIMPayload(payload: string, currentEventType: string | undefined) {
	if (!payload) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(payload);
		if (currentEventType === 'content_block_start') {
			const textContent = parsed.content_block;
			if (textContent?.type === 'text' && typeof textContent.text === 'string' && textContent.text.length > 0) {
				return { type: 'delta' as const, text: textContent.text };
			}
			return undefined;
		}
		if (currentEventType === 'content_block_delta') {
			if (parsed.delta?.type === 'text_delta' && typeof parsed.delta.text === 'string') {
				return { type: 'delta' as const, text: parsed.delta.text };
			}
			return undefined;
		}
		if (currentEventType === 'message_stop') {
			return { type: 'done' as const };
		}
		if (currentEventType === 'error') {
			return {
				type: 'error' as const,
				message: parsed.error?.message ?? JSON.stringify(parsed),
			};
		}
	} catch {
		// Ignore malformed transport noise and wait for the next SSE line.
	}

	return undefined;
}

function parseGoogleFIMPayload(payload: string) {
	if (payload === '[DONE]') {
		return { type: 'done' as const };
	}

	try {
		const parsed = JSON.parse(payload);
		if (parsed.error) {
			return {
				type: 'error' as const,
				message: parsed.error.message ?? JSON.stringify(parsed.error) ?? 'Google completion request failed.',
			};
		}
		const promptFeedbackMessage = getGooglePromptFeedbackErrorMessage(parsed);
		if (promptFeedbackMessage) {
			return {
				type: 'error' as const,
				message: promptFeedbackMessage,
			};
		}
		const candidate = parsed.candidates?.[0];
		const text = getGoogleCandidateText(candidate);
		if (candidate?.finishReason === 'STOP' || candidate?.finishReason === 'MAX_TOKENS') {
			if (typeof text === 'string' && text.length > 0) {
				return { type: 'delta' as const, text };
			}
			return { type: 'done' as const };
		}
		if (typeof text === 'string' && text.length > 0) {
			return { type: 'delta' as const, text };
		}
		const finishReasonMessage = getGoogleFinishReasonErrorMessage(candidate);
		if (finishReasonMessage) {
			return {
				type: 'error' as const,
				message: finishReasonMessage,
			};
		}
	} catch {
		// Ignore malformed transport noise and wait for the next SSE line.
	}

	return undefined;
}

function buildOpenAIInput(messages: readonly IVSCloneOpenAILLMChatMessage[]) {
	const input: Array<Record<string, unknown>> = [];

	for (const message of messages) {
		switch (message.role) {
			case 'user':
			case 'system':
			case 'developer':
				input.push({
					type: 'message',
					role: message.role,
					content: toOpenAIInputContent(message.content),
				});
				break;
			case 'assistant': {
				const assistantText = extractOpenAIAssistantText(message.content);
				if (assistantText.length > 0) {
					input.push({
						type: 'message',
						role: 'assistant',
						status: 'completed',
						content: [{
							type: 'output_text',
							text: assistantText,
							annotations: [],
						}],
					});
				}
				for (const toolCall of message.tool_calls ?? []) {
					input.push({
						type: 'function_call',
						call_id: toolCall.id,
						name: toolCall.function.name,
						arguments: toolCall.function.arguments,
						status: 'completed',
					});
				}
				break;
			}
			case 'tool':
				input.push({
					type: 'function_call_output',
					call_id: message.tool_call_id,
					output: message.content,
				});
				break;
		}
	}

	return input;
}

function buildOpenAITools(prepared: IVSCloneLLMPreparedChatPayload): VSCloneOpenAIFunctionTool[] {
	return getVSCloneVisibleToolDefinitions(prepared.mode, prepared.toolDefinitions).map(tool => ({
		type: 'function',
		name: tool.name,
		description: tool.description,
		parameters: cloneToolJsonSchema(toVSCloneToolJsonSchema(tool)),
		strict: false,
	}));
}

function buildAnthropicTools(prepared: IVSCloneLLMPreparedChatPayload): VSCloneAnthropicTool[] {
	return getVSCloneVisibleToolDefinitions(prepared.mode, prepared.toolDefinitions).map(tool => ({
		name: tool.name,
		description: tool.description,
		input_schema: cloneToolJsonSchema(toVSCloneToolJsonSchema(tool)) as VSCloneAnthropicToolInputSchema,
	}));
}

function buildGoogleTools(prepared: IVSCloneLLMPreparedChatPayload): Array<{ functionDeclarations: VSCloneGoogleFunctionDeclaration[] }> {
	const functionDeclarations: VSCloneGoogleFunctionDeclaration[] = getVSCloneVisibleToolDefinitions(prepared.mode, prepared.toolDefinitions).map(tool => ({
		name: tool.name,
		description: tool.description,
		parameters: toGoogleToolSchema(toVSCloneToolJsonSchema(tool)),
	}));

	return functionDeclarations.length > 0 ? [{ functionDeclarations }] : [];
}

function toGoogleToolSchema(schema: IVSCloneToolJsonSchema): VSCloneGoogleSchema {
	return toGoogleSchema(schema) ?? {
		type: googleSchemaTypeObject,
		properties: {},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toGoogleSchema(value: unknown): VSCloneGoogleSchema | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	if (isNullOnlyJsonSchema(value)) {
		return toGoogleNullOnlySchema(value);
	}

	const typeInfo = googleTypeInfoFromJsonSchemaType(value.type);
	const schema: VSCloneGoogleSchema = {};
	if (typeInfo.type) {
		schema.type = typeInfo.type;
	}
	if (typeInfo.nullable) {
		schema.nullable = true;
	}
	if (typeInfo.anyOf) {
		schema.anyOf = typeInfo.anyOf;
	}
	if (typeof value.description === 'string') {
		schema.description = value.description;
	}
	const enumInfo = toGoogleStringEnum(value.enum);
	if (enumInfo?.values) {
		schema.enum = enumInfo.values;
	}
	if (enumInfo?.nullable) {
		// Draft-07 allows nullability to be encoded only as an enum member. Gemini models
		// nullability separately, so keep the string enum constraint and lift null into the flag.
		schema.nullable = true;
	}
	if (Array.isArray(value.required) && value.required.every(item => typeof item === 'string')) {
		schema.required = [...value.required];
	}

	const properties = toGoogleSchemaProperties(value.properties);
	if (properties) {
		schema.properties = properties;
	}

	const items = toGoogleSchema(value.items);
	if (items) {
		schema.items = items;
	}

	const anyOf = toGoogleSchemaList(value.anyOf);
	if (anyOf?.nullable) {
		schema.nullable = true;
	}
	if (anyOf?.schemas) {
		schema.anyOf = mergeGoogleAnyOf(schema.anyOf, anyOf.schemas);
	}

	return schema;
}

function toGoogleNullOnlySchema(value: Record<string, unknown>): VSCloneGoogleSchema {
	const schema: VSCloneGoogleSchema = {
		type: googleSchemaTypeString,
		nullable: true,
	};

	// Gemini has nullable schemas but no null-only type. A nullable string is the least unsafe
	// approximation: it avoids invalid empty enums and avoids inventing sentinel values that could
	// leak into MCP tool arguments. The description keeps the provider-facing intent explicit.
	schema.description = typeof value.description === 'string'
		? `${value.description}\n\nOnly null is valid for this value.`
		: 'Only null is valid for this value.';
	return schema;
}

function toGoogleStringEnum(value: unknown): { readonly values?: string[]; readonly nullable: boolean } | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const enumValues: string[] = [];
	let nullable = false;
	for (const item of value) {
		if (typeof item === 'string') {
			enumValues.push(item);
			continue;
		}
		if (item === null) {
			nullable = true;
			continue;
		}
		return undefined;
	}

	return enumValues.length > 0 || nullable ? {
		values: enumValues.length > 0 ? enumValues : undefined,
		nullable,
	} : undefined;
}

function toGoogleSchemaList(value: unknown): { readonly schemas?: VSCloneGoogleSchema[]; readonly nullable: boolean } | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	let nullable = false;
	const schemas = value.flatMap(item => {
		if (isNullOnlyJsonSchema(item)) {
			// Gemini models nullability as a flag, so null-only draft-07 union branches must not
			// become anyOf entries. Standalone null-only schemas keep their own approximation, but
			// using that inside a union would broaden constrained branches to arbitrary strings.
			nullable = true;
			return [];
		}
		const schema = toGoogleSchema(item);
		return schema ? [schema] : [];
	});

	return schemas.length > 0 || nullable ? {
		schemas: schemas.length > 0 ? schemas : undefined,
		nullable,
	} : undefined;
}

function isNullOnlyJsonSchema(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}

	const type = value.type;
	if (type === 'null' || (Array.isArray(type) && type.length > 0 && type.every(item => item === 'null'))) {
		return true;
	}

	if (value.const === null) {
		return true;
	}

	// Some MCP servers use enum-only draft-07 branches for nullable unions. Treat an enum that
	// contains only null as a null branch instead of converting it to an unconstrained Gemini schema.
	return Array.isArray(value.enum) && value.enum.length > 0 && value.enum.every(item => item === null);
}

function mergeGoogleAnyOf(existing: VSCloneGoogleSchema[] | undefined, incoming: VSCloneGoogleSchema[]): VSCloneGoogleSchema[] {
	if (!existing) {
		return incoming;
	}

	return [...existing, ...incoming];
}

function toGoogleSchemaProperties(value: unknown): Record<string, VSCloneGoogleSchema> | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	// Gemini can represent nested objects and arrays, so keep MCP input schemas structured instead
	// of flattening every argument to a string as the built-in XML-era parameter list does.
	const properties: Record<string, VSCloneGoogleSchema> = {};
	for (const [key, property] of Object.entries(value)) {
		const googleProperty = toGoogleSchema(property);
		if (googleProperty) {
			properties[key] = googleProperty;
		}
	}

	return Object.keys(properties).length > 0 ? properties : undefined;
}

function googleTypeFromJsonSchemaType(type: unknown): VSCloneGoogleSchemaType | undefined {
	switch (type) {
		case 'object':
			return googleSchemaTypeObject;
		case 'string':
			return googleSchemaTypeString;
		case 'number':
			return googleSchemaTypeNumber;
		case 'integer':
			return googleSchemaTypeInteger;
		case 'boolean':
			return googleSchemaTypeBoolean;
		case 'array':
			return googleSchemaTypeArray;
		default:
			return undefined;
	}
}

function googleTypeInfoFromJsonSchemaType(type: unknown): { readonly type?: VSCloneGoogleSchemaType; readonly nullable?: boolean; readonly anyOf?: VSCloneGoogleSchema[] } {
	if (!Array.isArray(type)) {
		return { type: googleTypeFromJsonSchemaType(type) };
	}

	const googleTypes = type
		.filter(item => item !== 'null')
		.map(googleTypeFromJsonSchemaType)
		.filter((item): item is VSCloneGoogleSchemaType => item !== undefined);
	const nullable = type.includes('null');
	if (googleTypes.length <= 1) {
		return {
			type: googleTypes[0],
			nullable,
		};
	}

	// Gemini models nullable directly, but multiple non-null draft-07 types need anyOf.
	return {
		nullable,
		anyOf: googleTypes.map(item => ({ type: item })),
	};
}

function toOpenAIInputContent(content: Extract<IVSCloneOpenAILLMChatMessage, { readonly role: 'user' | 'system' | 'developer' }>['content']) {
	if (typeof content === 'string') {
		return [{
			type: 'input_text',
			text: content,
		}];
	}

	return content.map(part => {
		if (part.type === 'text') {
			return {
				type: 'input_text',
				text: part.text,
			};
		}
		return {
			type: 'input_image',
			image_url: part.image_url.url,
			detail: part.image_url.detail,
		};
	});
}

function extractOpenAIAssistantText(content: Extract<IVSCloneOpenAILLMChatMessage, { readonly role: 'assistant' }>['content']): string {
	if (typeof content === 'string') {
		return content;
	}

	return content
		.flatMap(part => part.type === 'text' ? [part.text] : [])
		.join('');
}

function createEmptyToolCall(): IVSCloneLLMMessageToolCall {
	return {
		name: '',
		rawParams: {},
		doneParams: [],
		id: '',
		isDone: false,
	};
}

function updateToolCallFromJsonString(
	toolCall: IVSCloneLLMMessageToolCall,
	update: {
		readonly id?: string;
		readonly argsJson: string;
		readonly isDone?: boolean;
	},
): IVSCloneLLMMessageToolCall {
	const rawParams = parseToolArgsJson(update.argsJson);
	return {
		...toolCall,
		id: update.id ?? toolCall.id,
		rawParams,
		doneParams: Object.keys(rawParams).sort(),
		isDone: update.isDone ?? toolCall.isDone,
	};
}

function parseToolArgsJson(value: string): Record<string, string> {
	try {
		const parsed = JSON.parse(value);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {};
		}
		return Object.fromEntries(
			Object.entries(parsed).map(([key, entryValue]) => [key, stringifyToolParamValue(entryValue)]),
		);
	} catch {
		return {};
	}
}

function toVSCloneToolCallFromOpenAIEventItem(
	item: VSCloneOpenAIResponseOutputItem,
	currentToolCall: IVSCloneLLMMessageToolCall,
	argsJson: string,
): IVSCloneLLMMessageToolCall {
	if (item.type !== 'function_call') {
		return currentToolCall;
	}

	return updateToolCallFromJsonString({
		...currentToolCall,
		name: item.name,
	}, {
		id: item.call_id || item.id,
		argsJson,
		isDone: item.status === 'completed',
	});
}

function toVSCloneToolCallFromOpenAIResponse(
	response: VSCloneOpenAIResponse,
): IVSCloneLLMMessageToolCall | undefined {
	const functionCall = response.output.find(item => item.type === 'function_call');
	if (!functionCall) {
		return undefined;
	}

	const rawParams = parseToolArgsJson(functionCall.arguments);
	return {
		name: functionCall.name,
		rawParams,
		doneParams: Object.keys(rawParams).sort(),
		id: functionCall.call_id || functionCall.id || '',
		isDone: functionCall.status === 'completed',
	};
}

function toVSCloneToolCallFromAnthropicMessage(
	message: VSCloneAnthropicMessage,
): IVSCloneLLMMessageToolCall | undefined {
	const toolUseBlock = message.content.find(contentBlock => contentBlock.type === 'tool_use');
	if (!toolUseBlock || !toolUseBlock.id || !toolUseBlock.name) {
		return undefined;
	}

	const rawInput = toolUseBlock.input && typeof toolUseBlock.input === 'object'
		? toolUseBlock.input
		: {};
	return {
		name: toolUseBlock.name,
		rawParams: Object.fromEntries(Object.entries(rawInput).map(([key, value]) => [key, stringifyToolParamValue(value)])),
		doneParams: Object.keys(rawInput).sort(),
		id: toolUseBlock.id,
		isDone: true,
	};
}

function stringifyToolParamValue(value: unknown): string {
	return value && typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function cloneToolJsonSchema(schema: IVSCloneToolJsonSchema): Record<string, unknown> {
	return {
		type: schema.type,
		properties: Object.fromEntries(
			Object.entries(schema.properties ?? {}).map(([name, property]) => [name, { ...property }]),
		),
		...(schema.required ? { required: [...schema.required] } : {}),
		...(schema.additionalProperties !== undefined ? { additionalProperties: schema.additionalProperties } : {}),
	};
}

function resolveVSCloneApiModelId(vendor: VSCloneModelVendor, catalogModelId: string): string {
	switch (vendor) {
		case 'anthropic':
			return anthropicModelMap[catalogModelId] ?? catalogModelId;
		case 'google':
			return googleModelMap[catalogModelId] ?? catalogModelId;
		default:
			return catalogModelId;
	}
}

function assertSupportsAnthropicOAuthMessagesModel(modelId: string): void {
	if (!supportedAnthropicOAuthMessagesModelIds.has(modelId)) {
		throw new Error(
			'Anthropic OAuth messages currently support only Claude Haiku 4.5 and Claude Haiku 3 in VSClone. Re-select an Anthropic Haiku model.',
		);
	}
}

function getGoogleCandidateText(
	candidate: { content?: { parts?: Array<{ text?: string }> } } | undefined,
): string | undefined {
	const parts = candidate?.content?.parts;
	if (!Array.isArray(parts) || parts.length === 0) {
		return undefined;
	}

	const text = parts
		.map(part => typeof part.text === 'string' ? part.text : '')
		.join('');
	return text.length > 0 ? text : undefined;
}

function getOpenAIBaseUrl(): string {
	const endpoint = new URL(defaultOAuthProviderConfig.openai.apiEndpoint);
	const segments = endpoint.pathname.split('/').filter(Boolean);
	if (segments.length === 0) {
		throw new Error('VSClone OpenAI OAuth endpoint is missing the responses path segment.');
	}

	endpoint.pathname = `/${segments.slice(0, -1).join('/')}`;
	return endpoint.toString().replace(/\/$/, '');
}

function buildGoogleHttpOptions(headers: Readonly<Record<string, string>>) {
	const endpoint = new URL(defaultOAuthProviderConfig.google.apiEndpoint);
	const pathSegments = endpoint.pathname.split('/').filter(Boolean);
	if (pathSegments.length < 2) {
		throw new Error('VSClone Google OAuth endpoint is missing the API version and models path.');
	}

	return {
		baseUrl: endpoint.origin,
		apiVersion: pathSegments.slice(0, -1).join('/'),
		headers: { ...headers },
	};
}

function getGooglePromptFeedbackErrorMessage(response: import('@google/genai').GenerateContentResponse): string | undefined {
	const blockReason = response.promptFeedback?.blockReason;
	if (!blockReason) {
		return undefined;
	}

	const blockReasonMessage = response.promptFeedback?.blockReasonMessage?.trim();
	return blockReasonMessage
		? `Google completion blocked: ${blockReason} (${blockReasonMessage}).`
		: `Google completion blocked: ${blockReason}.`;
}

function getGoogleFinishReasonErrorMessage(candidate: VSCloneGoogleCandidate | undefined): string | undefined {
	const finishReason = candidate?.finishReason;
	if (!finishReason || finishReason === 'STOP' || finishReason === 'MAX_TOKENS') {
		return undefined;
	}

	const finishMessage = candidate?.finishMessage?.trim();
	return finishMessage
		? `Google completion finished with ${finishReason}: ${finishMessage}.`
		: `Google completion finished with ${finishReason}.`;
}

function describeOpenAIProviderError(error: { message?: string | null } | null | undefined): string {
	const message = error?.message?.trim();
	return message || localize('vsclone.llmMessage.providerError', 'The provider reported an unknown error.');
}

function requireBearerToken(headers: Readonly<Record<string, string>>, vendor: VSCloneModelVendor): string {
	const authorizationHeader = getHeader(headers, 'Authorization');
	const match = authorizationHeader && /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
	if (match?.[1]) {
		return match[1];
	}

	throw new Error(localize(
		'vsclone.llmMessage.missingBearerToken',
		'VSClone LLM requests require an OAuth Bearer token from the renderer for {0}.',
		displayVendorName(vendor),
	));
}

function displayVendorName(vendor: VSCloneModelVendor): string {
	switch (vendor) {
		case 'openai':
			return 'OpenAI';
		case 'anthropic':
			return 'Anthropic';
		case 'google':
			return 'Google';
	}
}

function getHeader(headers: Readonly<Record<string, string>>, name: string): string | undefined {
	const expectedName = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expectedName) {
			return value;
		}
	}

	return undefined;
}

function withoutHeader(headers: Readonly<Record<string, string>>, name: string): Record<string, string> {
	const expectedName = name.toLowerCase();
	const filteredHeaders: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== expectedName) {
			filteredHeaders[key] = value;
		}
	}

	return filteredHeaders;
}

function bindAbortController(signal: AbortSignal, abort: () => void): () => void {
	if (signal.aborted) {
		abort();
		return () => { };
	}

	const abortListener = () => abort();
	signal.addEventListener('abort', abortListener, { once: true });
	return () => signal.removeEventListener('abort', abortListener);
}

function maskHeadersForLog(headers: Readonly<Record<string, string>>): Record<string, string> {
	const maskedHeaders: Record<string, string> = { ...headers };
	const authorization = getHeader(maskedHeaders, 'Authorization');
	if (!authorization) {
		return maskedHeaders;
	}

	let authorizationKey = 'Authorization';
	for (const key of Object.keys(maskedHeaders)) {
		if (key.toLowerCase() === 'authorization') {
			authorizationKey = key;
			break;
		}
	}

	const token = authorization.replace(/^Bearer\s+/i, '');
	if (token.length <= 8) {
		maskedHeaders[authorizationKey] = 'Bearer ****';
		return maskedHeaders;
	}

	maskedHeaders[authorizationKey] = `Bearer ${token.slice(0, 4)}...${token.slice(token.length - 4)}`;
	return maskedHeaders;
}
