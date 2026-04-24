/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IBulkEditService, ResourceTextEdit } from '../../../../../editor/browser/services/bulkEditService.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IMarkerService } from '../../../../../platform/markers/common/markers.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { QueryBuilder } from '../../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { VSCloneToolExecutionService, VSCloneToolRuntimeService } from '../../browser/vscloneToolExecutionService.js';
import { IVSCloneEditCodeService, type VSCloneEditApplyResult } from '../../browser/vscloneEditCodeServiceInterface.js';
import { IVSCloneTerminalToolService } from '../../browser/vscloneTerminalToolService.js';
import { type VSCloneChatMode } from '../../common/vsclonePlanModeTypes.js';
import { IVSClonePlanModeService } from '../../common/vsclonePlanModeService.js';
import { IMcpService, McpToolVisibility, type IMcpServer, type IMcpTool } from '../../../mcp/common/mcpTypes.js';
import type { MCP } from '../../../mcp/common/modelContextProtocol.js';

interface IResolveStat {
	readonly resource: URI;
	readonly name: string;
	readonly isDirectory: boolean;
	readonly children?: readonly IResolveStat[];
}

class TestLogService implements Pick<ILogService, 'info' | 'warn' | 'error'> {
	readonly infos: string[] = [];
	readonly warnings: unknown[][] = [];
	readonly errors: unknown[][] = [];

	info(...args: unknown[]): void {
		this.infos.push(args.map(arg => String(arg)).join(' '));
	}

	warn(...args: unknown[]): void {
		this.warnings.push(args);
	}

	error(...args: unknown[]): void {
		this.errors.push(args);
	}
}

class ToolExecutionHarness {
	readonly workspaceRoot = URI.file('/workspace');
	workspaceFolders: Array<{ uri: URI; name?: string }> = [{ uri: this.workspaceRoot, name: 'workspace' }];
	readonly logService = new TestLogService();
	readonly openModels = new Map<string, { getValue(): string }>();
	readonly markers = new Map<string, unknown[]>();
	readonly resolveCalls: string[] = [];
	readonly readFileCalls: string[] = [];
	readonly createFolderCalls: string[] = [];
	readonly writeFileCalls: Array<{ resource: string; content: string }> = [];
	readonly openEditorCalls: string[] = [];
	readonly bulkEditCalls: Array<{ edits: ResourceTextEdit[]; options: { label?: string } | undefined }> = [];
	readonly searchCalls: Array<{ query: unknown; token: { isCancellationRequested: boolean } }> = [];
	readonly queryBuilderCalls: Array<{ contentPattern: { pattern: string; isRegExp: boolean }; folderResources: readonly URI[]; options: { includePattern?: string; previewOptions?: { matchLines: number; charsPerLine: number }; maxResults?: number } }> = [];
	readonly terminalRunCalls: Array<{ command: string; opts: { type: 'persistent'; persistentTerminalId: string } | { type: 'temporary'; cwd: string | null; terminalId: string } }> = [];
	readonly createdPersistentTerminals: Array<{ cwd: string | null }> = [];
	readonly killedPersistentTerminalIds: string[] = [];
	readonly callBeforeApplyOrEditCalls: string[] = [];
	readonly applySearchReplaceCalls: Array<{ uri: string; searchReplaceBlocks: string }> = [];
	readonly rewriteFileCalls: Array<{ uri: string; newContent: string }> = [];

	nextTerminalRunResult = {
		result: '$ echo hi\nhi',
		resolveReason: { type: 'done', exitCode: 0 } as const,
	};
	nextCreatedPersistentTerminalId = '1';
	nextEditApplyResult: VSCloneEditApplyResult = {
		attemptedEdits: 1,
		appliedEdits: 1,
		modifiedFiles: [],
		failures: [],
		fileChanges: [],
	};

	setWorkspaceFolders(...folders: URI[]): void {
		this.workspaceFolders = folders.map(folder => ({
			uri: folder,
			name: folder.path.split('/').filter(Boolean).pop(),
		}));
	}

	resolveHandler: (resource: URI) => Promise<IResolveStat> = async (resource) => ({
		resource,
		name: resource.path.split('/').filter(Boolean).pop() ?? resource.path,
		isDirectory: false,
	});

	readFileHandler: (resource: URI) => Promise<string> = async (resource) => {
		throw new Error(`No file content registered for ${resource.toString()}`);
	};

	existsHandler: (resource: URI) => Promise<boolean> = async (_resource) => false;

	searchProgressItems: unknown[] = [];
	searchResult: unknown = { results: [], messages: [] };
	bulkEditResult = { ariaSummary: '', isApplied: true };
	isToolAllowedResult = true;

	readonly fileService = {
		exists: (resource: URI) => this.existsHandler(resource),
		createFolder: async (resource: URI) => {
			this.createFolderCalls.push(resource.toString());
		},
		writeFile: async (resource: URI, content: VSBuffer) => {
			this.writeFileCalls.push({ resource: resource.toString(), content: content.toString() });
		},
		readFile: async (resource: URI) => {
			this.readFileCalls.push(resource.toString());
			return { value: VSBuffer.fromString(await this.readFileHandler(resource)) };
		},
		resolve: (resource: URI) => {
			this.resolveCalls.push(resource.toString());
			return this.resolveHandler(resource);
		},
	} as unknown as IFileService;

	readonly workspaceContextService = {
		getWorkspace: () => ({
			folders: this.workspaceFolders,
		}),
		isInsideWorkspace: (resource: URI) => this.workspaceFolders.some(folder =>
			resource.path === folder.uri.path || resource.path.startsWith(`${folder.uri.path}/`),
		),
	} as unknown as IWorkspaceContextService;

	readonly modelService = {
		getModel: (resource: URI) => this.openModels.get(resource.toString()),
	} as unknown as IModelService;

	readonly editorService = {
		openEditor: async (options: { resource: URI }) => {
			this.openEditorCalls.push(options.resource.toString());
		},
	} as unknown as IEditorService;

	readonly bulkEditService = {
		hasPreviewHandler: () => false,
		setPreviewHandler: async () => ({ dispose() { /* no-op */ } }),
		apply: async (edits: ResourceTextEdit[], options?: { label?: string }) => {
			this.bulkEditCalls.push({ edits, options });
			return this.bulkEditResult;
		},
	} as unknown as IBulkEditService;

