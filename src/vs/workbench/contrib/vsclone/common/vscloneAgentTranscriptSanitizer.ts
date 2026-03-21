/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parseToolCalls } from './vscloneToolCallParser.js';

export interface IVSCloneSanitizedAgentModelOutput {
	readonly sanitizedText: string;
	readonly removedFakeToolResults: boolean;
	readonly truncatedAfterAttemptCompletion: boolean;
}

const fakeToolResultPattern = /<tool_result\s*>([\s\S]*?)<\/tool_result>/g;

function normalizeSanitizedText(value: string): string {
	return value
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * The agent runtime already records canonical tool traces and structured tool results. When the
 * model also fabricates inline <tool_result> blocks or repeats its final answer after an
 * attempt_completion tool call, persisting that raw text pollutes history with a second,
 * non-canonical transcript. This sanitizer strips the invalid parts while keeping the model's
 * legitimate planning prose and tool-call intent available for debugging.
 */
export function sanitizeAgentModelOutput(text: string): IVSCloneSanitizedAgentModelOutput {
	let sanitizedText = text;
	let removedFakeToolResults = false;
	let truncatedAfterAttemptCompletion = false;

	fakeToolResultPattern.lastIndex = 0;
	if (fakeToolResultPattern.test(sanitizedText)) {
		removedFakeToolResults = true;
		fakeToolResultPattern.lastIndex = 0;
		sanitizedText = sanitizedText.replace(fakeToolResultPattern, '\n');
	}

	const parsedCalls = parseToolCalls(sanitizedText).toolCalls;
	const attemptCompletionCall = [...parsedCalls].reverse().find(call => call.name === 'attempt_completion');
	if (attemptCompletionCall && attemptCompletionCall.endOffset < sanitizedText.length) {
		const trailingText = sanitizedText.slice(attemptCompletionCall.endOffset);
		if (trailingText.trim().length > 0) {
			truncatedAfterAttemptCompletion = true;
			sanitizedText = sanitizedText.slice(0, attemptCompletionCall.endOffset);
		}
	}

	return {
		sanitizedText: normalizeSanitizedText(sanitizedText),
		removedFakeToolResults,
		truncatedAfterAttemptCompletion,
	};
}
