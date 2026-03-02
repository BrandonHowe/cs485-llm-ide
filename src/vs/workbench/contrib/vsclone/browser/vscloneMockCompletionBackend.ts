/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { IVSCloneCompletionBackend, IVSCloneCompletionRequest } from '../common/vscloneCompletionBackend.js';

const defaultMockDelayMs = 200;

function getCurrentLinePrefix(prefix: string): string {
	const newlineOffset = prefix.lastIndexOf('\n');
	return newlineOffset >= 0 ? prefix.slice(newlineOffset + 1) : prefix;
}

function detectIndentUnit(prefix: string): string {
	const lines = prefix.replace(/\r\n/g, '\n').split('\n');
	for (let index = lines.length - 1; index >= 0; index--) {
		const indentation = lines[index].match(/^(\s+)/)?.[1];
		if (!indentation) {
			continue;
		}
		if (indentation.includes('\t')) {
			return '\t';
		}
		return indentation.length >= 4 ? '    ' : '  ';
	}

	return '\t';
}

export class VSCloneMockCompletionBackend implements IVSCloneCompletionBackend {
	declare readonly _serviceBrand: undefined;

	async complete(request: IVSCloneCompletionRequest, token: CancellationToken): Promise<string | undefined> {
		try {
			// Intentionally emulate transport latency so debounce/cancellation can be validated now.
			await timeout(defaultMockDelayMs, token);
		} catch (error) {
			if (isCancellationError(error)) {
				return undefined;
			}
			throw error;
		}

		if (token.isCancellationRequested) {
			return undefined;
		}

		return this.generateCompletion(request);
	}

	private generateCompletion(request: IVSCloneCompletionRequest): string | undefined {
		const linePrefix = getCurrentLinePrefix(request.prefix);
		const linePrefixTrimmedRight = linePrefix.trimEnd();
		const prefixTrimmedRight = request.prefix.trimEnd();
		const currentIndentation = linePrefix.match(/^\s*/)?.[0] ?? '';
		const nestedIndentation = `${currentIndentation}${detectIndentUnit(request.prefix)}`;

		const keywordCompletion = this.completeCommonPatterns(linePrefix, linePrefixTrimmedRight, currentIndentation, nestedIndentation);
		if (keywordCompletion) {
			return keywordCompletion;
		}

		const blockCompletion = this.completeBlockCharacters(prefixTrimmedRight, currentIndentation, nestedIndentation);
		if (blockCompletion) {
			return blockCompletion;
		}

		const lineContinuation = this.completeLineContinuation(request.prefix, linePrefix);
		if (lineContinuation) {
			return lineContinuation;
		}

		if (request.predictionType === 'multi-line') {
			return `\n${nestedIndentation}`;
		}

		return undefined;
	}

	private completeBlockCharacters(prefix: string, currentIndentation: string, nestedIndentation: string): string | undefined {
		if (prefix.endsWith('{')) {
			return `\n${nestedIndentation}\n${currentIndentation}}`;
		}
		if (prefix.endsWith('(')) {
			return ')';
		}
		if (prefix.endsWith('[')) {
			return ']';
		}
		if (prefix.endsWith(':')) {
			return `\n${nestedIndentation}`;
		}

		return undefined;
	}

	private completeCommonPatterns(
		linePrefix: string,
		linePrefixTrimmedRight: string,
		currentIndentation: string,
		nestedIndentation: string,
	): string | undefined {
		if (/\bif\s*\($/.test(linePrefixTrimmedRight)) {
			return `condition) {\n${nestedIndentation}\n${currentIndentation}}`;
		}
		if (/\bfor\s*\($/.test(linePrefixTrimmedRight)) {
			return `let i = 0; i < arr.length; i++) {\n${nestedIndentation}\n${currentIndentation}}`;
		}
		if (/\bfunction\s+$/.test(linePrefix)) {
			return `name(params) {\n${nestedIndentation}\n${currentIndentation}}`;
		}
		if (/\bconsole\.$/.test(linePrefixTrimmedRight)) {
			return 'log();';
		}
		if (/\bimport\s+$/.test(linePrefix)) {
			return '{ } from \'\';';
		}
		if (/\breturn\s+$/.test(linePrefix)) {
			return ';';
		}

		return undefined;
	}

	private completeLineContinuation(prefix: string, linePrefix: string): string | undefined {
		const trimmedCurrentLinePrefix = linePrefix.trim();
		if (!trimmedCurrentLinePrefix) {
			return undefined;
		}

		const lines = prefix.replace(/\r\n/g, '\n').split('\n');
		for (let index = lines.length - 2; index >= 0 && index >= lines.length - 10; index--) {
			const candidate = lines[index].trim();
			if (!candidate) {
				continue;
			}

			if (trimmedCurrentLinePrefix.endsWith('=')) {
				const rightHandSide = candidate.match(/=\s*(.+?);?$/)?.[1];
				if (rightHandSide) {
					return ` ${rightHandSide};`;
				}
			}

			if (candidate.startsWith(trimmedCurrentLinePrefix) && candidate.length > trimmedCurrentLinePrefix.length) {
				return candidate.slice(trimmedCurrentLinePrefix.length);
			}
		}

		return undefined;
	}
}
