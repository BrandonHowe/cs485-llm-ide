/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import {
	isVSCloneChatMode,
	type VSCloneChatMode,
} from '../vsclonePlanModeTypes.js';
import type {
	IVSCloneThreadRuntimeAssistantEditApplication,
	IVSCloneThreadRuntimeAssistantEditApplicationState,
	IVSCloneThreadRuntimeCatalogEntry,
	IVSCloneThreadRuntimeCheckpoint,
	IVSCloneThreadRuntimeConversationMessageMetadata,
	IVSCloneThreadRuntimeEditApplyResult,
	IVSCloneThreadRuntimeEditFileChange,
	IVSCloneThreadRuntimeMessage,
	IVSCloneThreadRuntimePausedApproval,
	IVSCloneThreadRuntimeSnapshot,
	IVSCloneThreadRuntimeState,
	VSCloneThreadRuntimeCatalogStatus,
	VSCloneThreadStreamState,
} from '../vscloneThreadRuntimeTypes.js';
import type { IVSCloneImageAttachment } from '../vscloneImageAttachmentTypes.js';
import type { VSCloneReasoningEffortLevel } from '../vscloneModelCatalogService.js';
import type { VSCloneModelVendor } from '../vscloneOAuthTypes.js';
import type { VSCloneToolApprovalType } from '../vscloneToolRuntimeTypes.js';

interface IVSCloneThreadRuntimeIndexPayload {
	schemaVersion: 1;
	workspaceId: string;
	updatedAt: number;
	threadIds: string[];
	deletedThreadIds?: string[];
}

interface ISerializedThreadRuntimeSnapshot {
	uri: string;
	existed: boolean;
	content?: string;
	isDirectory: boolean;
}

interface ISerializedThreadRuntimeCatalogEntry {
	threadId: string;
	sessionResource?: string;
	title: string;
	activeModelIdentifier?: string;
	createdAt: number;
	updatedAt: number;
	status: string;
	archived: boolean;
	turnCount: number;
	lastTurnPreview: string;
	importedFromHistory?: boolean;
}

interface ISerializedThreadRuntimeCheckpoint {
	id: string;
	createdAt: number;
	type: 'tool_edit';
	toolName: string;
	snapshots: ISerializedThreadRuntimeSnapshot[];
}

interface ISerializedThreadRuntimePausedApproval {
	requestedAt: number;
	toolName: string;
	params: Record<string, string>;
	approvalType?: string;
	snapshots: ISerializedThreadRuntimeSnapshot[];
	run: Omit<IVSCloneThreadRuntimePausedApproval['run'], 'vendor'> & {
		vendor: string;
	};
}

interface ISerializedThreadRuntimeEditFileChange {
	uri: string;
	displayPath: string;
	addedLines: number;
	removedLines: number;
	action: 'create' | 'modify';
	originalContent?: string;
}

interface ISerializedThreadRuntimeEditApplyResult {
	attemptedEdits: number;
	appliedEdits: number;
	modifiedFiles: string[];
	failures: string[];
	fileChanges: ISerializedThreadRuntimeEditFileChange[];
}

type ISerializedThreadRuntimeAssistantEditApplicationState =
	| {
		phase: 'pending' | 'failed';
	}
	| {
		phase: 'partial' | 'applied' | 'undone';
		result: ISerializedThreadRuntimeEditApplyResult;
	};

interface ISerializedThreadRuntimeAssistantEditApplication {
	messageId: string;
	state: ISerializedThreadRuntimeAssistantEditApplicationState;
}

interface ISerializedThreadRuntimeConversationMessageMetadata {
	importedFromHistory?: boolean;
}

type ISerializedThreadRuntimeMessage =
	| {
		id: string;
		role: 'user';
		mode?: string;
		metadata?: ISerializedThreadRuntimeConversationMessageMetadata;
		createdAt: number;
		content: string;
		imageAttachments?: IVSCloneImageAttachment[];
	}
	| {
		id: string;
		role: 'assistant';
		mode?: string;
		metadata?: ISerializedThreadRuntimeConversationMessageMetadata;
		createdAt: number;
		content: string;
	}
	| {
		id: string;
		role: 'tool';
		createdAt: number;
		type: 'tool_request' | 'running_now' | 'success' | 'tool_error' | 'rejected';
		toolName: string;
		approvalType?: string;
		params: Record<string, string>;
		output?: string;
		success?: boolean;
	}
	| {
		id: string;
		role: 'checkpoint';
		createdAt: number;
		checkpoint: ISerializedThreadRuntimeCheckpoint;
	};

