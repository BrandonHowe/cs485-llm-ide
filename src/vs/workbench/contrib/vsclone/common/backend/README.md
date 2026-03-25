# VSClone Backend

This document describes the backend that is actually implemented under `src/vs/workbench/contrib/vsclone`. VSClone does not run as a separate web service. Its "backend" is a mix of workbench services in the renderer process and Electron main-process IPC channels for provider fetches and OAuth loopback handling.

## Scope

The backend-facing code is split across three areas:

- `common/backend/`
  - Canonical durable chat snapshot ownership.
  - History reduction, serialization, retention, plan-mode persistence, and model-selection persistence.
- `common/`
  - Shared types plus model catalog, provider preferences, prompt assembly, OAuth config, completion prompt shaping, and provider wire adapters.
- `browser/` and `electron-main/`
  - Renderer-side orchestration and Electron main-process transports for chat, inline completion, and OAuth.

The Electron channels are registered in [`src/vs/code/electron-main/app.ts`](../../../../../code/electron-main/app.ts). The server/web entrypoint does not register them, so `./scripts/code-server.sh` is not a valid way to exercise the full VSClone backend.

## Runtime Topology

### Renderer/workbench services

- `VSCloneUnifiedChatBackendService`
  - Single durable owner of chat history, persisted thread plan mode, persisted per-thread selections, per-location defaults, and recent models.
- `VSCloneChatHistoryService`
  - Thin facade kept for UI compatibility; delegates to the unified backend.
- `VSCloneThreadModelSelectionService`
  - Selection policy, fallback handling, recents, and catalog reconciliation.
- `VSClonePlanModeService`
  - Thread/composer Plan vs Act state plus runtime tool gating.
- `VSCloneModelCatalogService`
  - Explicit provider/model catalog derived from source code constants plus auth readiness.
- `VSCloneProviderPreferencesService`
  - Profile-scoped provider enablement flags.
- `VSCloneChatSessionService`
  - Chat submission entrypoint. Resolves selection, snapshots mode, gathers context, and starts the agent loop.
- `VSCloneAgentLoopService`
  - Multi-step tool-using execution loop with transcript sanitization and trace emission.
- `VSCloneToolExecutionService`
  - Executes `read_file`, `list_directory`, `search_files`, `edit_file`, `create_file`, and `attempt_completion`.
- `VSCloneChatApiService`
  - Renderer-side auth lookup and IPC bridge for chat streaming.
- `VSCloneCompletionBackendService`
  - Inline completion backend policy, timeout, retry, and post-processing.
- `VSCloneCompletionApiService`
  - Renderer-side auth lookup and IPC bridge for inline completion.
- `VSCloneOAuthService`
  - OAuth token restore, refresh, sign-in, sign-out, and provider-specific header construction.

### Electron main-process channels

- `vsclone-chat-api`
  - Implemented by `VSCloneChatApiChannel`.
  - Executes chat streaming requests with `fetch`, parses SSE, and emits delta/complete/error/aborted events.
- `vsclone-completion`
  - Implemented by `VSCloneCompletionChannel`.
  - Executes inline completion requests with `fetch`, parses SSE, and returns one accumulated completion string.
- `vsclone-oauth`
  - Implemented by `VSCloneOAuthLoopbackChannel`.
  - Starts/stops the localhost callback listener, waits for the OAuth redirect, proxies token exchange POSTs, and opens the external browser.

## Durable Storage Contract

VSClone does not create its own SQL schema or database file. It stores JSON payloads through VS Code storage services. On desktop builds those services are backed by `state.vscdb`, but the VSClone code only relies on storage keys and JSON payloads.

### Chat history snapshot

`VSCloneChatHistoryStore` persists schema version `2` under these keys:

- `vsclone.chatHistory.v2.index`
  - Summary payload containing:
    - sorted thread summaries
    - `modeByThread`
    - `selectedByLocation`
    - `recentModelIdentifiers`
- `vsclone.chatHistory.v2.thread.<url-encoded-thread-id>`
  - Per-thread payload containing:
    - ordered turns
    - optional per-thread selection

The persistence scope is controlled by `vsclone.chatHistory.persistScope`:

- `workspace`
  - Stores keys in workspace storage.
- `profile`
  - Stores keys in profile/global storage.

### Provider preferences

- Key: `vsclone.providerPreferences.v1`
- Scope: profile storage
- Purpose: persist provider enabled flags.

### OAuth tokens

- Keys in code: `vsclone.oauth.tokens.openai`, `vsclone.oauth.tokens.anthropic`, `vsclone.oauth.tokens.google`
- Actual stored keys in the host secret storage: `secret://vsclone.oauth.tokens.<vendor>`
- Scope: application secret storage
- Purpose: JSON-serialized token sets used by `VSCloneOAuthService`

If VS Code's encryption service is unavailable, secret storage falls back to in-memory storage and those tokens do not survive restart.

### What is stored

The durable chat snapshot currently includes:

- thread summaries (`threadId`, `sessionResource`, `title`, `activeModelIdentifier`, timestamps, archived/status metadata, preview text)
- ordered turns (`promptText`, `responseMarkdown`, `responsePlainText`, execution mode, provider/model metadata, timestamps, status, error code)
- per-thread plan mode
- per-thread model selection
- per-location model defaults
- recent model identifiers

The store can redact simple secret-like substrings before persisting thread titles, previews, prompts, and responses when `vsclone.chatHistory.redactSecrets=true`.

## Provider Endpoints

