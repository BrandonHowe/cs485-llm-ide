/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { VSCloneDiff, VSCloneDiffArea, VSCloneFileSnapshot } from '../common/vscloneEditCodeServiceTypes.js';

export type VSCloneStartBehavior = 'accept-conflicts' | 'reject-conflicts' | 'keep-conflicts';

export type VSCloneCallBeforeStartApplyingOpts = {
	from: 'QuickEdit';
	diffareaid: number;
} | {
	from: 'ClickApply';
	uri: 'current' | URI;
};

export type VSCloneStartApplyingOpts = {
	from: 'QuickEdit';
	diffareaid: number;
	startBehavior: VSCloneStartBehavior;
} | {
	from: 'ClickApply';
	applyStr: string;
	uri: 'current' | URI;
	startBehavior: VSCloneStartBehavior;
};

export type VSCloneAddCtrlKOpts = {
	startLine: number;
	endLine: number;
	editor: ICodeEditor;
};

export interface VSCloneParsedEdit {
	readonly filePath: string;
	readonly searchText: string;
	readonly replaceText: string;
	readonly order: number;
}

export interface VSCloneResolvedContentEdit {
	readonly startOffset: number;
	readonly endOffset: number;
	readonly replaceText: string;
	readonly source: VSCloneParsedEdit;
}

export interface VSCloneEditApplyResult {
	readonly attemptedEdits: number;
	readonly appliedEdits: number;
	readonly modifiedFiles: readonly URI[];
	readonly failures: readonly string[];
	readonly fileChanges: readonly VSCloneEditFileChange[];
}

export interface VSCloneEditFileChange {
	readonly uri: URI;
	readonly displayPath: string;
	readonly addedLines: number;
	readonly removedLines: number;
	readonly action: 'create' | 'modify';
	readonly originalContent: string | undefined;
}

export interface VSCloneEditUndoResult {
	readonly revertedFiles: readonly URI[];
	readonly failures: readonly string[];
}

export const IVSCloneEditCodeService = createDecorator<IVSCloneEditCodeService>('vscloneEditCodeService');

export interface IVSCloneEditCodeService {
	readonly _serviceBrand: undefined;

	processRawKeybindingText(keybindingStr: string): string;
	callBeforeApplyOrEdit(uri: URI | 'current'): Promise<void>;
	startApplying(opts: VSCloneStartApplyingOpts): [URI, Promise<void>] | null;
	instantlyApplySearchReplaceBlocks(opts: { uri: URI; searchReplaceBlocks: string }): Promise<VSCloneEditApplyResult>;
	instantlyRewriteFile(opts: { uri: URI; newContent: string }): Promise<VSCloneEditApplyResult>;
	addCtrlKZone(opts: VSCloneAddCtrlKOpts): number | undefined;
	removeCtrlKZone(opts: { diffareaid: number }): void;

	diffAreaOfId: Record<string, VSCloneDiffArea>;
	diffAreasOfURI: Record<string, Set<string> | undefined>;
	diffOfId: Record<string, VSCloneDiff>;

	acceptOrRejectAllDiffAreas(opts: { uri: URI; removeCtrlKs: boolean; behavior: 'reject' | 'accept'; _addToHistory?: boolean }): Promise<void>;
	acceptDiff(opts: { diffid: number }): Promise<void>;
	rejectDiff(opts: { diffid: number }): Promise<void>;

	onDidAddOrDeleteDiffZones: Event<{ uri: URI }>;
	onDidChangeDiffsInDiffZoneNotStreaming: Event<{ uri: URI; diffareaid: number }>;
	onDidChangeStreamingInDiffZone: Event<{ uri: URI; diffareaid: number }>;
	onDidChangeStreamingInCtrlKZone: Event<{ uri: URI; diffareaid: number }>;

	isCtrlKZoneStreaming(opts: { diffareaid: number }): boolean;
	interruptCtrlKStreaming(opts: { diffareaid: number }): void;
	interruptURIStreaming(opts: { uri: URI }): void;

	getVSCloneFileSnapshot(uri: URI): VSCloneFileSnapshot;
	restoreVSCloneFileSnapshot(uri: URI, snapshot: VSCloneFileSnapshot): void;

	hasSearchReplaceBlocks(responseText: string): boolean;
	parseSearchReplaceBlocks(responseText: string, defaultFilePath?: string): readonly VSCloneParsedEdit[];
	startApplyingSearchReplaceBlocks(responseText: string): Promise<VSCloneEditApplyResult>;
	applySearchReplaceBlocks(responseText: string): Promise<VSCloneEditApplyResult>;
	undoEditApply(fileChanges: readonly VSCloneEditFileChange[]): Promise<VSCloneEditUndoResult>;
}