interface IVSCloneThreadRuntimeThreadPayload {
	schemaVersion: 1;
	state: {
		threadId: string;
		catalog?: ISerializedThreadRuntimeCatalogEntry;
		turnId?: string;
		mode?: string;
		streamState: VSCloneThreadStreamState;
		messages: ISerializedThreadRuntimeMessage[];
		assistantEditApplications?: ISerializedThreadRuntimeAssistantEditApplication[];
		checkpoints: ISerializedThreadRuntimeCheckpoint[];
		currentCheckpointId?: string;
		branchHeadMessageId?: string;
		pausedApproval?: ISerializedThreadRuntimePausedApproval;
		isRunning: boolean;
		lastUpdatedAt: number;
	};
}

function isCatalogStatus(value: unknown): value is VSCloneThreadRuntimeCatalogStatus {
	return value === 'active' || value === 'completed' || value === 'failed' || value === 'archived';
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object';
}

function isImageAttachment(value: unknown): value is IVSCloneImageAttachment {
	return isObject(value)
		&& typeof value.mimeType === 'string'
		&& typeof value.base64Data === 'string';
}

function isSnapshot(value: unknown): value is ISerializedThreadRuntimeSnapshot {
	return isObject(value)
		&& typeof value.uri === 'string'
		&& typeof value.existed === 'boolean'
		&& (value.content === undefined || typeof value.content === 'string')
		&& typeof value.isDirectory === 'boolean';
}

function isCheckpoint(value: unknown): value is ISerializedThreadRuntimeCheckpoint {
	return isObject(value)
		&& typeof value.id === 'string'
		&& typeof value.createdAt === 'number'
		&& value.type === 'tool_edit'
		&& typeof value.toolName === 'string'
		&& Array.isArray(value.snapshots)
		&& value.snapshots.every(isSnapshot);
}

function isCatalogEntry(value: unknown): value is ISerializedThreadRuntimeCatalogEntry {
	return isObject(value)
		&& typeof value.threadId === 'string'
		&& (value.sessionResource === undefined || typeof value.sessionResource === 'string')
		&& typeof value.title === 'string'
		&& (value.activeModelIdentifier === undefined || typeof value.activeModelIdentifier === 'string')
		&& typeof value.createdAt === 'number'
		&& typeof value.updatedAt === 'number'
		&& isCatalogStatus(value.status)
		&& typeof value.archived === 'boolean'
		&& typeof value.turnCount === 'number'
		&& typeof value.lastTurnPreview === 'string'
		&& (value.importedFromHistory === undefined || typeof value.importedFromHistory === 'boolean');
}

function isEditFileChange(value: unknown): value is ISerializedThreadRuntimeEditFileChange {
	return isObject(value)
		&& typeof value.uri === 'string'
		&& typeof value.displayPath === 'string'
		&& typeof value.addedLines === 'number'
		&& typeof value.removedLines === 'number'
		&& (value.action === 'create' || value.action === 'modify')
		&& (value.originalContent === undefined || typeof value.originalContent === 'string');
}

function isConversationMessageMetadata(value: unknown): value is ISerializedThreadRuntimeConversationMessageMetadata {
	return isObject(value)
		&& (value.importedFromHistory === undefined || typeof value.importedFromHistory === 'boolean');
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
	return isObject(value) && Object.values(value).every(entry => typeof entry === 'string');
}

function isEditApplyResult(value: unknown): value is ISerializedThreadRuntimeEditApplyResult {
	return isObject(value)
		&& typeof value.attemptedEdits === 'number'
		&& typeof value.appliedEdits === 'number'
		&& Array.isArray(value.modifiedFiles)
		&& value.modifiedFiles.every(entry => typeof entry === 'string')
		&& Array.isArray(value.failures)
		&& value.failures.every(entry => typeof entry === 'string')
		&& Array.isArray(value.fileChanges)
		&& value.fileChanges.every(isEditFileChange);
}

