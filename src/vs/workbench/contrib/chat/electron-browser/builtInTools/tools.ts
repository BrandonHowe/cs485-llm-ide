/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { isAbsolute } from '../../../../../base/common/path.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ChatExternalPathConfirmationContribution } from '../../common/tools/builtinTools/chatExternalPathConfirmation.js';
import { ChatUrlFetchingConfirmationContribution } from '../../common/tools/builtinTools/chatUrlFetchingConfirmation.js';
import { ILanguageModelToolsConfirmationService } from '../../common/tools/languageModelToolsConfirmationService.js';
import { ILanguageModelToolsService } from '../../common/tools/languageModelToolsService.js';
import { InternalFetchWebPageToolId } from '../../common/tools/builtinTools/tools.js';
import { FileSearchToolId, ListDirectoryToolId, ReadFileToolId, TextSearchToolId } from '../../common/tools/builtinTools/workspaceTools.js';
import { FetchWebPageTool, FetchWebPageToolData, IFetchWebPageToolParams } from './fetchPageTool.js';

export class NativeBuiltinToolsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'chat.nativeBuiltinTools';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ILanguageModelToolsConfirmationService confirmationService: ILanguageModelToolsConfirmationService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
	) {
		super();

		const editTool = instantiationService.createInstance(FetchWebPageTool);
		this._register(toolsService.registerTool(FetchWebPageToolData, editTool));
		this._register(toolsService.webToolSet.addTool(FetchWebPageToolData));

		this._register(confirmationService.registerConfirmationContribution(
			InternalFetchWebPageToolId,
			instantiationService.createInstance(
				ChatUrlFetchingConfirmationContribution,
				params => (params as IFetchWebPageToolParams).urls
			)
		));

		// Read and search tools all share the same session-scoped folder allowlist so an approval
		// for one folder can cover subsequent reads/searches in that location without creating a
		// second source of truth for path permissions.
		const externalPathConfirmation = new ChatExternalPathConfirmationContribution(
			(ref) => {
				const params = ref.parameters as { filePath?: string; path?: string };
				const rawPath = params?.filePath ?? params?.path;
				if (!rawPath) {
					return undefined;
				}

				let resolvedPath: URI | undefined;
				if (isAbsolute(rawPath)) {
					resolvedPath = URI.file(rawPath);
				} else {
					const workspace = workspaceContextService.getWorkspace();
					if (workspace.folders.length !== 1) {
						return undefined;
					}
					resolvedPath = joinPath(workspace.folders[0].uri, ...rawPath.split(/[\\/]+/).filter(Boolean));
				}

				return {
					path: resolvedPath.fsPath,
					isDirectory: !params?.filePath,
				};
			}
		);

		this._register(confirmationService.registerConfirmationContribution(
			'copilot_readFile',
			externalPathConfirmation
		));

		this._register(confirmationService.registerConfirmationContribution(
			'copilot_listDirectory',
			externalPathConfirmation
		));

		this._register(confirmationService.registerConfirmationContribution(
			ReadFileToolId,
			externalPathConfirmation
		));

		this._register(confirmationService.registerConfirmationContribution(
			ListDirectoryToolId,
			externalPathConfirmation
		));

		this._register(confirmationService.registerConfirmationContribution(
			FileSearchToolId,
			externalPathConfirmation
		));

		this._register(confirmationService.registerConfirmationContribution(
			TextSearchToolId,
			externalPathConfirmation
		));
	}
}
