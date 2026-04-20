/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { isAbsolute } from '../../../../../../base/common/path.js';
import { basename, dirname, joinPath } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { detectEncodingFromBuffer } from '../../../../../services/textfile/common/encoding.js';
import {
	FileOperationResult,
	IFileService,
	toFileOperationResult,
} from '../../../../../../platform/files/common/files.js';
import { IWorkspaceFolder, IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IChatService } from '../../chatService/chatService.js';
import { ChatModel } from '../../model/chatModel.js';
import {
	getExcludes,
	IFileQuery,
	IPatternInfo,
	ISearchConfiguration,
	ISearchComplete,
	ISearchService,
	ITextQuery,
	QueryType,
	resultIsMatch,
} from '../../../../../services/search/common/search.js';
import {
	CountTokensCallback,
	IPreparedToolInvocation,
	IToolData,
	IToolImpl,
	IToolInvocation,
	IToolInvocationPreparationContext,
	IToolResult,
	IToolResultInputOutputDetails,
	ToolDataSource,
	ToolProgress,
} from '../languageModelToolsService.js';

const enum WorkspaceToolLimits {
	MaxReadableBytes = 256 * 1024,
	MaxDirectoryEntries = 200,
	DefaultFileSearchResults = 100,
	DefaultTextSearchResults = 100,
	DefaultPreviewChars = 240,
	DefaultInlineMaxChars = 16000,
	MaxDetailsRefs = 200,
}

let externalEditOperationPool = 0;

export const ReadFileToolId = 'vscode_readFile';
export const ListDirectoryToolId = 'vscode_listDirectory';
export const FileSearchToolId = 'vscode_fileSearch';
export const TextSearchToolId = 'vscode_textSearch';
export const CreateFileToolId = 'vscode_createFile';
export const CreateDirectoryToolId = 'vscode_createDirectory';

export const ReadFileToolData: IToolData = {
	id: ReadFileToolId,
	toolReferenceName: 'readFile',
	displayName: localize('workspaceTools.readFile.displayName', 'Read File'),
	modelDescription: 'Read a UTF-8 text file from the workspace or an explicitly approved path. Use this to inspect source files and configuration files.',
	source: ToolDataSource.Internal,
	runsInWorkspace: true,
	canRequestPreApproval: true,
	inputSchema: {
		type: 'object',
		properties: {
			filePath: {
				type: 'string',
				description: 'The absolute path or workspace-relative path of the file to read.',
			},
			workspaceFolder: {
				type: 'string',
				description: 'Optional workspace folder name to use when resolving a relative path in a multi-root workspace.',
			},
		},
		required: ['filePath'],
		additionalProperties: false,
	},
};

export const ListDirectoryToolData: IToolData = {
	id: ListDirectoryToolId,
	toolReferenceName: 'listDirectory',
	displayName: localize('workspaceTools.listDirectory.displayName', 'List Directory'),
	modelDescription: 'List the direct children of a directory in the workspace or in an explicitly approved path.',
	source: ToolDataSource.Internal,
	runsInWorkspace: true,
	canRequestPreApproval: true,
	inputSchema: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'The absolute path or workspace-relative path of the directory to inspect.',
			},
			workspaceFolder: {
				type: 'string',
				description: 'Optional workspace folder name to use when resolving a relative path in a multi-root workspace.',
			},
		},
		required: ['path'],
		additionalProperties: false,
	},
};

export const FileSearchToolData: IToolData = {
	id: FileSearchToolId,
	toolReferenceName: 'fileSearch',
	legacyToolReferenceFullNames: ['findFiles'],
	displayName: localize('workspaceTools.fileSearch.displayName', 'Find Files'),
	modelDescription: 'Search for files by glob pattern in the workspace or in an explicitly approved directory.',
	source: ToolDataSource.Internal,
	runsInWorkspace: true,
	canRequestPreApproval: true,
	inputSchema: {
		type: 'object',
		properties: {
			pattern: {
				type: 'string',
				description: 'The glob pattern to match against file paths, such as `**/*.ts` or `package.json`.',
			},
			path: {
				type: 'string',
				description: 'Optional absolute or workspace-relative directory path to scope the search to.',
			},
			workspaceFolder: {
				type: 'string',
				description: 'Optional workspace folder name to use when resolving a relative search path in a multi-root workspace.',
			},
			maxResults: {
				type: 'number',
				description: 'Optional maximum number of file results to return.',
			},
		},
		required: ['pattern'],
		additionalProperties: false,
	},
};