function isAssistantEditApplicationState(value: unknown): value is ISerializedThreadRuntimeAssistantEditApplicationState {
	if (!isObject(value) || typeof value.phase !== 'string') {
		return false;
	}

	switch (value.phase) {
		case 'pending':
		case 'failed':
			return true;
		case 'partial':
		case 'applied':
		case 'undone':
			return isEditApplyResult(value.result);
		default:
			return false;
	}
}

function isAssistantEditApplication(value: unknown): value is ISerializedThreadRuntimeAssistantEditApplication {
	return isObject(value)
		&& typeof value.messageId === 'string'
		&& isAssistantEditApplicationState(value.state);
}

function isStreamState(value: unknown): value is VSCloneThreadStreamState {
	if (!isObject(value) || typeof value.kind !== 'string') {
		return false;
	}

	switch (value.kind) {
		case 'idle':
		case 'llm':
			return true;
		case 'tool':
			return typeof value.toolName === 'string';
		case 'awaiting_user':
			return typeof value.toolName === 'string'
				&& (value.approvalType === undefined || typeof value.approvalType === 'string');
		default:
			return false;
	}
}

function isMessage(value: unknown): value is ISerializedThreadRuntimeMessage {
	if (!isObject(value) || typeof value.id !== 'string' || typeof value.role !== 'string' || typeof value.createdAt !== 'number') {
		return false;
	}

	switch (value.role) {
		case 'user':
			return typeof value.content === 'string'
				&& (value.mode === undefined || isVSCloneChatMode(value.mode))
				&& (value.metadata === undefined || isConversationMessageMetadata(value.metadata))
				&& (value.imageAttachments === undefined || (Array.isArray(value.imageAttachments) && value.imageAttachments.every(isImageAttachment)));
		case 'assistant':
			return typeof value.content === 'string'
				&& (value.mode === undefined || isVSCloneChatMode(value.mode))
				&& (value.metadata === undefined || isConversationMessageMetadata(value.metadata));
		case 'tool':
			return (value.type === 'tool_request' || value.type === 'running_now' || value.type === 'success' || value.type === 'tool_error' || value.type === 'rejected')
				&& typeof value.toolName === 'string'
				&& (value.approvalType === undefined || typeof value.approvalType === 'string')
				&& isRecordOfStrings(value.params)
				&& (value.output === undefined || typeof value.output === 'string')
				&& (value.success === undefined || typeof value.success === 'boolean');
		case 'checkpoint':
			return isCheckpoint(value.checkpoint);
		default:
			return false;
	}
}

function serializeSnapshot(snapshot: IVSCloneThreadRuntimeSnapshot): ISerializedThreadRuntimeSnapshot {
	return {
		uri: snapshot.uri.toString(),
		existed: snapshot.existed,
		content: snapshot.content,
		isDirectory: snapshot.isDirectory,
	};
}

function deserializeSnapshot(snapshot: ISerializedThreadRuntimeSnapshot): IVSCloneThreadRuntimeSnapshot {
	return {
		uri: URI.parse(snapshot.uri),
		existed: snapshot.existed,
		content: snapshot.content,
		isDirectory: snapshot.isDirectory,
	};
}

function serializeCheckpoint(checkpoint: IVSCloneThreadRuntimeCheckpoint): ISerializedThreadRuntimeCheckpoint {
	return {
		id: checkpoint.id,
		createdAt: checkpoint.createdAt,
		type: checkpoint.type,
		toolName: checkpoint.toolName,
		snapshots: checkpoint.snapshots.map(serializeSnapshot),
	};
}

function serializeCatalogEntry(catalog: IVSCloneThreadRuntimeCatalogEntry): ISerializedThreadRuntimeCatalogEntry {
	return { ...catalog };
}

