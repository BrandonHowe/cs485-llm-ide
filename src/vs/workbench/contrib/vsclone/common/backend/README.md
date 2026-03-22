# VSClone Backend

This document covers the backend-facing parts of the VSClone feature under `src/vs/workbench/contrib/vsclone/common/backend/`. It is written for SREs and new maintainers who need to install, start, stop, inspect, and reset the feature without reverse-engineering the Electron and storage layers first.

## Scope

VSClone does **not** run as a standalone microservice. Its backend is embedded in the desktop `Code - OSS` main process and is made up of:

- `common/backend/`: durable state ownership for chat history, model selection, and plan mode.
- `electron-main/`: outbound provider transports for chat and inline completion, plus the OAuth loopback callback server.
- `browser/`: renderer-side clients that fetch OAuth headers, call the main-process IPC channels, and update persisted state.

The IPC channels are registered only from the Electron entrypoint in `src/vs/code/electron-main/app.ts`. The web/server entrypoint in `src/server-main.ts` does not register them, so `./scripts/code-server.sh` is **not** a valid way to exercise this backend.

## Runtime Topology

At runtime the VSClone backend is three main-process handlers:

- `vsclone-chat-api`: streams chat requests to the selected provider over HTTPS Server-Sent Events (SSE).
- `vsclone-completion`: streams inline completion requests to the selected provider over HTTPS SSE.
- `vsclone-oauth`: starts a localhost callback listener, opens the browser, and proxies OAuth token exchanges through the main process.

Persistent state is owned by `VSCloneUnifiedChatBackendService`, which writes into VS Code's built-in storage service instead of creating a custom VSClone database.

## External Dependencies

The table below lists every external library, framework, technology, or service that this backend depends on directly or indirectly at runtime.

| Dependency | Required | Why VSClone needs it | Operational notes |
| --- | --- | --- | --- |
| Electron desktop main process | Yes | The backend channels are registered only in the Electron main process. | Starting the web/server variant does not start VSClone backend services. |
| VS Code dependency injection, IPC, and storage framework | Yes | VSClone is wired as a workbench contribution and communicates over VS Code IPC channels. | This is host-provided infrastructure, not a standalone VSClone package. |
| Node/Electron networking primitives (`fetch`, `AbortController`, `ReadableStream`, `TextDecoder`, `http`, `https`) | Yes | Used for SSE streaming, request cancellation, OAuth callback listening, and token exchange. | If outbound HTTPS or localhost bind is blocked, the feature degrades or fails. |
| SQLite via VS Code storage (`@vscode/sqlite3` under the host storage service) | Yes | Chat history, provider preferences, and encrypted secret blobs are stored in VS Code's `state.vscdb` files. | VSClone does not manage its own schema beyond key names in `ItemTable`. |
| VS Code secret storage + encryption service | Yes for durable OAuth tokens | Stores OAuth token sets under encrypted `secret://...` keys. | If encryption is unavailable, secrets fall back to in-memory storage and disappear on restart. |
| OAuth 2.0 Authorization Code + PKCE | Yes for provider sign-in | All three providers authenticate through OAuth rather than raw API keys. | Loopback capture is preferred; manual paste fallback exists if localhost callback capture fails. |
| OpenAI OAuth + Codex Responses API | Optional provider | Used when the active vendor is `openai`. | Requires a user account with access to the backing OpenAI/ChatGPT service. |
| Anthropic OAuth + Messages API | Optional provider | Used when the active vendor is `anthropic`. | Requires a user account with access to the backing Anthropic service. |
| Google OAuth + Gemini REST streaming endpoint | Optional provider | Used when the active vendor is `google`. | Requires local client credentials in `.env.vsclone` and a user account with access. |
| Local environment file loading (`.env.vsclone`, `.env.local`, `.env`) | Optional | `scripts/code.sh` loads these before startup so repo-local credentials can be injected. | Only Google currently depends on repo-local OAuth client credentials. |

### Provider Endpoints

