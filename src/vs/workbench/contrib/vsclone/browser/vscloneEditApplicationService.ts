/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	type IVSCloneEditCodeService as IVSCloneEditCodeServiceContract,
	VSCloneEditApplyResult,
	VSCloneEditFileChange,
	VSCloneEditUndoResult,
	VSCloneParsedEdit,
	VSCloneResolvedContentEdit,
} from './vscloneEditCodeServiceInterface.js';
import {
	IVSCloneEditCodeService as IVSCloneEditCodeServiceDecorator,
	parseSearchReplaceBlocks as parseVSCloneSearchReplaceBlocks,
	resolveContentEdits as resolveVSCloneContentEdits,
	applyResolvedEditsInReverse as applyVSCloneResolvedEditsInReverse,
} from './vscloneEditCodeService.js';

export type IVSCloneParsedEdit = VSCloneParsedEdit;
export type IVSCloneResolvedContentEdit = VSCloneResolvedContentEdit;
export type IVSCloneEditApplyResult = VSCloneEditApplyResult;
export type IVSCloneEditFileChange = VSCloneEditFileChange;
export type IVSCloneEditUndoResult = VSCloneEditUndoResult;

export const IVSCloneEditApplicationService = createDecorator<IVSCloneEditApplicationService>('vscloneEditApplicationService');

export interface IVSCloneEditApplicationService {
	readonly _serviceBrand: undefined;
	hasSearchReplaceBlocks(responseText: string): boolean;
	parseSearchReplaceBlocks(responseText: string): readonly IVSCloneParsedEdit[];
	startApplyingSearchReplaceBlocks(responseText: string): Promise<IVSCloneEditApplyResult>;
	applySearchReplaceBlocks(responseText: string): Promise<IVSCloneEditApplyResult>;
	undoEditApply(fileChanges: readonly IVSCloneEditFileChange[]): Promise<IVSCloneEditUndoResult>;
}

export const parseSearchReplaceBlocks = parseVSCloneSearchReplaceBlocks;
export const resolveContentEdits = resolveVSCloneContentEdits;
export const applyResolvedEditsInReverse = applyVSCloneResolvedEditsInReverse;

export class VSCloneEditApplicationService implements IVSCloneEditApplicationService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IVSCloneEditCodeServiceDecorator private readonly editCodeService: IVSCloneEditCodeServiceContract,
	) {
	}

	hasSearchReplaceBlocks(responseText: string): boolean {
		return this.editCodeService.hasSearchReplaceBlocks(responseText);
	}

	parseSearchReplaceBlocks(responseText: string): readonly IVSCloneParsedEdit[] {
		return this.editCodeService.parseSearchReplaceBlocks(responseText);
	}

	startApplyingSearchReplaceBlocks(responseText: string): Promise<IVSCloneEditApplyResult> {
		return this.editCodeService.startApplyingSearchReplaceBlocks(responseText);
	}

	applySearchReplaceBlocks(responseText: string): Promise<IVSCloneEditApplyResult> {
		return this.editCodeService.applySearchReplaceBlocks(responseText);
	}

	undoEditApply(fileChanges: readonly IVSCloneEditFileChange[]): Promise<IVSCloneEditUndoResult> {
		return this.editCodeService.undoEditApply(fileChanges);
	}
}