function deriveFallbackCatalogEntry(
	threadId: string,
	messages: readonly IVSCloneThreadRuntimeMessage[],
	lastUpdatedAt: number,
	streamState: VSCloneThreadStreamState,
	isRunning: boolean,
): IVSCloneThreadRuntimeCatalogEntry {
	const conversationMessages = messages.filter((message): message is Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'user' | 'assistant' }> =>
		message.role === 'user' || message.role === 'assistant',
	);
	const firstConversationMessage = conversationMessages[0];
	const latestConversationMessage = [...conversationMessages].reverse()[0];
	const latestToolMessage = [...messages].reverse().find((message): message is Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'tool' }> => message.role === 'tool');
	const titleSource = firstConversationMessage?.content?.trim() || latestConversationMessage?.content?.trim() || threadId;
	const previewSource = latestConversationMessage?.content?.trim()
		|| latestToolMessage?.output?.trim()
		|| titleSource;
	const status: VSCloneThreadRuntimeCatalogStatus = isRunning || streamState.kind !== 'idle'
		? 'active'
		: latestToolMessage?.type === 'tool_error' || latestToolMessage?.type === 'rejected'
			? 'failed'
			: messages.length > 0
				? 'completed'
				: 'active';

	return {
		threadId,
		title: titleSource.slice(0, 120),
		createdAt: firstConversationMessage?.createdAt ?? messages[0]?.createdAt ?? lastUpdatedAt,
		updatedAt: lastUpdatedAt,
		status,
		archived: false,
		turnCount: conversationMessages.filter(message => message.role === 'user').length,
		lastTurnPreview: previewSource.slice(0, 280),
	};
}

function deserializeCatalogEntry(
	catalog: ISerializedThreadRuntimeCatalogEntry | undefined,
	threadId: string,
	messages: readonly IVSCloneThreadRuntimeMessage[],
	lastUpdatedAt: number,
	streamState: VSCloneThreadStreamState,
	isRunning: boolean,
): IVSCloneThreadRuntimeCatalogEntry {
	if (!catalog) {
		return deriveFallbackCatalogEntry(threadId, messages, lastUpdatedAt, streamState, isRunning);
	}
	return { ...catalog };
}

function deserializeCheckpoint(checkpoint: ISerializedThreadRuntimeCheckpoint): IVSCloneThreadRuntimeCheckpoint {
	return {
		id: checkpoint.id,
		createdAt: checkpoint.createdAt,
		type: checkpoint.type,
		toolName: checkpoint.toolName,
		snapshots: checkpoint.snapshots.map(deserializeSnapshot),
	};
}

function serializeEditFileChange(change: IVSCloneThreadRuntimeEditFileChange): ISerializedThreadRuntimeEditFileChange {
	return {
		uri: change.uri.toString(),
		displayPath: change.displayPath,
		addedLines: change.addedLines,
		removedLines: change.removedLines,
		action: change.action,
		originalContent: change.originalContent,
	};
}

function deserializeEditFileChange(change: ISerializedThreadRuntimeEditFileChange): IVSCloneThreadRuntimeEditFileChange {
	return {
		uri: URI.parse(change.uri),
		displayPath: change.displayPath,
		addedLines: change.addedLines,
		removedLines: change.removedLines,
		action: change.action,
		originalContent: change.originalContent,
	};
}

function serializeEditApplyResult(result: IVSCloneThreadRuntimeEditApplyResult): ISerializedThreadRuntimeEditApplyResult {
	return {
		attemptedEdits: result.attemptedEdits,
		appliedEdits: result.appliedEdits,
		modifiedFiles: result.modifiedFiles.map(resource => resource.toString()),
		failures: [...result.failures],
		fileChanges: result.fileChanges.map(serializeEditFileChange),
	};
}

function deserializeEditApplyResult(result: ISerializedThreadRuntimeEditApplyResult): IVSCloneThreadRuntimeEditApplyResult {
	return {
		attemptedEdits: result.attemptedEdits,
		appliedEdits: result.appliedEdits,
		modifiedFiles: result.modifiedFiles.map(resource => URI.parse(resource)),
		failures: [...result.failures],
		fileChanges: result.fileChanges.map(deserializeEditFileChange),
	};
}

function serializeAssistantEditApplicationState(state: IVSCloneThreadRuntimeAssistantEditApplicationState): ISerializedThreadRuntimeAssistantEditApplicationState {
	switch (state.phase) {
		case 'pending':
		case 'failed':
			return { phase: state.phase };
		case 'partial':
		case 'applied':
		case 'undone':
			return {
				phase: state.phase,
				result: serializeEditApplyResult(state.result),
			};
	}
}

