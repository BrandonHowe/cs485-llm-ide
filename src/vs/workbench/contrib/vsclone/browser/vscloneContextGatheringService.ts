/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVSClonePromptContext } from '../common/vsclonePromptAssemblyService.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';

const maxDirectoryDepth = 3;
const maxDirectoryChildren = 3;
const maxDirectoryTreeChars = 15000;
const ignoredDirectoryNames = new Set([
	'.git',
	'node_modules',
	'out',
	'dist',
	'build',
	'.cache',
	'__pycache__',
	'coverage',
]);

export const IVSCloneContextGatheringService = createDecorator<IVSCloneContextGatheringService>('vscloneContextGatheringService');

export interface IVSCloneContextGatheringService {
	readonly _serviceBrand: undefined;
	gatherContext(): Promise<IVSClonePromptContext>;
}

export class VSCloneContextGatheringService implements IVSCloneContextGatheringService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IModelService private readonly modelService: IModelService,
	) {
	}

	async gatherContext(): Promise<IVSClonePromptContext> {
		const activeFile = this.getActiveFileContext();
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders.map(folder => ({ name: folder.name, uri: folder.uri }));
		const [directoryTree, diagnostics] = await Promise.all([
			this.buildDirectoryTree(workspaceFolders),
			Promise.resolve(this.getDiagnostics(activeFile?.uri)),
		]);

		return {
			activeFile,
			openFiles: this.getOpenFiles(),
			workspaceFolders,
			directoryTree,
			diagnostics,
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
			// Even an empty selection communicates cursor location for centered truncation in prompt assembly.
			selectionRange: selection
				? { startLine: selection.startLineNumber, endLine: selection.endLineNumber }
				: undefined,
		};
	}

	private getOpenFiles(): readonly URI[] {
		const result: URI[] = [];
		const seen = new Set<string>();

		for (const editor of this.editorService.editors) {
			const resource = EditorResourceAccessor.getOriginalUri(editor, {
				supportSideBySide: SideBySideEditor.ANY,
			});
			if (!resource) {
				continue;
			}

			const key = resource.toString();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			result.push(resource);
		}

		return result;
	}

	private getDiagnostics(resource: URI | undefined): readonly { uri: URI; message: string; severity: string; line: number }[] {
		if (!resource) {
			return [];
		}

		const markers = this.markerService.read({ resource });
		return markers.map(marker => ({
			uri: marker.resource,
			message: marker.message,
			severity: this.toSeverityLabel(marker.severity),
			line: marker.startLineNumber,
		}));
	}

	private toSeverityLabel(severity: MarkerSeverity): string {
		switch (severity) {
			case MarkerSeverity.Error:
				return 'error';
			case MarkerSeverity.Warning:
				return 'warning';
			case MarkerSeverity.Info:
				return 'info';
			default:
				return 'hint';
		}
	}

	private async buildDirectoryTree(workspaceFolders: readonly { name: string; uri: URI }[]): Promise<string> {
		if (workspaceFolders.length === 0) {
			return '(no workspace folders)';
		}

		const lines: string[] = [];
		const budget = { remaining: maxDirectoryTreeChars, truncated: false };

		for (let folderIndex = 0; folderIndex < workspaceFolders.length; folderIndex++) {
			if (folderIndex > 0) {
				this.pushLineWithinBudget(lines, '', budget);
			}

			const folder = workspaceFolders[folderIndex];
			if (!this.pushLineWithinBudget(lines, `${folder.name}/`, budget)) {
				break;
			}

			await this.appendDirectoryChildren(folder.uri, '', 0, lines, budget);
			if (budget.truncated) {
				break;
			}
		}

		if (budget.truncated) {
			this.pushLineWithinBudget(lines, '... (truncated)', { remaining: 64, truncated: false });
		}

		return lines.join('\n');
	}

	private async appendDirectoryChildren(
		resource: URI,
		prefix: string,
		depth: number,
		lines: string[],
		budget: { remaining: number; truncated: boolean },
	): Promise<void> {
		if (depth >= maxDirectoryDepth || budget.truncated) {
			return;
		}

		let stat: IFileStat | undefined;
		try {
			stat = await this.fileService.resolve(resource);
		} catch {
			return;
		}
		if (!stat?.children || stat.children.length === 0) {
			return;
		}

		const visibleChildren = stat.children
			.filter(child => !ignoredDirectoryNames.has(child.name))
			.sort((left, right) => {
				if (left.isDirectory !== right.isDirectory) {
					return left.isDirectory ? -1 : 1;
				}
				return left.name.localeCompare(right.name);
			});

		const limitedChildren = visibleChildren.slice(0, maxDirectoryChildren);
		for (let i = 0; i < limitedChildren.length; i++) {
			const child = limitedChildren[i];
			const isLast = i === limitedChildren.length - 1;
			const connector = isLast ? '└── ' : '├── ';
			const childLine = `${prefix}${connector}${child.name}${child.isDirectory ? '/' : ''}`;
			if (!this.pushLineWithinBudget(lines, childLine, budget)) {
				return;
			}

			if (child.isDirectory && depth + 1 < maxDirectoryDepth) {
				const nextPrefix = `${prefix}${isLast ? '    ' : '│   '}`;
				await this.appendDirectoryChildren(child.resource, nextPrefix, depth + 1, lines, budget);
				if (budget.truncated) {
					return;
				}
			}
		}

		if (visibleChildren.length > limitedChildren.length) {
			this.pushLineWithinBudget(lines, `${prefix}└── ...`, budget);
		}
	}

	private pushLineWithinBudget(lines: string[], line: string, budget: { remaining: number; truncated: boolean }): boolean {
		const lineCost = line.length + 1;
		if (budget.remaining - lineCost < 0) {
			budget.truncated = true;
			return false;
		}

		budget.remaining -= lineCost;
		lines.push(line);
		return true;
	}
}
