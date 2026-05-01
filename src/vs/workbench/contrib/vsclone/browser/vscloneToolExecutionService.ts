/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { hasKey } from '../../../../base/common/types.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { isFileMatch, ISearchService, resultIsMatch } from '../../../services/search/common/search.js';
import { IMcpService, McpToolVisibility, type IMcpTool } from '../../mcp/common/mcpTypes.js';
import { IVSClonePlanModeService } from '../common/vsclonePlanModeService.js';
import { type VSCloneChatMode } from '../common/vsclonePlanModeTypes.js';
import { type IVSCloneToolDefinition, type IVSCloneToolJsonSchema, type VSCloneToolApprovalType, VSCLONE_TOOL_DEFINITIONS } from '../common/vscloneToolDefinitions.js';
import { formatToolResultWithDiff } from '../common/vscloneToolResultDiff.js';
import { isVSCloneAmbiguousWorkspaceRelativePath, resolveVSCloneWorkspacePath } from '../common/vscloneWorkspacePaths.js';
import { isVSCloneSensitiveFilePath } from '../common/vsclonePrompts.js';
import { resolveContentEdits } from './vscloneEditCodeService.js';
import {
	IVSCloneEditCodeService,
	type VSCloneParsedEdit as IVSCloneParsedEdit,
	type VSCloneResolvedContentEdit as IVSCloneResolvedContentEdit,
} from './vscloneEditCodeServiceInterface.js';
import { IVSCloneTerminalToolService } from './vscloneTerminalToolService.js';

const maxReadChars = 100000;
const maxDirectoryEntries = 200;
const maxSearchMatches = 50;
const maxDiffPreviewLines = 220;
const maxDiffPreviewChars = 12000;
const malformedEditFileChangesMessage = [
	'No SEARCH/REPLACE blocks found in changes parameter.',
	'The `changes` value for edit_file must contain one or more blocks in this exact format:',
	'<<<<<<< SEARCH',
	'<exact existing text>',
	'=======',
	'<replacement text>',
	'>>>>>>> REPLACE',
].join('\n');

export interface IVSCloneToolExecutionResult {
	readonly success: boolean;
	readonly output: string;
}

export const IVSCloneToolExecutionService = createDecorator<IVSCloneToolExecutionService>('vscloneToolExecutionService');

export interface IVSCloneToolExecutionService {
	readonly _serviceBrand: undefined;
	executeTool(toolName: string, params: Record<string, string>, mode?: VSCloneChatMode, token?: CancellationToken): Promise<IVSCloneToolExecutionResult>;
}

export const IVSCloneToolRuntimeService = createDecorator<IVSCloneToolRuntimeService>('vscloneToolRuntimeService');

export interface IVSCloneToolRuntimeService {
	readonly _serviceBrand: undefined;
	listToolDefinitions(mode?: VSCloneChatMode): readonly IVSCloneToolDefinition[];
	getToolDefinition(toolName: string): IVSCloneToolDefinition | undefined;
	getApprovalType(toolName: string): VSCloneToolApprovalType | undefined;
}

function normalizeToolName(toolName: string): string {
	// Keep accepting the pre-port XML names so older transcripts and persisted approvals remain
	// executable while new prompts only advertise the Void-style tool names.
	switch (toolName) {
		case 'list_directory':
			return 'ls_dir';
		case 'search_files':
			return 'search_for_files';
		default:
			return toolName;
	}
}

interface IParsedSearchReplaceBlock {
	readonly searchText: string;
	readonly replaceText: string;
}

interface IWorkspacePathResolution {
	readonly uri: URI;
	readonly rawPath: string;
}

export class VSCloneToolRuntimeService implements IVSCloneToolRuntimeService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IMcpService private readonly mcpService?: IMcpService,
	) {
		// MCP collections can be extension-backed and lazily discovered. Kick discovery once from the
		// runtime catalog owner so a chat started shortly after workbench load sees any installed MCP
		// tools as soon as the platform service has them.
		this.mcpService?.activateCollections().catch(error => {
			this.logService.warn('[VSCloneToolRuntime] Failed to activate MCP collections for tool discovery.', error);
		});
	}

	listToolDefinitions(mode: VSCloneChatMode = 'act'): readonly IVSCloneToolDefinition[] {
		const definitions = [
			...VSCLONE_TOOL_DEFINITIONS,
			...this.getMcpToolDefinitions(),
		];
		return mode === 'plan'
			? definitions.filter(tool => tool.planModeAllowed)
			: definitions;
	}

	getToolDefinition(toolName: string): IVSCloneToolDefinition | undefined {
		return this.listToolDefinitions('act').find(tool => tool.name === normalizeToolName(toolName));
	}

	getApprovalType(toolName: string): VSCloneToolApprovalType | undefined {
		return this.getToolDefinition(toolName)?.approvalType;
	}

	private getMcpToolDefinitions(): readonly IVSCloneToolDefinition[] {
		return this.getVisibleMcpTools().map(tool => ({
			name: tool.id,
			description: tool.definition.description ?? `Run MCP tool ${tool.referenceName}.`,
			approvalType: 'MCP tools',
			planModeAllowed: false,
			parameters: mcpSchemaToParameterDefinitions(tool.definition.inputSchema),
			inputSchema: mcpInputSchemaToVSCloneSchema(tool.definition.inputSchema),
		}));
	}

	private getVisibleMcpTools(): readonly IMcpTool[] {
		return this.mcpService?.servers.get().flatMap(server =>
			server.tools.get().filter(tool => Boolean(tool.visibility & McpToolVisibility.Model)),
		) ?? [];
	}
}

