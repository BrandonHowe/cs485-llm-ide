/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IUserDataProfileService } from '../../../services/userDataProfile/common/userDataProfile.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IVSCloneChatHistoryMigrationService } from './vscloneChatHistoryMigrationService.js';
import { IVSCloneChatHistorySnapshot, IVSCloneChatHistoryThread, IVSCloneChatHistoryTurn, VSCloneChatHistoryScope } from './vscloneChatHistoryService.js';
import { VSCloneChatHistorySerializer } from './vscloneChatHistorySerializer.js';

const INDEX_FILE_NAME = 'history.index.v1.json';
const THREADS_FOLDER_NAME = 'threads';
const ATOMIC_POSTFIX = '.tmp';

const secretPatterns: RegExp[] = [
	/(api[_-]?key\s*[:=]\s*)([\w\-]{8,})/gi,
	/(token\s*[:=]\s*)([\w\-]{8,})/gi,
	/(password\s*[:=]\s*)([^\s'"`]+)/gi,
	/(bearer\s+)([a-z0-9\-._~+/]+=*)/gi,
];

function redactText(value: string): string {
	let redacted = value;
	for (const pattern of secretPatterns) {
		redacted = redacted.replace(pattern, (_match, prefix: string) => `${prefix}[REDACTED]`);
	}
	return redacted;
}

function redactThread(thread: IVSCloneChatHistoryThread): IVSCloneChatHistoryThread {
	return {
		...thread,
		title: redactText(thread.title),
		lastTurnPreview: redactText(thread.lastTurnPreview),
	};
}

function redactTurn(turn: IVSCloneChatHistoryTurn): IVSCloneChatHistoryTurn {
	return {
		...turn,
		promptText: redactText(turn.promptText),
		responseMarkdown: redactText(turn.responseMarkdown),
		responsePlainText: redactText(turn.responsePlainText),
	};
}

function isFileNotFound(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	return toFileOperationResult(error) === FileOperationResult.FILE_NOT_FOUND;
}

function encodeThreadId(threadId: string): string {
	return encodeURIComponent(threadId);
}

export interface IVSCloneChatHistoryStoreSaveOptions {
	redactSecrets: boolean;
}

export class VSCloneChatHistoryStore extends Disposable {
	private readonly serializer = new VSCloneChatHistorySerializer();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IUserDataProfileService private readonly userDataProfileService: IUserDataProfileService,
		@ILogService private readonly logService: ILogService,
		@IVSCloneChatHistoryMigrationService private readonly migrationService: IVSCloneChatHistoryMigrationService,
	) {
		super();
	}

	async load(scope: VSCloneChatHistoryScope): Promise<IVSCloneChatHistorySnapshot> {
		const indexResource = this.getIndexResource(scope);
		const fallback: IVSCloneChatHistorySnapshot = { updatedAt: Date.now(), threads: [], turnsByThreadId: {} };

		let indexRaw: string;
		try {
			const indexContent = await this.fileService.readFile(indexResource);
			indexRaw = indexContent.value.toString();
		} catch (error) {
			if (isFileNotFound(error)) {
				return fallback;
			}
			throw error;
		}

		const migratedIndex = this.migrationService.migrateIndex(JSON.parse(indexRaw) as unknown);
		const index = this.serializer.deserializeIndex(JSON.stringify(migratedIndex));

		const turnsByThreadId: Record<string, readonly IVSCloneChatHistoryTurn[]> = {};
		const threads: IVSCloneChatHistoryThread[] = [];
		for (const thread of index.threads) {
			const threadResource = this.getThreadResource(scope, thread.threadId);
			try {
				const raw = (await this.fileService.readFile(threadResource)).value.toString();
				const migratedThread = this.migrationService.migrateThread(JSON.parse(raw) as unknown);
				const parsed = this.serializer.deserializeThread(JSON.stringify(migratedThread));
				threads.push(thread);
				turnsByThreadId[thread.threadId] = parsed.turns;
			} catch (error) {
				if (!isFileNotFound(error)) {
					this.logService.warn(`Skipping malformed VSClone history thread '${thread.threadId}'`, error);
				}
				threads.push(thread);
				turnsByThreadId[thread.threadId] = [];
			}
		}

		return {
			updatedAt: index.updatedAt,
			threads,
			turnsByThreadId,
		};
	}

	async save(scope: VSCloneChatHistoryScope, snapshot: IVSCloneChatHistorySnapshot, options: IVSCloneChatHistoryStoreSaveOptions): Promise<void> {
		const root = this.getStorageRoot(scope);
		const threadsFolder = joinPath(root, THREADS_FOLDER_NAME);
		await this.fileService.createFolder(threadsFolder);

		const threads = options.redactSecrets ? snapshot.threads.map(redactThread) : snapshot.threads;
		const expectedResources = new Set<string>();

		for (const thread of threads) {
			const threadResource = this.getThreadResource(scope, thread.threadId);
			expectedResources.add(threadResource.toString());
			const turns = snapshot.turnsByThreadId[thread.threadId] ?? [];
			const persistedTurns = options.redactSecrets ? turns.map(redactTurn) : turns;
			const content = this.serializer.serializeThread(thread.threadId, thread.sessionResource, persistedTurns);
			await this.fileService.writeFile(threadResource, VSBuffer.fromString(content), { atomic: { postfix: ATOMIC_POSTFIX } });
		}

		await this.deleteStaleThreadFiles(threadsFolder, expectedResources);

		const indexContent = this.serializer.serializeIndex(this.workspaceContextService.getWorkspace().id, snapshot.updatedAt, threads);
		await this.fileService.writeFile(this.getIndexResource(scope), VSBuffer.fromString(indexContent), { atomic: { postfix: ATOMIC_POSTFIX } });
	}

	async clear(scope: VSCloneChatHistoryScope): Promise<void> {
		const root = this.getStorageRoot(scope);
		try {
			await this.fileService.del(root, { recursive: true, useTrash: false });
		} catch (error) {
			if (!isFileNotFound(error)) {
				throw error;
			}
		}
	}

	private async deleteStaleThreadFiles(threadsFolder: URI, expectedResources: Set<string>): Promise<void> {
		let stat;
		try {
			stat = await this.fileService.resolve(threadsFolder);
		} catch (error) {
			if (isFileNotFound(error)) {
				return;
			}
			throw error;
		}

		for (const child of stat.children ?? []) {
			if (child.isDirectory) {
				continue;
			}

			if (!expectedResources.has(child.resource.toString())) {
				try {
					await this.fileService.del(child.resource, { useTrash: false });
				} catch (error) {
					if (!isFileNotFound(error)) {
						this.logService.warn(`Failed to delete stale VSClone thread file '${child.resource.toString()}'`, error);
					}
				}
			}
		}
	}

	private getStorageRoot(scope: VSCloneChatHistoryScope): URI {
		if (scope === 'profile') {
			return joinPath(this.userDataProfileService.currentProfile.globalStorageHome, 'vsclone', 'chatHistory');
		}

		const workspaceId = this.workspaceContextService.getWorkspace().id;
		return joinPath(this.environmentService.workspaceStorageHome, workspaceId, 'vsclone', 'chatHistory');
	}

	private getIndexResource(scope: VSCloneChatHistoryScope): URI {
		return joinPath(this.getStorageRoot(scope), INDEX_FILE_NAME);
	}

	private getThreadResource(scope: VSCloneChatHistoryScope, threadId: string): URI {
		return joinPath(this.getStorageRoot(scope), THREADS_FOLDER_NAME, `${encodeThreadId(threadId)}.v1.json`);
	}
}