The source-of-truth provider configuration lives in [`src/vs/workbench/contrib/vsclone/common/vscloneOAuthTypes.ts`](../vscloneOAuthTypes.ts).

- OpenAI
  - OAuth authorize: `https://auth.openai.com/oauth/authorize`
  - OAuth token: `https://auth.openai.com/oauth/token`
  - Chat API: `https://chatgpt.com/backend-api/codex/responses`
- Anthropic
  - OAuth authorize: `https://claude.ai/oauth/authorize`
  - OAuth token: `https://platform.claude.com/v1/oauth/token`
  - Chat API: `https://api.anthropic.com/v1/messages`
- Google
  - OAuth authorize: `https://accounts.google.com/o/oauth2/v2/auth`
  - OAuth token: `https://oauth2.googleapis.com/token`
  - Completion/chat base API: `https://generativelanguage.googleapis.com/v1beta/models`

Google sign-in depends on local environment variables. On macOS/Linux, `./scripts/code.sh` loads them from repo-local env files when present. On Windows, export them before launching `.\scripts\code.bat`:

- `VSCODE_VSCLONE_GOOGLE_CLIENT_ID`
- `VSCODE_VSCLONE_GOOGLE_CLIENT_SECRET`
- `VSCODE_VSCLONE_GOOGLE_QUOTA_PROJECT` (optional override)

## Starting and Stopping

Start the desktop development shell from the repository root.

macOS/Linux:

```bash
./scripts/code.sh
```

This loads `.env.vsclone`, `.env.local`, and `.env` when present, runs the normal prelaunch build unless `VSCODE_SKIP_PRELAUNCH=1`, and starts the Electron app that registers the VSClone IPC channels.

Windows PowerShell:

```powershell
$env:VSCODE_VSCLONE_GOOGLE_CLIENT_ID="your-client-id"
$env:VSCODE_VSCLONE_GOOGLE_CLIENT_SECRET="your-client-secret"
$env:VSCODE_VSCLONE_GOOGLE_QUOTA_PROJECT="your-quota-project" # optional
.\scripts\code.bat
```

`.\scripts\code.bat` starts the same Electron app, but unlike `./scripts/code.sh` it does not currently load `.env.vsclone`, `.env.local`, or `.env` automatically. Set the required environment variables in the launching shell first.

For faster restarts after an initial build:

```bash
VSCODE_SKIP_PRELAUNCH=1 ./scripts/code.sh
```

Windows PowerShell equivalent:

```powershell
$env:VSCODE_SKIP_PRELAUNCH="1"
.\scripts\code.bat
```

Do not use `./scripts/code-server.sh` to validate this backend. That entrypoint does not register `vsclone-chat-api`, `vsclone-completion`, or `vsclone-oauth`.

To stop VSClone, stop the Electron app. There is no separate VSClone daemon.

## Inspecting and Resetting State

### Soft reset

Prefer the UI first:

- sign out from the provider actions
- clear VSClone chat history from the VSClone commands/UI
- reset model selection by re-selecting a model or clearing the thread state

### Inspect stored keys

Typical desktop source builds store VS Code data under a user-data root such as `~/.vscode-oss-dev`, but use the actual profile/workspace path for your running instance.

Inspect VSClone keys in storage:

```bash
sqlite3 "$PROFILE_DB" "SELECT key FROM ItemTable WHERE key LIKE 'vsclone.%' OR key LIKE 'secret://vsclone.oauth.tokens.%';"
sqlite3 "$WORKSPACE_DB" "SELECT key FROM ItemTable WHERE key LIKE 'vsclone.%';"
```

### Targeted cleanup

Delete workspace-scoped chat history:

```bash
sqlite3 "$WORKSPACE_DB" "
DELETE FROM ItemTable
WHERE key = 'vsclone.chatHistory.v2.index'
   OR key LIKE 'vsclone.chatHistory.v2.thread.%';
VACUUM;
"
```

Delete profile-scoped chat history and provider preferences:

```bash
sqlite3 "$PROFILE_DB" "
DELETE FROM ItemTable
WHERE key = 'vsclone.chatHistory.v2.index'
   OR key LIKE 'vsclone.chatHistory.v2.thread.%'
   OR key = 'vsclone.providerPreferences.v1';
VACUUM;
"
```

Delete VSClone OAuth secrets:

```bash
sqlite3 "$PROFILE_DB" "
DELETE FROM ItemTable
WHERE key LIKE 'secret://vsclone.oauth.tokens.%';
VACUUM;
"
```

### Full reset

Only use a full file removal when resetting unrelated VS Code state is acceptable too:

- deleting `.../User/globalStorage/state.vscdb` resets unrelated profile/application storage
- deleting `.../User/workspaceStorage/<workspace-id>/state.vscdb` resets unrelated workspace storage
- deleting `state.vscdb.backup` alongside it avoids resurrecting stale keys from the backup file

## Operational Notes

- The canonical history reduction path is `IVSCloneChatTurnUpdate -> reduceThreadTurns(...) -> VSCloneChatHistoryModel -> VSCloneChatHistoryStore`.
- Stream updates are persisted with a `300ms` delayer; terminal events persist immediately.
- Retention is enforced both on initialize and after each turn update using `vsclone.chatHistory.maxThreads` and `vsclone.chatHistory.retentionDays`.
- `VSCloneChatHistorySerializer` accepts only schema version `2`. A malformed index aborts initialization; malformed individual thread payloads are skipped with a warning.
- The current chat send path always routes through `VSCloneAgentLoopService`, which means tool parsing and plan-mode enforcement are active for all VSClone composer sends.
