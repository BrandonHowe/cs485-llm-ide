/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
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
	type IVSCloneLLMMessageToolCall,
	type IVSCloneLLMPreparedFIMPayload,
	type IVSCloneLLMPreparedChatPayload,
	IVSCloneLLMMessageRequest,
	IVSCloneLLMMessageTextPayload,
	type IVSCloneOpenAILLMChatMessage,
} from '../common/vscloneLLMMessageTypes.js';
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

interface IVSCloneFIMTransportRequest {
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
const googleSchemaTypeArray = 'ARRAY' as VSCloneGoogleSchemaType;
const googleSchemaTypeBoolean = 'BOOLEAN' as VSCloneGoogleSchemaType;
const googleSchemaTypeInteger = 'INTEGER' as VSCloneGoogleSchemaType;
const googleSchemaTypeNumber = 'NUMBER' as VSCloneGoogleSchemaType;
const googleSchemaTypeObject = 'OBJECT' as VSCloneGoogleSchemaType;
const googleSchemaTypeString = 'STRING' as VSCloneGoogleSchemaType;

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
						fullReasoning: '',
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
		fullReasoning: '',
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
					if (event.content_block.type !== 'text' || !event.content_block.text) {
						continue;
					}

					fullText += event.content_block.text;
					callbacks.onText({
						text: event.content_block.text,
						fullText,
						fullReasoning: '',
						toolCall: toolCall.name ? toolCall : undefined,
					});
					break;
				case 'content_block_delta':
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
						fullReasoning: '',
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
	callbacks.onFinalMessage({
		fullText,
		fullReasoning: '',
		toolCall: finalToolCall,
		anthropicReasoning: null,
	});
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
		googleAuthOptions: {
			authClient: (await createGooglePassThroughAuthClient()) as never,
		},
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

	if (!prepared.reasoningEffort) {
		return baseRequest;
	}

	return {
		...baseRequest,
		reasoning: {
			effort: toOpenAIReasoningEffort(prepared.reasoningEffort),
		},
	};
}

function buildAnthropicChatRequest(prepared: IVSCloneLLMPreparedChatPayload) {
	const apiModelId = resolveVSCloneApiModelId('anthropic', prepared.modelId);
	assertSupportsAnthropicOAuthMessagesModel(apiModelId);

	return {
		model: apiModelId,
		messages: prepared.messages as readonly IVSCloneAnthropicLLMChatMessage[],
		max_tokens: 16384,
		// The prepared-message seam now owns tool/result conversion, but Anthropic reasoning blocks
		// are still omitted until the live runtime can round-trip them end-to-end.
		system: prepared.separateSystemMessage?.trim() || defaultSystemMessage,
		tools: buildAnthropicTools(prepared),
		tool_choice: {
			type: 'auto',
			disable_parallel_tool_use: true,
		},
	};
}