export class VSCloneToolExecutionService implements IVSCloneToolExecutionService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IModelService private readonly modelService: IModelService,
		@ISearchService private readonly searchService: ISearchService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IVSClonePlanModeService private readonly planModeService: IVSClonePlanModeService,
		@ILogService private readonly logService: ILogService,
		@IVSCloneEditCodeService private readonly editCodeService: IVSCloneEditCodeService,
		@IVSCloneTerminalToolService private readonly terminalToolService?: IVSCloneTerminalToolService,
		@IMcpService private readonly mcpService?: IMcpService,
	) {
	}

	async executeTool(toolName: string, params: Record<string, string>, mode: VSCloneChatMode = 'act', token: CancellationToken = CancellationToken.None): Promise<IVSCloneToolExecutionResult> {
		const normalizedToolName = normalizeToolName(toolName);
		const invocationLog = `[VSCloneToolExecution] Executing ${normalizedToolName} (${summarizeToolParams(params)})`;
		this.logService.info(invocationLog);
		if (token.isCancellationRequested) {
			return {
				success: false,
				output: `Tool ${normalizedToolName} was cancelled before it could finish.`,
			};
		}
		try {
			// Plan mode is enforced here as the last runtime gate so prompt drift or model disobedience
			// cannot silently turn a read-only planning turn into a workspace mutation.
			if (mode === 'plan' && !this.planModeService.isToolAllowed(mode, normalizedToolName)) {
				return {
					success: false,
					output: localize(
						'vsclone.toolExecution.planModeUnavailable',
						'Tool "{0}" is not available in plan mode. Switch to Act mode to make edits.',
						normalizedToolName,
					),
				};
			}

			const mcpTool = this.findMcpTool(normalizedToolName);
			if (mcpTool) {
				return this.executeMcpTool(mcpTool, params, token);
			}

			switch (normalizedToolName) {
				case 'read_file':
					return this.executeReadFile(params);
				case 'ls_dir':
					return this.executeListDirectory(params);
				case 'search_for_files':
					return this.executeSearchFiles(params, token);
				case 'edit_file':
					return this.executeEditFile(params);
				case 'create_file':
					return this.executeCreateFile(params);
				case 'run_command':
					return this.executeRunCommand(params, token);
				case 'open_persistent_terminal':
					return this.executeOpenPersistentTerminal(params, token);
				case 'run_persistent_command':
					return this.executeRunPersistentCommand(params, token);
				case 'kill_persistent_terminal':
					return this.executeKillPersistentTerminal(params, token);
				case 'ask_user':
					return {
						success: false,
						output: 'ask_user must be answered by the user before the agent can continue.',
					};
				case 'attempt_completion':
					return {
						success: true,
						output: params.result?.trim() || 'Task complete.',
					};
				default:
					return {
						success: false,
						output: `Unknown tool: ${normalizedToolName}`,
					};
			}
		} catch (error) {
			if (error instanceof CancellationError || token.isCancellationRequested) {
				return {
					success: false,
					output: `Tool ${normalizedToolName} was cancelled before it could finish.`,
				};
			}
			const message = error instanceof Error ? error.message : String(error);
			this.logService.error('[VSCloneToolExecution] Tool execution failed', error);
			return {
				success: false,
				output: message,
			};
		}
	}

	private async executeReadFile(params: Record<string, string>): Promise<IVSCloneToolExecutionResult> {
		const path = params.path;
		if (!path) {
			return { success: false, output: 'Missing required parameter: path' };
		}

		const target = this.resolveWorkspacePath(path);
		if (!target) {
			return { success: false, output: this.invalidPathMessage(path) };
		}

		if (isVSCloneSensitiveFilePath(target.rawPath)) {
			return { success: false, output: this.envProtectionMessage(target.rawPath) };
		}

		const stat = await this.safeResolve(target.uri);
		if (!stat) {
			return { success: false, output: `File not found: ${target.rawPath}` };
		}
		if (stat.isDirectory) {
			return { success: false, output: `Path is a directory, not a file: ${target.rawPath}` };
		}

		const content = await this.readFileContents(target.uri);
		const { text: boundedContent, truncatedChars } = truncateText(content, maxReadChars);
		const truncationNotice = truncatedChars > 0 ? `\n\n[truncated ${truncatedChars} characters]` : '';

		return {
			success: true,
			output: [
				`Contents of ${target.uri.toString()}:`,
				'```',
				boundedContent,
				'```',
				truncationNotice,
			].filter(Boolean).join('\n'),
		};
	}

	private findMcpTool(toolName: string): IMcpTool | undefined {
		for (const server of this.mcpService?.servers.get() ?? []) {
			const tool = server.tools.get().find(candidate =>
				// MCP tools are advertised to models with the platform-assigned id. Raw server names
				// can collide with built-ins like `read_file`, so dispatch must use the same namespaced
				// identifier that went through VSClone approval and provider declaration.
				candidate.id === toolName,
			);
			if (tool && (tool.visibility & McpToolVisibility.Model)) {
				return tool;
			}
		}
		return undefined;
	}

	private async executeMcpTool(tool: IMcpTool, params: Record<string, string>, token: CancellationToken): Promise<IVSCloneToolExecutionResult> {
		// Tool-call parameters are serialized through the provider bridge as strings for legacy
		// built-ins. MCP tools can have structured schemas, so decode JSON-shaped values before
		// calling the platform MCP service.
		const result = await tool.call(decodeMcpToolParams(params), undefined, token);
		return {
			success: !result.isError,
			output: formatMcpToolResult(result),
		};
	}

	private async executeListDirectory(params: Record<string, string>): Promise<IVSCloneToolExecutionResult> {
		const path = params.path;
		if (!path) {
			return { success: false, output: 'Missing required parameter: path' };
		}

		const target = this.resolveWorkspacePath(path);
		if (!target) {
			return { success: false, output: this.invalidPathMessage(path) };
		}

		const recursive = toBoolean(params.recursive);
		const root = await this.safeResolve(target.uri);
		if (!root) {
			return { success: false, output: `Directory not found: ${target.rawPath}` };
		}
		if (!root.isDirectory) {
			return { success: false, output: `Path is a file, not a directory: ${target.rawPath}` };
		}

		const lines: string[] = [`Directory listing for ${target.uri.toString()}:`];
		const state = { count: 0, truncated: false };
		await this.appendDirectoryListing(root.resource, '', recursive, lines, state);
		// A blank listing is ambiguous to the model, so emit an explicit marker for truly empty folders.
		if (state.count === 0) {
			lines.push('(empty directory)');
		}
		if (state.truncated) {
			lines.push(`[truncated after ${maxDirectoryEntries} entries]`);
		}

		return {
			success: true,
			output: lines.join('\n'),
		};
	}

	private async executeSearchFiles(params: Record<string, string>, externalToken: CancellationToken = CancellationToken.None): Promise<IVSCloneToolExecutionResult> {
		const path = params.path;
		const pattern = params.pattern;
		if (!path) {
			return { success: false, output: 'Missing required parameter: path' };
		}
		if (!pattern) {
			return { success: false, output: 'Missing required parameter: pattern' };
		}

		// Models occasionally emit malformed regex (e.g. unbalanced parens) that the underlying
		// search engine handles inconsistently across platforms. Validating up front turns the
		// failure into a fast, actionable error instead of relying on the engine to bail out.
		try {
			void new RegExp(pattern);
		} catch (regexError) {
			const message = regexError instanceof Error ? regexError.message : String(regexError);
			return {
				success: false,
				output: `Invalid regex pattern /${pattern}/: ${message}`,
			};
		}

		const target = this.resolveWorkspacePath(path);
		if (!target) {
			return { success: false, output: this.invalidPathMessage(path) };
		}

		const root = await this.safeResolve(target.uri);
		if (!root) {
			return { success: false, output: `Directory not found: ${target.rawPath}` };
		}
		if (!root.isDirectory) {
			return { success: false, output: `Path is a file, not a directory: ${target.rawPath}` };
		}

		const queryBuilder = this.instantiationService.createInstance(QueryBuilder);
		const textQuery = queryBuilder.text({
			pattern,
			isRegExp: true,
		}, [target.uri], {
			includePattern: params.file_glob ? params.file_glob : undefined,
			previewOptions: { matchLines: 1, charsPerLine: 160 },
			maxResults: maxSearchMatches,
		});

		// Local CTS is used to halt the search once the result cap is reached. The external token
		// is forwarded so that the thread runtime's stop action (and tool-execution timeout) can
		// also terminate an in-flight search instead of leaving the chat stuck.
		const cts = new CancellationTokenSource();
		const externalCancelListener = externalToken.onCancellationRequested(() => cts.cancel());
		const lines: string[] = [];
		let matchCount = 0;
		let limited = false;

		try {
			await this.searchService.textSearch(textQuery, cts.token, item => {
				if (!isFileMatch(item) || !item.results || limited) {
					return;
				}

				for (const result of item.results) {
					if (!resultIsMatch(result)) {
						continue;
					}

					for (const location of result.rangeLocations) {
						if (matchCount >= maxSearchMatches) {
							limited = true;
							cts.cancel();
							break;
						}

						matchCount += 1;
						const preview = result.previewText.replace(/\s+/g, ' ').trim();
						lines.push(`${item.resource.toString()}:${location.source.startLineNumber}:${location.source.startColumn} ${preview}`);
					}

					if (limited) {
						break;
					}
				}
			});
		} catch (error) {
			// Cancellation is used intentionally to stop once we reach the configured result cap.
			if (!cts.token.isCancellationRequested) {
				throw error;
			}
		} finally {
			externalCancelListener.dispose();
			cts.dispose();
		}

		if (externalToken.isCancellationRequested && !limited) {
			throw new CancellationError();
		}

		if (lines.length === 0) {
			return {
				success: true,
				output: `No matches found for pattern /${pattern}/ in ${target.uri.toString()}.`,
			};
		}

		const limitedNotice = limited ? `\n[limited to ${maxSearchMatches} matches]` : '';
		return {
			success: true,
			output: [
				`Found ${matchCount} match(es) in ${target.uri.toString()}:`,
				...lines,
				limitedNotice,
			].filter(Boolean).join('\n'),
		};
	}

	private async executeEditFile(params: Record<string, string>): Promise<IVSCloneToolExecutionResult> {
		const path = params.path;
		const changes = params.changes;
		if (!path) {
			return { success: false, output: 'Missing required parameter: path' };
		}
		if (!changes) {
			return { success: false, output: 'Missing required parameter: changes' };
		}

		const target = this.resolveWorkspacePath(path);
		if (!target) {
			return { success: false, output: this.invalidPathMessage(path) };
		}

		if (isVSCloneSensitiveFilePath(target.rawPath)) {
			return { success: false, output: this.envProtectionMessage(target.rawPath) };
		}

		const stat = await this.safeResolve(target.uri);
		if (!stat) {
			return { success: false, output: `File not found: ${target.rawPath}` };
		}
		if (stat.isDirectory) {
			return { success: false, output: `Path is a directory, not a file: ${target.rawPath}` };
		}

		const parsedBlocks = parseSearchReplaceBlocks(changes);
		if (parsedBlocks.length === 0) {
			// This warning is intentionally structured around the malformed payload preview because the
			// UI error alone does not explain whether the model omitted delimiters entirely or only sent
			// prose. Keeping a short preview in logs makes bad tool-call generations debuggable.
			this.logService.warn('[VSCloneToolExecution] edit_file called without SEARCH/REPLACE blocks', {
				path: target.rawPath,
				changesPreview: summarizeEditPayload(changes),
			});
			return { success: false, output: malformedEditFileChangesMessage };
		}
		if (parsedBlocks.some(block => block.searchText.trim().length === 0)) {
			this.logService.warn('[VSCloneToolExecution] edit_file called with an empty SEARCH block', {
				path: target.rawPath,
				changesPreview: summarizeEditPayload(changes),
			});
			return { success: false, output: 'Empty SEARCH blocks are not allowed in edit_file. Use create_file for new files.' };
		}

		const content = await this.readFileContents(target.uri);
		const edits: IVSCloneParsedEdit[] = parsedBlocks.map((block, index) => ({
			filePath: target.uri.toString(),
			searchText: block.searchText,
			replaceText: block.replaceText,
			order: index,
		}));

		const resolved = resolveContentEdits(content, edits);
		if (resolved.failed.length > 0) {
			return {
				success: false,
				output: `One or more SEARCH blocks did not match ${target.uri.toString()}.`,
			};
		}

		const diffPreview = this.buildEditFileDiffPreview(target.rawPath, content, resolved.resolved);
		// Assistant-triggered edits must flow through the shared edit engine so any new diff-zone,
		// checkpoint, or undo semantics remain authoritative. The tool keeps a local preview copy of
		// the resolved edits only for transcript rendering; it no longer applies the mutation itself.
		await this.editCodeService.callBeforeApplyOrEdit(target.uri);
		const applyResult = await this.editCodeService.instantlyApplySearchReplaceBlocks({
			uri: target.uri,
			searchReplaceBlocks: changes,
		});
		if (applyResult.appliedEdits === 0) {
			return this.toToolApplyFailure(target.uri, applyResult.failures, 'searchReplace');
		}

		const markerCount = this.markerService.read({ resource: target.uri }).length;
		return {
			success: true,
			output: formatToolResultWithDiff(
				`Applied ${applyResult.appliedEdits} edit(s) to ${target.uri.toString()}. Current diagnostics on file: ${markerCount}.`,
				diffPreview,
			),
		};
	}

	private async executeCreateFile(params: Record<string, string>): Promise<IVSCloneToolExecutionResult> {
		const path = params.path;
		const content = params.content;
		if (!path) {
			return { success: false, output: 'Missing required parameter: path' };
		}
		if (content === undefined) {
			return { success: false, output: 'Missing required parameter: content' };
		}

		const target = this.resolveWorkspacePath(path);
		if (!target) {
			return { success: false, output: this.invalidPathMessage(path) };
		}

		if (isVSCloneSensitiveFilePath(target.rawPath)) {
			return { success: false, output: this.envProtectionMessage(target.rawPath) };
		}

		if (await this.fileService.exists(target.uri)) {
			return { success: false, output: `File already exists: ${target.rawPath}` };
		}

		const diffPreview = this.buildCreateFileDiffPreview(target.rawPath, content);
		// Route create_file through the same engine as click-apply so create operations start
		// participating in diff tracking immediately instead of appearing as opaque direct writes.
		const applyResult = await this.editCodeService.instantlyRewriteFile({
			uri: target.uri,
			newContent: content,
		});
		if (applyResult.appliedEdits === 0) {
			return this.toToolApplyFailure(target.uri, applyResult.failures, 'rewrite');
		}

		return {
			success: true,
			output: formatToolResultWithDiff(
				`Created file ${target.uri.toString()}.`,
				diffPreview,
			),
		};
	}

	private async executeRunCommand(params: Record<string, string>, token: CancellationToken): Promise<IVSCloneToolExecutionResult> {
		if (!this.terminalToolService) {
			return { success: false, output: 'Terminal tooling is not available in this build.' };
		}
		if (token.isCancellationRequested) {
			return { success: false, output: 'Tool run_command was cancelled before it could finish.' };
		}

		const command = readToolParam(params, 'command');
		if (!command) {
			return { success: false, output: 'Missing required parameter: command' };
		}

		const cwd = readToolParam(params, 'cwd') ?? null;
		const terminalId = generateUuid();
		const { interrupt, resPromise } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId });
		let cancellationListener: { dispose(): void } | undefined;
		const cancellationPromise = new Promise<never>((_, reject) => {
			cancellationListener = token.onCancellationRequested(() => {
				interrupt();
				reject(new CancellationError());
			});
		});
		try {
			const { result, resolveReason } = await Promise.race([resPromise, cancellationPromise]);

			return {
				success: true,
				output: [
					`Command: ${command}`,
					`Resolve reason: ${describeTerminalResolveReason(resolveReason)}`,
					result || '(empty output)',
				].join('\n'),
			};
		} finally {
			cancellationListener?.dispose();
		}
	}

	private async executeOpenPersistentTerminal(params: Record<string, string>, token: CancellationToken): Promise<IVSCloneToolExecutionResult> {
		if (!this.terminalToolService) {
			return { success: false, output: 'Terminal tooling is not available in this build.' };
		}
		if (token.isCancellationRequested) {
			return { success: false, output: 'Tool open_persistent_terminal was cancelled before it could finish.' };
		}

		const cwd = readToolParam(params, 'cwd') ?? null;
		const persistentTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd });
		return {
			success: true,
			output: `Created persistent terminal ${persistentTerminalId} (${persistentTerminalId === '1' ? 'VSClone Tool Terminal' : `VSClone Tool Terminal (${persistentTerminalId})`}).`,
		};
	}

	private async executeRunPersistentCommand(params: Record<string, string>, token: CancellationToken): Promise<IVSCloneToolExecutionResult> {
		if (!this.terminalToolService) {
			return { success: false, output: 'Terminal tooling is not available in this build.' };
		}
		if (token.isCancellationRequested) {
			return { success: false, output: 'Tool run_persistent_command was cancelled before it could finish.' };
		}

		const persistentTerminalId = readToolParam(params, 'persistent_terminal_id', 'persistentTerminalId');
		const command = readToolParam(params, 'command');
		if (!persistentTerminalId) {
			return { success: false, output: 'Missing required parameter: persistent_terminal_id' };
		}
		if (!command) {
			return { success: false, output: 'Missing required parameter: command' };
		}

		const { interrupt, resPromise } = await this.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId });
		let cancellationListener: { dispose(): void } | undefined;
		const cancellationPromise = new Promise<never>((_, reject) => {
			cancellationListener = token.onCancellationRequested(() => {
				interrupt();
				reject(new CancellationError());
			});
		});
		try {
			const { result, resolveReason } = await Promise.race([resPromise, cancellationPromise]);

			return {
				success: true,
				output: [
					`Persistent terminal: ${persistentTerminalId}`,
					`Command: ${command}`,
					`Resolve reason: ${describeTerminalResolveReason(resolveReason)}`,
					result || '(empty output)',
				].join('\n'),
			};
		} finally {
			cancellationListener?.dispose();
		}
	}

	private async executeKillPersistentTerminal(params: Record<string, string>, token: CancellationToken): Promise<IVSCloneToolExecutionResult> {
		if (!this.terminalToolService) {
			return { success: false, output: 'Terminal tooling is not available in this build.' };
		}
		if (token.isCancellationRequested) {
			return { success: false, output: 'Tool kill_persistent_terminal was cancelled before it could finish.' };
		}

		const persistentTerminalId = readToolParam(params, 'persistent_terminal_id', 'persistentTerminalId');
		if (!persistentTerminalId) {
			return { success: false, output: 'Missing required parameter: persistent_terminal_id' };
		}

		await this.terminalToolService.killPersistentTerminal(persistentTerminalId);
		return {
			success: true,
			output: `Closed persistent terminal ${persistentTerminalId}.`,
		};
	}

	private async appendDirectoryListing(
		root: URI,
		prefix: string,
		recursive: boolean,
		lines: string[],
		state: { count: number; truncated: boolean },
	): Promise<void> {
		if (state.truncated) {
			return;
		}

		const stat = await this.safeResolve(root);
		if (!stat?.children) {
			return;
		}

		const children = [...stat.children].sort((left, right) => {
			if (left.isDirectory !== right.isDirectory) {
				return left.isDirectory ? -1 : 1;
			}
			return left.name.localeCompare(right.name);
		});

		for (let index = 0; index < children.length; index++) {
			if (state.count >= maxDirectoryEntries) {
				state.truncated = true;
				return;
			}

			const child = children[index];
			const isLast = index === children.length - 1;
			const connector = isLast ? '`-- ' : '|-- ';
			lines.push(`${prefix}${connector}${child.name}${child.isDirectory ? '/' : ''}`);
			state.count += 1;

			if (recursive && child.isDirectory) {
				const childPrefix = `${prefix}${isLast ? '    ' : '|   '}`;
				await this.appendDirectoryListing(child.resource, childPrefix, recursive, lines, state);
				if (state.truncated) {
					return;
				}
			}
		}
	}

	private resolveWorkspacePath(rawPath: string): IWorkspacePathResolution | undefined {
		const normalizedPath = normalizePath(rawPath);
		if (!normalizedPath) {
			return undefined;
		}

		const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
		if (workspaceFolders.length === 0) {
			return undefined;
		}

		const candidate = resolveVSCloneWorkspacePath(workspaceFolders, normalizedPath);

		if (!candidate || !this.workspaceContextService.isInsideWorkspace(candidate)) {
			return undefined;
		}

		return { uri: candidate, rawPath: normalizedPath };
	}

	private envProtectionMessage(path: string): string {
		return `Access denied: ${path} is a .env file. .env files are protected from read/write access. They remain visible in directory listings but their contents cannot be read or modified by tools.`;
	}

	private async readFileContents(resource: URI): Promise<string> {
		// Open models include unsaved text; prefer them so edits/search operate on what the user sees.
		const openModel = this.modelService.getModel(resource);
		if (openModel) {
			return openModel.getValue();
		}

		const fileContents = await this.fileService.readFile(resource);
		return fileContents.value.toString();
	}

	private async safeResolve(resource: URI) {
		try {
			return await this.fileService.resolve(resource);
		} catch {
			return undefined;
		}
	}

	/**
	 * The preview only includes mutated hunks so transcript diffs stay compact enough to read
	 * while still exposing exactly what was replaced. We emit unified hunk headers with the
	 * modified start line so the chat transcript can navigate back to the applied location.
	 */
	private buildEditFileDiffPreview(rawPath: string, originalContent: string, edits: readonly IVSCloneResolvedContentEdit[]): string {
		const displayPath = toDiffDisplayPath(rawPath);
		const lines: string[] = [
			`--- a/${displayPath}`,
			`+++ b/${displayPath}`,
		];

		const ordered = [...edits].sort((left, right) => left.startOffset - right.startOffset);
		let modifiedLineDelta = 0;
		for (const edit of ordered) {
			const before = originalContent.slice(edit.startOffset, edit.endOffset);
			const beforeLines = splitLinesForDiff(before);
			const afterLines = splitLinesForDiff(edit.replaceText);
			const originalStart = positionAtOffset(originalContent, edit.startOffset);
			const originalLineCount = countDiffHunkLines(before);
			const modifiedLineCount = countDiffHunkLines(edit.replaceText);
			const modifiedStartLineNumber = Math.max(1, originalStart.lineNumber + modifiedLineDelta);
			lines.push(`@@ -${originalStart.lineNumber},${originalLineCount} +${modifiedStartLineNumber},${modifiedLineCount} @@`);
			for (const line of beforeLines) {
				lines.push(`-${line}`);
			}
			for (const line of afterLines) {
				lines.push(`+${line}`);
			}
			modifiedLineDelta += modifiedLineCount - originalLineCount;
		}

		return finalizeDiffPreview(lines);
	}

	/**
	 * New files are represented as a /dev/null diff so the UI can reuse the same renderer
	 * for both create_file and edit_file tool results.
	 */
	private buildCreateFileDiffPreview(rawPath: string, content: string): string {
		const displayPath = toDiffDisplayPath(rawPath);
		const addedLines = splitLinesForDiff(content);
		const lines: string[] = [
			'--- /dev/null',
			`+++ b/${displayPath}`,
			`@@ -0,0 +1,${addedLines.length} @@`,
			...addedLines.map(line => `+${line}`),
		];
		return finalizeDiffPreview(lines);
	}

	private invalidPathMessage(path: string): string {
		if (isVSCloneAmbiguousWorkspaceRelativePath(this.workspaceContextService.getWorkspace().folders, path)) {
			return `Invalid path '${path}'. Relative paths are ambiguous in a multi-root workspace; prefix them with a workspace folder name or use an absolute path inside the workspace.`;
		}
		return `Invalid path '${path}'. Paths must resolve inside the current workspace.`;
	}

	private toToolApplyFailure(resource: URI, failures: readonly string[], operation: 'searchReplace' | 'rewrite'): IVSCloneToolExecutionResult {
		if (failures.includes('Workspace edit was not applied.')) {
			return { success: false, output: 'Workspace edit was not applied.' };
		}

		if (failures.length > 0) {
			if (operation === 'rewrite') {
				return { success: false, output: failures[0] };
			}

			return {
				success: false,
				output: `One or more SEARCH blocks did not match ${resource.toString()}.`,
			};
		}

		return {
			success: false,
			output: `No edits were applied to ${resource.toString()}.`,
		};
	}
}