export const TextSearchToolData: IToolData = {
	id: TextSearchToolId,
	toolReferenceName: 'textSearch',
	displayName: localize('workspaceTools.textSearch.displayName', 'Search File Contents'),
	modelDescription: 'Search file contents in the workspace or in an explicitly approved directory. Use this to find text, symbols, error messages, or regular-expression matches.',
	source: ToolDataSource.Internal,
	runsInWorkspace: true,
	canRequestPreApproval: true,
	inputSchema: {
		type: 'object',
		properties: {
			pattern: {
				type: 'string',
				description: 'The text or regular expression to search for.',
			},
			path: {
				type: 'string',
				description: 'Optional absolute or workspace-relative directory path to scope the search to.',
			},
			workspaceFolder: {
				type: 'string',
				description: 'Optional workspace folder name to use when resolving a relative search path in a multi-root workspace.',
			},
			maxResults: {
				type: 'number',
				description: 'Optional maximum number of text matches to return.',
			},
			isRegExp: {
				type: 'boolean',
				description: 'Whether `pattern` should be interpreted as a regular expression.',
			},
			isCaseSensitive: {
				type: 'boolean',
				description: 'Whether the search should be case-sensitive.',
			},
		},
		required: ['pattern'],
		additionalProperties: false,
	},
};

export const CreateFileToolData: IToolData = {
	id: CreateFileToolId,
	toolReferenceName: 'createFile',
	displayName: localize('workspaceTools.createFile.displayName', 'Create File'),
	modelDescription: 'Create a new file or overwrite an existing file in the workspace. Prefer using this tool when you want the resulting change to appear in the editing session review flow.',
	source: ToolDataSource.Internal,
	runsInWorkspace: true,
	canRequestPreApproval: true,
	inputSchema: {
		type: 'object',
		properties: {
			filePath: {
				type: 'string',
				description: 'The absolute path or workspace-relative path of the file to create or overwrite.',
			},
			contents: {
				type: 'string',
				description: 'The full contents to write into the file. Defaults to an empty file when omitted.',
			},
			overwrite: {
				type: 'boolean',
				description: 'Whether to overwrite an existing file.',
			},
			workspaceFolder: {
				type: 'string',
				description: 'Optional workspace folder name to use when resolving a relative path in a multi-root workspace.',
			},
		},
		required: ['filePath'],
		additionalProperties: false,
	},
};

export const CreateDirectoryToolData: IToolData = {
	id: CreateDirectoryToolId,
	toolReferenceName: 'createDirectory',
	displayName: localize('workspaceTools.createDirectory.displayName', 'Create Directory'),
	modelDescription: 'Create a directory in the workspace or in an explicitly approved path.',
	source: ToolDataSource.Internal,
	runsInWorkspace: true,
	canRequestPreApproval: true,
	inputSchema: {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'The absolute path or workspace-relative path of the directory to create.',
			},
			workspaceFolder: {
				type: 'string',
				description: 'Optional workspace folder name to use when resolving a relative path in a multi-root workspace.',
			},
		},
		required: ['path'],
		additionalProperties: false,
	},
};

interface IWorkspacePathParams {
	workspaceFolder?: string;
}

interface IReadFileParams extends IWorkspacePathParams {
	filePath: string;
}

interface IListDirectoryParams extends IWorkspacePathParams {
	path: string;
}

interface IFileSearchParams extends IWorkspacePathParams {
	pattern: string;
	path?: string;
	maxResults?: number;
}

interface ITextSearchParams extends IWorkspacePathParams {
	pattern: string;
	path?: string;
	maxResults?: number;
	isRegExp?: boolean;
	isCaseSensitive?: boolean;
}

