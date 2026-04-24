/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { type IVSCloneChatTransportConversationMessage, type IVSCloneChatTransportRequestOptions } from './vscloneChatTransportTypes.js';
import type { IVSCloneCompletionPromptEnvelope } from './vscloneCompletionTypes.js';
import { type IVSCloneImageAttachment, toVSCloneImageDataUrl } from './vscloneImageAttachmentTypes.js';
import {
	type IVSCloneAnthropicLLMChatMessage,
	type IVSCloneGeminiLLMChatMessage,
	type IVSCloneLLMMessageReasoningBlock,
	type IVSCloneLLMPreparedFIMPayload,
	type IVSCloneLLMPreparedChatPayload,
	type IVSCloneOpenAILLMChatMessage,
} from './vscloneLLMMessageTypes.js';
import type { IVSCloneModelSelection } from './vscloneModelSelectionTypes.js';

export const IVSCloneConvertToLLMMessageService = createDecorator<IVSCloneConvertToLLMMessageService>('vscloneConvertToLLMMessageService');

export interface IVSCloneConvertToLLMMessageService {
	readonly _serviceBrand: undefined;
	prepareChatRequest(options: IVSCloneChatTransportRequestOptions): IVSCloneLLMPreparedChatPayload;
	prepareFIMRequest(selection: Pick<IVSCloneModelSelection, 'vendor' | 'modelId' | 'modelIdentifier' | 'reasoningEffort'>, envelope: Pick<IVSCloneCompletionPromptEnvelope, 'prefix' | 'suffix' | 'maxTokens' | 'temperature' | 'stopTokens' | 'systemMessage' | 'promptText'>): IVSCloneLLMPreparedFIMPayload;
}

type IVSCloneSimplePreparedMessage =
	| {
		readonly role: 'user';
		readonly content: string;
		readonly imageAttachments?: readonly IVSCloneImageAttachment[];
	}
	| {
		readonly role: 'assistant';
		readonly content: string;
		readonly anthropicReasoning?: readonly IVSCloneLLMMessageReasoningBlock[] | null;
	}
	| {
		readonly role: 'tool';
		readonly id: string;
		readonly name: string;
		readonly rawParams: Readonly<Record<string, string>>;
		readonly content: string;
	};

/**
 * This service ports only the transcript-conversion seam from Void. It stays auth-blind on
 * purpose: OAuth headers remain owned by the runtime submit path, while this service only turns
 * VSClone's structured runtime transcript into provider-native prepared messages.
 */
export class VSCloneConvertToLLMMessageService implements IVSCloneConvertToLLMMessageService {
	declare readonly _serviceBrand: undefined;

	prepareChatRequest(options: IVSCloneChatTransportRequestOptions): IVSCloneLLMPreparedChatPayload {
		const simpleMessages = this.buildSimpleMessages(options.previousTurns, options.currentTurn);
		const separateSystemMessage = options.systemMessage?.trim() || undefined;

		switch (options.vendor) {
			case 'openai':
				return {
					vendor: options.vendor,
					modelId: options.modelId,
					modelIdentifier: options.modelIdentifier,
					mode: options.mode,
					reasoningEffort: options.reasoningEffort,
					reasoningEnabled: options.reasoningEnabled,
					reasoningBudget: options.reasoningBudget,
					messages: prepareOpenAIMessages(simpleMessages),
					separateSystemMessage,
					toolDefinitions: options.toolDefinitions,
				};
			case 'anthropic':
				return {
					vendor: options.vendor,
					modelId: options.modelId,
					modelIdentifier: options.modelIdentifier,
					mode: options.mode,
					reasoningEffort: options.reasoningEffort,
					reasoningEnabled: options.reasoningEnabled,
					reasoningBudget: options.reasoningBudget,
					messages: prepareAnthropicMessages(simpleMessages),
					separateSystemMessage,
					toolDefinitions: options.toolDefinitions,
				};
			case 'google':
				return {
					vendor: options.vendor,
					modelId: options.modelId,
					modelIdentifier: options.modelIdentifier,
					mode: options.mode,
					reasoningEffort: options.reasoningEffort,
					reasoningEnabled: options.reasoningEnabled,
					reasoningBudget: options.reasoningBudget,
					messages: prepareGeminiMessages(simpleMessages),
					separateSystemMessage,
					toolDefinitions: options.toolDefinitions,
				};
		}
	}