function parseSearchReplaceBlocks(changes: string): readonly IParsedSearchReplaceBlock[] {
	const normalized = changes.replace(/\r\n/g, '\n');
	const blockPattern = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
	const blocks: IParsedSearchReplaceBlock[] = [];
	let match: RegExpExecArray | null;

	while ((match = blockPattern.exec(normalized)) !== null) {
		blocks.push({
			searchText: match[1],
			replaceText: match[2],
		});
	}

	return blocks;
}

function normalizePath(rawPath: string): string {
	return rawPath.trim().replace(/^`+|`+$/g, '').replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
}

function summarizeEditPayload(changes: string): string {
	const compact = changes.replace(/\s+/g, ' ').trim();
	if (compact.length <= 160) {
		return compact;
	}
	return `${compact.slice(0, 157)}...`;
}

function toBoolean(value: string | undefined): boolean {
	if (!value) {
		return false;
	}
	const normalized = value.trim().toLowerCase();
	return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function summarizeToolParams(params: Record<string, string>): string {
	const maxSummaryLength = 160;
	const entries = Object.entries(params);
	if (entries.length === 0) {
		return 'no params';
	}

	const summary = entries.map(([key, value]) => `${key}=${truncateText(value, 48).text.replace(/\s+/g, ' ')}`).join(', ');
	if (summary.length <= maxSummaryLength) {
		return summary;
	}

	return `${summary.slice(0, maxSummaryLength)}...`;
}

function mcpInputSchemaToVSCloneSchema(schema: unknown): IVSCloneToolJsonSchema {
	if (isObjectSchema(schema)) {
		return {
			type: 'object',
			properties: schema.properties as IVSCloneToolJsonSchema['properties'],
			required: Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : undefined,
			additionalProperties: schema.additionalProperties,
		};
	}
	return {
		type: 'object',
		properties: {},
	};
}

function mcpSchemaToParameterDefinitions(schema: unknown): readonly IVSCloneToolDefinition['parameters'][number][] {
	if (!isObjectSchema(schema) || !schema.properties || typeof schema.properties !== 'object') {
		return [];
	}

	const required = new Set(Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : []);
	return Object.entries(schema.properties).map(([name, value]) => ({
		name,
		required: required.has(name),
		description: getMcpSchemaPropertyDescription(value),
	}));
}

function getMcpSchemaPropertyDescription(value: unknown): string {
	if (value && typeof value === 'object' && hasKey(value, { description: true })) {
		const property = value as { readonly description?: unknown };
		if (typeof property.description === 'string') {
			return property.description;
		}
	}
	return 'MCP tool argument.';
}

function isObjectSchema(value: unknown): value is { readonly properties?: unknown; readonly required?: unknown; readonly additionalProperties?: unknown } {
	return !!value && typeof value === 'object';
}

function decodeMcpToolParams(params: Record<string, string>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, decodeMcpToolParam(value)]));
}