interface ICreateFileParams extends IWorkspacePathParams {
	filePath: string;
	contents?: string;
	overwrite?: boolean;
}

interface ICreateDirectoryParams extends IWorkspacePathParams {
	path: string;
}

interface IResolvedWorkspacePath {
	resource: URI;
	originalPath: string;
	workspaceFolder: IWorkspaceFolder | undefined;
	isInsideWorkspace: boolean;
}

abstract class WorkspaceToolBase {

	constructor(
		@IFileService protected readonly fileService: IFileService,
		@IWorkspaceContextService protected readonly workspaceContextService: IWorkspaceContextService,
		@IConfigurationService protected readonly configurationService: IConfigurationService,
		@ISearchService protected readonly searchService: ISearchService,
		@IChatService protected readonly chatService: IChatService,
	) { }

	protected resolvePath(path: string, workspaceFolderName: string | undefined, option: 'file' | 'directory' | 'path'): IResolvedWorkspacePath {
		if (!path.trim()) {
			throw new Error(localize('workspaceTools.emptyPath', 'A non-empty path is required.'));
		}

		const workspace = this.workspaceContextService.getWorkspace();
		const normalizedPath = path.trim();
		let resource: URI;
		let workspaceFolder: IWorkspaceFolder | undefined;

		// Keep relative path resolution anchored to a concrete workspace folder so prompts can use
		// short paths without accidentally escaping to the process cwd in multi-root workspaces.
		if (looksLikeAbsolutePath(normalizedPath)) {
			resource = URI.file(normalizedPath);
		} else if (normalizedPath.includes('://')) {
			resource = URI.parse(normalizedPath);
			workspaceFolder = this.workspaceContextService.getWorkspaceFolder(resource) ?? undefined;
		} else {
			workspaceFolder = this.resolveWorkspaceFolder(workspaceFolderName);
			resource = joinPath(workspaceFolder.uri, ...normalizedPath.split(/[\\/]+/).filter(Boolean));
		}

		if (option === 'directory' && basename(resource) === '.' && workspaceFolder) {
			resource = workspaceFolder.uri;
		}

		return {
			resource,
			originalPath: normalizedPath,
			workspaceFolder: workspaceFolder ?? this.workspaceContextService.getWorkspaceFolder(resource) ?? undefined,
			isInsideWorkspace: this.workspaceContextService.isInsideWorkspace(resource) || workspace.folders.some(folder => folder.uri.toString() === resource.toString()),
		};
	}

	protected resolveSearchRoots(path: string | undefined, workspaceFolderName: string | undefined): IResolvedWorkspacePath[] {
		if (!path) {
			const workspace = this.workspaceContextService.getWorkspace();
			if (workspace.folders.length === 0) {
				throw new Error(localize('workspaceTools.noWorkspace', 'A workspace folder is required when no search path is provided.'));
			}
			return workspace.folders.map(folder => ({
				resource: folder.uri,
				originalPath: folder.uri.fsPath || folder.uri.path,
				workspaceFolder: folder,
				isInsideWorkspace: true,
			}));
		}

		return [this.resolvePath(path, workspaceFolderName, 'directory')];
	}

	protected resolveWorkspaceFolder(workspaceFolderName: string | undefined): IWorkspaceFolder {
		const workspace = this.workspaceContextService.getWorkspace();
		if (workspace.folders.length === 0) {
			throw new Error(localize('workspaceTools.noWorkspace', 'A workspace folder is required to resolve a relative path.'));
		}
		if (workspaceFolderName) {
			const folder = workspace.folders.find(candidate => candidate.name === workspaceFolderName);
			if (!folder) {
				throw new Error(localize('workspaceTools.unknownWorkspaceFolder', 'Workspace folder "{0}" was not found.', workspaceFolderName));
			}
			return folder;
		}
		if (workspace.folders.length === 1) {
			return workspace.folders[0];
		}
		throw new Error(localize('workspaceTools.workspaceFolderRequired', 'A workspace folder name is required when resolving a relative path in a multi-root workspace.'));
	}

