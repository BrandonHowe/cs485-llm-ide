# VSClone Integration Test Specifications

This document contains English-language integration test specifications for the VSClone code pathways that require frontend and backend code to execute together. In this repository, "frontend" means the workbench/browser UI layer and "backend" means the shared VSClone services plus the Electron main-process IPC channels described in [cs485/backend-unified-spec.md](/Users/brandonhowe/Documents/NJIT/vsclone/cs485/backend-unified-spec.md).

Each section lists the functionality that must be tested for one implemented cross-stack pathway, followed by a test table. Every current frontend-to-backend VSClone pathway has at least one integration test in this document.

## `Thread History and Thread Restore`

Primary files:
- `src/vs/workbench/contrib/vsclone/browser/vscloneUnifiedChatViewPane.ts`
- `src/vs/workbench/contrib/vsclone/browser/vscloneChatHistoryRail.ts`
- `src/vs/workbench/contrib/vsclone/common/backend/vscloneChatHistoryService.ts`
- `src/vs/workbench/contrib/vsclone/common/backend/vscloneUnifiedChatBackendService.ts`

Functionality that needs to be tested:
- loading persisted thread summaries and turns into the history rail when the VSClone pane initializes
- restoring the selected thread transcript, model selection, and plan mode from the same backend snapshot
- archiving and unarchiving a thread from the rail while preserving turns and metadata
- deleting an active thread and keeping cancellation, backend deletion, and UI refresh in sync
- clearing all history for the configured scope and returning the pane to a new-chat state

| Pathway | Test Purpose | Test Inputs | Expected Output |
|---|---|---|---|
| Pane initialization -> history backend -> rail restore | Verify the pane restores an existing thread from persisted backend state instead of rebuilding UI state heuristically. | Pre-seed `vsclone.chatHistory.v2.index` and one `vsclone.chatHistory.v2.thread.<id>` payload with thread `t1`, two turns, persisted model `openai/gpt-5.4`, and persisted mode `plan`; then open the VSClone pane and select `t1`. | The rail lists `t1`; the conversation view renders the stored turns in sequence order; the model switcher shows `openai/gpt-5.4`; the plan-mode control shows `Plan`; no extra thread is created. |
| Rail action -> history backend archive mutation -> rail filtering | Verify archive and unarchive actions round-trip through the backend and immediately change the rail projection. | Start with visible active thread `t1`; invoke archive from the rail row menu; switch from the active tab to the all tab; then invoke unarchive for the same row. | After archive, `t1` disappears from the active-only view, remains visible in the all view, and keeps its turns/selection metadata; after unarchive, `t1` returns to the active view with the same transcript and model badge. |
| Active thread delete -> session cancel -> backend delete -> pane refresh | Verify deleting the active thread coordinates frontend cancellation and backend removal. | Open thread `t1`, start a prompt so the thread is busy, then invoke delete on `t1`. | The in-flight session is canceled first, `historyService.deleteThread('t1')` removes the thread from the backend snapshot, the rail no longer shows `t1`, and the pane returns to the empty composer/new-chat state. |
| Clear history action -> backend clear -> empty-state restore | Verify scope-level clearing removes every managed VSClone thread and resets the frontend. | Seed multiple workspace-scoped threads, open the pane, and invoke `clearAll('workspace')`. | All managed workspace history entries are removed from storage, the rail becomes empty, the conversation list is cleared, and the pane shows the new-chat placeholder instead of stale thread data. |

## `Chat Execution and Streaming`

Primary files:
- `src/vs/workbench/contrib/vsclone/browser/vscloneUnifiedChatViewPane.ts`
- `src/vs/workbench/contrib/vsclone/browser/vscloneChatSessionService.ts`
- `src/vs/workbench/contrib/vsclone/browser/vscloneAgentLoopService.ts`
- `src/vs/workbench/contrib/vsclone/browser/vscloneChatApiService.ts`
- `src/vs/workbench/contrib/vsclone/electron-main/vscloneChatApiChannel.ts`

Functionality that needs to be tested:
- submitting a prompt from the composer and creating a new thread when needed
- resolving the selected model and snapshotted plan/act mode before dispatch
- streaming deltas from the Electron main process into the frontend transcript and persisted history
- executing tool calls inside the agent loop and persisting tool results in the same turn
- canceling an in-flight request from the frontend and reflecting the cancel state in both UI and history

