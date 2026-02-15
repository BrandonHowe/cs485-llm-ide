## Header

- **Spec ID:** `BC-CHAT-HISTORY-001`
- **Feature:** VSClone Chat History Side Panel
- **User Story:** As a developer, I want to maintain a chat history with the LLM in a side panel so that I can reference previous prompts and responses while I work.
- **Scope:** Add a VSClone-owned history panel that captures prompt/response turns from existing chat sessions, persists them, and supports search/reference actions.
- **Non-goals:** Replacing VS Code’s core chat execution pipeline, multi-user sync, or introducing a new LLM provider protocol.
- **Target code area:** `src/vs/workbench/contrib/vsclone`
- **Proposed folders:**
  - `src/vs/workbench/contrib/vsclone/common`
  - `src/vs/workbench/contrib/vsclone/browser`
  - `src/vs/workbench/contrib/vsclone/electron-main` (reserved for future desktop-only enhancements; not required for MVP)
- **Required integration touchpoints:**
  - `src/vs/workbench/workbench.common.main.ts` (register contribution import)
  - Existing chat services/events from `src/vs/workbench/contrib/chat/common/*` and `src/vs/workbench/contrib/chat/browser/*`

## Architecture Diagram

![Architecture Diagram](diagrams/userstory1/architecture-diagram-1.svg)

- **Runtime placement:**
  - **Client:** side panel UI, bridge, in-memory model, persistence orchestration.
  - **Server process:** existing chat session execution and model event source.
  - **Cloud:** existing LLM backend (no new endpoint introduced).
  - **Local:** workspace/profile-scoped history files.

## Class Diagram

![Class Diagram](diagrams/userstory1/class-diagram-1.svg)

## List of Classes

- `VSCloneChatHistoryContribution` (`browser/vscloneChatHistory.contribution.ts`): registers view container/view, service singleton, and startup lifecycle hooks.
- `VSCloneChatSessionBridge` (`browser/vscloneChatSessionBridge.ts`): subscribes to `IChatService`/`IChatModel` events and converts them into normalized turn updates.
- `VSCloneChatHistoryViewPane` (`browser/vscloneChatHistoryViewPane.ts`): side-panel UI (filter/search + tree + details area) with live updates.
- `VSCloneChatHistoryTreeDataSource` (`browser/vscloneChatHistoryTree.ts`): adapts history model into tree nodes (thread groups, threads, turns).
- `VSCloneChatHistoryCommandRegistrar` (`browser/vscloneChatHistoryActions.ts`): registers command handlers, context menu actions, and keybindings.
- `VSCloneChatHistoryService` (`common/vscloneChatHistoryService.ts`): central orchestration service for loading, querying, mutating, and persistence scheduling.
- `VSCloneChatHistoryModel` (`common/vscloneChatHistoryModel.ts`): in-memory store and query engine for thread/turn state.
- `VSCloneChatHistoryStore` (`common/vscloneChatHistoryStore.ts`): file-backed persistence, retention pruning, and recovery.
- `VSCloneChatHistorySerializer` (`common/vscloneChatHistorySerializer.ts`): JSON serialization/deserialization with deterministic ordering.
- `VSCloneChatHistoryMigrationService` (`common/vscloneChatHistoryMigrationService.ts`): schema upgrades and backward compatibility logic.

**Consistency check:** the 10 classes above match the 10 classes in the class diagram.

## State Diagrams

![State Diagram 1](diagrams/userstory1/state-diagrams-1.svg)

![State Diagram 2](diagrams/userstory1/state-diagrams-2.svg)

## Flow Chart

![Flow Chart](diagrams/userstory1/flow-chart-1.svg)

## Development Risks and Failures

| Risk | Failure Mode | Mitigation |
|---|---|---|
| Event ordering drift from chat internals | Turns attached to wrong thread or wrong status | Normalize by `sessionResource + requestId`; ignore stale sequence numbers |
| Streaming write pressure | UI jank and excessive disk writes | Keep streaming in memory; persist on terminal states + debounced checkpoints |
| Corrupt history files | Panel fails to load | Atomic write (`.tmp` then replace), schema validation, backup + recovery path |
| Large history volume | Slow startup/filtering | Lazy-load thread bodies, cap defaults (`maxThreads`, `maxTurnsPerThread`), prune old data |
| Multi-window same workspace | Last write wins and index inconsistency | Timestamp-based conflict resolution and periodic full re-read before write |
| API changes in upstream chat contrib | Bridge breaks after merge/rebase | Isolate bridge adapter, cover with unit tests against mocked `IChatModel` events |
| Markdown safety | XSS-like rendering concerns | Reuse existing sanitized markdown renderer pipeline and allowed tags list |

## Technology Stack

- Language/runtime: TypeScript in VS Code workbench architecture.
- UI: `ViewPane`/`FilterViewPane`, tree/list widgets, existing markdown rendering infra.
- State/events: `Emitter`, `Event`, and existing observable patterns.
- Persistence: `IFileService`, `IStorageService`, workspace/profile storage paths.
- Integration: existing `IChatService`, `IChatModel`, `IChatWidgetService`, `IClipboardService`.
- Testing: workbench unit tests in `src/vs/workbench/contrib/vsclone/test/browser` and persistence tests in `.../test/common`.
- Telemetry/logging: existing workbench telemetry/log services with content-redacted events only.

## APIs

- Existing consumed APIs:
  - `IChatService.onDidCreateModel`
  - `IChatService.getSession(...)`
  - `IChatModel.onDidChange` (`addRequest`, `changedRequest`, `completedRequest`, `removeRequest`)
  - `IChatWidgetService.revealWidget(...)`, `IChatWidget.setInput(...)`
