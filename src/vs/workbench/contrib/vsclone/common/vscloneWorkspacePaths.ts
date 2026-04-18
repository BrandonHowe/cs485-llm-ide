/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';

export interface IVSCloneWorkspaceFolderLike {
	readonly uri: URI;
	readonly name?: string;
}

function normalizeWorkspacePath(rawPath: string | undefined): string | undefined {
	const normalized = rawPath?.replace(/\\/g, '/').trim();
	return normalized ? normalized : undefined;
}

function getWorkspaceFolderLabels(folder: IVSCloneWorkspaceFolderLike): readonly string[] {
	const labels = new Set<string>();
	if (folder.name) {
		labels.add(folder.name);
	}
	const basename = folder.uri.path.split('/').filter(Boolean).at(-1);
	if (basename) {
		labels.add(basename);
	}
	return [...labels];
}

function getRelativeWorkspaceCandidate(
	workspaceFolders: readonly IVSCloneWorkspaceFolderLike[],
	normalizedPath: string,
): URI | undefined {
	if (workspaceFolders.length === 1) {
		return joinPath(workspaceFolders[0].uri, normalizedPath.replace(/^\.\//, ''));
	}

	const relativePath = normalizedPath.replace(/^\.\//, '');
	const matches = workspaceFolders.flatMap(folder =>
		getWorkspaceFolderLabels(folder)
			.filter(label => relativePath === label || relativePath.startsWith(`${label}/`))
			.map(label => ({ folder, label })),
	);
	if (matches.length !== 1) {
		return undefined;
	}

	const [{ folder, label }] = matches;
	const suffix = relativePath === label ? '' : relativePath.slice(label.length + 1);
	return suffix ? joinPath(folder.uri, suffix) : folder.uri;
}

export function resolveVSCloneWorkspacePath(
	workspaceFolders: readonly IVSCloneWorkspaceFolderLike[],
	rawPath: string | undefined,
): URI | undefined {
	const normalizedPath = normalizeWorkspacePath(rawPath);
	if (!normalizedPath || workspaceFolders.length === 0) {
		return undefined;
	}

	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalizedPath)) {
		try {
			return URI.parse(normalizedPath);
		} catch {
			return undefined;
		}
	}

	if (normalizedPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(normalizedPath)) {
		return URI.file(normalizedPath);
	}

	return getRelativeWorkspaceCandidate(workspaceFolders, normalizedPath);
}

export function isVSCloneAmbiguousWorkspaceRelativePath(
	workspaceFolders: readonly IVSCloneWorkspaceFolderLike[],
	rawPath: string | undefined,
): boolean {
	const normalizedPath = normalizeWorkspacePath(rawPath);
	if (!normalizedPath || workspaceFolders.length <= 1) {
		return false;
	}

	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalizedPath)) {
		return false;
	}

	if (normalizedPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(normalizedPath)) {
		return false;
	}

	const relativePath = normalizedPath.replace(/^\.\//, '');
	const matches = workspaceFolders.flatMap(folder =>
		getWorkspaceFolderLabels(folder)
			.filter(label => relativePath === label || relativePath.startsWith(`${label}/`)),
	);
	return matches.length !== 1;
}
