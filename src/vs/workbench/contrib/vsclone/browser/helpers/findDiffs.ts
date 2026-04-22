/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSCloneComputedDiff } from '../../common/vscloneEditCodeServiceTypes.js';
import { diffLines } from '../preact/out/diff/index.js';

export function findDiffs(oldStr: string, newStr: string): VSCloneComputedDiff[] {

	// This makes it so the end of the file always ends with a \n. Without this, diffing E vs E\n
	// gives an "edit" rather than an "insertion". Adding the newline to both sides normalises it.
	newStr += '\n';
	oldStr += '\n';

	// An ordered list of every original line, line added to the new file, and line removed from
	// the old file. The order is unambiguous.
	const lineByLineChanges = diffLines(oldStr, newStr);
	// Push a dummy trailing no-op so any pending streak gets flushed at the end of the loop.
	lineByLineChanges.push({ value: '', added: false, removed: false });

	let oldFileLineNum: number = 1;
	let newFileLineNum: number = 1;

	let streakStartInNewFile: number | undefined = undefined;
	let streakStartInOldFile: number | undefined = undefined;

	const oldStrLines = ('\n' + oldStr).split('\n'); // add newline so indexing starts at 1
	const newStrLines = ('\n' + newStr).split('\n');

	const replacements: VSCloneComputedDiff[] = [];
	for (const line of lineByLineChanges) {

		// No change on this line.
		if (!line.added && !line.removed) {

			// If we were on a streak of +s and -s, end it.
			if (streakStartInNewFile !== undefined) {
				let type: 'edit' | 'insertion' | 'deletion' = 'edit';

				const startLine = streakStartInNewFile;
				const endLine = newFileLineNum - 1; // don't include current line, the edit was up to but not including it

				const originalStartLine = streakStartInOldFile!;
				const originalEndLine = oldFileLineNum - 1; // same

				const newContent = newStrLines.slice(startLine, endLine + 1).join('\n');
				const originalContent = oldStrLines.slice(originalStartLine, originalEndLine + 1).join('\n');

				// If the new-file range is empty this streak was a pure deletion.
				if (endLine === startLine - 1) {
					type = 'deletion';
				}
				// If the old-file range is empty this streak was a pure insertion.
				else if (originalEndLine === originalStartLine - 1) {
					type = 'insertion';
				}

				if (type === 'edit') {
					replacements.push({
						type,
						originalCode: originalContent,
						originalStartLine,
						originalEndLine,
						code: newContent,
						startLine,
						endLine,
					});
				} else if (type === 'insertion') {
					replacements.push({
						type,
						originalStartLine,
						code: newContent,
						startLine,
						endLine,
					});
				} else {
					replacements.push({
						type,
						originalCode: originalContent,
						originalStartLine,
						originalEndLine,
						startLine,
					});
				}

				streakStartInNewFile = undefined;
				streakStartInOldFile = undefined;
			}
			oldFileLineNum += line.count ?? 0;
			newFileLineNum += line.count ?? 0;
		}

		// Line was removed from the old file.
		else if (line.removed) {
			if (streakStartInNewFile === undefined) {
				streakStartInNewFile = newFileLineNum;
				streakStartInOldFile = oldFileLineNum;
			}
			oldFileLineNum += line.count ?? 0;
		}

		// Line was added to the new file.
		else if (line.added) {
			if (streakStartInNewFile === undefined) {
				streakStartInNewFile = newFileLineNum;
				streakStartInOldFile = oldFileLineNum;
			}
			newFileLineNum += line.count ?? 0;
		}
	}

	return replacements;
}
