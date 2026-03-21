/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IVSCloneCompletionCrossFileContext } from '../common/vscloneCompletionTypes.js';

const maxTotalContextChars = 5_000;

/**
 * Browser-side context gathering stays separate from prompt assembly so common completion code can
 * remain transport-focused while the workbench layer decides which live tabs are worth sampling.
 */
export const IVSCloneCompletionContextService = createDecorator<IVSCloneCompletionContextService>('vscloneCompletionContextService');

/**
 * Completion snippets intentionally use the same shape as the transport contract to keep the
 * browser-to-common handoff simple and fully serializable.
 */
export type IVSCloneCompletionContextSnippet = IVSCloneCompletionCrossFileContext;

export interface IVSCloneCompletionContextService {
	readonly _serviceBrand: undefined;
	gatherContext(currentUri: URI, currentLanguageId: string, maxSnippets: number, maxCharsPerSnippet: number): readonly IVSCloneCompletionContextSnippet[];
}

interface IContextCandidate {
	readonly resource: URI;
	readonly model: ITextModel;
	readonly filePath: string;
	readonly languageId: string;
	readonly score: number;
	readonly size: number;
	readonly editorOrder: number;
}

export class VSCloneCompletionContextService implements IVSCloneCompletionContextService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IModelService private readonly modelService: IModelService,
		@ILogService private readonly logService: ILogService,
	) {
	}

	gatherContext(currentUri: URI, currentLanguageId: string, maxSnippets: number, maxCharsPerSnippet: number): readonly IVSCloneCompletionContextSnippet[] {
		if (maxSnippets <= 0 || maxCharsPerSnippet <= 0) {
			return [];
		}

		const seen = new Set<string>([currentUri.toString()]);
		const candidates: IContextCandidate[] = [];

		for (let index = 0; index < this.editorService.editors.length; index++) {
			const editor = this.editorService.editors[index];
			const resource = EditorResourceAccessor.getOriginalUri(editor, {
				supportSideBySide: SideBySideEditor.ANY,
			});
			if (!resource) {
				continue;
			}

			const resourceKey = resource.toString();
			if (seen.has(resourceKey)) {
				continue;
			}
			seen.add(resourceKey);

			const model = this.modelService.getModel(resource);
			if (!model) {
				continue;
			}

			const fileSize = model.getValueLength();
			if (fileSize === 0) {
				continue;
			}

			candidates.push({
				resource,
				model,
				filePath: resource.fsPath || resource.path || resource.toString(),
				languageId: model.getLanguageId(),
				score: this.scoreCandidate(model, currentLanguageId, maxCharsPerSnippet),
				size: fileSize,
				editorOrder: index,
			});
		}

		candidates.sort((left, right) => {
			return right.score - left.score
				|| left.size - right.size
				|| left.editorOrder - right.editorOrder
				|| left.filePath.localeCompare(right.filePath);
		});

		const snippets: IVSCloneCompletionContextSnippet[] = [];
		let remainingChars = maxTotalContextChars;
		for (const candidate of candidates) {
			if (snippets.length >= maxSnippets || remainingChars <= 0) {
				break;
			}

			const snippetBudget = Math.min(maxCharsPerSnippet, remainingChars);
			const content = this.extractSnippet(candidate.model, snippetBudget);
			if (!content.trim()) {
				continue;
			}

			snippets.push({
				filePath: candidate.filePath,
				languageId: candidate.languageId,
				content,
			});
			remainingChars -= content.length;
		}

		return snippets;
	}

	/**
	 * Same-language and edited buffers are stronger semantic signals than untouched tabs, while
	 * smaller files usually surface imports and helper declarations without burning prompt budget.
	 */
	private scoreCandidate(model: ITextModel, currentLanguageId: string, maxCharsPerSnippet: number): number {
		let score = 0;
		if (model.getLanguageId() === currentLanguageId) {
			score += 2;
		}
		if (model.getVersionId() > 1) {
			score += 1;
		}
		if (model.getValueLength() <= maxCharsPerSnippet) {
			score += 1;
		}

		return score;
	}

	private extractSnippet(model: ITextModel, maxChars: number): string {
		try {
			const value = model.getValue();
			if (value.length <= maxChars) {
				return value;
			}

			// Favor whole declarations when they fit; otherwise fall back to a hard slice so the
			// total budget remains deterministic even for unusually long first lines.
			const bounded = value.slice(0, maxChars);
			const lastNewline = bounded.lastIndexOf('\n');
			return lastNewline >= Math.floor(maxChars / 2) ? bounded.slice(0, lastNewline) : bounded;
		} catch (error) {
			this.logService.debug('[VSCloneCompletionContext] Failed to extract open-tab context.', error);
			return '';
		}
	}
}