| Pathway | Test Purpose | Test Inputs | Expected Output |
|---|---|---|---|
| Composer submit -> session service -> chat IPC -> history stream | Verify a new prompt creates a thread, streams a response, and persists the finished turn. | No active thread; selected chat model `anthropic/claude-sonnet`; mode `act`; composer text `"Explain the current file"`; the chat channel emits two delta events followed by a complete event. | A new thread id is created; the composer enters a busy state during streaming; the transcript updates incrementally from the delta events; the backend stores `prompt`, `stream`, and `complete` turn updates; the rail shows the new thread with the final preview text and active-model metadata. |
| Agent loop -> tool execution -> transcript persistence | Verify a tool-using turn keeps one coherent transcript across model output, tool execution, and final completion. | Existing thread `t1` in `act` mode; prompt asks for information that requires `read_file`; the model emits a `read_file` tool call; the tool executor returns file contents; the model then emits a final assistant answer. | The same turn records the tool call and tool result markers, the frontend renders the tool-result block plus the final assistant message, the thread remains `t1`, and the turn ends with status `completed` in persisted history. |
| Stop button -> cancelThread -> main-process abort | Verify user cancellation aborts the request and leaves the UI/backend in a consistent partial state. | Existing busy thread `t1` with one streamed delta already rendered; the user presses `Stop`; the main-process channel acknowledges the abort. | The request handle is canceled, no further deltas are appended after the abort, the turn is persisted with status `cancelled`, the partially streamed text remains only up to the cancel point, and the composer returns to its idle send state. |

## `Model Selection Persistence`

Primary files:
- `src/vs/workbench/contrib/vsclone/browser/vscloneModelSwitcherWidget.ts`
- `src/vs/workbench/contrib/vsclone/browser/vscloneUnifiedChatViewPane.ts`
- `src/vs/workbench/contrib/vsclone/common/vscloneModelCatalogService.ts`
- `src/vs/workbench/contrib/vsclone/common/backend/vscloneThreadModelSelectionService.ts`
- `src/vs/workbench/contrib/vsclone/common/backend/vscloneUnifiedChatBackendService.ts`

Functionality that needs to be tested:
- populating the model switcher from the shared model catalog and auth readiness state
- persisting a per-thread model selection through the unified backend snapshot
- restoring the saved selection when a thread is reopened
- using the restored selection for the next chat request instead of a UI-only cached value
- reconciling a stale selection against fallback policy when the original model becomes unavailable

| Pathway | Test Purpose | Test Inputs | Expected Output |
|---|---|---|---|
| Model picker -> selection service -> unified backend -> next submit | Verify an explicit user selection is persisted and then used by the next prompt submission. | Open thread `t1`; catalog exposes selectable `openai/gpt-5.4` and `google/gemini-3.1-flash`; choose the Google model with reasoning effort `minimal`; then submit a prompt. | The switcher label updates immediately, the backend stores the Google selection for `t1`, and the next chat request uses `vendor='google'`, the chosen model id, and reasoning effort `minimal` instead of the prior selection. |
| Backend restore -> reopened thread -> switcher state | Verify the selected model is restored from backend state after the pane reloads. | Pre-seed thread `t1` with persisted selection `openai/gpt-5.4`; close and reopen the pane, then reactivate `t1`. | The switcher restores `openai/gpt-5.4` without requiring the user to reselect it, the rail continues to show the same active-model metadata, and the next prompt for `t1` uses that restored selection. |
| Auth/catalog change -> selection reconciliation -> request resolution | Verify a stale stored selection is reconciled before the frontend sends a request. | Persist thread `t1` with an OpenAI model; mark OpenAI as not ready while a Google fallback remains selectable; reopen `t1` and submit a prompt or request an inline completion. | The frontend does not send a request with the stale OpenAI selection; it either resolves to the configured fallback selection or surfaces the need to reselect; any emitted request uses the reconciled backend selection rather than the stale stored identifier. |

## `Plan Mode Persistence and Enforcement`

Primary files:
- `src/vs/workbench/contrib/vsclone/browser/vscloneUnifiedChatViewPane.ts`
- `src/vs/workbench/contrib/vsclone/common/vsclonePlanModeService.ts`
- `src/vs/workbench/contrib/vsclone/common/vsclonePromptAssemblyService.ts`
- `src/vs/workbench/contrib/vsclone/browser/vscloneToolExecutionService.ts`
- `src/vs/workbench/contrib/vsclone/common/backend/vscloneUnifiedChatBackendService.ts`

Functionality that needs to be tested:
- changing the plan/act toggle in the frontend and persisting that mode per thread
- restoring the saved mode when the thread is reopened
- snapshotting the mode at submit time so the turn metadata matches the UI selection
- filtering mutating tools out of the prompt in plan mode
- rejecting edit/create tool execution at runtime when a plan-mode turn still attempts them

| Pathway | Test Purpose | Test Inputs | Expected Output |
|---|---|---|---|
| Plan toggle -> mode service -> unified backend -> submit snapshot | Verify plan mode is persisted and applied to the next submitted turn. | Open thread `t1`, change the mode from `act` to `plan`, reload the pane, and then submit a prompt that asks for a refactor. | The toggle restores as `Plan` after reload, the submitted turn is stored with `executionMode='plan'`, and the prompt assembly step excludes `edit_file` and `create_file` from the tool list offered to the model. |
| Plan-mode turn -> runtime tool gate -> transcript/history | Verify runtime enforcement still blocks mutations if the model emits a disallowed tool call. | Active thread `t1` in plan mode; streamed model output contains an `edit_file` tool call. | No file mutation is applied, the tool execution layer returns a rejection/failure result for the disallowed tool, the transcript shows that rejection, and persisted history records the blocked tool attempt instead of silently performing the edit. |

## `Tab Completion`