	protected getExcludePattern(resource: URI) {
		return getExcludes(this.configurationService.getValue<ISearchConfiguration>({ resource })) || {};
	}

	protected getDisregardIgnoreFiles(): boolean {
		return this.configurationService.getValue<boolean>('explorer.excludeGitIgnore');
	}

	protected getDetails(input: string, resources: readonly URI[]): IToolResultInputOutputDetails {
		return {
			input,
			output: resources.slice(0, WorkspaceToolLimits.MaxDetailsRefs).map(resource => ({ type: 'ref' as const, uri: resource })),
		};
	}

	protected async createPathApprovalPreparation(
		action: string,
		targetPath: IResolvedWorkspacePath | undefined,
		message: string,
	): Promise<IPreparedToolInvocation | undefined> {
		if (!targetPath || targetPath.isInsideWorkspace) {
			return undefined;
		}

		return {
			invocationMessage: localize('workspaceTools.progressive', "{0}: {1}", action, targetPath.resource.fsPath || targetPath.resource.path),
			pastTenseMessage: localize('workspaceTools.past', "{0}: {1}", action, targetPath.resource.fsPath || targetPath.resource.path),
			confirmationMessages: {
				title: localize('workspaceTools.externalConfirmation.title', 'Allow access outside the workspace?'),
				message: new MarkdownString(message),
			},
		};
	}

	protected getCurrentRequest(invocation: IToolInvocation): { model: ChatModel; request: NonNullable<ReturnType<ChatModel['getRequests']>[number]> } {
		if (!invocation.context) {
			throw new Error(localize('workspaceTools.noSession', 'A chat session is required for this tool.'));
		}

		const model = this.chatService.getSession(invocation.context.sessionResource) as ChatModel | undefined;
		const request = model?.getRequests().find(candidate => candidate.id === invocation.chatRequestId) ?? model?.getRequests().at(-1);
		if (!model || !request) {
			throw new Error(localize('workspaceTools.noRequest', 'An active chat request is required for this tool.'));
		}

		return { model, request };
	}

	protected async fitTextToBudget(text: string, invocation: IToolInvocation, countTokens: CountTokensCallback, token: CancellationToken): Promise<string> {
		let candidate = text;
		let suffix = '';

		if (candidate.length > WorkspaceToolLimits.DefaultInlineMaxChars) {
			candidate = candidate.slice(0, WorkspaceToolLimits.DefaultInlineMaxChars);
			suffix = '\n\n[Output truncated due to length.]';
		}

		if (!invocation.tokenBudget) {
			return candidate + suffix;
		}

		const fullCandidate = candidate + suffix;
		if (await countTokens(fullCandidate, token) <= invocation.tokenBudget) {
			return fullCandidate;
		}

		const budgetSuffix = '\n\n[Output truncated to fit the tool token budget.]';
		let low = 0;
		let high = candidate.length;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			const probe = candidate.slice(0, mid) + budgetSuffix;
			if (await countTokens(probe, token) <= invocation.tokenBudget) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}

		return candidate.slice(0, low) + budgetSuffix;
	}

	protected getFileOperationError(resource: URI, error: unknown): Error {
		const fileOperationResult = error instanceof Error ? toFileOperationResult(error) : FileOperationResult.FILE_OTHER_ERROR;
		switch (fileOperationResult) {
			case FileOperationResult.FILE_NOT_FOUND:
				return new Error(localize('workspaceTools.fileNotFound', 'The path "{0}" was not found.', resource.fsPath || resource.path));
			case FileOperationResult.FILE_IS_DIRECTORY:
				return new Error(localize('workspaceTools.isDirectory', '"{0}" is a directory, not a file.', resource.fsPath || resource.path));
			case FileOperationResult.FILE_NOT_DIRECTORY:
				return new Error(localize('workspaceTools.notDirectory', '"{0}" is not a directory.', resource.fsPath || resource.path));
			case FileOperationResult.FILE_PERMISSION_DENIED:
				return new Error(localize('workspaceTools.permissionDenied', 'Permission was denied for "{0}".', resource.fsPath || resource.path));
			case FileOperationResult.FILE_TOO_LARGE:
				return new Error(localize('workspaceTools.fileTooLarge', '"{0}" is too large to process with this tool.', resource.fsPath || resource.path));
			default:
				return error instanceof Error ? error : new Error(String(error));
		}
	}
}