function deserializeAssistantEditApplicationState(state: ISerializedThreadRuntimeAssistantEditApplicationState): IVSCloneThreadRuntimeAssistantEditApplicationState {
	switch (state.phase) {
		case 'pending':
		case 'failed':
			return { phase: state.phase };
		case 'partial':
		case 'applied':
		case 'undone':
			return {
				phase: state.phase,
				result: deserializeEditApplyResult(state.result),
			};
	}
}

function serializeAssistantEditApplication(application: IVSCloneThreadRuntimeAssistantEditApplication): ISerializedThreadRuntimeAssistantEditApplication {
	return {
		messageId: application.messageId,
		state: serializeAssistantEditApplicationState(application.state),
	};
}

function deserializeAssistantEditApplication(application: ISerializedThreadRuntimeAssistantEditApplication): IVSCloneThreadRuntimeAssistantEditApplication {
	return {
		messageId: application.messageId,
		state: deserializeAssistantEditApplicationState(application.state),
	};
}

function serializeConversationMessageMetadata(
	metadata: IVSCloneThreadRuntimeConversationMessageMetadata | undefined,
): ISerializedThreadRuntimeConversationMessageMetadata | undefined {
	return metadata ? { ...metadata } : undefined;
}

function deserializeConversationMessageMetadata(
	metadata: ISerializedThreadRuntimeConversationMessageMetadata | undefined,
): IVSCloneThreadRuntimeConversationMessageMetadata | undefined {
	return metadata ? { ...metadata } : undefined;
}

function serializeMessage(message: IVSCloneThreadRuntimeMessage): ISerializedThreadRuntimeMessage {
	switch (message.role) {
		case 'user':
			return {
				id: message.id,
				role: 'user',
				mode: message.mode,
				metadata: serializeConversationMessageMetadata(message.metadata),
				createdAt: message.createdAt,
				content: message.content,
				imageAttachments: message.imageAttachments ? [...message.imageAttachments] : undefined,
			};
		case 'assistant':
			return {
				id: message.id,
				role: 'assistant',
				mode: message.mode,
				metadata: serializeConversationMessageMetadata(message.metadata),
				createdAt: message.createdAt,
				content: message.content,
			};
		case 'tool':
			return {
				id: message.id,
				role: 'tool',
				createdAt: message.createdAt,
				type: message.type,
				toolName: message.toolName,
				approvalType: message.approvalType,
				params: { ...message.params },
				output: message.output,
				success: message.success,
			};
		case 'checkpoint':
			return {
				id: message.id,
				role: 'checkpoint',
				createdAt: message.createdAt,
				checkpoint: serializeCheckpoint(message.checkpoint),
			};
	}
}

function deserializeMessage(
	message: ISerializedThreadRuntimeMessage,
	defaultConversationMode: VSCloneChatMode = 'act',
): IVSCloneThreadRuntimeMessage {
	switch (message.role) {
		case 'user': {
			const metadata = deserializeConversationMessageMetadata(message.metadata);
			return {
				id: message.id,
				role: 'user',
				mode: (message.mode && isVSCloneChatMode(message.mode) ? message.mode : defaultConversationMode),
				...(metadata ? { metadata } : {}),
				createdAt: message.createdAt,
				content: message.content,
				imageAttachments: message.imageAttachments ? [...message.imageAttachments] : undefined,
			};
		}
		case 'assistant': {
			const metadata = deserializeConversationMessageMetadata(message.metadata);
			return {
				id: message.id,
				role: 'assistant',
				mode: (message.mode && isVSCloneChatMode(message.mode) ? message.mode : defaultConversationMode),
				...(metadata ? { metadata } : {}),
				createdAt: message.createdAt,
				content: message.content,
			};
		}
		case 'tool':
			return {
				id: message.id,
				role: 'tool',
				createdAt: message.createdAt,
				type: message.type,
				toolName: message.toolName,
				approvalType: message.approvalType,
				params: { ...message.params },
				output: message.output,
				success: message.success,
			};
		case 'checkpoint':
			return {
				id: message.id,
				role: 'checkpoint',
				createdAt: message.createdAt,
				checkpoint: deserializeCheckpoint(message.checkpoint),
			};
	}
}

