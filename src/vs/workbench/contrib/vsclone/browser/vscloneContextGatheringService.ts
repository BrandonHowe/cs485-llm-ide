/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { IVSClonePromptContext } from '../common/vsclonePrompts.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

export const IVSCloneContextGatheringService = createDecorator<IVSCloneContextGatheringService>('vscloneContextGatheringService');

export interface IVSCloneContextGatheringService {
	readonly _serviceBrand: undefined;
	gatherContext(): Promise<IVSClonePromptContext>;
}

export class VSCloneContextGatheringService implements IVSCloneContextGatheringService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IModelService private readonly modelService: IModelService,
	) {
	}

	async gatherContext(): Promise<IVSClonePromptContext> {
		return {
			// Phase 3 deliberately limits prompt context to the user's current editor focus. Directory
			// listings, open-file enumeration, and diagnostics are now meant to flow through tools so
			// the model pays for them only when they are actually needed.
			activeFile: this.getActiveFileContext(),
		};
	}

	private getActiveFileContext(): IVSClonePromptContext['activeFile'] {
		const codeEditor = getCodeEditor(this.editorService.activeTextEditorControl);
		const model = codeEditor?.getModel();
		if (!model) {
			return undefined;
		}

		// We prefer the live editor model because it includes unsaved edits.
		const liveModel = this.modelService.getModel(model.uri) ?? model;
		const selection = codeEditor?.getSelection();
		const hasSelection = !!selection && !selection.isEmpty();

		return {
			uri: liveModel.uri,
			languageId: liveModel.getLanguageId(),
			content: liveModel.getValue(),
			selection: hasSelection && selection ? liveModel.getValueInRange(selection) : undefined,
			// Even an empty selection communicates the cursor line for the prompt's active-file summary.
			selectionRange: selection
				? { startLine: selection.startLineNumber, endLine: selection.endLineNumber }
				: undefined,
		};
	}
}