export class ReadFileTool extends WorkspaceToolBase implements IToolImpl {

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as IReadFileParams;
		const target = this.resolvePath(params.filePath, params.workspaceFolder, 'file');
		return this.createPathApprovalPreparation(
			localize('workspaceTools.readFile.action', 'Read file'),
			target,
			localize('workspaceTools.readFile.external', 'Read the file at `{0}`.', target.resource.fsPath || target.resource.path),
		);
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IReadFileParams;
		const target = this.resolvePath(params.filePath, params.workspaceFolder, 'file');

		try {
			const stat = await this.fileService.stat(target.resource);
			if (stat.isDirectory) {
				throw new Error(localize('workspaceTools.readFile.directory', '"{0}" is a directory. Use listDirectory instead.', target.resource.fsPath || target.resource.path));
			}
			if (stat.size > WorkspaceToolLimits.MaxReadableBytes) {
				throw new Error(localize('workspaceTools.readFile.tooLarge', '"{0}" is larger than the built-in read file limit of {1} KB.', target.resource.fsPath || target.resource.path, WorkspaceToolLimits.MaxReadableBytes / 1024));
			}

			const buffer = await this.fileService.readFile(target.resource, undefined, token);
			const detectedEncoding = detectEncodingFromBuffer({ buffer: buffer.value, bytesRead: buffer.value.byteLength });
			if (detectedEncoding.seemsBinary) {
				throw new Error(localize('workspaceTools.readFile.binary', '"{0}" appears to be a binary file and cannot be read with this tool.', target.resource.fsPath || target.resource.path));
			}

			const body = await this.fitTextToBudget(
				`Contents of ${target.resource.fsPath || target.resource.path}:\n\n${buffer.value.toString()}`,
				invocation,
				countTokens,
				token,
			);
			return {
				content: [{ kind: 'text', value: body }],
				toolResultDetails: this.getDetails(JSON.stringify({ filePath: params.filePath }), [target.resource]),
			};
		} catch (error) {
			throw this.getFileOperationError(target.resource, error);
		}
	}
}

export class ListDirectoryTool extends WorkspaceToolBase implements IToolImpl {

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as IListDirectoryParams;
		const target = this.resolvePath(params.path, params.workspaceFolder, 'directory');
		return this.createPathApprovalPreparation(
			localize('workspaceTools.listDirectory.action', 'List directory'),
			target,
			localize('workspaceTools.listDirectory.external', 'List the contents of `{0}`.', target.resource.fsPath || target.resource.path),
		);
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IListDirectoryParams;
		const target = this.resolvePath(params.path, params.workspaceFolder, 'directory');

		try {
			const stat = await this.fileService.resolve(target.resource, { resolveMetadata: true });
			if (!stat.isDirectory) {
				throw new Error(localize('workspaceTools.listDirectory.notDirectory', '"{0}" is not a directory.', target.resource.fsPath || target.resource.path));
			}

			const children = [...(stat.children ?? [])]
				.sort((left, right) => left.name.localeCompare(right.name))
				.slice(0, WorkspaceToolLimits.MaxDirectoryEntries);
			const body = await this.fitTextToBudget(
				[
					`Directory listing for ${target.resource.fsPath || target.resource.path}:`,
					...children.map(child => child.isDirectory
						? `- ${child.name}/`
						: `- ${child.name}${typeof child.size === 'number' ? ` (${child.size} bytes)` : ''}`),
				].join('\n'),
				invocation,
				countTokens,
				token,
			);

			return {
				content: [{ kind: 'text', value: body }],
				toolResultDetails: this.getDetails(JSON.stringify({ path: params.path }), [target.resource, ...children.map(child => child.resource)]),
			};
		} catch (error) {
			throw this.getFileOperationError(target.resource, error);
		}
	}
}