export class VSCloneThreadRuntimeSerializer {
	serializeIndex(workspaceId: string, updatedAt: number, threadIds: readonly string[], deletedThreadIds: readonly string[] = []): string {
		const payload: IVSCloneThreadRuntimeIndexPayload = {
			schemaVersion: 1,
			workspaceId,
			updatedAt,
			threadIds: [...new Set(threadIds)].sort((left, right) => left.localeCompare(right)),
			deletedThreadIds: [...new Set(deletedThreadIds)].sort((left, right) => left.localeCompare(right)),
		};
		return JSON.stringify(payload, undefined, 2);
	}

	deserializeIndex(raw: string): IVSCloneThreadRuntimeIndexPayload {
		const parsed = JSON.parse(raw) as unknown;
		if (!isObject(parsed)) {
			throw new Error('Runtime index is not an object');
		}
		if (
			parsed.schemaVersion !== 1
			|| typeof parsed.workspaceId !== 'string'
			|| typeof parsed.updatedAt !== 'number'
			|| !Array.isArray(parsed.threadIds)
			|| !parsed.threadIds.every(entry => typeof entry === 'string')
			|| (parsed.deletedThreadIds !== undefined && (!Array.isArray(parsed.deletedThreadIds) || !parsed.deletedThreadIds.every(entry => typeof entry === 'string')))
		) {
			throw new Error('Runtime index is malformed');
		}

		return {
			schemaVersion: 1,
			workspaceId: parsed.workspaceId,
			updatedAt: parsed.updatedAt,
			threadIds: [...new Set(parsed.threadIds)].sort((left, right) => left.localeCompare(right)),
			deletedThreadIds: [...new Set(parsed.deletedThreadIds ?? [])].sort((left, right) => left.localeCompare(right)),
		};
	}

	serializeState(state: IVSCloneThreadRuntimeState): string {
		const payload: IVSCloneThreadRuntimeThreadPayload = {
			schemaVersion: 1,
			state: {
				threadId: state.threadId,
				catalog: serializeCatalogEntry(state.catalog),
				turnId: state.turnId,
				mode: state.mode,
				streamState: state.streamState,
				messages: state.messages.map(serializeMessage),
				assistantEditApplications: state.assistantEditApplications?.map(serializeAssistantEditApplication),
				checkpoints: state.checkpoints.map(serializeCheckpoint),
				currentCheckpointId: state.currentCheckpointId,
				branchHeadMessageId: state.branchHeadMessageId,
				pausedApproval: state.pausedApproval ? {
					requestedAt: state.pausedApproval.requestedAt,
					toolName: state.pausedApproval.toolName,
					params: { ...state.pausedApproval.params },
					approvalType: state.pausedApproval.approvalType,
					snapshots: state.pausedApproval.snapshots.map(serializeSnapshot),
					run: { ...state.pausedApproval.run },
				} : undefined,
				isRunning: state.isRunning,
				lastUpdatedAt: state.lastUpdatedAt,
			},
		};
		return JSON.stringify(payload, undefined, 2);
	}