function decodeMcpToolParam(value: string): unknown {
	const trimmed = value.trim();
	if (!trimmed) {
		return value;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function formatMcpToolResult(result: { readonly content?: readonly unknown[]; readonly structuredContent?: unknown; readonly isError?: boolean }): string {
	const output: string[] = [];
	if (result.structuredContent !== undefined) {
		output.push(JSON.stringify(result.structuredContent, undefined, 2));
	}
	for (const part of result.content ?? []) {
		output.push(formatMcpToolContentPart(part));
	}
	return output.filter(Boolean).join('\n\n') || (result.isError ? 'MCP tool returned an error with no content.' : 'MCP tool completed with no content.');
}

function formatMcpToolContentPart(part: unknown): string {
	if (!part || typeof part !== 'object') {
		return String(part);
	}
	if (hasKey(part, { type: true, text: true })) {
		const textPart = part as { readonly type?: unknown; readonly text?: unknown };
		if (textPart.type === 'text' && typeof textPart.text === 'string') {
			return textPart.text;
		}
	}
	if (hasKey(part, { type: true, resource: true })) {
		const resourcePart = part as { readonly type?: unknown; readonly resource?: unknown };
		if (resourcePart.type === 'resource') {
			return JSON.stringify(resourcePart.resource, undefined, 2);
		}
	}
	return JSON.stringify(part, undefined, 2);
}

function truncateText(value: string, maxChars: number): { text: string; truncatedChars: number } {
	if (value.length <= maxChars) {
		return { text: value, truncatedChars: 0 };
	}
	return {
		text: value.slice(0, maxChars),
		truncatedChars: value.length - maxChars,
	};
}

function splitLinesForDiff(value: string): readonly string[] {
	const normalized = value.replace(/\r\n/g, '\n');
	if (normalized.length === 0) {
		return [''];
	}
	const lines = normalized.split('\n');
	if (lines.length > 1 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

function toDiffDisplayPath(value: string): string {
	const normalized = value.replace(/\\/g, '/').trim();
	if (!normalized) {
		return 'unknown-path';
	}
	return normalized.startsWith('/') ? normalized.slice(1) : normalized;
}

/**
 * Unified hunk counts use 0 for empty replacements, but blank lines still count as a single line.
 */
function countDiffHunkLines(value: string): number {
	if (value.length === 0) {
		return 0;
	}

	return splitLinesForDiff(value).length;
}

function finalizeDiffPreview(lines: readonly string[]): string {
	let previewLines = [...lines];
	let truncated = false;
	if (previewLines.length > maxDiffPreviewLines) {
		previewLines = previewLines.slice(0, maxDiffPreviewLines);
		truncated = true;
	}

	let text = previewLines.join('\n');
	if (text.length > maxDiffPreviewChars) {
		text = text.slice(0, maxDiffPreviewChars);
		truncated = true;
	}

	return truncated ? `${text}\n... [diff truncated]` : text;
}

function positionAtOffset(content: string, offset: number): { lineNumber: number; column: number } {
	const boundedOffset = Math.max(0, Math.min(offset, content.length));
	let lineNumber = 1;
	let lineStartOffset = 0;

	for (let index = 0; index < boundedOffset; index++) {
		if (content.charCodeAt(index) === 10 /* \n */) {
			lineNumber += 1;
			lineStartOffset = index + 1;
		}
	}

	return {
		lineNumber,
		column: boundedOffset - lineStartOffset + 1,
	};
}

function readToolParam(params: Record<string, string>, ...names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = params[name];
		if (typeof value === 'string') {
			const normalized = value.trim();
			if (normalized.length > 0) {
				return normalized;
			}
		}
	}
	return undefined;
}

function describeTerminalResolveReason(resolveReason: { type: 'timeout' } | { type: 'done'; exitCode: number }): string {
	return resolveReason.type === 'timeout'
		? 'timeout'
		: `done (exit code ${resolveReason.exitCode})`;
}
