/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VSCloneThreadRuntimeSerializer } from '../../common/backend/vscloneThreadRuntimeSerializer.js';
import { IVSCloneThreadRuntimeState } from '../../common/vscloneThreadRuntimeTypes.js';

suite('VSCloneThreadRuntimeSerializer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function createState(): IVSCloneThreadRuntimeState {
		return {
			threadId: 'thread-1',
			catalog: {
				threadId: 'thread-1',
				sessionResource: 'vsclone://api/thread-1',
				title: 'Edit src/app.ts and then run the checks.',
				activeModelIdentifier: 'openai/gpt-5.3-codex',
				createdAt: 1,
				updatedAt: 11,
				status: 'archived',
				archived: true,
				turnCount: 2,
				lastTurnPreview: 'I started applying the follow-up edits.',
				importedFromHistory: true,
			},
			turnId: 'turn-1',
			mode: 'act',
			streamState: { kind: 'awaiting_user', toolName: 'edit_file', approvalType: 'edits' },
			messages: [
				{
					id: 'msg-user',
					role: 'user',
					mode: 'plan',
					metadata: { importedFromHistory: true },
					createdAt: 1,
					content: 'Edit src/app.ts and then run the checks.',
					imageAttachments: [{ mimeType: 'image/png', base64Data: 'ZmFrZQ==' }],
				},
				{
					id: 'msg-assistant',
					role: 'assistant',
					mode: 'plan',
					metadata: { importedFromHistory: true },
					createdAt: 2,
					content: 'I am preparing the edit.',
				},
				{
					id: 'msg-tool-request',
					role: 'tool',
					createdAt: 3,
					type: 'tool_request',
					toolName: 'edit_file',
					approvalType: 'edits',
					params: { path: 'src/app.ts', changes: 'ignored' },
					output: undefined,
					success: undefined,
				},
				{
					id: 'msg-tool-running',
					role: 'tool',
					createdAt: 4,
					type: 'running_now',
					toolName: 'edit_file',
					approvalType: 'edits',
					params: { path: 'src/app.ts', changes: 'ignored' },
					output: undefined,
					success: undefined,
				},
				{
					id: 'msg-tool-success',
					role: 'tool',
					createdAt: 5,
					type: 'success',
					toolName: 'edit_file',
					approvalType: 'edits',
					params: { path: 'src/app.ts', changes: 'ignored' },
					output: 'Applied edit.',
					success: true,
				},
				{
					id: 'msg-checkpoint',
					role: 'checkpoint',
					createdAt: 6,
					checkpoint: {
						id: 'checkpoint-1',
						createdAt: 6,
						type: 'tool_edit',
						toolName: 'edit_file',
						snapshots: [{
							uri: URI.file('/workspace/src/app.ts'),
							existed: true,
							content: 'before',
							isDirectory: false,
						}, {
							uri: URI.file('/workspace/src/generated'),
							existed: true,
							content: undefined,
							isDirectory: true,
						}],
					},
				},
				{
					id: 'msg-tool-error',
					role: 'tool',
					createdAt: 7,
					type: 'tool_error',
					toolName: 'run_command',
					approvalType: 'terminal',
					params: { command: 'npm test', cwd: '/workspace' },
					output: 'command failed',
					success: false,
				},
				{
					id: 'msg-tool-rejected',
					role: 'tool',
					createdAt: 8,
					type: 'rejected',
					toolName: 'run_persistent_command',
					approvalType: 'terminal',
					params: { persistent_terminal_id: '1', command: 'rm -rf /workspace' },
					output: 'Denied by reviewer.',
					success: false,
				},
				{
					id: 'msg-assistant-applied',
					role: 'assistant',
					mode: 'act',
					metadata: {
						editSuggestion: {
							kind: 'search_replace',
							applyMode: 'auto',
						},
					},
					createdAt: 8.25,
					content: 'File: src/app.ts\n<<<<<<< SEARCH\nbefore\n=======\nafter\n>>>>>>> REPLACE',
				},
				{
					id: 'msg-assistant-pending',
					role: 'assistant',
					mode: 'act',
					metadata: {
						editSuggestion: {
							kind: 'search_replace',
							applyMode: 'auto',
						},
					},
					createdAt: 8.5,
					content: 'I started applying the follow-up edits.',
				},
				{
					id: 'msg-tool-request-paused',
					role: 'tool',
					createdAt: 9,
					type: 'tool_request',
					toolName: 'edit_file',
					approvalType: 'edits',
					params: { path: 'src/paused.ts', changes: 'ignored' },
					output: undefined,
					success: undefined,
				},
			],
			assistantEditApplications: [{
				messageId: 'msg-assistant-applied',
				state: {
					phase: 'applied',
					result: {
						attemptedEdits: 2,
						appliedEdits: 1,
						modifiedFiles: [URI.file('/workspace/src/app.ts')],
						failures: ['src/missing.ts did not match'],
						fileChanges: [{
							uri: URI.file('/workspace/src/app.ts'),
							displayPath: 'src/app.ts',
							addedLines: 4,
							removedLines: 2,
							action: 'modify',
							originalContent: 'before',
						}],
					},
				},
			}, {
				messageId: 'msg-assistant-pending',
				state: {
					phase: 'pending',
				},
			}],
			checkpoints: [{
				id: 'checkpoint-1',
				createdAt: 6,
				type: 'tool_edit',
				toolName: 'edit_file',
				snapshots: [{
					uri: URI.file('/workspace/src/app.ts'),
					existed: true,
					content: 'before',
					isDirectory: false,
				}, {
					uri: URI.file('/workspace/src/generated'),
					existed: true,
					content: undefined,
					isDirectory: true,
				}],
			}],
			currentCheckpointId: 'checkpoint-1',
			branchHeadMessageId: 'msg-tool-request-paused',
			pausedApproval: {
				requestedAt: 10,
				toolName: 'edit_file',
				params: { path: 'src/paused.ts', changes: 'ignored' },
				approvalType: 'edits',
				snapshots: [{
					uri: URI.file('/workspace/src/paused.ts'),
					existed: true,
					content: 'before',
					isDirectory: false,
				}],
				run: {
					turnId: 'turn-1',
					sequence: 1,
					sessionResource: 'vsclone://api/thread-1',
					mode: 'act',
					vendor: 'openai',
					modelId: 'gpt-5.3-codex',
					modelIdentifier: 'openai/gpt-5.3-codex',
					reasoningEffort: 'high',
					systemMessage: 'SYSTEM',
					imageAttachments: [{ mimeType: 'image/png', base64Data: 'ZmFrZQ==' }],
				},
			},
			isRunning: false,
			lastUpdatedAt: 11,
		};
	}

	function toComparableConversationMetadata(metadata: IVSCloneThreadRuntimeState['messages'][number] extends infer T
		? T extends { metadata?: infer M }
		? M
		: never
		: never) {
		if (!metadata) {
			return undefined;
		}
		return {
			...(metadata.importedFromHistory !== undefined ? { importedFromHistory: metadata.importedFromHistory } : {}),
			...(metadata.editSuggestion ? { editSuggestion: { ...metadata.editSuggestion } } : {}),
		};
	}

	function toComparableState(state: IVSCloneThreadRuntimeState) {
		// URI identity changes across serialization boundaries, so the comparison normalizes every
		// persisted snapshot URI to a string before asserting on the full runtime graph.
		return {
			...state,
			messages: state.messages.map(message => {
				if (message.role === 'checkpoint') {
					return {
						...message,
						checkpoint: {
							...message.checkpoint,
							snapshots: message.checkpoint.snapshots.map(snapshot => ({
								...snapshot,
								uri: snapshot.uri.toString(),
							})),
						},
					};
				}
				if (message.role === 'user' || message.role === 'assistant') {
					return {
						...message,
						...(message.metadata ? { metadata: toComparableConversationMetadata(message.metadata) } : {}),
					};
				}
				return message;
			}),
			assistantEditApplications: state.assistantEditApplications?.map(application => ({
				...application,
				state: application.state.phase === 'partial' || application.state.phase === 'applied' || application.state.phase === 'undone'
					? {
						...application.state,
						result: {
							...application.state.result,
							modifiedFiles: application.state.result.modifiedFiles.map(resource => resource.toString()),
							fileChanges: application.state.result.fileChanges.map(change => ({
								...change,
								uri: change.uri.toString(),
							})),
						},
					}
					: application.state,
			})),
			checkpoints: state.checkpoints.map(checkpoint => ({
				...checkpoint,
				snapshots: checkpoint.snapshots.map(snapshot => ({
					...snapshot,
					uri: snapshot.uri.toString(),
				})),
			})),
			pausedApproval: state.pausedApproval
				? {
					...state.pausedApproval,
					snapshots: state.pausedApproval.snapshots.map(snapshot => ({
						...snapshot,
						uri: snapshot.uri.toString(),
					})),
				}
				: undefined,
		};
	}

	function toComparableEditApplicationState(state: NonNullable<IVSCloneThreadRuntimeState['assistantEditApplications']>[number]['state']) {
		return state.phase === 'partial' || state.phase === 'applied' || state.phase === 'undone'
			? {
				...state,
				result: {
					...state.result,
					modifiedFiles: state.result.modifiedFiles.map(resource => resource.toString()),
					fileChanges: state.result.fileChanges.map(change => ({
						...change,
						uri: change.uri.toString(),
					})),
				},
			}
			: state;
	}

	test('round-trips runtime messages, checkpoint messages, paused approvals, branch head, and checkpoint cursor', () => {
		const serializer = new VSCloneThreadRuntimeSerializer();
		const original = createState();
		const raw = serializer.serializeState(original);
		const restored = serializer.deserializeState(raw);

		assert.deepStrictEqual(toComparableState(restored), toComparableState(original));
		assert.ok(URI.isUri(restored.checkpoints[0].snapshots[0].uri), 'checkpoint snapshots must round-trip as URI instances');
		assert.ok(URI.isUri(restored.pausedApproval?.snapshots[0].uri), 'paused approval snapshots must round-trip as URI instances');
		assert.ok(URI.isUri(restored.assistantEditApplications?.[0]?.state.phase === 'applied' ? restored.assistantEditApplications[0].state.result.modifiedFiles[0] : undefined), 'edit-apply modified files must restore as URI instances');
		assert.ok(URI.isUri(restored.assistantEditApplications?.[0]?.state.phase === 'applied' ? restored.assistantEditApplications[0].state.result.fileChanges[0].uri : undefined), 'edit-apply file changes must restore as URI instances');

		const checkpointMessage = restored.messages.find(message => message.role === 'checkpoint');
		assert.ok(checkpointMessage && URI.isUri(checkpointMessage.checkpoint.snapshots[0].uri), 'checkpoint messages must restore checkpoint snapshot URIs as URI instances');
	});

	test('round-trips per-message execution mode for user and assistant messages', () => {
		const serializer = new VSCloneThreadRuntimeSerializer();
		const restored = serializer.deserializeState(serializer.serializeState(createState()));
		const firstUserMessage = restored.messages.find(message => message.role === 'user' && message.content === 'Edit src/app.ts and then run the checks.');
		const firstAssistantMessage = restored.messages.find(message => message.role === 'assistant' && message.content === 'I am preparing the edit.');
		const secondAssistantMessage = restored.messages.find(message => message.role === 'assistant' && message.content === 'I started applying the follow-up edits.');

		assert.ok(firstUserMessage && firstUserMessage.role === 'user');
		assert.ok(firstAssistantMessage && firstAssistantMessage.role === 'assistant');
		assert.ok(secondAssistantMessage && secondAssistantMessage.role === 'assistant');
		if (!firstUserMessage || firstUserMessage.role !== 'user' || !firstAssistantMessage || firstAssistantMessage.role !== 'assistant' || !secondAssistantMessage || secondAssistantMessage.role !== 'assistant') {
			throw new Error('Expected restored runtime messages to preserve user/assistant message ordering.');
		}
		assert.strictEqual(firstUserMessage.mode, 'plan');
		assert.strictEqual(firstAssistantMessage.mode, 'plan');
		assert.strictEqual(secondAssistantMessage.mode, 'act');
	});

	test('round-trips imported-from-history metadata for user and assistant messages', () => {
		const serializer = new VSCloneThreadRuntimeSerializer();
		const restored = serializer.deserializeState(serializer.serializeState(createState()));
		const importedUserMessage = restored.messages.find(message => message.role === 'user' && message.content === 'Edit src/app.ts and then run the checks.');
		const importedAssistantMessage = restored.messages.find(message => message.role === 'assistant' && message.content === 'I am preparing the edit.');
		const liveAssistantMessage = restored.messages.find(message => message.role === 'assistant' && message.content === 'I started applying the follow-up edits.');

		assert.ok(importedUserMessage && importedUserMessage.role === 'user');
		assert.ok(importedAssistantMessage && importedAssistantMessage.role === 'assistant');
		assert.ok(liveAssistantMessage && liveAssistantMessage.role === 'assistant');
		if (!importedUserMessage || importedUserMessage.role !== 'user' || !importedAssistantMessage || importedAssistantMessage.role !== 'assistant' || !liveAssistantMessage || liveAssistantMessage.role !== 'assistant') {
			throw new Error('Expected restored runtime messages to preserve user/assistant import metadata.');
		}
		assert.strictEqual(importedUserMessage.metadata?.importedFromHistory, true);
		assert.strictEqual(importedAssistantMessage.metadata?.importedFromHistory, true);
		assert.strictEqual(liveAssistantMessage.metadata?.importedFromHistory, undefined);
		assert.deepStrictEqual(liveAssistantMessage.metadata?.editSuggestion, { kind: 'search_replace', applyMode: 'auto' });
	});

	test('round-trips assistant edit suggestion metadata for live and imported assistant messages', () => {
		const serializer = new VSCloneThreadRuntimeSerializer();
		const original = createState();
		const raw = serializer.serializeState({
			...original,
			messages: original.messages.map(message => {
				if (message.role !== 'assistant') {
					return message;
				}
				if (message.id === 'msg-assistant') {
					return {
						...message,
						metadata: {
							...(message.metadata ?? {}),
							editSuggestion: {
								kind: 'search_replace' as const,
								applyMode: 'manual' as const,
							},
						},
					};
				}
				if (message.id === 'msg-assistant-pending') {
					return {
						...message,
						metadata: {
							editSuggestion: {
								kind: 'search_replace' as const,
								applyMode: 'auto' as const,
							},
						},
					};
				}
				return message;
			}),
		});
		const restored = serializer.deserializeState(raw);
		const importedAssistantMessage = restored.messages.find(message => message.role === 'assistant' && message.id === 'msg-assistant');
		const liveAssistantMessage = restored.messages.find(message => message.role === 'assistant' && message.id === 'msg-assistant-pending');

		assert.ok(importedAssistantMessage && importedAssistantMessage.role === 'assistant');
		assert.ok(liveAssistantMessage && liveAssistantMessage.role === 'assistant');
		if (!importedAssistantMessage || importedAssistantMessage.role !== 'assistant' || !liveAssistantMessage || liveAssistantMessage.role !== 'assistant') {
			throw new Error('Expected restored runtime messages to preserve assistant edit suggestion metadata.');
		}
		assert.deepStrictEqual(importedAssistantMessage.metadata?.editSuggestion, { kind: 'search_replace', applyMode: 'manual' });
		assert.deepStrictEqual(liveAssistantMessage.metadata?.editSuggestion, { kind: 'search_replace', applyMode: 'auto' });
	});

	test('round-trips partial assistant edit-apply results without flattening them to full success', () => {
		const serializer = new VSCloneThreadRuntimeSerializer();
		const original = createState();
		const partialResult = {
			attemptedEdits: 3,
			appliedEdits: 1,
			modifiedFiles: [URI.file('/workspace/src/app.ts')],
			failures: ['src/other.ts did not match', 'src/missing.ts was not found'],
			fileChanges: [{
				uri: URI.file('/workspace/src/app.ts'),
				displayPath: 'src/app.ts',
				addedLines: 2,
				removedLines: 1,
				action: 'modify' as const,
				originalContent: 'before',
			}],
		};
		const raw = serializer.serializeState({
			...original,
			assistantEditApplications: [{
				messageId: 'msg-assistant-applied',
				state: {
					phase: 'partial',
					result: partialResult,
				},
			}],
		});
		const restored = serializer.deserializeState(raw);

		assert.deepStrictEqual(
			toComparableEditApplicationState(restored.assistantEditApplications?.[0]?.state ?? { phase: 'failed' }),
			toComparableEditApplicationState({ phase: 'partial', result: partialResult }),
		);
		assert.strictEqual(restored.assistantEditApplications?.[0]?.state.phase, 'partial');
	});

	test('deserializes older payloads without import metadata so runtime restore can apply the compatibility fallback', () => {
		const serializer = new VSCloneThreadRuntimeSerializer();
		const raw = JSON.stringify({
			schemaVersion: 1,
			state: {
				threadId: 'thread-legacy',
				mode: 'act',
				streamState: { kind: 'idle' },
				messages: [{
					id: 'legacy-user',
					role: 'user',
					mode: 'act',
					createdAt: 1,
					content: 'Prompt',
				}, {
					id: 'legacy-assistant',
					role: 'assistant',
					mode: 'act',
					createdAt: 2,
					content: 'File: src/app.ts\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE',
				}],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 3,
			},
		});

		const restored = serializer.deserializeState(raw);
		const restoredConversationMessages = restored.messages.filter((message): message is Extract<IVSCloneThreadRuntimeState['messages'][number], { role: 'user' | 'assistant' }> =>
			message.role === 'user' || message.role === 'assistant',
		);

		assert.strictEqual(restoredConversationMessages.length, 2);
		assert.strictEqual(restoredConversationMessages[0]?.metadata, undefined);
		assert.strictEqual(restoredConversationMessages[1]?.metadata, undefined);
	});

	test('deserializes older payloads without a runtime catalog by deriving safe fallback thread metadata', () => {
		const serializer = new VSCloneThreadRuntimeSerializer();
		const raw = JSON.stringify({
			schemaVersion: 1,
			state: {
				threadId: 'thread-legacy-catalog',
				mode: 'act',
				streamState: { kind: 'idle' },
				messages: [{
					id: 'legacy-user',
					role: 'user',
					mode: 'act',
					createdAt: 10,
					content: 'Legacy prompt text',
				}, {
					id: 'legacy-assistant',
					role: 'assistant',
					mode: 'act',
					createdAt: 20,
					content: 'Legacy assistant response',
				}],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 30,
			},
		});

		const restored = serializer.deserializeState(raw);

		// Older payloads still need a usable runtime catalog so thread listing and lifecycle
		// actions can operate after migration even before the thread is rewritten. The original
		// session resource is unknown in this payload shape, so restore must keep that field unset
		// instead of inventing a synthetic value that later looks authoritative.
		assert.deepStrictEqual(restored.catalog, {
			threadId: 'thread-legacy-catalog',
			title: 'Legacy prompt text',
			createdAt: 10,
			updatedAt: 30,
			status: 'completed',
			archived: false,
			turnCount: 1,
			lastTurnPreview: 'Legacy assistant response',
		});
	});

	test('deserializes checkpoint messages into runtime checkpoints', () => {
		const serializer = new VSCloneThreadRuntimeSerializer();
		const raw = JSON.stringify({
			schemaVersion: 1,
			state: {
				threadId: 'thread-1',
				streamState: { kind: 'idle' },
				messages: [{
					id: 'msg-checkpoint',
					role: 'checkpoint',
					createdAt: 6,
					checkpoint: {
						id: 'checkpoint-1',
						createdAt: 6,
						type: 'tool_edit',
						toolName: 'edit_file',
						snapshots: [{
							uri: URI.file('/workspace/src/app.ts').toString(),
							existed: true,
							content: 'before',
							isDirectory: false,
						}],
					},
				}],
				checkpoints: [],
				isRunning: false,
				lastUpdatedAt: 7,
			},
		});

		const restored = serializer.deserializeState(raw);
		const checkpointMessage = restored.messages[0];

		assert.ok(checkpointMessage && checkpointMessage.role === 'checkpoint');
		if (!checkpointMessage || checkpointMessage.role !== 'checkpoint') {
			throw new Error('Expected the runtime message to deserialize as a checkpoint message.');
		}
		assert.ok(URI.isUri(checkpointMessage.checkpoint.snapshots[0]?.uri));
		assert.strictEqual(checkpointMessage.checkpoint.snapshots[0]?.uri.toString(), URI.file('/workspace/src/app.ts').toString());
	});

	test('round-trips thread index payloads', () => {
		const serializer = new VSCloneThreadRuntimeSerializer();
		const raw = serializer.serializeIndex('workspace-id', 10, ['thread-2', 'thread-1', 'thread-2'], ['thread-3', 'thread-3']);
		const restored = serializer.deserializeIndex(raw);

		assert.deepStrictEqual(restored, {
			schemaVersion: 1,
			workspaceId: 'workspace-id',
			updatedAt: 10,
			threadIds: ['thread-1', 'thread-2'],
			deletedThreadIds: ['thread-3'],
		});
	});

	test('rejects malformed state payloads', () => {
		const serializer = new VSCloneThreadRuntimeSerializer();

		assert.throws(
			() => serializer.deserializeState('{"schemaVersion":1,"state":{"threadId":"thread-1","streamState":{"kind":"idle"},"messages":[{"id":"checkpoint","role":"checkpoint","createdAt":1,"checkpoint":{"id":"checkpoint-1","createdAt":1,"type":"tool_edit","toolName":"edit_file","snapshots":[{"uri":42,"existed":true,"content":"before","isDirectory":false}]}}],"checkpoints":[],"isRunning":false,"lastUpdatedAt":5}}'),
			/Runtime thread state is malformed/,
		);
		assert.throws(
			() => serializer.deserializeState('{"schemaVersion":1,"state":{"threadId":"thread-1","streamState":{"kind":"idle"},"messages":[{"id":"user-1","role":"user","mode":"act","metadata":{"importedFromHistory":"yes"},"createdAt":1,"content":"prompt"}],"checkpoints":[],"isRunning":false,"lastUpdatedAt":5}}'),
			/Runtime thread state is malformed/,
		);
		assert.throws(
			() => serializer.deserializeState('{"schemaVersion":1,"state":{"threadId":"thread-1","streamState":{"kind":"idle"},"messages":[{"id":"assistant-1","role":"assistant","mode":"act","metadata":{"editSuggestion":{"kind":"search_replace","applyMode":"sometimes"}},"createdAt":1,"content":"prompt"}],"checkpoints":[],"isRunning":false,"lastUpdatedAt":5}}'),
			/Runtime thread state is malformed/,
		);
		assert.throws(
			() => serializer.deserializeState('{"schemaVersion":1,"state":{"threadId":"thread-1","streamState":{"kind":"idle"},"messages":[],"assistantEditApplications":[{"messageId":"assistant-1","state":{"phase":"applied","result":{"attemptedEdits":1,"appliedEdits":1,"modifiedFiles":["file:///workspace/src/app.ts"],"failures":[],"fileChanges":[{"uri":7,"displayPath":"src/app.ts","addedLines":1,"removedLines":0,"action":"modify"}]}}}],"checkpoints":[],"isRunning":false,"lastUpdatedAt":5}}'),
			/Runtime thread state is malformed/,
		);
		assert.throws(
			() => serializer.deserializeState('{"schemaVersion":1,"state":{"threadId":"thread-1","streamState":{"kind":"idle"},"messages":[],"assistantEditApplications":[{"messageId":"assistant-1","state":{"phase":"partial","result":{"attemptedEdits":1,"appliedEdits":1,"modifiedFiles":["file:///workspace/src/app.ts"],"failures":[],"fileChanges":[{"uri":7,"displayPath":"src/app.ts","addedLines":1,"removedLines":0,"action":"modify"}]}}}],"checkpoints":[],"isRunning":false,"lastUpdatedAt":5}}'),
			/Runtime thread state is malformed/,
		);
		assert.throws(
			() => serializer.deserializeState('{"schemaVersion":1,"state":{"threadId":"thread-1","streamState":{"kind":"awaiting_user","toolName":"edit_file","approvalType":"edits"},"messages":[],"checkpoints":[],"branchHeadMessageId":7,"isRunning":false,"lastUpdatedAt":5}}'),
			/Runtime thread state is malformed/,
		);
		assert.throws(
			() => serializer.deserializeState('{"schemaVersion":1,"state":{"threadId":"thread-1","streamState":{"kind":"idle"},"messages":[],"checkpoints":[],"isRunning":false,"lastUpdatedAt":5,"pausedApproval":{"requestedAt":3,"toolName":"edit_file","params":{"path":"src/app.ts","changes":1},"snapshots":[],"run":{"turnId":"turn-1","sequence":1,"sessionResource":"vsclone://api/thread-1","mode":"act","vendor":"openai","modelId":"gpt-5.3-codex","modelIdentifier":"openai/gpt-5.3-codex"}}}}'),
			/Runtime paused approval is malformed/,
		);
	});

	test('rejects malformed index payloads', () => {
		const serializer = new VSCloneThreadRuntimeSerializer();

		assert.throws(
			() => serializer.deserializeIndex('{"schemaVersion":1,"workspaceId":"workspace-id","updatedAt":10,"threadIds":[1]}'),
			/Runtime index is malformed/,
		);
		assert.throws(
			() => serializer.deserializeIndex('{"schemaVersion":2,"workspaceId":"workspace-id","updatedAt":10,"threadIds":["thread-1"]}'),
			/Runtime index is malformed/,
		);
	});
});