	deserializeState(raw: string): IVSCloneThreadRuntimeState {
		const parsed = JSON.parse(raw) as unknown;
		if (!isObject(parsed) || parsed.schemaVersion !== 1 || !isObject(parsed.state)) {
			throw new Error('Runtime thread payload is malformed');
		}

		const state = parsed.state;
		if (
			typeof state.threadId !== 'string'
			|| (state.catalog !== undefined && !isCatalogEntry(state.catalog))
			|| (state.turnId !== undefined && typeof state.turnId !== 'string')
			|| (state.mode !== undefined && !isVSCloneChatMode(state.mode))
			|| !isStreamState(state.streamState)
			|| !Array.isArray(state.messages)
			|| !state.messages.every(isMessage)
			|| (state.assistantEditApplications !== undefined && (!Array.isArray(state.assistantEditApplications) || !state.assistantEditApplications.every(isAssistantEditApplication)))
			|| !Array.isArray(state.checkpoints)
			|| !state.checkpoints.every(isCheckpoint)
			|| (state.currentCheckpointId !== undefined && typeof state.currentCheckpointId !== 'string')
			|| (state.branchHeadMessageId !== undefined && typeof state.branchHeadMessageId !== 'string')
			|| typeof state.isRunning !== 'boolean'
			|| typeof state.lastUpdatedAt !== 'number'
		) {
			throw new Error('Runtime thread state is malformed');
		}

		if (state.pausedApproval !== undefined) {
			if (
				!isObject(state.pausedApproval)
				|| typeof state.pausedApproval.requestedAt !== 'number'
				|| typeof state.pausedApproval.toolName !== 'string'
				|| !isRecordOfStrings(state.pausedApproval.params)
				|| (state.pausedApproval.approvalType !== undefined && typeof state.pausedApproval.approvalType !== 'string')
				|| !Array.isArray(state.pausedApproval.snapshots)
				|| !state.pausedApproval.snapshots.every(isSnapshot)
				|| !isObject(state.pausedApproval.run)
				|| typeof state.pausedApproval.run.turnId !== 'string'
				|| typeof state.pausedApproval.run.sequence !== 'number'
				|| typeof state.pausedApproval.run.sessionResource !== 'string'
				|| !isVSCloneChatMode(state.pausedApproval.run.mode)
				|| typeof state.pausedApproval.run.vendor !== 'string'
				|| typeof state.pausedApproval.run.modelId !== 'string'
				|| typeof state.pausedApproval.run.modelIdentifier !== 'string'
				|| (state.pausedApproval.run.reasoningEffort !== undefined && typeof state.pausedApproval.run.reasoningEffort !== 'string')
				|| (state.pausedApproval.run.systemMessage !== undefined && typeof state.pausedApproval.run.systemMessage !== 'string')
				|| (state.pausedApproval.run.imageAttachments !== undefined && (!Array.isArray(state.pausedApproval.run.imageAttachments) || !state.pausedApproval.run.imageAttachments.every(isImageAttachment)))
			) {
				throw new Error('Runtime paused approval is malformed');
			}
		}

		const messages = state.messages.map(message => deserializeMessage(message, state.mode ?? 'act'));
		return {
			threadId: state.threadId,
			catalog: deserializeCatalogEntry(
				state.catalog,
				state.threadId,
				messages,
				state.lastUpdatedAt,
				state.streamState,
				state.isRunning,
			),
			turnId: state.turnId,
			mode: state.mode,
			streamState: state.streamState,
			// Older payloads may not have per-message mode or import metadata yet. Deserialization
			// accepts that shape so the runtime service can apply the restore-time compatibility
			// policy that keeps legacy threads safe instead of rejecting them outright.
			messages,
			assistantEditApplications: state.assistantEditApplications?.map(deserializeAssistantEditApplication),
			checkpoints: state.checkpoints.map(deserializeCheckpoint),
			currentCheckpointId: state.currentCheckpointId,
			branchHeadMessageId: state.branchHeadMessageId,
			pausedApproval: state.pausedApproval ? {
				requestedAt: state.pausedApproval.requestedAt,
				toolName: state.pausedApproval.toolName,
				params: { ...state.pausedApproval.params },
				approvalType: state.pausedApproval.approvalType as VSCloneToolApprovalType | undefined,
				snapshots: state.pausedApproval.snapshots.map(deserializeSnapshot),
				run: {
					turnId: state.pausedApproval.run.turnId,
					sequence: state.pausedApproval.run.sequence,
					sessionResource: state.pausedApproval.run.sessionResource,
					mode: state.pausedApproval.run.mode,
					vendor: state.pausedApproval.run.vendor as VSCloneModelVendor,
					modelId: state.pausedApproval.run.modelId,
					modelIdentifier: state.pausedApproval.run.modelIdentifier,
					reasoningEffort: state.pausedApproval.run.reasoningEffort as VSCloneReasoningEffortLevel | undefined,
					systemMessage: state.pausedApproval.run.systemMessage,
					imageAttachments: state.pausedApproval.run.imageAttachments ? [...state.pausedApproval.run.imageAttachments] : undefined,
				},
			} : undefined,
			isRunning: state.isRunning,
			lastUpdatedAt: state.lastUpdatedAt,
		};
	}
}