export class FileSearchTool extends WorkspaceToolBase implements IToolImpl {

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as IFileSearchParams;
		const target = params.path ? this.resolvePath(params.path, params.workspaceFolder, 'directory') : undefined;
		return this.createPathApprovalPreparation(
			localize('workspaceTools.fileSearch.action', 'Search files'),
			target,
			localize('workspaceTools.fileSearch.external', 'Search for files under `{0}` using the pattern `{1}`.', target?.resource.fsPath || target?.resource.path || '', params.pattern),
		);
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IFileSearchParams;
		const roots = this.resolveSearchRoots(params.path, params.workspaceFolder);
		const maxResults = normalizeMaxResults(params.maxResults, WorkspaceToolLimits.DefaultFileSearchResults);
		const folderQueries = await Promise.all(roots.map(async root => {
			const stat = await this.fileService.stat(root.resource);
			if (!stat.isDirectory) {
				throw new Error(localize('workspaceTools.search.notDirectory', '"{0}" is not a directory.', root.resource.fsPath || root.resource.path));
			}
			return {
				folder: root.resource,
				disregardIgnoreFiles: this.getDisregardIgnoreFiles(),
			};
		}));

		const query: IFileQuery = {
			type: QueryType.File,
			folderQueries,
			filePattern: params.pattern,
			shouldGlobMatchFilePattern: true,
			ignoreGlobCase: true,
			sortByScore: true,
			maxResults,
			excludePattern: this.getExcludePattern(folderQueries[0].folder),
		};

		const result = await this.searchService.fileSearch(query, token);
		const matches = result.results.slice(0, maxResults);
		const body = await this.fitTextToBudget(
			[
				`Found ${matches.length} file${matches.length === 1 ? '' : 's'} for pattern ${JSON.stringify(params.pattern)}:`,
				...matches.map(match => `- ${match.resource.fsPath || match.resource.path}`),
			].join('\n'),
			invocation,
			countTokens,
			token,
		);

		return {
			content: [{ kind: 'text', value: body }],
			toolResultDetails: this.getDetails(JSON.stringify({ pattern: params.pattern, path: params.path }), matches.map(match => match.resource)),
		};
	}
}

export class TextSearchTool extends WorkspaceToolBase implements IToolImpl {

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as ITextSearchParams;
		const target = params.path ? this.resolvePath(params.path, params.workspaceFolder, 'directory') : undefined;
		return this.createPathApprovalPreparation(
			localize('workspaceTools.textSearch.action', 'Search file contents'),
			target,
			localize('workspaceTools.textSearch.external', 'Search file contents under `{0}` using the pattern `{1}`.', target?.resource.fsPath || target?.resource.path || '', params.pattern),
		);
	}

	async invoke(invocation: IToolInvocation, countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as ITextSearchParams;
		const roots = this.resolveSearchRoots(params.path, params.workspaceFolder);
		const maxResults = normalizeMaxResults(params.maxResults, WorkspaceToolLimits.DefaultTextSearchResults);
		const folderQueries = await Promise.all(roots.map(async root => {
			const stat = await this.fileService.stat(root.resource);
			if (!stat.isDirectory) {
				throw new Error(localize('workspaceTools.search.notDirectory', '"{0}" is not a directory.', root.resource.fsPath || root.resource.path));
			}
			return {
				folder: root.resource,
				disregardIgnoreFiles: this.getDisregardIgnoreFiles(),
			};
		}));

		const query: ITextQuery = {
			type: QueryType.Text,
			folderQueries,
			contentPattern: {
				pattern: params.pattern,
				isRegExp: params.isRegExp,
				isCaseSensitive: params.isCaseSensitive,
			} satisfies IPatternInfo,
			maxResults,
			previewOptions: {
				matchLines: 1,
				charsPerLine: WorkspaceToolLimits.DefaultPreviewChars,
			},
			excludePattern: this.getExcludePattern(folderQueries[0].folder),
		};

		const result = await this.searchService.textSearch(query, token);
		const body = await this.fitTextToBudget(
			this.formatTextSearchResult(result, params.pattern),
			invocation,
			countTokens,
			token,
		);

		return {
			content: [{ kind: 'text', value: body }],
			toolResultDetails: this.getDetails(JSON.stringify({ pattern: params.pattern, path: params.path }), result.results.map(match => match.resource)),
		};
	}

	private formatTextSearchResult(result: ISearchComplete, pattern: string): string {
		const lines = [`Text search results for ${JSON.stringify(pattern)}:`];
		for (const fileMatch of result.results) {
			lines.push(`\n${fileMatch.resource.fsPath || fileMatch.resource.path}`);
			for (const entry of fileMatch.results ?? []) {
				if (!resultIsMatch(entry)) {
					continue;
				}
				for (const range of entry.rangeLocations) {
					lines.push(`  ${range.source.startLineNumber}:${range.source.startColumn} ${entry.previewText.trimEnd()}`);
				}
			}
		}
		return lines.join('\n');
	}
}