	readonly searchService = {
		textSearch: async (query: unknown, token: { isCancellationRequested: boolean }, onProgress?: (result: unknown) => void) => {
			this.searchCalls.push({ query, token });
			for (const item of this.searchProgressItems) {
				onProgress?.(item);
			}
			return this.searchResult;
		},
		aiTextSearch: async () => ({ results: [], messages: [] }),
		getAIName: async () => undefined,
		textSearchSplitSyncAsync: () => ({ syncResults: { results: [], messages: [] }, asyncResults: Promise.resolve({ results: [], messages: [] }) }),
		fileSearch: async () => ({ results: [], messages: [] }),
		schemeHasFileSearchProvider: () => false,
		clearCache: async () => { },
		registerSearchResultProvider: () => ({ dispose() { /* no-op */ } }),
	} as unknown as ISearchService;

	readonly markerService = {
		read: ({ resource }: { resource: URI }) => this.markers.get(resource.toString()) ?? [],
	} as unknown as IMarkerService;

	readonly planModeService = {
		isToolAllowed: (_mode: VSCloneChatMode, _toolName: string) => this.isToolAllowedResult,
	} as unknown as IVSClonePlanModeService;

	readonly editCodeService = {
		processRawKeybindingText: (keybindingStr: string) => keybindingStr,
		callBeforeApplyOrEdit: async (uri: URI | 'current') => {
			this.callBeforeApplyOrEditCalls.push(uri === 'current' ? uri : uri.toString());
		},
		startApplying: () => null,
		instantlyApplySearchReplaceBlocks: async ({ uri, searchReplaceBlocks }: { uri: URI; searchReplaceBlocks: string }) => {
			this.applySearchReplaceCalls.push({ uri: uri.toString(), searchReplaceBlocks });
			return this.nextEditApplyResult;
		},
		instantlyRewriteFile: async ({ uri, newContent }: { uri: URI; newContent: string }) => {
			this.rewriteFileCalls.push({ uri: uri.toString(), newContent });
			return this.nextEditApplyResult;
		},
		addCtrlKZone: () => undefined,
		removeCtrlKZone: () => undefined,
		diffAreaOfId: {},
		diffAreasOfURI: {},
		diffOfId: {},
		acceptOrRejectAllDiffAreas: async () => undefined,
		acceptDiff: async () => undefined,
		rejectDiff: async () => undefined,
		onDidAddOrDeleteDiffZones: () => ({ dispose() { /* no-op */ } }),
		onDidChangeDiffsInDiffZoneNotStreaming: () => ({ dispose() { /* no-op */ } }),
		onDidChangeStreamingInDiffZone: () => ({ dispose() { /* no-op */ } }),
		onDidChangeStreamingInCtrlKZone: () => ({ dispose() { /* no-op */ } }),
		isCtrlKZoneStreaming: () => false,
		interruptCtrlKStreaming: () => undefined,
		interruptURIStreaming: () => undefined,
		getVSCloneFileSnapshot: () => ({ diffAreaInfo: [], entireFileCode: '' }),
		restoreVSCloneFileSnapshot: () => undefined,
		hasSearchReplaceBlocks: () => false,
		parseSearchReplaceBlocks: () => [],
		startApplyingSearchReplaceBlocks: async () => this.nextEditApplyResult,
		applySearchReplaceBlocks: async () => this.nextEditApplyResult,
		undoEditApply: async () => ({ revertedFiles: [], failures: [] }),
	} as unknown as IVSCloneEditCodeService;

	readonly terminalToolService = {
		runCommand: async (command: string, opts: { type: 'persistent'; persistentTerminalId: string } | { type: 'temporary'; cwd: string | null; terminalId: string }) => {
			this.terminalRunCalls.push({ command, opts });
			return {
				interrupt: () => undefined,
				resPromise: Promise.resolve(this.nextTerminalRunResult),
			};
		},
		createPersistentTerminal: async ({ cwd }: { cwd: string | null }) => {
			this.createdPersistentTerminals.push({ cwd });
			return this.nextCreatedPersistentTerminalId;
		},
		killPersistentTerminal: async (terminalId: string) => {
			this.killedPersistentTerminalIds.push(terminalId);
		},
		persistentTerminalExists: () => true,
		listPersistentTerminalIds: () => [],
		focusPersistentTerminal: async () => { },
		readTerminal: async () => '',
		getPersistentTerminal: () => undefined,
		getTemporaryTerminal: () => undefined,
	} as unknown as IVSCloneTerminalToolService;

	readonly instantiationService = {
		createInstance: <T>(ctor: new (...args: never[]) => T) => {
			if (ctor === QueryBuilder) {
				return {
					text: (
						contentPattern: { pattern: string; isRegExp: boolean },
						folderResources: readonly URI[],
						options: { includePattern?: string; previewOptions?: { matchLines: number; charsPerLine: number }; maxResults?: number },
					) => {
						this.queryBuilderCalls.push({ contentPattern, folderResources, options });
						return {
							type: 'text',
							contentPattern,
							folderResources,
							options,
						};
					},
				} as unknown as T;
			}

			throw new Error(`Unexpected constructor: ${ctor.name}`);
		},
	} as unknown as IInstantiationService;

	createService(mcpService?: IMcpService): VSCloneToolExecutionService {
		return new VSCloneToolExecutionService(
			this.fileService,
			this.workspaceContextService,
			this.modelService,
			this.searchService,
			this.markerService,
			this.instantiationService,
			this.planModeService,
			this.logService as unknown as ILogService,
			this.editCodeService,
			this.terminalToolService,
			mcpService,
		);
	}
}

function createFileStat(path: string): IResolveStat {
	const resource = URI.file(path);
	return {
		resource,
		name: path.split('/').filter(Boolean).pop() ?? path,
		isDirectory: false,
	};
}

function createDirectoryStat(path: string, children: readonly IResolveStat[] = []): IResolveStat {
	const resource = URI.file(path);
	return {
		resource,
		name: path.split('/').filter(Boolean).pop() ?? path,
		isDirectory: true,
		children,
	};
}