function buildGoogleChatRequest(prepared: IVSCloneLLMPreparedChatPayload, signal: AbortSignal) {
	const apiModelId = resolveVSCloneApiModelId('google', prepared.modelId);
	const googleTools = buildGoogleTools(prepared);
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

function buildOpenAIFIMRequest(prepared: IVSCloneLLMPreparedFIMPayload): IVSCloneFIMTransportRequest {
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
	if (prepared.reasoningEffort) {
		body.reasoning = {
			effort: toOpenAIReasoningEffort(prepared.reasoningEffort),
		};
	}

	return {
		url: defaultOAuthProviderConfig.openai.apiEndpoint,
		body,
	};
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
	return getPreparedToolDefinitions(prepared).map(tool => ({
		type: 'function',
		name: tool.name,
		description: tool.description,
		parameters: cloneToolJsonSchema(toVSCloneToolJsonSchema(tool)),
		strict: false,
	}));
}

function buildAnthropicTools(prepared: IVSCloneLLMPreparedChatPayload): VSCloneAnthropicTool[] {
	return getPreparedToolDefinitions(prepared).map(tool => ({
		name: tool.name,
		description: tool.description,
		input_schema: cloneToolJsonSchema(toVSCloneToolJsonSchema(tool)) as VSCloneAnthropicToolInputSchema,
	}));
}

function buildGoogleTools(prepared: IVSCloneLLMPreparedChatPayload): Array<{ functionDeclarations: VSCloneGoogleFunctionDeclaration[] }> {
	const functionDeclarations: VSCloneGoogleFunctionDeclaration[] = getPreparedToolDefinitions(prepared).map(tool => {
		return {
			name: tool.name,
			description: tool.description,
			parameters: toGoogleSchema(toVSCloneToolJsonSchema(tool)),
		};
	});

	return functionDeclarations.length > 0 ? [{ functionDeclarations }] : [];
}

function toGoogleSchema(schema: IVSCloneToolJsonSchema | Readonly<Record<string, unknown>>): VSCloneGoogleSchema {
	const schemaRecord = schema as Readonly<Record<string, unknown>>;
	const googleSchema: VSCloneGoogleSchema = {};
	const schemaType = toGoogleSchemaType(schemaRecord.type);
	if (schemaType) {
		googleSchema.type = schemaType;
	}
	if (typeof schemaRecord.description === 'string') {
		googleSchema.description = schemaRecord.description;
	}
	if (Array.isArray(schemaRecord.enum) && schemaRecord.enum.every(value => typeof value === 'string')) {
		googleSchema.enum = schemaRecord.enum;
	}
	if (typeof schemaRecord.format === 'string') {
		googleSchema.format = schemaRecord.format;
	}
	if (Array.isArray(schemaRecord.required) && schemaRecord.required.every(value => typeof value === 'string')) {
		googleSchema.required = schemaRecord.required;
	}
	if (isJsonSchemaRecord(schemaRecord.items)) {
		googleSchema.items = toGoogleSchema(schemaRecord.items);
	}
	if (isJsonSchemaRecordMap(schemaRecord.properties)) {
		googleSchema.properties = Object.fromEntries(
			Object.entries(schemaRecord.properties).map(([name, property]) => [name, toGoogleSchema(property)]),
		);
	}
	if (Array.isArray(schemaRecord.anyOf)) {
		const anyOf = schemaRecord.anyOf.filter(isJsonSchemaRecord).map(toGoogleSchema);
		if (anyOf.length > 0) {
			googleSchema.anyOf = anyOf;
		}
	}
	return googleSchema;
}

function toGoogleSchemaType(value: unknown): VSCloneGoogleSchemaType | undefined {
	switch (Array.isArray(value) ? value[0] : value) {
		case 'array':
			return googleSchemaTypeArray;
		case 'boolean':
			return googleSchemaTypeBoolean;
		case 'integer':
			return googleSchemaTypeInteger;
		case 'number':
			return googleSchemaTypeNumber;
		case 'object':
			return googleSchemaTypeObject;
		case 'string':
			return googleSchemaTypeString;
		default:
			return undefined;
	}
}

function isJsonSchemaRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isJsonSchemaRecordMap(value: unknown): value is Record<string, Record<string, unknown>> {
	return isJsonSchemaRecord(value) && Object.values(value).every(isJsonSchemaRecord);
}

function getPreparedToolDefinitions(prepared: IVSCloneLLMPreparedChatPayload) {
	return prepared.toolDefinitions ?? getVSCloneVisibleToolDefinitions(prepared.mode);
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

function parseToolArgsJson(value: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(value);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {};
		}
		return parsed as Record<string, unknown>;
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
		? toolUseBlock.input as Record<string, unknown>
		: {};
	return {
		name: toolUseBlock.name,
		rawParams: rawInput,
		doneParams: Object.keys(rawInput).sort(),
		id: toolUseBlock.id,
		isDone: true,
	};
}

function cloneToolJsonSchema(schema: IVSCloneToolJsonSchema): Record<string, unknown> {
	// OpenAI and Anthropic accept JSON Schema-like input definitions, so preserve MCP keywords such
	// as additionalProperties, $defs, enum, and nested composition instead of rebuilding a subset.
	return cloneJsonSchemaRecord(schema);
}

function cloneJsonSchemaRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJsonSchemaValue(entry)]));
}

function cloneJsonSchemaValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(cloneJsonSchemaValue);
	}
	if (value && typeof value === 'object') {
		return cloneJsonSchemaRecord(value as Readonly<Record<string, unknown>>);
	}
	return value;
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

type OpenAIReasoningEffort =
	| 'none'
	| 'minimal'
	| 'low'
	| 'medium'
	| 'high'
	| 'xhigh';

function toOpenAIReasoningEffort(level: NonNullable<IVSCloneLLMPreparedChatPayload['reasoningEffort']>): OpenAIReasoningEffort {
	switch (level) {
		case 'xhigh':
		case 'max':
			return 'xhigh';
		case 'high':
			return 'high';
		case 'medium':
		case 'standard':
			return 'medium';
		case 'low':
		case 'lite':
			return 'low';
		case 'minimal':
			return 'minimal';
		case 'none':
			return 'none';
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