export class CreateFileTool extends WorkspaceToolBase implements IToolImpl {

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as ICreateFileParams;
		const target = this.resolvePath(params.filePath, params.workspaceFolder, 'file');
		const exists = await this.fileService.exists(target.resource);
		if (exists && !params.overwrite) {
			return {
				invocationMessage: localize('workspaceTools.createFile.exists', 'File already exists: {0}', target.resource.fsPath || target.resource.path),
				pastTenseMessage: localize('workspaceTools.createFile.exists', 'File already exists: {0}', target.resource.fsPath || target.resource.path),
			};
		}

		if (!target.isInsideWorkspace || exists) {
			// The NLS extractor only supports literal message strings, so branch before localize(...)
			// instead of embedding conditional expressions inside the localized message arguments.
			const invocationAction = exists
				? localize('workspaceTools.createFile.action.overwrite', 'Overwriting')
				: localize('workspaceTools.createFile.action.create', 'Creating');
			const pastTenseAction = exists
				? localize('workspaceTools.createFile.past.overwrite', 'Overwrote')
				: localize('workspaceTools.createFile.past.create', 'Created');
			const confirmationTitle = exists
				? localize('workspaceTools.createFile.confirm.title.overwrite', 'Allow overwriting this file?')
				: localize('workspaceTools.createFile.confirm.title.create', 'Allow creating this file?');
			const confirmationMessage = exists
				? localize('workspaceTools.createFile.confirm.message.overwrite', 'Overwrite `{0}` with the provided contents.', target.resource.fsPath || target.resource.path)
				: localize('workspaceTools.createFile.confirm.message.create', 'Create `{0}` with the provided contents.', target.resource.fsPath || target.resource.path);
			return {
				invocationMessage: localize('workspaceTools.createFile.action', '{0} {1}', invocationAction, target.resource.fsPath || target.resource.path),
				pastTenseMessage: localize('workspaceTools.createFile.past', '{0} {1}', pastTenseAction, target.resource.fsPath || target.resource.path),
				confirmationMessages: {
					title: confirmationTitle,
					message: new MarkdownString(confirmationMessage),
				},
			};
		}

		return undefined;
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as ICreateFileParams;
		const target = this.resolvePath(params.filePath, params.workspaceFolder, 'file');
		const { model, request } = this.getCurrentRequest(invocation);
		const editSession = model.editingSession;
		if (!editSession || !request.response) {
			throw new Error(localize('workspaceTools.createFile.editSessionRequired', 'This tool must be called from within an editing session.'));
		}

		const parent = dirname(target.resource);
		const parentStat = await this.fileService.stat(parent).catch(error => { throw this.getFileOperationError(parent, error); });
		if (!parentStat.isDirectory) {
			throw new Error(localize('workspaceTools.createFile.parentMissing', 'Parent directory "{0}" does not exist.', parent.fsPath || parent.path));
		}