function asInternals(service: VSCloneToolExecutionService): {
	resolveWorkspacePath(rawPath: string): { uri: URI; rawPath: string } | undefined;
	invalidPathMessage(path: string): string;
	executeReadFile(params: Record<string, string>): Promise<{ success: boolean; output: string }>;
	executeListDirectory(params: Record<string, string>): Promise<{ success: boolean; output: string }>;
	executeSearchFiles(params: Record<string, string>): Promise<{ success: boolean; output: string }>;
	executeEditFile(params: Record<string, string>): Promise<{ success: boolean; output: string }>;
	executeCreateFile(params: Record<string, string>): Promise<{ success: boolean; output: string }>;
	readFileContents(resource: URI): Promise<string>;
	safeResolve(resource: URI): Promise<IResolveStat | undefined>;
	buildEditFileDiffPreview(rawPath: string, originalContent: string, edits: ReadonlyArray<{ startOffset: number; endOffset: number; replaceText: string }>): string;
	buildCreateFileDiffPreview(rawPath: string, content: string): string;
	appendDirectoryListing(root: URI, prefix: string, recursive: boolean, lines: string[], state: { count: number; truncated: boolean }): Promise<void>;
} {
	return service as unknown as {
		resolveWorkspacePath(rawPath: string): { uri: URI; rawPath: string } | undefined;
		invalidPathMessage(path: string): string;
		executeReadFile(params: Record<string, string>): Promise<{ success: boolean; output: string }>;
		executeListDirectory(params: Record<string, string>): Promise<{ success: boolean; output: string }>;
		executeSearchFiles(params: Record<string, string>): Promise<{ success: boolean; output: string }>;
		executeEditFile(params: Record<string, string>): Promise<{ success: boolean; output: string }>;
		executeCreateFile(params: Record<string, string>): Promise<{ success: boolean; output: string }>;
		readFileContents(resource: URI): Promise<string>;
		safeResolve(resource: URI): Promise<IResolveStat | undefined>;
		buildEditFileDiffPreview(rawPath: string, originalContent: string, edits: ReadonlyArray<{ startOffset: number; endOffset: number; replaceText: string }>): string;
		buildCreateFileDiffPreview(rawPath: string, content: string): string;
		appendDirectoryListing(root: URI, prefix: string, recursive: boolean, lines: string[], state: { count: number; truncated: boolean }): Promise<void>;
	};
}

function muteConsoleForToolExecutionSuite(): { restore(): void } {
	const originalConsole = {
		debug: console.debug,
		info: console.info,
		warn: console.warn,
		error: console.error,
	};

	// Tool execution intentionally mirrors invocation details to the browser console so interactive
	// sessions can inspect what the agent attempted. The unit harness treats that output as a failure,
	// so the suite silences console writes while still asserting against the injected log service.
	console.debug = () => undefined;
	console.info = () => undefined;
	console.warn = () => undefined;
	console.error = () => undefined;

	return {
		restore: () => {
			console.debug = originalConsole.debug;
			console.info = originalConsole.info;
			console.warn = originalConsole.warn;
			console.error = originalConsole.error;
		},
	};
}

function createTestMcpTool(id: string, referenceName: string, callResult?: MCP.CallToolResult): IMcpTool & { readonly calls: Record<string, unknown>[] } {
	const calls: Record<string, unknown>[] = [];
	const defaultCallResult: MCP.CallToolResult = {
		isError: false,
		content: [{ type: 'text' as const, text: `called ${referenceName}` }],
	};
	const tool = {
		id,
		referenceName,
		icons: {},
		definition: {
			name: referenceName,
			description: `Test MCP tool ${referenceName}.`,
			inputSchema: {
				type: 'object',
				properties: {
					nested: { type: 'object' },
				},
			},
		},
		visibility: McpToolVisibility.Model,
		call: async (params: Record<string, unknown>) => {
			calls.push(params);
			return callResult ?? defaultCallResult;
		},
		callWithProgress: async (params: Record<string, unknown>) => {
			calls.push(params);
			return callResult ?? defaultCallResult;
		},
		calls,
	};
	return tool as unknown as IMcpTool & { readonly calls: Record<string, unknown>[] };
}

function createTestMcpServer(id: string, label: string, tools: readonly IMcpTool[]): IMcpServer {
	return {
		definition: { id, label },
		tools: { get: () => tools },
	} as unknown as IMcpServer;
}

function createTestMcpService(servers: readonly IMcpServer[]): IMcpService {
	return {
		servers: { get: () => servers },
		activateCollections: async () => undefined,
		autostart: () => ({ get: () => ({ working: false }) }),
	} as unknown as IMcpService;
}