- New commands:
  - `vsclone.chatHistory.openView`
  - `vsclone.chatHistory.focusFilter`
  - `vsclone.chatHistory.copyPrompt`
  - `vsclone.chatHistory.copyResponse`
  - `vsclone.chatHistory.reusePrompt`
  - `vsclone.chatHistory.openSession`
  - `vsclone.chatHistory.deleteThread`
  - `vsclone.chatHistory.clearAllWorkspace`
- New configuration keys:
  - `vsclone.chatHistory.enabled` (`boolean`, default `true`)
  - `vsclone.chatHistory.maxThreads` (`number`, default `200`)
  - `vsclone.chatHistory.maxTurnsPerThread` (`number`, default `100`)
  - `vsclone.chatHistory.retentionDays` (`number`, default `30`)
  - `vsclone.chatHistory.persistScope` (`"workspace" | "profile"`, default `"workspace"`)
  - `vsclone.chatHistory.redactSecrets` (`boolean`, default `true`)
- No new external cloud endpoint is introduced by this story; existing LLM transport remains unchanged.

## Public Interfaces

```ts
export interface IVSCloneChatHistoryService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<IVSCloneChatHistoryChangeEvent>;
	initialize(): Promise<void>;
	getThreads(query?: IVSCloneChatHistoryQuery): readonly IVSCloneChatHistoryThread[];
	getTurns(threadId: string): readonly IVSCloneChatHistoryTurn[];
	applyTurnUpdate(update: IVSCloneChatTurnUpdate): Promise<void>;
	archiveThread(threadId: string, archived: boolean): Promise<void>;
	deleteThread(threadId: string): Promise<void>;
	clearAll(scope: 'workspace' | 'profile'): Promise<void>;
}

export interface IVSCloneChatHistoryQuery {
	text?: string;
	includeArchived?: boolean;
	fromTimestamp?: number;
	toTimestamp?: number;
	limit?: number;
}

export interface IVSCloneChatHistoryThread {
	threadId: string;
	sessionResource: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	status: 'active' | 'completed' | 'failed' | 'archived';
	archived: boolean;
	turnCount: number;
	lastTurnPreview: string;
}

export interface IVSCloneChatHistoryTurn {
	turnId: string;
	threadId: string;
	sequence: number;
	promptText: string;
	responseMarkdown: string;
	responsePlainText: string;
	startedAt: number;
	completedAt?: number;
	status: 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';
	errorCode?: string;
}

export interface IVSCloneChatTurnUpdate {
	threadId: string;
	turnId: string;
	sequence: number;
	phase: 'prompt' | 'stream' | 'complete' | 'error' | 'cancel';
	promptText?: string;
	responseMarkdownDelta?: string;
	responsePlainTextDelta?: string;
	occurredAt: number;
	errorCode?: string;
}
```

## Data Schemas

- **Storage root:**
  - Workspace scope: `<workspaceStorage>/[workspaceId]/vsclone/chatHistory`
  - Empty window/profile scope: `<profileGlobalStorage>/vsclone/chatHistory`
- **Files:**
  - `history.index.v1.json` (thread metadata)
  - `threads/{threadId}.v1.json` (full turn data per thread)

```json
{
  "schemaVersion": 1,
  "workspaceId": "9f0a...c1",
  "updatedAt": 1765000000000,
  "threads": [
    {
      "threadId": "3f4e...8a",
      "sessionResource": "vscode-local-chat-session://session/abc",
      "title": "Refactor auth middleware",
      "createdAt": 1764999000000,
      "updatedAt": 1765000000000,
      "status": "completed",
      "archived": false,
      "turnCount": 4,
      "lastTurnPreview": "Try extracting JWT validation..."
    }
  ]
}
```

```json
{
  "schemaVersion": 1,
  "threadId": "3f4e...8a",
  "sessionResource": "vscode-local-chat-session://session/abc",
  "turns": [
    {
      "turnId": "t-001",
      "sequence": 1,
      "promptText": "Refactor this auth middleware for readability",
      "responseMarkdown": "Here is a cleaner structure...",
      "responsePlainText": "Here is a cleaner structure...",
      "startedAt": 1764999000123,
      "completedAt": 1764999002450,
      "status": "completed"
    }
  ]
}
```

- **Migration policy:**
  - Always read via `VSCloneChatHistoryMigrationService`.
  - Unsupported major version triggers safe fallback (history disabled for that workspace + non-blocking error notification).
  - Successful migration rewrites v1 files atomically.

## Security and Privacy

- History content remains local to the machine/workspace storage; no prompt/response content is sent to telemetry.
- Telemetry, if any, contains only aggregate counters (history size, load time, migration success/failure).
- Markdown rendering reuses existing sanitized renderer (no raw HTML execution).
- `persistScope` defaults to `workspace` to reduce cross-project leakage.
- `redactSecrets` applies lightweight local redaction before persist for common token patterns.
- User controls:
  - disable feature globally
  - clear workspace history
  - delete single thread
- Residual risk: local filesystem access by other local users is out of scope for this story’s MVP.

## Risks to Completion

- High churn in upstream chat internals may require adapter updates during rebases.
- Accessibility polish (keyboard traversal, screen reader labels) may take longer than expected.
- Search UX expectations may expand from substring to semantic search, increasing scope.
- Web/desktop storage parity edge cases may require additional platform-specific handling.
- Late privacy policy changes (e.g., mandatory encryption-at-rest) could force schema redesign.
