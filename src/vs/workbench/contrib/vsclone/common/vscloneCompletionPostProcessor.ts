/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSCloneCompletionPredictionType } from './vscloneCompletionBackend.js';

const openingBrackets = new Set(['(', '[', '{']);
const closingToOpeningBracket = new Map<string, string>([
	[')', '('],
	[']', '['],
	['}', '{'],
]);

function stripMarkdownWrapper(text: string): string {
	const normalized = text.replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');

	// Inline completions should be plain source text; fenced output from generic models is UI noise.
	if (lines.length > 0 && lines[0].trimStart().startsWith('```')) {
		lines.shift();
	}
	if (lines.length > 0 && lines[lines.length - 1].trim() === '```') {
		lines.pop();
	}

	return lines.join('\n').replace(/^`+/, '').replace(/`+$/, '');
}

function getCurrentLinePrefix(prefix: string): string {
	const newlineOffset = prefix.lastIndexOf('\n');
	return newlineOffset >= 0 ? prefix.slice(newlineOffset + 1) : prefix;
}

function normalizeLeadingWhitespace(text: string, prefix: string): string {
	let result = text.replace(/^\n+/, '');
	const currentLinePrefix = getCurrentLinePrefix(prefix);
	const currentLineIndentation = currentLinePrefix.match(/^\s*/)?.[0] ?? '';

	// If the cursor is already sitting at indentation, don't duplicate it in the completion payload.
	if (currentLinePrefix.trim().length === 0 && currentLineIndentation.length > 0 && result.startsWith(currentLineIndentation)) {
		result = result.slice(currentLineIndentation.length);
	}

	return result;
}

function removeSuffixOverlap(text: string, suffix: string): string {
	if (!text || !suffix) {
		return text;
	}

	const maxOverlap = Math.min(text.length, suffix.length);
	for (let overlap = maxOverlap; overlap > 0; overlap--) {
		if (text.slice(text.length - overlap) === suffix.slice(0, overlap)) {
			return text.slice(0, text.length - overlap);
		}
	}

	return text;
}

function truncateForSingleLine(text: string): string {
	const newlineOffset = text.indexOf('\n');
	return newlineOffset < 0 ? text : text.slice(0, newlineOffset);
}

function buildBracketStack(prefix: string): string[] {
	const stack: string[] = [];
	for (const char of prefix) {
		if (openingBrackets.has(char)) {
			stack.push(char);
			continue;
		}

		const expectedOpeningBracket = closingToOpeningBracket.get(char);
		if (!expectedOpeningBracket) {
			continue;
		}

		if (stack[stack.length - 1] === expectedOpeningBracket) {
			stack.pop();
		}
	}
	return stack;
}

function truncateOnUnbalancedClosingBracket(text: string, prefix: string): string {
	const stack = buildBracketStack(prefix);
	let result = '';

	for (const char of text) {
		if (openingBrackets.has(char)) {
			stack.push(char);
			result += char;
			continue;
		}

		const expectedOpeningBracket = closingToOpeningBracket.get(char);
		if (!expectedOpeningBracket) {
			result += char;
			continue;
		}

		if (stack.length === 0 || stack[stack.length - 1] !== expectedOpeningBracket) {
			break;
		}

		stack.pop();
		result += char;
	}

	return result;
}

export function postProcessCompletion(
	rawCompletion: string,
	prefix: string,
	suffix: string,
	predictionType: VSCloneCompletionPredictionType,
): string | undefined {
	let processed = stripMarkdownWrapper(rawCompletion);
	processed = normalizeLeadingWhitespace(processed, prefix);
	processed = removeSuffixOverlap(processed, suffix);

	if (predictionType === 'single-line') {
		processed = truncateForSingleLine(processed);
	}

	processed = truncateOnUnbalancedClosingBracket(processed, prefix);
	processed = processed.replace(/[ \t]+$/g, '');

	return processed.trim().length > 0 ? processed : undefined;
}