	/**
	 * FIM payload preparation stays intentionally small. The autocomplete stack already assembled a
	 * transport-ready prompt envelope, so this seam just stamps the selection metadata into the
	 * same prepared-payload shape the unified transport expects.
	 */
	prepareFIMRequest(
		selection: Pick<IVSCloneModelSelection, 'vendor' | 'modelId' | 'modelIdentifier' | 'reasoningEffort'>,
		envelope: Pick<IVSCloneCompletionPromptEnvelope, 'prefix' | 'suffix' | 'maxTokens' | 'temperature' | 'stopTokens' | 'systemMessage' | 'promptText'>,
	): IVSCloneLLMPreparedFIMPayload {
		return {
			vendor: selection.vendor,
			modelId: selection.modelId,
			modelIdentifier: selection.modelIdentifier,
			reasoningEffort: selection.reasoningEffort,
			prompt: {
				prefix: envelope.prefix,
				suffix: envelope.suffix,
				maxTokens: envelope.maxTokens,
				temperature: envelope.temperature,
				stopTokens: envelope.stopTokens,
				systemMessage: envelope.systemMessage,
				promptText: envelope.promptText,
			},
		};
	}

	/**
	 * Runtime now projects tool calls structurally, so this seam no longer needs to recover tool
	 * history by reparsing assistant XML. Keeping the conversion as a small role-based pass keeps
	 * provider request shaping deterministic across fresh runs, rewind, and restore.
	 */
	private buildSimpleMessages(
		previousTurns: readonly IVSCloneChatTransportConversationMessage[] | undefined,
		currentTurn: IVSCloneChatTransportConversationMessage,
	): IVSCloneSimplePreparedMessage[] {
		const conversation = [
			...(previousTurns ?? []),
			currentTurn,
		];
		const messages: IVSCloneSimplePreparedMessage[] = [];

		for (const message of conversation) {
			switch (message.role) {
				case 'assistant':
					messages.push({
						role: 'assistant',
						content: message.content,
						...(message.anthropicReasoning ? { anthropicReasoning: message.anthropicReasoning } : {}),
					});
					break;
				case 'tool':
					messages.push({
						role: 'tool',
						id: message.id,
						name: message.name,
						rawParams: message.rawParams,
						content: message.content,
					});
					break;
				case 'user':
					messages.push({
						role: 'user',
						content: message.content,
						imageAttachments: message.imageAttachments,
					});
					break;
			}
		}

		return messages;
	}
}

function prepareOpenAIMessages(messages: readonly IVSCloneSimplePreparedMessage[]): readonly IVSCloneOpenAILLMChatMessage[] {
	const preparedMessages: IVSCloneOpenAILLMChatMessage[] = [];

	for (const message of messages) {
		switch (message.role) {
			case 'user':
				preparedMessages.push({
					role: 'user',
					content: message.imageAttachments?.length
						? buildOpenAIUserContent(message.content, message.imageAttachments)
						: message.content,
				});
				break;
			case 'assistant':
				preparedMessages.push({
					role: 'assistant',
					content: message.content,
				});
				break;
			case 'tool': {
				const previousMessage = preparedMessages.at(-1);
				if (previousMessage?.role === 'assistant') {
					const existingToolCalls = previousMessage.tool_calls ?? [];
					preparedMessages[preparedMessages.length - 1] = {
						...previousMessage,
						tool_calls: [
							...existingToolCalls,
							{
								type: 'function',
								id: message.id,
								function: {
									name: message.name,
									arguments: JSON.stringify(message.rawParams),
								},
							},
						],
					};
				}
				preparedMessages.push({
					role: 'tool',
					tool_call_id: message.id,
					content: message.content,
				});
				break;
			}
		}
	}

	return preparedMessages;
}

