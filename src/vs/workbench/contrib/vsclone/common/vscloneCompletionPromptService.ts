/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IVSCloneCompletionCrossFileContext, IVSCloneCompletionPromptEnvelope, IVSCloneCompletionRequest } from './vscloneCompletionTypes.js';
import type { IVSCloneModelSelection } from './vscloneModelSelectionTypes.js';

const maxSingleLinePromptPrefixChars = 4_000;
const maxMultiLinePromptPrefixChars = 8_000;
const minPromptPrefixChars = 2_500;
const maxSingleLinePromptSuffixChars = 1_000;
const maxMultiLinePromptSuffixChars = 2_500;
const maxPromptCrossFileContextChars = 2_500;
const maxSingleLineOutputTokens = 96;
const maxMultiLineOutputTokens = 192;
const completionTemperature = 0.01;
const singleLineStopTokens = ['\r\n', '\n'];
const multiLineStopTokens = ['\n\n'];
const holeFillerSystemMessage = [
	'You are a code completion engine. You will be given source code with a <CURSOR> marker.',
	'Return ONLY the exact text to insert at <CURSOR>. No markdown, no backticks, no explanation.',
	'',
	'Example:',
	'Input: const x = Math.max(<CURSOR>);',
	'Output: a, b',
	'',
	'Rules:',
	'- Match surrounding indentation and style.',
	'- For single-line: produce only the rest of the current line.',
	'- For multi-line: produce a natural continuation, stop before repeating suffix content.',
	'- Never repeat code already present after <CURSOR>.',
].join('\n');

export const IVSCloneCompletionPromptService = createDecorator<IVSCloneCompletionPromptService>('vscloneCompletionPromptService');

export interface IVSCloneCompletionPromptService {
	readonly _serviceBrand: undefined;
	buildPromptEnvelope(request: IVSCloneCompletionRequest, selection: IVSCloneModelSelection): IVSCloneCompletionPromptEnvelope;
}

/**
 * Prompt assembly stays pure so the hot path can be unit tested without standing up transport or
 * model-selection services. The backend hands this envelope straight to the completion transport.
 */
export class VSCloneCompletionPromptService implements IVSCloneCompletionPromptService {
	declare readonly _serviceBrand: undefined;

	buildPromptEnvelope(request: IVSCloneCompletionRequest, _selection: IVSCloneModelSelection): IVSCloneCompletionPromptEnvelope {
		const crossFileContext = this.trimCrossFileContextForBudget(request.crossFileContext);
		const prefix = this.trimPrefixForBudget(request.prefix, request.predictionType, crossFileContext);
		const suffix = this.prepareSuffixForPrompt(this.trimSuffixForBudget(request.suffix, request.predictionType));

		return {
			prefix,
			suffix,
			languageId: request.languageId,
			filePath: request.filePath,
			predictionType: request.predictionType,
			maxTokens: this.getMaxOutputTokens(request.predictionType, request.maxTokens),
			temperature: completionTemperature,
			stopTokens: this.getStopTokens(request.predictionType),
			crossFileContext: crossFileContext.length > 0 ? crossFileContext : undefined,
			systemMessage: holeFillerSystemMessage,
			promptText: this.buildVendorPrompt(request, prefix, suffix, crossFileContext),
		};
	}

	private getStopTokens(predictionType: IVSCloneCompletionRequest['predictionType']): readonly string[] {
		return predictionType === 'multi-line' ? multiLineStopTokens : singleLineStopTokens;
	}

	private getMaxOutputTokens(predictionType: IVSCloneCompletionRequest['predictionType'], requestedMaxTokens: number): number {
		const cap = predictionType === 'multi-line' ? maxMultiLineOutputTokens : maxSingleLineOutputTokens;
		return Math.max(1, Math.min(cap, requestedMaxTokens));
	}

	/**
	 * Nearby code is still the strongest signal, so related-file context only borrows from the
	 * prefix budget down to a floor instead of crowding out the local file entirely.
	 */
	private trimPrefixForBudget(
		prefix: string,
		predictionType: IVSCloneCompletionRequest['predictionType'],
		crossFileContext: readonly IVSCloneCompletionCrossFileContext[],
	): string {
		const promptPrefixBudget = this.getPrefixBudgetForCrossFileContext(predictionType, crossFileContext);
		const boundedPrefix = prefix.length <= promptPrefixBudget ? prefix : prefix.slice(-promptPrefixBudget);
		return boundedPrefix.trimEnd();
	}

	private trimSuffixForBudget(suffix: string, predictionType: IVSCloneCompletionRequest['predictionType']): string {
		const suffixBudget = predictionType === 'multi-line' ? maxMultiLinePromptSuffixChars : maxSingleLinePromptSuffixChars;
		return suffix.length <= suffixBudget ? suffix : suffix.slice(0, suffixBudget);
	}

	private prepareSuffixForPrompt(suffix: string): string {
		return suffix.length > 0 ? suffix : '\n';
	}

	private trimCrossFileContextForBudget(
		crossFileContext: readonly IVSCloneCompletionCrossFileContext[] | undefined,
	): readonly IVSCloneCompletionCrossFileContext[] {
		if (!crossFileContext || crossFileContext.length === 0) {
			return [];
		}

		let remainingChars = maxPromptCrossFileContextChars;
		const boundedContext: IVSCloneCompletionCrossFileContext[] = [];

		for (const snippet of crossFileContext) {
			if (remainingChars <= 0) {
				break;
			}

			const contentBudget = Math.min(remainingChars, snippet.content.length);
			const content = this.trimSnippetContentForBudget(snippet.content, contentBudget);
			if (!content.trim()) {
				continue;
			}

			boundedContext.push({
				filePath: snippet.filePath,
				languageId: snippet.languageId,
				content,
			});
			remainingChars -= content.length;
		}

		return boundedContext;
	}

	private trimSnippetContentForBudget(content: string, maxChars: number): string {
		if (content.length <= maxChars) {
			return content;
		}

		const bounded = content.slice(0, maxChars);
		const lastNewline = bounded.lastIndexOf('\n');
		return lastNewline >= Math.floor(maxChars / 2) ? bounded.slice(0, lastNewline) : bounded;
	}

	private getPrefixBudgetForCrossFileContext(
		predictionType: IVSCloneCompletionRequest['predictionType'],
		crossFileContext: readonly IVSCloneCompletionCrossFileContext[],
	): number {
		const baseBudget = predictionType === 'multi-line' ? maxMultiLinePromptPrefixChars : maxSingleLinePromptPrefixChars;
		const crossFilePromptCost = crossFileContext.reduce((total, snippet) => {
			return total + snippet.filePath.length + snippet.content.length + 12;
		}, 0);
		const reducedBudget = baseBudget - crossFilePromptCost;
		return Math.max(minPromptPrefixChars, reducedBudget);
	}

	private buildVendorPrompt(
		request: IVSCloneCompletionRequest,
		prefix: string,
		suffix: string,
		crossFileContext: readonly IVSCloneCompletionCrossFileContext[],
	): string {
		const promptSections: string[] = [];

		if (crossFileContext.length > 0) {
			promptSections.push('Related files:', '');
			for (const snippet of crossFileContext) {
				promptSections.push(`--- ${snippet.filePath || '(untitled)'} ---`);
				promptSections.push(snippet.content, '');
			}
		}

		promptSections.push(
			'Current file:',
			`Language: ${request.languageId || 'plaintext'}`,
			`File: ${request.filePath || '(untitled)'}`,
			'---',
			`${prefix}<CURSOR>${suffix}`,
		);

		return promptSections.join('\n');
	}
}