VSClone currently supports OpenAI, Google, and Anthropic logins. It currently talks to these external services:

- OpenAI
  - OAuth authorize: `https://auth.openai.com/oauth/authorize`
  - OAuth token: `https://auth.openai.com/oauth/token`
  - Inference: `https://chatgpt.com/backend-api/codex/responses`
- Anthropic
  - OAuth authorize: `https://claude.ai/oauth/authorize`
  - OAuth token: `https://platform.claude.com/v1/oauth/token`
  - Inference: `https://api.anthropic.com/v1/messages`
- Google
  - OAuth authorize: `https://accounts.google.com/o/oauth2/v2/auth`
  - OAuth token: `https://oauth2.googleapis.com/token`
  - Inference: `https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse`

**Note: Due to Anthropic login being against their Terms of Service, only select Haiku models are offered. Use the Claude integration at your own risk.**

### OAuth and Loopback Ports

The sign-in flow prefers localhost callback capture:

- OpenAI prefers port `1455`.
- Anthropic requests an ephemeral port.
- Google requests an ephemeral port.
- If loopback capture fails, manual fallback uses the provider redirect template and a fallback port of `33418` only for the pasted-URL flow.

## Databases and Persistent Storage

VSClone does **not** create or use Postgres, MySQL, MariaDB, SQL Server, Oracle, MongoDB, Redis, or any other external database service.

It uses the host application's SQLite-backed storage files:

| Storage file | Created by | Used for | Notes |
| --- | --- | --- | --- |
| `.../User/globalStorage/state.vscdb` | VS Code application/profile storage | OAuth secrets, provider preferences, and chat history when `vsclone.chatHistory.persistScope=profile` | On source builds started with `./scripts/code.sh`, the product data folder gets a `-dev` suffix. |
| `.../User/workspaceStorage/<workspace-id>/state.vscdb` | VS Code workspace storage | Chat history when `vsclone.chatHistory.persistScope=workspace` | This is the default persistence mode. |

Each `state.vscdb` is a key/value SQLite database with one table:

```sql
CREATE TABLE IF NOT EXISTS ItemTable (
  key TEXT UNIQUE ON CONFLICT REPLACE,
  value BLOB
);
```

### VSClone Keys

VSClone stores data under these keys:

- `vsclone.chatHistory.v2.index`
  - Chat thread index plus plan mode, location selections, and recent-model state.
- `vsclone.chatHistory.v2.thread.<url-encoded-thread-id>`
  - Per-thread turns and per-thread model selection.
- `vsclone.providerPreferences.v1`
  - Provider enable/disable flags.
- `secret://vsclone.oauth.tokens.openai`
- `secret://vsclone.oauth.tokens.anthropic`
- `secret://vsclone.oauth.tokens.google`

### Read/Write Matrix

| Data | Reads | Writes |
| --- | --- | --- |
| Workspace-scoped chat history | Workspace `state.vscdb` | Workspace `state.vscdb` |
| Profile-scoped chat history | Global/profile `state.vscdb` | Global/profile `state.vscdb` |
| Provider preferences | Global/profile `state.vscdb` | Global/profile `state.vscdb` |
| OAuth token sets | Global/profile `state.vscdb` via secret storage | Global/profile `state.vscdb` via secret storage |

## Installation

From the repository root:

```bash
npm install
```

Optional Google setup:

```bash
cp .env.vsclone.example .env.vsclone
```

Then populate:

- `VSCODE_VSCLONE_GOOGLE_CLIENT_ID`
- `VSCODE_VSCLONE_GOOGLE_CLIENT_SECRET`
- `VSCODE_VSCLONE_GOOGLE_QUOTA_PROJECT` (optional override for the billed/quota project)

### Prerequisites

- Outbound HTTPS access to the provider endpoints listed above.
- Ability to bind a localhost callback port for OAuth loopback sign-in.
- Desktop Electron runtime. The backend is not exposed from `code-server` or the test-web server.

## Starting the Backend

Start the full desktop development shell from the repository root:

```bash
./scripts/code.sh
```

What this does:

- Loads `.env.vsclone`, `.env.local`, and `.env` if present.
- Runs the normal VS Code prelaunch build unless `VSCODE_SKIP_PRELAUNCH=1` is set.
- Starts the Electron desktop app.
- Registers the VSClone IPC backend channels automatically as part of main-process startup.

If you have already built once and want faster restarts:

```bash
VSCODE_SKIP_PRELAUNCH=1 ./scripts/code.sh
```

### What Not to Use

Do **not** use this to validate VSClone backend behavior:

```bash
./scripts/code-server.sh
```

That entrypoint starts `src/server-main.ts`, which does not register `vsclone-chat-api`, `vsclone-completion`, or `vsclone-oauth`.

## Stopping the Backend

There is no separate VSClone daemon to stop.

- If you launched from a terminal, press `Ctrl-C`.
- If you launched the desktop app normally, close the app window.

Stopping the Electron process also stops:

- in-flight chat/completion streams,
- the OAuth loopback callback listener,
- further reads and writes to VSClone storage.

## Resetting Services and Data

Use the lightest reset that solves the problem.

### Soft Reset

Use the product UI when you only need a feature reset:

- Sign out of the provider from the VSClone UI.
- Clear VSClone chat history from the VSClone history UI/commands.
- Reset provider preferences from the provider configuration UI.

This preserves unrelated `Code - OSS` state.

### Hard Reset: Surgical SQLite Cleanup

1. Stop the desktop app.
2. Identify the correct storage files.
3. Delete only the VSClone keys from `ItemTable`.

Typical source-build locations on macOS/Linux are under `~/.vscode-oss-dev/User/...`, but the exact user-data root is platform-specific. Work from the actual user-data directory for the instance you launched.

Inspect keys before deleting:

```bash
sqlite3 "$PROFILE_DB" "SELECT key FROM ItemTable WHERE key LIKE 'vsclone.%' OR key LIKE 'secret://vsclone.oauth.tokens.%';"
sqlite3 "$WORKSPACE_DB" "SELECT key FROM ItemTable WHERE key LIKE 'vsclone.%';"
```

Delete workspace-scoped VSClone history:

```bash
sqlite3 "$WORKSPACE_DB" "
DELETE FROM ItemTable
WHERE key = 'vsclone.chatHistory.v2.index'
   OR key LIKE 'vsclone.chatHistory.v2.thread.%';
VACUUM;
"
```

Delete profile-scoped VSClone history, provider preferences, and OAuth secrets:

```bash
sqlite3 "$PROFILE_DB" "
DELETE FROM ItemTable
WHERE key = 'vsclone.chatHistory.v2.index'
   OR key LIKE 'vsclone.chatHistory.v2.thread.%'
   OR key = 'vsclone.providerPreferences.v1'
   OR key LIKE 'secret://vsclone.oauth.tokens.%';
VACUUM;
"
```

### Hard Reset: Full File Removal

Only use this when a full product-state reset is acceptable.

- Deleting `.../User/globalStorage/state.vscdb` resets unrelated application/profile storage in addition to VSClone.
- Deleting `.../User/workspaceStorage/<workspace-id>/state.vscdb` resets unrelated workspace storage for that workspace.
- Deleting the whole `workspaceStorage/<workspace-id>/` directory also removes the workspace metadata file.

If you remove a `state.vscdb`, also remove the matching backup file if present:

- `state.vscdb.backup`

## Operational Notes

- Default chat-history persistence is `workspace`, not `profile`. If a user reports "missing history" after opening a different workspace, this is expected behavior.
- Secret redaction is enabled by default for persisted chat history, but it is intentionally simple pattern matching and should not be treated as a full DLP control.
- If the OS encryption service is unavailable, OAuth tokens are stored only in memory and will be gone after restart.
- OpenAI and Anthropic use repository-defined OAuth client IDs. Google relies on local environment variables loaded by `scripts/code.sh`.
