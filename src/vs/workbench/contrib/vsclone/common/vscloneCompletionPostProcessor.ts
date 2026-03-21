/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSCloneCompletionPredictionType } from './vscloneCompletionTypes.js';

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

function decodeEscapedMultilineText(text: string, predictionType: VSCloneCompletionPredictionType): string {
	if (!text.includes('\\n')) {
		return text;
	}

	const trimmed = text.trim();
	const escapedNewlineCount = text.match(/\\n/g)?.length ?? 0;
	const looksLikeEscapedBlock = text.startsWith('\\n')
		|| text.includes('\\n ')
		|| text.includes('\\n\t')
		|| text.includes('\\n}')
		|| text.includes('\\n]');

	if (escapedNewlineCount < 2 && !trimmed.startsWith('"')) {
		return text;
	}

	if (predictionType !== 'multi-line' && !looksLikeEscapedBlock && !trimmed.startsWith('"')) {
		return text;
	}

	// Some providers serialize a whole block as one escaped string literal. We only decode when the
	// payload clearly looks multi-line so legitimate single-line string completions stay untouched.
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed === 'string') {
				return parsed;
			}
		} catch {
			// Fall through to the narrower newline/tab decoding below.
		}
	}

	return text
		.replace(/\\r\\n/g, '\n')
		.replace(/\\n/g, '\n')
		.replace(/\\t/g, '\t');
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

function truncateAtSuffixLineMatch(text: string, suffix: string): string {
	if (!text || !suffix) {
		return text;
	}

	const suffixLines = suffix.replace(/\r\n/g, '\n').split('\n').slice(0, 5).map(line => line.trim());
	if (suffixLines.length === 0) {
		return text;
	}

	const lines = text.replace(/\r\n/g, '\n').split('\n');
	for (let index = 0; index < lines.length; index++) {
		if (suffixLines.includes(lines[index].trim())) {
			return lines.slice(0, index).join('\n');
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

function truncateRepetition(text: string): string {
	if (!text) {
		return text;
	}

	const lines = text.replace(/\r\n/g, '\n').split('\n');
	let runStart = 0;
	while (runStart < lines.length) {
		const normalizedLine = lines[runStart].trim();
		let runEnd = runStart + 1;
		while (runEnd < lines.length && lines[runEnd].trim() === normalizedLine) {
			runEnd++;
		}

		const runLength = runEnd - runStart;
		if (runLength >= 8) {
			return '';
		}
		if (runLength >= 4) {
			return lines.slice(0, runStart + 2).join('\n');
		}

		runStart = runEnd;
	}

	return text;
}

function getIndentationWidth(line: string): number {
	return line.match(/^\s*/)?.[0].length ?? 0;
}

function startsWithClosingBracket(text: string): boolean {
	return /^[)\]}]/.test(text);
}

function truncateAtScopeExit(text: string, prefix: string): string {
	if (!text.includes('\n')) {
		return text;
	}

	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const cursorIndentation = getIndentationWidth(getCurrentLinePrefix(prefix));
	for (let index = 1; index < lines.length; index++) {
		const trimmedLine = lines[index].trim();
		if (!trimmedLine) {
			continue;
		}

		if (getIndentationWidth(lines[index]) < cursorIndentation && !startsWithClosingBracket(trimmedLine)) {
			return lines.slice(0, index).join('\n');
		}
	}

	return text;
}

export function postProcessCompletion(
	rawCompletion: string,
	prefix: string,
	suffix: string,
	predictionType: VSCloneCompletionPredictionType,
): string | undefined {
	let processed = stripMarkdownWrapper(rawCompletion);
	processed = decodeEscapedMultilineText(processed, predictionType);
	processed = normalizeLeadingWhitespace(processed, prefix);
	processed = removeSuffixOverlap(processed, suffix);
	processed = truncateAtSuffixLineMatch(processed, suffix);

	if (predictionType === 'single-line') {
		processed = truncateForSingleLine(processed);
	}

	processed = truncateOnUnbalancedClosingBracket(processed, prefix);
	processed = truncateRepetition(processed);
	if (predictionType === 'multi-line') {
		processed = truncateAtScopeExit(processed, prefix);
	}
	// Providers occasionally leave trailing blank lines after a block. Dropping them keeps ghost text
	// focused on the code that would actually be inserted.
	processed = processed.replace(/[ \t]+$/g, '').replace(/\n+$/g, '');

	return processed.trim().length > 0 ? processed : undefined;
}
