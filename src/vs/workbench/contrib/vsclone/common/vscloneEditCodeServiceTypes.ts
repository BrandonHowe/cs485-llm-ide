/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

/**
 * These computed diffs intentionally mirror Void's edit engine shape so the VSClone edit service
 * can keep the same acceptance/rollback semantics while remaining VSClone-named and self-contained.
 */
export type VSCloneComputedDiff = {
	type: 'edit';
	originalCode: string;
	originalStartLine: number;
	originalEndLine: number;
	code: string;
	startLine: number;
	endLine: number;
	startOffset: number;
	endOffset: number;
} | {
	type: 'insertion';
	originalCode?: string;
	originalStartLine: number;
	code: string;
	startLine: number;
	endLine: number;
	startOffset: number;
	endOffset: number;
} | {
	type: 'deletion';
	originalCode: string;
	originalStartLine: number;
	originalEndLine: number;
	startLine: number;
	endLine: number;
	startOffset: number;
	endOffset: number;
};

export type VSCloneCommonZoneProps = {
	diffareaid: number;
	startLine: number;
	endLine: number;
	_URI: URI;
};

export type VSCloneCtrlKZone = {
	type: 'CtrlKZone';
	originalCode?: undefined;
	editorId: string;
	_mountInfo: null | {
		textAreaRef: { current: HTMLTextAreaElement | null };
		dispose: () => void;
		refresh: () => void;
	};
	_linkedStreamingDiffZone: number | null;
	_removeStylesFns: Set<() => void>;
} & VSCloneCommonZoneProps;

export type VSCloneTrackingZone<T> = {
	type: 'TrackingZone';
	metadata: T;
	originalCode?: undefined;
	editorId?: undefined;
	_removeStylesFns?: undefined;
} & VSCloneCommonZoneProps;

export type VSCloneDiffArea = VSCloneCtrlKZone | VSCloneDiffZone | VSCloneTrackingZone<unknown>;

export type VSCloneDiff = {
	diffid: number;
	diffareaid: number;
} & VSCloneComputedDiff;

export type VSCloneDiffZone = {
	type: 'DiffZone';
	originalCode: string;
	_diffOfId: Record<string, VSCloneDiff>;
	_streamState: {
		isStreaming: true;
		streamRequestIdRef: { current: string | null };
		line: number;
	} | {
		isStreaming: false;
	};
	editorId?: undefined;
	_removeStylesFns: Set<() => void>;
} & VSCloneCommonZoneProps;

export const vscloneDiffAreaSnapshotKeys = [
	'type',
	'diffareaid',
	'originalCode',
	'startLine',
	'endLine',
	'editorId',
] as const satisfies (keyof VSCloneDiffArea)[];

export type VSCloneDiffAreaSnapshotEntry<DiffAreaType extends VSCloneDiffArea = VSCloneDiffArea> = Pick<DiffAreaType, typeof vscloneDiffAreaSnapshotKeys[number]>;

/**
 * Snapshots are intentionally shallow on purpose: the live service recreates the runtime-only
 * fields when restoring, while the serialized fields remain stable and easy to compare.
 */
export type VSCloneFileSnapshot = {
	snapshottedDiffAreaOfId: Record<string, VSCloneDiffAreaSnapshotEntry>;
	entireFileCode: string;
};
