/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IParsedToolCall {
	readonly name: string;
	readonly params: Record<string, string>;
	readonly rawXml: string;
	readonly startOffset: number;
	readonly endOffset: number;
}

export interface IParsedToolCallResult {
	readonly textSegments: readonly string[];
	readonly toolCalls: readonly IParsedToolCall[];
}

const toolCallStartTag = '<tool_call>';
const toolCallEndTag = '</tool_call>';

function decodeXmlText(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, '\'')
		.replace(/&amp;/g, '&');
}

function tryParseToolCall(rawXml: string, startOffset: number, endOffset: number): IParsedToolCall | undefined {
	const inner = rawXml.slice(toolCallStartTag.length, rawXml.length - toolCallEndTag.length);
	const tagPattern = /<([A-Za-z_][A-Za-z0-9_.-]*)>([\s\S]*?)<\/\1>/g;
	const params: Record<string, string> = Object.create(null) as Record<string, string>;
	let toolName: string | undefined;
	let match: RegExpExecArray | null;

	while ((match = tagPattern.exec(inner)) !== null) {
		const tagName = match[1];
		const value = decodeXmlText(match[2]);
		if (tagName === 'tool_name') {
			toolName = value.trim();
			continue;
		}
		params[tagName] = value;
	}

	if (!toolName) {
		return undefined;
	}

	return {
		name: toolName,
		params,
		rawXml,
		startOffset,
		endOffset,
	};
}

/**
 * Parses complete <tool_call> blocks while preserving surrounding text segments.
 * Incomplete or malformed blocks are left inside textSegments so streaming UI can keep rendering.
 */
export function parseToolCalls(text: string): IParsedToolCallResult {
	const textSegments: string[] = [];
	const toolCalls: IParsedToolCall[] = [];
	let cursor = 0;

	while (true) {
		const startOffset = text.indexOf(toolCallStartTag, cursor);
		if (startOffset < 0) {
			break;
		}

		const endTagOffset = text.indexOf(toolCallEndTag, startOffset + toolCallStartTag.length);
		if (endTagOffset < 0) {
			break;
		}

		const endOffset = endTagOffset + toolCallEndTag.length;
		const rawXml = text.slice(startOffset, endOffset);
		const parsed = tryParseToolCall(rawXml, startOffset, endOffset);

		if (!parsed) {
			// Treat malformed XML as plain assistant text so we never drop model output.
			break;
		}

		textSegments.push(text.slice(cursor, startOffset));
		toolCalls.push(parsed);
		cursor = endOffset;
	}

	textSegments.push(text.slice(cursor));
	return { textSegments, toolCalls };
}