suite('VSCloneToolExecutionService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let mutedConsole: { restore(): void } | undefined;

	suiteSetup(() => {
		mutedConsole = muteConsoleForToolExecutionSuite();
	});

	suiteTeardown(() => {
		mutedConsole?.restore();
	});

	test('TE-01 constructs with mocked services without side effects', () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();

		assert.ok(service);
		assert.deepStrictEqual(testHarness.logService.infos, []);
		assert.deepStrictEqual(testHarness.logService.errors, []);
		assert.deepStrictEqual(testHarness.resolveCalls, []);
		assert.deepStrictEqual(testHarness.readFileCalls, []);
	});

	test('TE-02 blocks write-capable tools in plan mode before dispatch', async () => {
		const testHarness = new ToolExecutionHarness();
		testHarness.isToolAllowedResult = false;
		const service = testHarness.createService();

		const result = await service.executeTool('edit_file', { path: '/workspace/src/app.ts', changes: 'ignored' }, 'plan');

		assert.strictEqual(result.success, false);
		assert.strictEqual(result.output, 'Tool "edit_file" is not available in plan mode. Switch to Act mode to make edits.');
		assert.deepStrictEqual(testHarness.bulkEditCalls, []);
		assert.deepStrictEqual(testHarness.openEditorCalls, []);
		assert.deepStrictEqual(testHarness.readFileCalls, []);
	});

	test('TE-03 runs one-off terminal commands through the terminal tool service', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();

		const result = await service.executeTool('run_command', { command: 'echo hi', cwd: 'scripts' }, 'act');

		assert.strictEqual(result.success, true);
		assert.deepStrictEqual(testHarness.terminalRunCalls, [{
			command: 'echo hi',
			opts: {
				type: 'temporary',
				cwd: 'scripts',
				terminalId: testHarness.terminalRunCalls[0]!.opts.type === 'temporary' ? testHarness.terminalRunCalls[0]!.opts.terminalId : '',
			},
		}]);
		assert.ok(result.output.includes('Command: echo hi'));
		assert.ok(result.output.includes('Resolve reason: done (exit code 0)'));
		assert.ok(result.output.includes('$ echo hi'));
	});

	test('TE-04 opens and closes persistent terminals through the terminal runtime', async () => {
		const testHarness = new ToolExecutionHarness();
		testHarness.nextCreatedPersistentTerminalId = '3';
		const service = testHarness.createService();

		const openResult = await service.executeTool('open_persistent_terminal', { cwd: '/workspace' }, 'act');
		const killResult = await service.executeTool('kill_persistent_terminal', { persistent_terminal_id: '3' }, 'act');

		assert.strictEqual(openResult.success, true);
		assert.strictEqual(openResult.output, 'Created persistent terminal 3 (VSClone Tool Terminal (3)).');
		assert.deepStrictEqual(testHarness.createdPersistentTerminals, [{ cwd: '/workspace' }]);
		assert.strictEqual(killResult.success, true);
		assert.strictEqual(killResult.output, 'Closed persistent terminal 3.');
		assert.deepStrictEqual(testHarness.killedPersistentTerminalIds, ['3']);
	});

	test('TE-04b gives all MCP tools collision-resistant provider names and dispatches by them', async () => {
		const firstTool = createTestMcpTool('duplicate_safe_id', 'lookup');
		const secondTool = createTestMcpTool('duplicate_safe_id', 'lookup');
		const mcpService = createTestMcpService([
			createTestMcpServer('server-one', 'Server One', [firstTool]),
			createTestMcpServer('server-two', 'Server Two', [secondTool]),
		]);
		const runtimeService = new VSCloneToolRuntimeService(mcpService);
		const toolDefinitions = runtimeService.listToolDefinitions('act').filter(tool => tool.approvalType === 'MCP tools');

		assert.strictEqual(toolDefinitions.length, 2);
		const providerNames = toolDefinitions.map(tool => tool.name);
		assert.ok(providerNames.every(name => /^mcp_[0-9a-f]{8}_lookup$/.test(name)), providerNames.join(', '));
		assert.ok(!providerNames.includes('duplicate_safe_id'));
		assert.notStrictEqual(providerNames[0], providerNames[1]);

		const executionService = new ToolExecutionHarness().createService(mcpService);
		const result = await executionService.executeTool(providerNames[0]!, { nested: { value: 1 } }, 'act');

		assert.deepStrictEqual(result, { success: true, output: 'called lookup' });
		assert.deepStrictEqual(firstTool.calls, [{ nested: { value: 1 } }]);
		assert.deepStrictEqual(secondTool.calls, []);
	});

	test('TE-04c filters MCP content by assistant audience and keeps structuredContent visible', async () => {
		const tool = createTestMcpTool('structured_tool', 'lookup', {
			isError: false,
			content: [
				{ type: 'text' as const, text: 'lookup complete' },
				{ type: 'text' as const, text: 'assistant detail', annotations: { audience: ['assistant'] } },
				{ type: 'text' as const, text: 'ui-only detail', annotations: { audience: ['user'] } },
			],
			structuredContent: {
				items: [{ id: 1, title: 'Result' }],
				nextCursor: 'abc',
			},
		});
		const mcpService = createTestMcpService([createTestMcpServer('server-one', 'Server One', [tool])]);
		const [toolDefinition] = new VSCloneToolRuntimeService(mcpService)
			.listToolDefinitions('act')
			.filter(tool => tool.approvalType === 'MCP tools');
		const executionService = new ToolExecutionHarness().createService(mcpService);

		const result = await executionService.executeTool(toolDefinition!.name, { nested: { query: 'Result' } }, 'act');

		assert.deepStrictEqual(tool.calls, [{ nested: { query: 'Result' } }]);
		assert.strictEqual(result.success, true);
		assert.strictEqual(result.output, [
			'lookup complete',
			'assistant detail',
			JSON.stringify({
				items: [{ id: 1, title: 'Result' }],
				nextCursor: 'abc',
			}, null, 2),
		].join('\n\n'));
		assert.ok(!result.output.includes('ui-only detail'));
	});

	test('TE-03 dispatches terminal success and unknown-tool failure', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();

		const completion = await service.executeTool('attempt_completion', { result: '  done  ' });
		const unknown = await service.executeTool('does_not_exist', {});

		assert.deepStrictEqual(completion, { success: true, output: 'done' });
		assert.deepStrictEqual(unknown, { success: false, output: 'Unknown tool: does_not_exist' });
	});

	test('TE-04 converts thrown helper errors into failed tool results', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();
		(asInternals(service) as { executeReadFile: (params: Record<string, string>) => Promise<{ success: boolean; output: string }> }).executeReadFile = (() => {
			throw new Error('boom');
		}) as unknown as (params: Record<string, string>) => Promise<{ success: boolean; output: string }>;

		const result = await service.executeTool('read_file', { path: '/workspace/src/app.ts' });

		assert.deepStrictEqual(result, { success: false, output: 'boom' });
		assert.strictEqual(testHarness.logService.errors.length, 1);
		assert.strictEqual(testHarness.logService.errors[0][0], '[VSCloneToolExecution] Tool execution failed');
		assert.ok(testHarness.logService.errors[0][1] instanceof Error);
	});

	test('TE-05 resolves normalized workspace paths and rejects outside-workspace inputs', () => {
		const testHarness = new ToolExecutionHarness();
		const helpers = asInternals(testHarness.createService());

		const relative = helpers.resolveWorkspacePath('`./src/file.ts`');
		const absolute = helpers.resolveWorkspacePath('/workspace/src/file.ts');
		const fileUri = helpers.resolveWorkspacePath('file:///workspace/src/file.ts');
		const outside = helpers.resolveWorkspacePath('../outside.ts');

		assert.strictEqual(relative?.rawPath, './src/file.ts');
		assert.strictEqual(relative?.uri.toString(), 'file:///workspace/src/file.ts');
		assert.strictEqual(absolute?.uri.toString(), 'file:///workspace/src/file.ts');
		assert.strictEqual(fileUri?.uri.toString(), 'file:///workspace/src/file.ts');
		assert.strictEqual(outside, undefined);
		// The path-validation helper is part of the tool contract, so this assertion intentionally pins the exact copy.
		// eslint-disable-next-line local/code-no-unexternalized-strings
		assert.strictEqual(helpers.invalidPathMessage('../outside.ts'), "Invalid path '../outside.ts'. Paths must resolve inside the current workspace.");
	});

	test('TE-05b rejects ambiguous relative paths in multi-root workspaces and accepts workspace-prefixed ones', async () => {
		const testHarness = new ToolExecutionHarness();
		testHarness.setWorkspaceFolders(URI.file('/workspace/app-one'), URI.file('/workspace/app-two'));
		testHarness.resolveHandler = async (resource) => createFileStat(resource.path);
		testHarness.readFileHandler = async () => 'export const value = 1;';
		const service = testHarness.createService();
		const helpers = asInternals(service);
		const ambiguousPath = 'src/file.ts';
		const ambiguousDirectoryPath = 'src';
		const ambiguousMessage = 'Invalid path \'src/file.ts\'. Relative paths are ambiguous in a multi-root workspace; prefix them with a workspace folder name or use an absolute path inside the workspace.';
		const ambiguousDirectoryMessage = 'Invalid path \'src\'. Relative paths are ambiguous in a multi-root workspace; prefix them with a workspace folder name or use an absolute path inside the workspace.';

		assert.strictEqual(helpers.resolveWorkspacePath(ambiguousPath), undefined);
		assert.strictEqual(helpers.resolveWorkspacePath(ambiguousDirectoryPath), undefined);
		assert.strictEqual(helpers.invalidPathMessage(ambiguousPath), ambiguousMessage);
		assert.strictEqual(helpers.invalidPathMessage(ambiguousDirectoryPath), ambiguousDirectoryMessage);
		assert.strictEqual(
			helpers.resolveWorkspacePath('app-two/src/file.ts')?.uri.toString(),
			'file:///workspace/app-two/src/file.ts',
		);
		const prefixedReadResult = await service.executeTool('read_file', { path: 'app-two/src/file.ts' });
		assert.strictEqual(prefixedReadResult.success, true);
		assert.ok(prefixedReadResult.output.includes('Contents of file:///workspace/app-two/src/file.ts:'));
		assert.ok(prefixedReadResult.output.includes('export const value = 1;'));
		assert.deepStrictEqual(testHarness.resolveCalls, ['file:///workspace/app-two/src/file.ts']);
		assert.deepStrictEqual(testHarness.readFileCalls, ['file:///workspace/app-two/src/file.ts']);

		const readResult = await service.executeTool('read_file', { path: ambiguousPath });
		const listResult = await service.executeTool('list_directory', { path: ambiguousDirectoryPath });
		const searchResult = await service.executeTool('search_files', { path: ambiguousDirectoryPath, pattern: 'value' });
		const editResult = await service.executeTool('edit_file', {
			path: ambiguousPath,
			changes: '<<<<<<< SEARCH\nvalue\n=======\nnext\n>>>>>>> REPLACE',
		});
		const createResult = await service.executeTool('create_file', { path: ambiguousPath, content: 'text' });

		assert.deepStrictEqual(readResult, { success: false, output: ambiguousMessage });
		assert.deepStrictEqual(listResult, { success: false, output: ambiguousDirectoryMessage });
		assert.deepStrictEqual(searchResult, { success: false, output: ambiguousDirectoryMessage });
		assert.deepStrictEqual(editResult, { success: false, output: ambiguousMessage });
		assert.deepStrictEqual(createResult, { success: false, output: ambiguousMessage });
		assert.deepStrictEqual(testHarness.resolveCalls, ['file:///workspace/app-two/src/file.ts']);
		assert.deepStrictEqual(testHarness.readFileCalls, ['file:///workspace/app-two/src/file.ts']);
		assert.deepStrictEqual(testHarness.searchCalls, []);
		assert.deepStrictEqual(testHarness.queryBuilderCalls, []);
		assert.deepStrictEqual(testHarness.bulkEditCalls, []);
		assert.deepStrictEqual(testHarness.rewriteFileCalls, []);
	});

	test('TE-06 rejects read-file calls without a path', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();

		const result = await service.executeTool('read_file', {});

		assert.deepStrictEqual(result, { success: false, output: 'Missing required parameter: path' });
	});

	test('TE-07 handles invalid-path, missing-file, and directory branches for read_file', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();
		const helpers = asInternals(service);

		const invalid = await helpers.executeReadFile({ path: '../outside.ts' });

		testHarness.resolveHandler = async () => {
			throw new Error('missing');
		};
		const missing = await helpers.executeReadFile({ path: '/workspace/src/missing.ts' });

		testHarness.resolveHandler = async (resource) => createDirectoryStat(resource.path, []);
		const directory = await helpers.executeReadFile({ path: '/workspace/src/folder' });

		// The read_file tool returns the same validation string verbatim, so the failure case must match it exactly.
		// eslint-disable-next-line local/code-no-unexternalized-strings
		assert.deepStrictEqual(invalid, { success: false, output: "Invalid path '../outside.ts'. Paths must resolve inside the current workspace." });
		assert.deepStrictEqual(missing, { success: false, output: 'File not found: /workspace/src/missing.ts' });
		assert.deepStrictEqual(directory, { success: false, output: 'Path is a directory, not a file: /workspace/src/folder' });
	});

	test('TE-08 prefers open-model content and reports truncation for long reads', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();
		const resource = URI.file('/workspace/src/app.ts');
		const openText = `open-model:${'x'.repeat(100005 - 'open-model:'.length)}`;
		testHarness.openModels.set(resource.toString(), { getValue: () => openText });
		testHarness.resolveHandler = async () => createFileStat(resource.path);
		testHarness.readFileHandler = async () => {
			throw new Error('file fallback should not be used when a model is open');
		};

		const result = await asInternals(service).executeReadFile({ path: '/workspace/src/app.ts' });

		assert.strictEqual(result.success, true);
		assert.ok(result.output.includes('Contents of file:///workspace/src/app.ts:'));
		assert.ok(result.output.includes('```'));
		assert.ok(result.output.includes(openText.slice(0, 32)));
		assert.ok(result.output.includes('[truncated 5 characters]'));
		assert.strictEqual(testHarness.readFileCalls.length, 0);
	});

	test('TE-09 rejects missing paths and non-directory paths when listing', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();
		const helpers = asInternals(service);

		const missingPath = await helpers.executeListDirectory({});
		testHarness.resolveHandler = async () => createFileStat('/workspace/src/file.txt');
		const filePath = await helpers.executeListDirectory({ path: '/workspace/src/file.txt' });

		assert.deepStrictEqual(missingPath, { success: false, output: 'Missing required parameter: path' });
		assert.deepStrictEqual(filePath, { success: false, output: 'Path is a file, not a directory: /workspace/src/file.txt' });
	});

	test('TE-10 emits an explicit empty-directory marker', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();
		testHarness.resolveHandler = async (resource) => createDirectoryStat(resource.path, []);

		const result = await service.executeTool('list_directory', { path: '/workspace/src/empty', recursive: 'false' });

		assert.strictEqual(result.success, true);
		assert.ok(result.output.includes('Directory listing for file:///workspace/src/empty:'));
		assert.ok(result.output.includes('(empty directory)'));
	});

	test('TE-11 sorts recursive listings, honors the entry cap, and treats undefined recursion as false', async () => {
		const recursiveHarness = new ToolExecutionHarness();
		const recursiveService = recursiveHarness.createService();
		const nestedDir = createDirectoryStat('/workspace/root/a-dir', [
			createFileStat('/workspace/root/a-dir/nested.txt'),
		]);
		const manyFiles = Array.from({ length: 201 }, (_, index) => createFileStat(`/workspace/root/file-${String(index).padStart(3, '0')}.txt`));
		recursiveHarness.resolveHandler = async (resource) => {
			if (resource.path === '/workspace/root/a-dir') {
				return nestedDir;
			}
			return createDirectoryStat(resource.path, [nestedDir, ...manyFiles]);
		};

		const recursiveResult = await recursiveService.executeTool('list_directory', { path: '/workspace/root', recursive: 'yes' });
		assert.strictEqual(recursiveResult.success, true);
		assert.ok(recursiveResult.output.includes('|-- a-dir/'));
		assert.ok(recursiveResult.output.includes('|   `-- nested.txt'));
		assert.ok(recursiveResult.output.includes('[truncated after 200 entries]'));

		const flatHarness = new ToolExecutionHarness();
		const flatService = flatHarness.createService();
		flatHarness.resolveHandler = async (resource) => createDirectoryStat(resource.path, [
			createDirectoryStat('/workspace/root/a-dir', [
				createFileStat('/workspace/root/a-dir/nested.txt'),
			]),
			createFileStat('/workspace/root/b.txt'),
		]);

		const flatResult = await flatService.executeTool('list_directory', { path: '/workspace/root' });
		assert.strictEqual(flatResult.success, true);
		assert.ok(flatResult.output.includes('|-- a-dir/'));
		assert.ok(flatResult.output.includes('`-- b.txt'));
		assert.ok(!flatResult.output.includes('nested.txt'));
	});

	test('TE-12 rejects search calls with missing parameters', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();
		testHarness.resolveHandler = async (resource) => createDirectoryStat(resource.path, []);

		const missingPath = await service.executeTool('search_files', { pattern: 'TODO' });
		const missingPattern = await service.executeTool('search_files', { path: '/workspace/src' });

		assert.deepStrictEqual(missingPath, { success: false, output: 'Missing required parameter: path' });
		assert.deepStrictEqual(missingPattern, { success: false, output: 'Missing required parameter: pattern' });
	});

	test('TE-13 returns a no-match result when search finds nothing', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();
		testHarness.resolveHandler = async (resource) => createDirectoryStat(resource.path, []);
		testHarness.searchResult = { results: [], messages: [] };

		const result = await service.executeTool('search_files', { path: '/workspace/src', pattern: 'TODO' });

		assert.strictEqual(result.success, true);
		assert.strictEqual(result.output, 'No matches found for pattern /TODO/ in file:///workspace/src.');
		assert.strictEqual(testHarness.queryBuilderCalls.length, 1);
		assert.strictEqual(testHarness.queryBuilderCalls[0].contentPattern.pattern, 'TODO');
		assert.strictEqual(testHarness.queryBuilderCalls[0].options.maxResults, 50);
	});

	test('TE-14 collects search matches in order and cancels after the cap', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();
		testHarness.resolveHandler = async (resource) => createDirectoryStat(resource.path, []);
		testHarness.searchProgressItems = [{
			resource: URI.file('/workspace/src/app.ts'),
			results: [{
				previewText: 'match\twith\nwhitespace',
				rangeLocations: Array.from({ length: 51 }, (_, index) => ({
					source: {
						startLineNumber: 1,
						startColumn: index + 1,
						endLineNumber: 1,
						endColumn: index + 2,
					},
					preview: {
						startLineNumber: 1,
						startColumn: index + 1,
						endLineNumber: 1,
						endColumn: index + 2,
					},
				})),
			}],
		}];

		const result = await service.executeTool('search_files', { path: '/workspace/src', pattern: 'TODO', file_glob: '**/*.ts' });

		assert.strictEqual(result.success, true);
		assert.ok(result.output.startsWith('Found 50 match(es) in file:///workspace/src:'));
		assert.ok(result.output.includes('file:///workspace/src/app.ts:1:1 match with whitespace'));
		assert.ok(result.output.includes('[limited to 50 matches]'));
		assert.strictEqual(testHarness.searchCalls[0].token.isCancellationRequested, true);
		assert.strictEqual(testHarness.queryBuilderCalls[0].options.includePattern, '**/*.ts');
	});

	test('TE-15 rejects edit-file calls without required parameters', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();

		const missingPath = await service.executeTool('edit_file', { changes: 'ignored' });
		const missingChanges = await service.executeTool('edit_file', { path: '/workspace/src/app.ts' });

		assert.deepStrictEqual(missingPath, { success: false, output: 'Missing required parameter: path' });
		assert.deepStrictEqual(missingChanges, { success: false, output: 'Missing required parameter: changes' });
	});

	test('TE-16 rejects malformed SEARCH/REPLACE payloads', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();
		testHarness.resolveHandler = async (resource) => createFileStat(resource.path);

		const noBlocks = await service.executeTool('edit_file', {
			path: '/workspace/src/app.ts',
			changes: 'plain text only',
		});

		const emptySearch = await service.executeTool('edit_file', {
			path: '/workspace/src/app.ts',
			changes: [
				'<<<<<<< SEARCH',
				'',
				'=======',
				'replacement',
				'>>>>>>> REPLACE',
			].join('\n'),
		});

		assert.deepStrictEqual(noBlocks, {
			success: false,
			output: [
				'No SEARCH/REPLACE blocks found in changes parameter.',
				'The `changes` value for edit_file must contain one or more blocks in this exact format:',
				'<<<<<<< SEARCH',
				'<exact existing text>',
				'=======',
				'<replacement text>',
				'>>>>>>> REPLACE',
			].join('\n'),
		});
		assert.deepStrictEqual(emptySearch, { success: false, output: 'Empty SEARCH blocks are not allowed in edit_file. Use create_file for new files.' });
		assert.strictEqual(testHarness.logService.warnings.length, 2);
		assert.strictEqual(testHarness.logService.warnings[0][0], '[VSCloneToolExecution] edit_file called without SEARCH/REPLACE blocks');
		assert.strictEqual(testHarness.logService.warnings[1][0], '[VSCloneToolExecution] edit_file called with an empty SEARCH block');
	});

	test('TE-17 fails before edits are applied when SEARCH blocks do not match', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();
		testHarness.resolveHandler = async (resource) => createFileStat(resource.path);
		testHarness.readFileHandler = async () => 'alpha\nbeta\n';

		const result = await service.executeTool('edit_file', {
			path: '/workspace/src/app.ts',
			changes: [
				'<<<<<<< SEARCH',
				'gamma',
				'=======',
				'delta',
				'>>>>>>> REPLACE',
			].join('\n'),
		});

		assert.deepStrictEqual(result, { success: false, output: 'One or more SEARCH blocks did not match file:///workspace/src/app.ts.' });
		assert.deepStrictEqual(testHarness.bulkEditCalls, []);
		assert.deepStrictEqual(testHarness.callBeforeApplyOrEditCalls, []);
		assert.deepStrictEqual(testHarness.applySearchReplaceCalls, []);
		assert.deepStrictEqual(testHarness.openEditorCalls, []);
	});

	test('TE-18 returns a not-applied result when the edit engine declines the change', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();
		testHarness.resolveHandler = async (resource) => createFileStat(resource.path);
		testHarness.readFileHandler = async () => 'alpha\nbeta\n';
		testHarness.nextEditApplyResult = {
			attemptedEdits: 1,
			appliedEdits: 0,
			modifiedFiles: [],
			failures: ['Workspace edit was not applied.'],
			fileChanges: [],
		};

		const result = await service.executeTool('edit_file', {
			path: '/workspace/src/app.ts',
			changes: [
				'<<<<<<< SEARCH',
				'alpha',
				'=======',
				'ALPHA',
				'>>>>>>> REPLACE',
			].join('\n'),
		});

		assert.deepStrictEqual(result, { success: false, output: 'Workspace edit was not applied.' });
		assert.deepStrictEqual(testHarness.callBeforeApplyOrEditCalls, ['file:///workspace/src/app.ts']);
		assert.deepStrictEqual(testHarness.applySearchReplaceCalls, [{
			uri: 'file:///workspace/src/app.ts',
			searchReplaceBlocks: [
				'<<<<<<< SEARCH',
				'alpha',
				'=======',
				'ALPHA',
				'>>>>>>> REPLACE',
			].join('\n'),
		}]);
		assert.deepStrictEqual(testHarness.openEditorCalls, []);
	});

	test('TE-19 routes edit_file through the edit engine and produces a stable diff preview', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();
		const helpers = asInternals(service);
		testHarness.resolveHandler = async (resource) => createFileStat(resource.path);
		testHarness.readFileHandler = async () => 'alpha\nbeta\n';
		testHarness.markers.set('file:///workspace/src/app.ts', [{ message: 'diagnostic' }, { message: 'diagnostic' }]);
		testHarness.nextEditApplyResult = {
			attemptedEdits: 2,
			appliedEdits: 2,
			modifiedFiles: [URI.file('/workspace/src/app.ts')],
			failures: [],
			fileChanges: [],
		};
		const changes = [
			'<<<<<<< SEARCH',
			'alpha',
			'=======',
			'ALPHA',
			'>>>>>>> REPLACE',
			'<<<<<<< SEARCH',
			'beta',
			'=======',
			'BETA',
			'>>>>>>> REPLACE',
		].join('\n');

		const result = await service.executeTool('edit_file', {
			path: '/workspace/src/app.ts',
			changes,
		});

		assert.strictEqual(result.success, true);
		assert.ok(result.output.includes('Applied 2 edit(s) to file:///workspace/src/app.ts. Current diagnostics on file: 2.'));
		assert.deepStrictEqual(testHarness.callBeforeApplyOrEditCalls, ['file:///workspace/src/app.ts']);
		assert.deepStrictEqual(testHarness.applySearchReplaceCalls, [{
			uri: 'file:///workspace/src/app.ts',
			searchReplaceBlocks: changes,
		}]);
		assert.deepStrictEqual(testHarness.bulkEditCalls, []);

		const preview = helpers.buildEditFileDiffPreview('/workspace/src/app.ts', 'alpha\nbeta\n', [
			{ startOffset: 0, endOffset: 5, replaceText: 'ALPHA' },
			{ startOffset: 6, endOffset: 10, replaceText: '' },
		]);

		assert.ok(preview.includes('--- a/workspace/src/app.ts'));
		assert.ok(preview.includes('+++ b/workspace/src/app.ts'));
		assert.ok(preview.includes('@@ -1,1 +1,1 @@'));
		assert.ok(preview.includes('@@ -2,1 +2,0 @@'));
		assert.ok(preview.indexOf('@@ -1,1 +1,1 @@') < preview.indexOf('@@ -2,1 +2,0 @@'));
		assert.deepStrictEqual(testHarness.openEditorCalls, []);
	});

	test('TE-20 rejects create-file calls without required parameters and when the target already exists', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();
		testHarness.existsHandler = async () => true;

		const missingPath = await service.executeTool('create_file', { content: 'hello' });
		const missingContent = await service.executeTool('create_file', { path: '/workspace/src/new-file.ts' });
		const alreadyExists = await service.executeTool('create_file', { path: '/workspace/src/new-file.ts', content: 'hello' });

		assert.deepStrictEqual(missingPath, { success: false, output: 'Missing required parameter: path' });
		assert.deepStrictEqual(missingContent, { success: false, output: 'Missing required parameter: content' });
		assert.deepStrictEqual(alreadyExists, { success: false, output: 'File already exists: /workspace/src/new-file.ts' });
	});

	test('TE-21 routes create_file through the edit engine and emits a /dev/null diff preview', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();
		testHarness.existsHandler = async () => false;
		testHarness.nextEditApplyResult = {
			attemptedEdits: 1,
			appliedEdits: 1,
			modifiedFiles: [URI.file('/workspace/src/new-file.ts')],
			failures: [],
			fileChanges: [],
		};

		const result = await service.executeTool('create_file', {
			path: '/workspace/src/new-file.ts',
			content: 'hello\nworld\n',
		});

		assert.strictEqual(result.success, true);
		assert.ok(result.output.includes('Created file file:///workspace/src/new-file.ts.'));
		assert.ok(result.output.includes('--- /dev/null'));
		assert.ok(result.output.includes('+++ b/workspace/src/new-file.ts'));
		assert.ok(result.output.includes('@@ -0,0 +1,2 @@'));
		assert.deepStrictEqual(testHarness.rewriteFileCalls, [{
			uri: 'file:///workspace/src/new-file.ts',
			newContent: 'hello\nworld\n',
		}]);
		assert.deepStrictEqual(testHarness.createFolderCalls, []);
		assert.deepStrictEqual(testHarness.writeFileCalls, []);
		assert.deepStrictEqual(testHarness.openEditorCalls, []);
	});

	test('TE-22 surfaces rewrite failures without falling back to SEARCH/REPLACE wording', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();
		testHarness.existsHandler = async () => false;
		testHarness.nextEditApplyResult = {
			attemptedEdits: 1,
			appliedEdits: 0,
			modifiedFiles: [],
			failures: ['Could not create parent folder.'],
			fileChanges: [],
		};

		const result = await service.executeTool('create_file', {
			path: '/workspace/src/new-file.ts',
			content: 'hello\n',
		});

		assert.deepStrictEqual(result, { success: false, output: 'Could not create parent folder.' });
	});

	test('TE-23 keeps tool-side mutation paths idle when assistant edits delegate to the edit engine', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();
		testHarness.resolveHandler = async (resource) => createFileStat(resource.path);
		testHarness.readFileHandler = async () => 'alpha\n';
		testHarness.existsHandler = async () => false;

		await service.executeTool('edit_file', {
			path: '/workspace/src/app.ts',
			changes: [
				'<<<<<<< SEARCH',
				'alpha',
				'=======',
				'ALPHA',
				'>>>>>>> REPLACE',
			].join('\n'),
		});
		await service.executeTool('create_file', {
			path: '/workspace/src/new-file.ts',
			content: 'hello\n',
		});

		assert.deepStrictEqual(testHarness.bulkEditCalls, []);
		assert.deepStrictEqual(testHarness.createFolderCalls, []);
		assert.deepStrictEqual(testHarness.writeFileCalls, []);
	});

	test('TE-24 reads open-model content before disk and returns undefined on safeResolve failure', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();
		const helpers = asInternals(service);
		const resource = URI.file('/workspace/src/app.ts');
		testHarness.openModels.set(resource.toString(), { getValue: () => 'open model text' });
		testHarness.readFileHandler = async () => 'disk fallback text';

		const fromModel = await helpers.readFileContents(resource);
		const resolved = await helpers.safeResolve(resource);

		testHarness.resolveHandler = async () => {
			throw new Error('resolve failure');
		};
		const failedResolve = await helpers.safeResolve(resource);

		assert.strictEqual(fromModel, 'open model text');
		assert.strictEqual(resolved?.resource.toString(), 'file:///workspace/src/app.ts');
		assert.strictEqual(failedResolve, undefined);
		assert.strictEqual(testHarness.readFileCalls.length, 0);
	});

	test('TE-25 normalizes whitespace, truncates long parameters, and handles empty input in tool logs', async () => {
		const testHarness = new ToolExecutionHarness();
		const service = testHarness.createService();

		await service.executeTool('does_not_exist', {});
		await service.executeTool('does_not_exist', {
			path: 'alpha\nbeta\tgamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron',
		});

		assert.ok(testHarness.logService.infos[0].includes('(no params)'));
		assert.ok(testHarness.logService.infos[1].includes('path=alpha beta gamma'));
		assert.ok(!testHarness.logService.infos[1].includes('\n'));
		assert.ok(testHarness.logService.infos[1].length < 200);
	});

	test('TE-26 renders create-file previews for empty content, trailing newlines, blank paths, and long diffs', () => {
		const testHarness = new ToolExecutionHarness();
		const helpers = asInternals(testHarness.createService());

		const emptyPreview = helpers.buildCreateFileDiffPreview('\\src\\file.ts', '');
		const trailingNewlinePreview = helpers.buildCreateFileDiffPreview('\\src\\file.ts', 'a\nb\n');
		const blankPathPreview = helpers.buildCreateFileDiffPreview('   ', 'content');
		const truncatedPreview = helpers.buildCreateFileDiffPreview('\\src\\file.ts', Array.from({ length: 221 }, () => 'x').join('\n'));

		assert.ok(emptyPreview.includes('+++ b/src/file.ts'));
		assert.ok(emptyPreview.includes('@@ -0,0 +1,1 @@'));
		assert.ok(trailingNewlinePreview.includes('@@ -0,0 +1,2 @@'));
		assert.ok(blankPathPreview.includes('+++ b/unknown-path'));
		assert.ok(truncatedPreview.endsWith('... [diff truncated]'));
	});
});
