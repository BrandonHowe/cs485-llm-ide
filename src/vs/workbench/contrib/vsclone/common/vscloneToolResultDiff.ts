/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const diffStartMarker = '[VSCLONE_TOOL_DIFF_START]';
const diffEndMarker = '[VSCLONE_TOOL_DIFF_END]';

export interface IVSCloneToolResultDiffPayload {
	readonly summary: string;
	readonly diff: string;
}

/**
 * Mutating tools include a structured diff payload so the chat transcript can render
 * a rich inline diff view while preserving plain-text compatibility for model context.
 */
export function formatToolResultWithDiff(summary: string, diff: string): string {
	return [
		summary.trim(),
		diffStartMarker,
		'```diff',
		diff.trimEnd(),
		'```',
		diffEndMarker,
	].join('\n');
}

/**
 * The parser is intentionally tolerant so older tool results (without markers) still
 * render normally and only marked payloads are upgraded into the dedicated diff card UI.
 */
export function parseToolResultDiff(output: string): IVSCloneToolResultDiffPayload | undefined {
	const startOffset = output.indexOf(diffStartMarker);
	if (startOffset < 0) {
		return undefined;
	}

	const endOffset = output.indexOf(diffEndMarker, startOffset + diffStartMarker.length);
	if (endOffset < 0) {
		return undefined;
	}

	const summary = output.slice(0, startOffset).trim();
	const payload = output.slice(startOffset + diffStartMarker.length, endOffset).trim();
	const fencedDiffMatch = /^```diff\s*\n([\s\S]*?)\n```$/m.exec(payload);
	const diff = (fencedDiffMatch?.[1] ?? payload).trimEnd();
	if (!diff) {
		return undefined;
	}

	return { summary, diff };
}