Primary files:
- `src/vs/workbench/contrib/vsclone/browser/vscloneAutocompleteService.ts`
- `src/vs/workbench/contrib/vsclone/browser/vscloneCompletionBackendService.ts`
- `src/vs/workbench/contrib/vsclone/browser/vscloneCompletionApiService.ts`
- `src/vs/workbench/contrib/vsclone/electron-main/vscloneCompletionChannel.ts`
- `src/vs/workbench/contrib/vsclone/common/backend/vscloneThreadModelSelectionService.ts`

Functionality that needs to be tested:
- resolving the `editorInline` model through the shared selection backend before a completion request is sent
- sending bounded prefix/suffix context from the editor to the completion backend and main-process channel
- gathering cross-file context only for multi-line completions
- inserting post-processed completion text back into the editor
- canceling superseded requests so stale completions never render
- retrying through the inline fallback chain when the primary provider fails

| Pathway | Test Purpose | Test Inputs | Expected Output |
|---|---|---|---|
| Editor typing -> autocomplete service -> completion IPC -> editor insert | Verify a successful single-line inline completion uses the shared backend selection and inserts the returned text. | Set `selectedByLocation['editorInline']` to a ready model; place the cursor in a line that should trigger single-line prediction; have the completion channel return `value();`. | The autocomplete service sends the request with the resolved `editorInline` vendor/model, the returned text is inserted at the cursor with the expected replace range, a cache entry is created for reuse, and no chat-history turn is created as a side effect. |
| Multi-line context gather -> completion backend -> editor insert | Verify multi-line completions include cross-file context and preserve multi-line formatting on insert. | Cursor is on an indented blank line inside a function body; open editors provide related snippets; the completion channel returns a multi-line block. | The frontend gathers cross-file snippets before dispatch, the completion backend uses multi-line request settings, and the inserted result preserves line breaks and indentation in the active editor. |
| Request supersession -> abort -> stale-result suppression | Verify stale completion results are discarded when a newer keystroke supersedes an older request. | Start completion request `A`, type again before `A` finishes so request `B` starts, then let the channel deliver `A`'s response before `B`'s response. | Request `A` is aborted through the completion channel, `A`'s result is ignored by the frontend, and only request `B`'s completion is shown to the user. |
| Primary provider failure -> fallback retry chain | Verify the completion backend retries through the configured inline fallback chain instead of failing immediately. | `editorInline` resolves to a ready primary model that returns an error; the next fallback model returns valid completion text. | The backend records the primary failure, retries using the next configured fallback selection, and the editor receives the successful fallback completion without requiring a second user keystroke. |

## `OAuth / Auth`

Primary files:
- `src/vs/workbench/contrib/vsclone/browser/vscloneOAuthService.ts`
- `src/vs/workbench/contrib/vsclone/browser/vscloneProviderConfigurationBridge.ts`
- `src/vs/workbench/contrib/vsclone/common/vscloneModelCatalogService.ts`
- `src/vs/workbench/contrib/vsclone/electron-main/vscloneOAuthLoopbackChannel.ts`
- `src/vs/workbench/contrib/vsclone/browser/vscloneChatApiService.ts`
- `src/vs/workbench/contrib/vsclone/browser/vscloneCompletionApiService.ts`

Functionality that needs to be tested:
- launching provider sign-in from the frontend provider-management UI
- completing the PKCE loopback flow through the Electron main process and persisting tokens in secret storage
- refreshing the model catalog and picker readiness after auth-state changes
- signing out and removing provider readiness from model-selection surfaces
- refreshing near-expiry tokens on downstream chat or completion requests
- reusing one refresh promise for concurrent requests against the same provider

| Pathway | Test Purpose | Test Inputs | Expected Output |
|---|---|---|---|
| Manage providers UI -> OAuth service -> loopback IPC -> catalog refresh | Verify a successful sign-in enables provider-backed models across the frontend. | Open the provider-management picker, choose `google` while signed out, have the loopback channel return a valid authorization code/state pair and a successful token exchange response, then refresh the catalog. | Google tokens are stored in secret storage, the frontend auth state becomes `signed_in`, Google models become selectable in the model picker, the provider-management UI changes from `Sign In` to `Sign Out`, and subsequent Google chat/completion requests include auth headers. |
| Sign-out action -> token clearing -> selection/catalog disablement | Verify sign-out removes provider readiness and prevents stale provider use. | Thread `t1` currently uses an OpenAI model; invoke `Sign Out` for OpenAI from the provider-management UI. | The OpenAI secret is deleted, auth state becomes `signed_out`, OpenAI models become unselectable in the picker, and the next chat/completion request for `t1` either resolves to a valid fallback or surfaces a reselection requirement instead of sending with stale credentials. |
| Downstream request -> token refresh -> request resume | Verify near-expiry tokens are refreshed once and then reused by the outgoing request. | A signed-in provider token expires within 60 seconds; trigger a chat request and an inline-completion request close together for the same vendor. | The OAuth service issues one refresh through the main-process token-exchange channel, both callers await the same refresh work, the stored token set is updated, and both outgoing requests use refreshed authorization headers instead of the stale access token. |
