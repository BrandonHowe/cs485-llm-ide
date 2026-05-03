/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { testWorkspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { QueryBuilder } from '../../../../services/search/common/queryBuilder.js';
import { IFileQuery, ISearchService } from '../../../../services/search/common/search.js';
import { VSCloneMentionSearchService } from '../../browser/vscloneMentionSearchService.js';

class MentionSearchHarness {
	workspaceRoots: URI[] = [URI.file('/workspace')];
	searchResults: URI[] = [];
	readonly fileSearchCalls: Array<{ query: IFileQuery; token: CancellationToken | undefined }> = [];
	readonly queryBuilderCalls: Array<{ folders: readonly URI[]; options: { filePattern?: string; maxResults?: number; sortByScore?: boolean } }> = [];

	readonly workspaceContextService = {
		getWorkspace: () => testWorkspace(...this.workspaceRoots),
		getWorkspaceFolder: (resource: URI) => testWorkspace(...this.workspaceRoots).getFolder(resource),
		isInsideWorkspace: (resource: URI) => this.workspaceRoots.some(root =>
			resource.path === root.path || resource.path.startsWith(`${root.path}/`),
		),
	} as unknown as IWorkspaceContextService;

	readonly searchService = {
		fileSearch: async (query: IFileQuery, token?: CancellationToken) => {
			this.fileSearchCalls.push({ query, token });
			return {
				results: this.searchResults.map(resource => ({ resource })),
				messages: [],
			};
		},
		textSearch: async () => ({ results: [], messages: [] }),
		aiTextSearch: async () => ({ results: [], messages: [] }),
		getAIName: async () => undefined,
		textSearchSplitSyncAsync: () => ({ syncResults: { results: [], messages: [] }, asyncResults: Promise.resolve({ results: [], messages: [] }) }),
		schemeHasFileSearchProvider: () => false,
		clearCache: async () => { },
		registerSearchResultProvider: () => ({ dispose() { /* no-op */ } }),
	} as unknown as ISearchService;

	readonly instantiationService = {
		createInstance: <T>(ctor: new (...args: never[]) => T) => {
			if (ctor === QueryBuilder) {
				return {
					file: (folders: readonly URI[], options: { filePattern?: string; maxResults?: number; sortByScore?: boolean }) => {
						this.queryBuilderCalls.push({ folders, options });
						return {
							type: 'file',
							folderQueries: folders.map(folder => ({ folder })),
							filePattern: options.filePattern,
							maxResults: options.maxResults,
							sortByScore: options.sortByScore,
						} as unknown as IFileQuery;
					},
				} as unknown as T;
			}

			throw new Error(`Unexpected createInstance call for ${ctor.name}`);
		},
	} as unknown as IInstantiationService;

	createService(): VSCloneMentionSearchService {
		return new VSCloneMentionSearchService(
			this.searchService,
			this.workspaceContextService,
			this.instantiationService,
		);
	}
}

suite('VSCloneMentionSearchService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('returns no results without querying search when the workspace is empty', async () => {
		const harness = new MentionSearchHarness();
		harness.workspaceRoots = [];
		const service = store.add(harness.createService());

		const results = await service.search('anything', 20, CancellationToken.None);

		assert.deepStrictEqual(results, []);
		assert.strictEqual(harness.queryBuilderCalls.length, 0);
		assert.strictEqual(harness.fileSearchCalls.length, 0);
	});

	test('derives matching folder mentions from unique file matches before file mentions', async () => {
		const harness = new MentionSearchHarness();
		harness.searchResults = [
			URI.file('/workspace/src/app.ts'),
			URI.file('/workspace/src/app.ts'),
			URI.file('/workspace/src/components/Button.ts'),
			URI.file('/workspace/docs/README.md'),
		];
		const service = store.add(harness.createService());

		const results = await service.search(' src ', 4, CancellationToken.None);

		assert.strictEqual(harness.queryBuilderCalls.length, 1);
		assert.deepStrictEqual(harness.queryBuilderCalls[0].folders.map(folder => folder.toString()), ['file:///workspace']);
		assert.strictEqual(harness.queryBuilderCalls[0].options.filePattern, 'src');
		assert.strictEqual(harness.queryBuilderCalls[0].options.maxResults, 16);
		assert.strictEqual(harness.queryBuilderCalls[0].options.sortByScore, true);
		assert.deepStrictEqual(results.map(result => `${result.kind}:${result.relativePath}`), [
			'folder:src',
			'folder:src/components',
			'file:src/app.ts',
			'file:src/components/Button.ts',
		]);
		assert.deepStrictEqual(results.map(result => result.label), [
			'src',
			'components',
			'app.ts',
			'Button.ts',
		]);
	});

	test('treats blank queries as broad file searches and still enforces the service result cap', async () => {
		const harness = new MentionSearchHarness();
		harness.searchResults = [
			URI.file('/workspace/a.ts'),
			URI.file('/workspace/b.ts'),
			URI.file('/workspace/c.ts'),
		];
		const service = store.add(harness.createService());

		const results = await service.search('   ', 2, CancellationToken.None);

		assert.strictEqual(harness.queryBuilderCalls[0].options.filePattern, undefined);
		assert.strictEqual(harness.queryBuilderCalls[0].options.maxResults, 8);
		assert.deepStrictEqual(results.map(result => result.relativePath), ['a.ts', 'b.ts']);
	});
});
