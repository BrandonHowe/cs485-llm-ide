/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hasKey } from '../../../../base/common/types.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { IVSCloneChatHistoryIndexFile, IVSCloneChatHistoryThreadFile } from './vscloneChatHistorySerializer.js';

export const IVSCloneChatHistoryMigrationService = createDecorator<IVSCloneChatHistoryMigrationService>('vsCloneChatHistoryMigrationService');

export class VSCloneUnsupportedHistoryVersionError extends Error {
	constructor(
		readonly kind: 'index' | 'thread',
		readonly version: number,
	) {
		super(`Unsupported ${kind} schema version: ${version}`);
	}
}

export interface IVSCloneChatHistoryMigrationService {
	readonly _serviceBrand: undefined;
	migrateIndex(raw: unknown): IVSCloneChatHistoryIndexFile;
	migrateThread(raw: unknown): IVSCloneChatHistoryThreadFile;
}

function getSchemaVersion(raw: unknown): number {
	if (!raw || typeof raw !== 'object' || !hasKey(raw, { schemaVersion: true })) {
		return 1;
	}

	const version = raw.schemaVersion;
	return typeof version === 'number' ? version : 1;
}

export class VSCloneChatHistoryMigrationService implements IVSCloneChatHistoryMigrationService {
	declare readonly _serviceBrand: undefined;

	migrateIndex(raw: unknown): IVSCloneChatHistoryIndexFile {
		const version = getSchemaVersion(raw);
		if (version !== 1) {
			throw new VSCloneUnsupportedHistoryVersionError('index', version);
		}
		return raw as IVSCloneChatHistoryIndexFile;
	}

	migrateThread(raw: unknown): IVSCloneChatHistoryThreadFile {
		const version = getSchemaVersion(raw);
		if (version !== 1) {
			throw new VSCloneUnsupportedHistoryVersionError('thread', version);
		}
		return raw as IVSCloneChatHistoryThreadFile;
	}
}
