/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import { ILanguageModelToolsService } from '../languageModelToolsService.js';
import { ConfirmationTool, ConfirmationToolData, ConfirmationToolWithOptionsData } from './confirmationTool.js';
import { EditTool, EditToolData } from './editFileTool.js';
import { createManageTodoListToolData, ManageTodoListTool } from './manageTodoListTool.js';
import { RunSubagentTool } from './runSubagentTool.js';
import {
	CreateDirectoryTool,
	CreateDirectoryToolData,
	CreateFileTool,
	CreateFileToolData,
	FileSearchTool,
	FileSearchToolData,
	ListDirectoryTool,
	ListDirectoryToolData,
	ReadFileTool,
	ReadFileToolData,
	TextSearchTool,
	TextSearchToolData,
} from './workspaceTools.js';

export class BuiltinToolsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'chat.builtinTools';

	constructor(
		@ILanguageModelToolsService toolsService: ILanguageModelToolsService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		const editTool = instantiationService.createInstance(EditTool);
		this._register(toolsService.registerTool(EditToolData, editTool));
		this._register(toolsService.editToolSet.addTool(EditToolData));

		const readFileTool = instantiationService.createInstance(ReadFileTool);
		this._register(toolsService.registerTool(ReadFileToolData, readFileTool));
		this._register(toolsService.readToolSet.addTool(ReadFileToolData));

		const listDirectoryTool = instantiationService.createInstance(ListDirectoryTool);
		this._register(toolsService.registerTool(ListDirectoryToolData, listDirectoryTool));
		this._register(toolsService.readToolSet.addTool(ListDirectoryToolData));

		const fileSearchTool = instantiationService.createInstance(FileSearchTool);
		this._register(toolsService.registerTool(FileSearchToolData, fileSearchTool));
		this._register(toolsService.searchToolSet.addTool(FileSearchToolData));

		const textSearchTool = instantiationService.createInstance(TextSearchTool);
		this._register(toolsService.registerTool(TextSearchToolData, textSearchTool));
		this._register(toolsService.searchToolSet.addTool(TextSearchToolData));

		const createFileTool = instantiationService.createInstance(CreateFileTool);
		this._register(toolsService.registerTool(CreateFileToolData, createFileTool));
		this._register(toolsService.editToolSet.addTool(CreateFileToolData));

		const createDirectoryTool = instantiationService.createInstance(CreateDirectoryTool);
		this._register(toolsService.registerTool(CreateDirectoryToolData, createDirectoryTool));
		this._register(toolsService.editToolSet.addTool(CreateDirectoryToolData));

		const todoToolData = createManageTodoListToolData();
		const manageTodoListTool = this._register(instantiationService.createInstance(ManageTodoListTool));
		this._register(toolsService.registerTool(todoToolData, manageTodoListTool));

		// Register the confirmation tool
		const confirmationTool = instantiationService.createInstance(ConfirmationTool);
		this._register(toolsService.registerTool(ConfirmationToolData, confirmationTool));
		this._register(toolsService.registerTool(ConfirmationToolWithOptionsData, confirmationTool));

		const runSubagentTool = this._register(instantiationService.createInstance(RunSubagentTool));

		let runSubagentRegistration: IDisposable | undefined;
		let toolSetRegistration: IDisposable | undefined;
		const registerRunSubagentTool = () => {
			runSubagentRegistration?.dispose();
			toolSetRegistration?.dispose();
			toolsService.flushToolUpdates();
			const runSubagentToolData = runSubagentTool.getToolData();
			runSubagentRegistration = toolsService.registerTool(runSubagentToolData, runSubagentTool);
			toolSetRegistration = toolsService.agentToolSet.addTool(runSubagentToolData);
		};
		registerRunSubagentTool();
		this._register(runSubagentTool.onDidUpdateToolData(registerRunSubagentTool));
		this._register({
			dispose: () => {
				runSubagentRegistration?.dispose();
				toolSetRegistration?.dispose();
			}
		});


	}
}

export const InternalFetchWebPageToolId = 'vscode_fetchWebPage_internal';