		const exists = await this.fileService.exists(target.resource);
		if (exists && !params.overwrite) {
			throw new Error(localize('workspaceTools.createFile.alreadyExists', 'The file "{0}" already exists. Set overwrite=true to replace it.', target.resource.fsPath || target.resource.path));
		}

		const operationId = ++externalEditOperationPool;
		const startProgress = await editSession.startExternalEdits(request.response, operationId, [target.resource], request.id);
		for (const part of startProgress) {
			model.acceptResponseProgress(request, part);
		}

		try {
			if (exists) {
				await this.fileService.writeFile(target.resource, VSBuffer.fromString(params.contents ?? ''));
			} else {
				// Route file creation through the external-edits capture path so new files still
				// become checkpointed, reviewable entries in the active editing session.
				await this.fileService.createFile(target.resource, VSBuffer.fromString(params.contents ?? ''), { overwrite: false });
			}
		} catch (error) {
			throw this.getFileOperationError(target.resource, error);
		} finally {
			const stopProgress = await editSession.stopExternalEdits(request.response, operationId);
			for (const part of stopProgress) {
				model.acceptResponseProgress(request, part);
			}
		}

		return {
			content: [{
				kind: 'text',
				value: exists
					? localize('workspaceTools.createFile.updated', 'Updated file {0}.', target.resource.fsPath || target.resource.path)
					: localize('workspaceTools.createFile.created', 'Created file {0}.', target.resource.fsPath || target.resource.path),
			}],
			toolResultDetails: this.getDetails(JSON.stringify({ filePath: params.filePath, overwrite: params.overwrite ?? false }), [target.resource]),
		};
	}
}

export class CreateDirectoryTool extends WorkspaceToolBase implements IToolImpl {

	async prepareToolInvocation(context: IToolInvocationPreparationContext, _token: CancellationToken): Promise<IPreparedToolInvocation | undefined> {
		const params = context.parameters as ICreateDirectoryParams;
		const target = this.resolvePath(params.path, params.workspaceFolder, 'directory');
		if (!target.isInsideWorkspace) {
			return {
				invocationMessage: localize('workspaceTools.createDirectory.action', 'Creating directory {0}', target.resource.fsPath || target.resource.path),
				pastTenseMessage: localize('workspaceTools.createDirectory.past', 'Created directory {0}', target.resource.fsPath || target.resource.path),
				confirmationMessages: {
					title: localize('workspaceTools.createDirectory.confirm.title', 'Allow creating this directory?'),
					message: new MarkdownString(localize('workspaceTools.createDirectory.confirm.message', 'Create the directory `{0}`.', target.resource.fsPath || target.resource.path)),
				},
			};
		}

		return undefined;
	}

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as ICreateDirectoryParams;
		const target = this.resolvePath(params.path, params.workspaceFolder, 'directory');

		try {
			const exists = await this.fileService.exists(target.resource);
			if (exists) {
				const stat = await this.fileService.stat(target.resource);
				if (!stat.isDirectory) {
					throw new Error(localize('workspaceTools.createDirectory.fileExists', '"{0}" already exists and is not a directory.', target.resource.fsPath || target.resource.path));
				}
				return {
					content: [{ kind: 'text', value: localize('workspaceTools.createDirectory.exists', 'Directory already exists: {0}', target.resource.fsPath || target.resource.path) }],
					toolResultDetails: this.getDetails(JSON.stringify({ path: params.path }), [target.resource]),
				};
			}

			await this.fileService.createFolder(target.resource);
			return {
				content: [{ kind: 'text', value: localize('workspaceTools.createDirectory.created', 'Created directory {0}.', target.resource.fsPath || target.resource.path) }],
				toolResultDetails: this.getDetails(JSON.stringify({ path: params.path }), [target.resource]),
			};
		} catch (error) {
			throw this.getFileOperationError(target.resource, error);
		}
	}
}

function looksLikeAbsolutePath(path: string): boolean {
	return isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path);
}

function normalizeMaxResults(value: number | undefined, fallback: number): number {
	return typeof value === 'number' && value > 0 ? Math.floor(value) : fallback;
}