function prepareAnthropicMessages(messages: readonly IVSCloneSimplePreparedMessage[]): readonly IVSCloneAnthropicLLMChatMessage[] {
	const preparedMessages: IVSCloneAnthropicLLMChatMessage[] = [];

	for (const message of messages) {
		switch (message.role) {
			case 'user':
				preparedMessages.push({
					role: 'user',
					content: message.imageAttachments?.length
						? buildAnthropicUserContent(message.content, message.imageAttachments)
						: message.content,
				});
				break;
			case 'assistant': {
				// When the assistant turn carries signed Anthropic thinking blocks, prepend them as
				// first-class content parts so the server can verify the original signatures on the
				// follow-up request. Mirrors Void's Anthropic content union.
				const reasoningBlocks = message.anthropicReasoning ?? [];
				if (reasoningBlocks.length === 0) {
					preparedMessages.push({
						role: 'assistant',
						content: message.content,
					});
					break;
				}
				const textContent = message.content.length > 0
					? [{ type: 'text' as const, text: message.content }]
					: [];
				preparedMessages.push({
					role: 'assistant',
					content: [...reasoningBlocks, ...textContent],
				});
				break;
			}
			case 'tool': {
				const previousMessage = preparedMessages.at(-1);
				if (previousMessage?.role === 'assistant') {
					const existingContent = typeof previousMessage.content === 'string'
						? previousMessage.content.length > 0
							? [{ type: 'text', text: previousMessage.content } as const]
							: []
						: [...previousMessage.content];
					preparedMessages[preparedMessages.length - 1] = {
						role: 'assistant',
						content: [
							...existingContent,
							{
								type: 'tool_use',
								id: message.id,
								name: message.name,
								input: message.rawParams,
							},
						],
					};
				}
				preparedMessages.push({
					role: 'user',
					content: [{
						type: 'tool_result',
						tool_use_id: message.id,
						content: message.content,
					}],
				});
				break;
			}
		}
	}

	return preparedMessages;
}

function prepareGeminiMessages(messages: readonly IVSCloneSimplePreparedMessage[]): readonly IVSCloneGeminiLLMChatMessage[] {
	const preparedMessages: IVSCloneGeminiLLMChatMessage[] = [];

	for (const message of messages) {
		switch (message.role) {
			case 'user':
				preparedMessages.push({
					role: 'user',
					parts: message.imageAttachments?.length
						? buildGeminiUserParts(message.content, message.imageAttachments)
						: [{ text: message.content }],
				});
				break;
			case 'assistant':
				preparedMessages.push({
					role: 'model',
					parts: [{ text: message.content }],
				});
				break;
			case 'tool': {
				const previousMessage = preparedMessages.at(-1);
				if (previousMessage?.role === 'model') {
					preparedMessages[preparedMessages.length - 1] = {
						role: 'model',
						parts: [
							...previousMessage.parts,
							{
								functionCall: {
									id: message.id,
									name: message.name,
									args: message.rawParams,
								},
							},
						],
					};
				}
				if (previousMessage?.role !== 'model') {
					preparedMessages.push({
						role: 'user',
						parts: [{ text: message.content }],
					});
					break;
				}
				preparedMessages.push({
					role: 'user',
					parts: [{
						functionResponse: {
							id: message.id,
							// Keep the tool name on the result itself so replay does not depend on a
							// mutable outer variable from an earlier assistant part.
							name: message.name,
							response: { output: message.content },
						},
					}],
				});
				break;
			}
		}
	}

	return preparedMessages;
}

function buildOpenAIUserContent(text: string, images: readonly IVSCloneImageAttachment[]) {
	return [
		{
			type: 'text' as const,
			text: `${buildImageAttachmentNotice(images.length)}\n\n${text}`,
		},
		...images.map(image => ({
			type: 'image_url' as const,
			image_url: {
				url: toVSCloneImageDataUrl(image),
				detail: 'auto' as const,
			},
		})),
	];
}

function buildAnthropicUserContent(text: string, images: readonly IVSCloneImageAttachment[]) {
	return [
		...images.map(image => ({
			type: 'image' as const,
			source: {
				type: 'base64' as const,
				media_type: toAnthropicImageMediaType(image.mimeType),
				data: image.base64Data,
			},
		})),
		{
			type: 'text' as const,
			text: `${buildImageAttachmentNotice(images.length)}\n\n${text}`,
		},
	];
}

function buildGeminiUserParts(text: string, images: readonly IVSCloneImageAttachment[]) {
	return [
		...images.map(image => ({
			inlineData: {
				mimeType: image.mimeType,
				data: image.base64Data,
			},
		})),
		{
			text: `${buildImageAttachmentNotice(images.length)}\n\n${text}`,
		},
	];
}

function buildImageAttachmentNotice(imageCount: number): string {
	const noun = imageCount === 1 ? 'image attachment' : 'image attachments';
	const pronoun = imageCount === 1 ? 'it' : 'them';
	return `This user turn includes ${imageCount} ${noun}. Inspect ${pronoun} directly when answering.`;
}

function toAnthropicImageMediaType(mimeType: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
	switch (mimeType) {
		case 'image/jpeg':
		case 'image/png':
		case 'image/gif':
		case 'image/webp':
			return mimeType;
		default:
			throw new Error(`Anthropic chat requests do not support the image type "${mimeType}" in VSClone yet.`);
	}
}
