/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../services/search/common/search.js';

export const IVSCloneMentionSearchService = createDecorator<IVSCloneMentionSearchService>('vscloneMentionSearchService');

export type VSCloneMentionResultKind = 'file' | 'folder';

export interface IVSCloneMentionResult {
	readonly kind: VSCloneMentionResultKind;
	readonly uri: URI;
	readonly label: string;
	readonly relativePath: string;
}

export interface IVSCloneMentionSearchService {
	readonly _serviceBrand: undefined;
	search(query: string, maxResults: number, token: CancellationToken): Promise<readonly IVSCloneMentionResult[]>;
}

const defaultMaxResults = 20;

/**
 * Search adapter that powers the composer `@` picker. Files come from the workspace file index;
 * folders are derived from the parent directories of matching files so the picker can surface both
 * without requiring a second workspace traversal.
 */
export class VSCloneMentionSearchService extends Disposable implements IVSCloneMentionSearchService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ISearchService private readonly searchService: ISearchService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
	}

	async search(query: string, maxResults: number, token: CancellationToken): Promise<readonly IVSCloneMentionResult[]> {
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
		if (workspaceFolders.length === 0) {
			return [];
		}

		const cap = Math.max(1, Math.min(maxResults || defaultMaxResults, 50));
		const queryBuilder = this.instantiationService.createInstance(QueryBuilder);
		const trimmed = query.trim();
		const fileQuery = queryBuilder.file(workspaceFolders.map(folder => folder.uri), {
			filePattern: trimmed.length === 0 ? undefined : trimmed,
			maxResults: cap * 4,
			sortByScore: true,
		});

		const searchResult = await this.searchService.fileSearch(fileQuery, token);
		const seen = new Set<string>();
		const files: IVSCloneMentionResult[] = [];
		const folders: IVSCloneMentionResult[] = [];

		for (const match of searchResult.results) {
			const uri = match.resource;
			const key = uri.toString();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			const relativePath = this.getRelativePath(uri) ?? uri.fsPath;
			const label = this.getLabel(uri);
			files.push({ kind: 'file', uri, label, relativePath });

			const parent = dirname(uri);
			const parentKey = parent.toString();
			if (!seen.has(parentKey) && this.workspaceContextService.isInsideWorkspace(parent)) {
				seen.add(parentKey);
				const parentRelative = this.getRelativePath(parent);
				if (parentRelative && parentRelative.length > 0 && this.matchesQuery(parentRelative, trimmed)) {
					folders.push({
						kind: 'folder',
						uri: parent,
						label: this.getLabel(parent),
						relativePath: parentRelative,
					});
				}
			}
		}

		return [...folders.slice(0, Math.floor(cap / 2)), ...files].slice(0, cap);
	}

	private getRelativePath(uri: URI): string | undefined {
		const folder = this.workspaceContextService.getWorkspaceFolder(uri);
		if (!folder) {
			return undefined;
		}
		const folderPath = folder.uri.path;
		if (!uri.path.startsWith(folderPath)) {
			return undefined;
		}
		const rest = uri.path.slice(folderPath.length);
		return rest.startsWith('/') ? rest.slice(1) : rest;
	}

	private getLabel(uri: URI): string {
		const segments = uri.path.split('/');
		return segments[segments.length - 1] || uri.fsPath;
	}

	private matchesQuery(path: string, query: string): boolean {
		if (query.length === 0) {
			return true;
		}
		return path.toLowerCase().includes(query.toLowerCase());
	}
}
