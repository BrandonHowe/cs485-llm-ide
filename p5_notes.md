# P5 Notes

## Step 1: Files to Test

I did not find an explicit user-story document in the repository, so I based these selections on the VSClone-specific behavior described in `README.md`: authenticated AI usage, chat/session handling, workspace tool execution, durable chat state, and desktop OAuth completion.

All four files below represent core product behavior and each contains at least 5 meaningful functions or methods that can support strong unit-test coverage.

### Frontend

1. `src/vs/workbench/contrib/vsclone/browser/vscloneChatSessionService.ts`
   - Core user story: a user sends a prompt, continues a conversation, and routes the request through the selected AI provider/model.
   - Why this file matters:
     - Validates prompt input.
     - Reuses or creates thread/session identifiers.
     - Captures the current plan/act mode at submit time.
     - Binds thread-specific model selection.
     - Gathers prior turns and prompt context.
     - Starts and tracks the agent loop.
     - Injects rejected turns when no valid provider/model is available.

2. `src/vs/workbench/contrib/vsclone/browser/vscloneToolExecutionService.ts`
   - Core user story: the assistant reads, searches, edits, and creates workspace files while respecting plan/act restrictions.
   - Why this file matters:
     - Dispatches supported tool calls.
     - Enforces plan-mode restrictions.
     - Resolves and validates workspace paths.
     - Reads files and lists directories.
     - Runs regex-based file search.
     - Applies search/replace file edits.
     - Creates new files and generates diff previews/results.

### Backend

1. `src/vs/workbench/contrib/vsclone/common/backend/vscloneUnifiedChatBackendService.ts`
   - Core user story: chat threads, turns, selected models, and plan-mode state persist correctly and restore reliably.
   - Why this file matters:
     - Initializes persistent history state.
     - Returns filtered threads and thread turns.
     - Applies turn updates through the state machine.
     - Enforces retention limits.
     - Archives and deletes threads.
     - Clears persisted state by scope.
     - Persists and restores model-selection and plan-mode state.

2. `src/vs/workbench/contrib/vsclone/electron-main/vscloneOAuthLoopbackChannel.ts`
   - Core user story: a desktop OAuth sign-in finishes through a localhost callback and token exchange path.
   - Why this file matters:
     - Starts loopback callback listeners.
     - Waits for OAuth callback completion with timeout behavior.
     - Stops and cleans up sessions.
     - Resolves redirect URI templates.
     - Handles success, missing-parameter, expired-session, and provider-error callback paths.
     - Proxies token exchange requests through the main process.

## Step 2: Test Specification

Private helpers and private methods will be unit-tested either through a deterministic public code path or by casting the class instance to a test-only loose type such as `any`. The goal of this specification is at least one unit test per function plus enough branch coverage to reach roughly 80% coverage in each file.

### Specification: `src/vs/workbench/contrib/vsclone/browser/vscloneChatSessionService.ts`

Functions in this file:

1. `constructor`
2. `createApiSessionResource`
3. `submitPrompt`
4. `cancelThread`
5. `dispose`
6. `submitApiPrompt`
7. `ensureThreadSelectionBinding`
8. `injectRejectedTurn`
9. `getApiVendor`
10. `rejectMissingApiSelection`

| Test ID | Function(s) covered | Purpose / program path | Test inputs | Expected output |
| --- | --- | --- | --- | --- |
| CS-01 | `constructor` | Verify the service can be created with mocked dependencies and starts with no active request handles. | Mock history, model selection, plan mode, log, agent loop, context gathering, and prompt assembly services. | Service instance is created successfully; internal request-handle collection is empty; no dependency method is called during construction. |
| CS-02 | `createApiSessionResource` | Verify session IDs are encoded into deterministic API session URIs. | `sessionId = "abc/123 value"` | Returned string is `vsclone://api/abc%2F123%20value`. |
| CS-03 | `submitPrompt` | Verify blank prompts are rejected before any initialization or side effects. | `promptText = "   "`, default options. | Method returns `undefined`; model selection initialization is not called; plan mode initialization is not called; agent loop is not started. |
| CS-04 | `submitPrompt`, `rejectMissingApiSelection`, `injectRejectedTurn`, `getApiVendor` | Verify the missing-provider path creates a rejected turn and reuses the caller-provided thread/session when they already match. | Non-empty prompt, `threadId = "thread-1"`, `sessionResource = "vsclone://api/existing"`, no model selection, plan mode returns `'act'`. | Method returns `{ threadId: "thread-1", sessionResource: "vsclone://api/existing" }`; plan mode is stored for `thread-1`; history service receives one `prompt` update and one `error` update with `errorCode = "request_rejected"`; agent loop is not started. |
| CS-05 | `submitPrompt`, `submitApiPrompt`, `ensureThreadSelectionBinding`, `getApiVendor` | Verify the normal successful routing path with explicit selection, previous completed/streaming turns, gathered context, and image attachments. | Prompt text, valid OpenAI/Anthropic/Google model selection, history containing prior completed and streaming turns, prompt assembly returning a system message, image attachments array. | Method returns a thread ID and session resource; agent loop is started once with vendor/model IDs, previous conversation messages, reasoning effort, system message, and image attachments; selection is bound to the thread if it was not already stored. |
| CS-06 | `submitApiPrompt` | Verify context-gathering failure does not block request submission. | Same as CS-05, but `gatherContext()` throws. | Agent loop still starts once; `systemMessage` is `undefined`; warning log entry is emitted; returned thread/session is still valid. |
| CS-07 | `ensureThreadSelectionBinding` | Verify an already-bound thread selection is reused without writing a new one. | Existing thread ID with `hasSelectionForThread(threadId) = true` and an existing current selection in the model-selection service. | Method returns the current stored selection; `setSelectionForThread` is not called. |
| CS-08 | `cancelThread` | Verify cancellation only applies to the exact thread prefix and does not over-cancel similar thread IDs. | Active handle map contains `thread-1:api:1`, `thread-10:api:2`, and `other:api:3`; call `cancelThread("thread-1")`. | Only the `thread-1:api:1` handle receives `cancel()` and is removed; similarly prefixed IDs such as `thread-10` remain active. |
| CS-09 | `dispose` | Verify disposing the service cancels every active handle and clears internal state. | Active handle map contains multiple in-flight handles; call `dispose()`. | Every handle receives `cancel()` exactly once; handle map becomes empty; superclass disposal completes without error. |
| CS-10 | `getApiVendor` | Verify unsupported providers are rejected. | A selection object with `vendor = "custom"` or another unsupported value. | Method returns `undefined`. |

### Specification: `src/vs/workbench/contrib/vsclone/browser/vscloneToolExecutionService.ts`

Functions in this file:

1. `constructor`
2. `executeTool`
3. `executeReadFile`
4. `executeListDirectory`
5. `executeSearchFiles`
6. `executeEditFile`
7. `executeCreateFile`
8. `appendDirectoryListing`
9. `resolveWorkspacePath`
10. `readFileContents`
11. `safeResolve`
12. `rangeFromOffsets`
13. `buildEditFileDiffPreview`
14. `buildCreateFileDiffPreview`
15. `invalidPathMessage`
16. `parseSearchReplaceBlocks`
17. `normalizePath`
18. `toBoolean`
19. `summarizeToolParams`
20. `truncateText`
21. `splitLinesForDiff`
22. `toDiffDisplayPath`
23. `countDiffHunkLines`
24. `finalizeDiffPreview`
25. `positionAtOffset`

| Test ID | Function(s) covered | Purpose / program path | Test inputs | Expected output |
| --- | --- | --- | --- | --- |
| TE-01 | `constructor` | Verify the tool execution service can be created with mocked services. | Mock file, workspace, model, editor, bulk edit, search, marker, instantiation, plan mode, and log services. | Service instance is created successfully; no side effects occur during construction. |
| TE-02 | `executeTool` | Verify plan mode blocks write-capable tools before dispatch. | `toolName = "edit_file"`, params with valid-looking fields, `mode = "plan"`, `isToolAllowed()` returns `false`. | Returned result has `success = false` and the localized “not available in plan mode” message; no file or edit service is called. |
| TE-03 | `executeTool` | Verify dispatch for terminal success and unknown-tool failure. | One subcase with `toolName = "attempt_completion"` and `result = "  done  "`; one subcase with `toolName = "does_not_exist"`. | `attempt_completion` returns `{ success: true, output: "done" }`; unknown tool returns `{ success: false, output: "Unknown tool: does_not_exist" }`. |
| TE-04 | `executeTool` | Verify top-level error handling converts thrown exceptions into failed tool results. | Force a dispatched helper, such as `executeReadFile`, to throw `new Error("boom")`. | Returned result has `success = false` and output `"boom"`; error is logged. |
| TE-05 | `resolveWorkspacePath`, `normalizePath`, `invalidPathMessage` | Verify path normalization and workspace validation for relative, absolute, URI, and outside-workspace inputs. | Inputs such as ``"`./src/file.ts`"``, `"/workspace/src/file.ts"`, `"file:///workspace/src/file.ts"`, and `"../outside.ts"`. | Relative, absolute, and file-URI inputs resolve to workspace URIs; outside-workspace input returns `undefined`; invalid-path helper formats `"Invalid path '...'. Paths must resolve inside the current workspace."` |
| TE-06 | `executeReadFile` | Verify the missing-parameter branch. | Params without `path`. | Returned result has `success = false` and output `"Missing required parameter: path"`. |
| TE-07 | `executeReadFile`, `safeResolve` | Verify invalid-path, missing-file, and directory branches. | One subcase where resolved path is outside workspace; one where `fileService.resolve` throws or returns missing; one where resolved stat is a directory. | Invalid path returns the formatted invalid-path message; missing file returns `"File not found: ..."`, and directory input returns `"Path is a directory, not a file: ..."`. |
| TE-08 | `executeReadFile`, `readFileContents`, `truncateText` | Verify successful reads prefer an open editor model and report truncation when content exceeds the budget. | Path to an in-workspace file, an open text model with content longer than `maxReadChars`, and a file service that would otherwise return different content. | Output contains the open-model text rather than the on-disk fallback, fenced code block markers, and a `[truncated N characters]` notice. |
| TE-09 | `executeListDirectory` | Verify missing-path and file-not-directory rejection. | One subcase without `path`; one where resolved stat is a file. | Missing path returns `"Missing required parameter: path"`; file path returns `"Path is a file, not a directory: ..."`. |
| TE-10 | `executeListDirectory` | Verify successful listing emits an explicit empty-directory marker. | Valid in-workspace empty directory, `recursive = false`. | Result is successful and contains `"Directory listing for ..."` followed by `"(empty directory)"`. |
| TE-11 | `appendDirectoryListing`, `toBoolean` | Verify recursive listing sorts directories before files, uses ASCII tree prefixes, and truncates at the configured entry cap. | Directory tree with mixed files/directories and more than `maxDirectoryEntries`; run once with `recursive = "yes"` and once with `recursive = undefined`. | Recursive run includes nested directory entries with `` `-- `` and `|--` prefixes and stops with `state.truncated = true` after the cap; boolean helper interprets `"yes"` as `true` and `undefined` as `false`. |
| TE-12 | `executeSearchFiles` | Verify missing-parameter branches. | Params missing `path`, then params missing `pattern`. | Returns `"Missing required parameter: path"` or `"Missing required parameter: pattern"` respectively. |
| TE-13 | `executeSearchFiles` | Verify the no-match branch. | Valid directory path, regex pattern that matches nothing. | Returns `{ success: true, output: "No matches found for pattern /.../ in ..." }`. |
| TE-14 | `executeSearchFiles` | Verify search result collection, preview normalization, and max-result cancellation. | Valid directory path, regex pattern with more than `maxSearchMatches` matches, mocked search results with multiple `rangeLocations`. | Output begins with `"Found N match(es) in ..."`; each line contains `uri:line:column preview`; search cancels when the cap is reached; output ends with `[limited to 50 matches]`. |
| TE-15 | `executeEditFile` | Verify missing-parameter branches. | Params missing `path`, then params missing `changes`. | Returns `"Missing required parameter: path"` or `"Missing required parameter: changes"`. |
| TE-16 | `executeEditFile`, `parseSearchReplaceBlocks` | Verify malformed change payloads are rejected. | One `changes` string with no SEARCH/REPLACE blocks; one with an empty SEARCH block. | Returns `"No SEARCH/REPLACE blocks found in changes parameter."` for the first case and `"Empty SEARCH blocks are not allowed in edit_file. Use create_file for new files."` for the second case. |
| TE-17 | `executeEditFile` | Verify unmatched SEARCH blocks fail before edits are applied. | Existing file content that does not contain the requested SEARCH text. | Returns `{ success: false, output: "One or more SEARCH blocks did not match ..." }`; bulk edit service is not called. |
| TE-18 | `executeEditFile` | Verify the not-applied workspace edit branch. | Matching SEARCH/REPLACE blocks, but `bulkEditService.apply()` returns `{ isApplied: false }`. | Returns `{ success: false, output: "Workspace edit was not applied." }`; editor is not opened. |
| TE-19 | `executeEditFile`, `rangeFromOffsets`, `positionAtOffset`, `buildEditFileDiffPreview`, `splitLinesForDiff`, `toDiffDisplayPath`, `countDiffHunkLines`, `finalizeDiffPreview` | Verify a successful edit computes ranges in reverse offset order, opens the file, counts diagnostics, and produces a unified diff preview. | Existing file content with two matching SEARCH/REPLACE blocks on different lines; `bulkEditService.apply()` succeeds; marker service returns known diagnostics count. | Output is successful; editor is opened for the file; output includes the diagnostics count and a diff preview with `--- a/...`, `+++ b/...`, and correctly numbered `@@` hunk headers; helper functions return the expected line/column math and diff line counts. |
| TE-20 | `executeCreateFile` | Verify missing-parameter and already-exists branches. | One call without `path`; one without `content`; one where `fileService.exists()` returns `true`. | Returns `"Missing required parameter: path"`, `"Missing required parameter: content"`, or `"File already exists: ..."` respectively. |
| TE-21 | `executeCreateFile`, `buildCreateFileDiffPreview` | Verify successful file creation creates parent folders, writes content, opens the file, and emits a `/dev/null` diff preview. | New in-workspace path with text content and `fileService.exists()` returning `false`. | Folder creation and file write are called once; editor opens the new file; output includes `"Created file ..."` plus a diff beginning with `--- /dev/null` and `+++ b/...`. |
| TE-22 | `readFileContents`, `safeResolve` | Verify file-content fallback behavior and safe resolve failure handling. | One resource with no open model and readable file contents; one resource whose resolve call throws. | `readFileContents()` returns on-disk text when no model is open; `safeResolve()` returns `undefined` instead of throwing when resolution fails. |
| TE-23 | `summarizeToolParams`, `truncateText` | Verify parameter summaries normalize whitespace, truncate long values, and handle empty input. | Empty params object, then a params object with a very long multiline value. | Empty params return `"no params"`; long params return a single-line summary truncated to the documented budget. |
| TE-24 | `splitLinesForDiff`, `toDiffDisplayPath`, `countDiffHunkLines`, `finalizeDiffPreview` | Verify helper behavior for empty values, trailing newlines, Windows path separators, blank paths, and preview truncation. | Empty string, `"a\nb\n"`, `"\\src\\file.ts"`, `"   "`, and a diff text longer than the line/char limits. | Empty split returns `[""]`; trailing newline is removed from the split result; Windows path becomes `src/file.ts`; blank path becomes `unknown-path`; large preview ends with `... [diff truncated]`. |

### Specification: `src/vs/workbench/contrib/vsclone/common/backend/vscloneUnifiedChatBackendService.ts`

Functions in this file:

1. `normalizeScope`
2. `toError`
3. `createEmptySelectionState`
4. `createEmptyPlanModeState`
5. `cloneSelectionState`
6. `clonePlanModeState`
7. `constructor`
8. `enabled` getter
9. `persistScope` getter
10. `maxThreads` getter
11. `maxTurnsPerThread` getter
12. `retentionDays` getter
13. `redactSecrets` getter
14. `initialize`
15. `getThreads`
16. `getTurns`
17. `applyTurnUpdate`
18. `archiveThread`
19. `deleteThread`
20. `clearAll`
21. `getSelectionState`
22. `getPlanModeState`
23. `replaceSelectionState`
24. `replacePlanModeState`
25. `doInitialize`
26. `schedulePersist`
27. `persistNow`

| Test ID | Function(s) covered | Purpose / program path | Test inputs | Expected output |
| --- | --- | --- | --- | --- |
| UB-01 | `normalizeScope` | Verify scope normalization defaults to workspace and preserves profile. | Inputs `"profile"`, `"workspace"`, and `undefined`. | Returns `"profile"` only for the literal profile input; all other inputs return `"workspace"`. |
| UB-02 | `toError` | Verify error normalization for both `Error` and non-`Error` inputs. | One real `Error` instance; one string or number value. | Existing `Error` instance is returned unchanged; non-error value is wrapped in `new Error(String(value))`. |
| UB-03 | `createEmptySelectionState`, `createEmptyPlanModeState` | Verify empty state factories return the expected shape. | No inputs. | Selection state contains empty `selectedByThread`, `selectedByLocation`, and `recentModelIdentifiers`; plan mode state contains empty `modeByThread`. |
| UB-04 | `cloneSelectionState`, `clonePlanModeState` | Verify cloning returns defensive copies and strips embedded `threadId` references from stored selections. | Selection state with populated `selectedByThread`, `selectedByLocation`, and `recentModelIdentifiers`; plan mode state with populated `modeByThread`. | Returned objects are deep-enough clones, arrays/maps are not shared with the source object, and cloned selection entries have `threadId: undefined`. |
| UB-05 | `constructor`, `enabled`, `persistScope`, `maxThreads`, `maxTurnsPerThread`, `retentionDays`, `redactSecrets` | Verify construction plus configuration-derived getter normalization and default/floor behavior. | Mock instantiation service returns a fake store; configuration returns unset values, invalid values such as `0`, and valid custom values. | Store is created once during construction; getters fall back to defaults when unset; numeric getters clamp to at least `1`; scope getter normalizes non-profile inputs to `"workspace"`. |
| UB-06 | `initialize` | Verify initialization short-circuits when history is already initialized, disabled, or globally turned off. | Service marked initialized, or `disabled = true`, or config returns `false` for the enabled setting. | Method returns without calling `doInitialize()`. |
| UB-07 | `initialize` | Verify concurrent initialization requests share one in-flight promise. | Two overlapping `initialize()` calls while `doInitialize()` is still pending. | Both calls resolve from the same underlying promise; `doInitialize()` runs only once; `initializing` is cleared afterward. |
| UB-08 | `doInitialize` | Verify successful initialization loads the snapshot, applies retention, persists if retention deletes threads, marks the service initialized, and emits an initialize event. | Store returns a snapshot with threads and possibly expired threads; model retention returns deleted thread IDs. | Model is initialized with the snapshot; `persistNow()` is called only when retention deleted threads; `initialized = true`; `onDidChange` emits `{ reason: "initialize", scope, threadIds }`. |
| UB-09 | `doInitialize` | Verify initialization failures are surfaced consistently. | Store load throws a non-`Error` value or `Error`. | Error is normalized through `toError()`, logged, user warning is shown, `onDidChange` emits `{ reason: "error" }`, and the promise rejects with the normalized error. |
| UB-10 | `getThreads`, `getTurns` | Verify gated-off behavior and query-limit clamping when active. | Calls before initialization and after successful initialization with `query.limit` greater than configured `maxThreads`. | Before initialization both methods return empty arrays; after initialization `getThreads()` forwards a normalized query whose `limit` is clamped to `maxThreads`, and `getTurns()` returns model turns for the requested thread. |
| UB-11 | `applyTurnUpdate` | Verify gated-off conditions produce no changes. | Apply an update while disabled, not initialized, or globally turned off. | Model, store, and event emitter are not called. |
| UB-12 | `applyTurnUpdate`, `schedulePersist` | Verify the streaming path reduces thread state, applies retention, emits the change event, and schedules delayed persistence instead of persisting immediately. | Initialized service, a `phase = "stream"` update, mocked `reduceThreadTurns()` result, and retention deleting zero or more threads. | Model state is updated; retention is applied; `onDidChange` emits `{ reason: "turnUpdate" }` with the changed thread IDs; `schedulePersist()` is called; `persistNow()` is not called immediately. |
| UB-13 | `applyTurnUpdate`, `persistNow` | Verify non-stream updates persist immediately. | Initialized service, `phase = "complete"` or `phase = "error"` update. | Model state is updated and `persistNow()` is invoked immediately. |
| UB-14 | `archiveThread` | Verify archive no-op and success branches. | One thread ID missing from the model; one existing thread ID. | Missing thread does nothing; existing thread emits `{ reason: "archive" }` and persists once. |
| UB-15 | `deleteThread` | Verify delete no-op and success branches. | One missing thread ID; one existing thread ID. | Missing thread does nothing; existing thread emits `{ reason: "delete" }` and persists once. |
| UB-16 | `clearAll` | Verify in-memory clearing only occurs when the requested scope matches the active persist scope, while storage clearing always happens for the requested scope. | Initialized service with `persistScope = "workspace"`, then call `clearAll("workspace")` and `clearAll("profile")`. | Workspace clear empties the model, emits `{ reason: "clear" }`, and clears workspace storage; profile clear skips the in-memory model reset but still clears profile storage. |
| UB-17 | `getSelectionState`, `getPlanModeState` | Verify empty-state fallback and defensive cloning. | Calls before initialization, then calls after initialization with populated model state. | Before initialization both getters return fresh empty state objects; after initialization returned state matches model contents but can be mutated by the test without changing internal model state. |
| UB-18 | `replaceSelectionState` | Verify replace-selection behavior initializes on demand, no-ops when disabled, stores a cloned selection state, and persists. | Disabled service, then enabled uninitialized service with a populated selection state. | Disabled service performs no work; enabled service calls `initialize()`, stores a cloned state with `threadId` removed from persisted selection entries, and calls `persistNow()`. |
| UB-19 | `replacePlanModeState` | Verify replace-plan-mode behavior initializes on demand, no-ops when disabled, stores a cloned plan-mode state, and persists. | Disabled service, then enabled uninitialized service with a populated `modeByThread`. | Disabled service performs no work; enabled service initializes, stores a cloned plan-mode map, and persists once. |
| UB-20 | `schedulePersist` | Verify the delayer queues `persistNow()` through the delayed callback. | Initialized service with a mocked `persistDelayer.trigger()` implementation. | `trigger()` is called once with a callback that eventually invokes `persistNow()`. |
| UB-21 | `persistNow` | Verify persistence no-op, success, and failure branches. | Calls when disabled/not initialized, then initialized success path, then initialized failure where store save throws. | Gated-off calls do nothing; success path saves `model.toSnapshot(Date.now())` with `{ redactSecrets }`; failure path logs the error and emits `{ reason: "error" }` without rethrowing. |

### Specification: `src/vs/workbench/contrib/vsclone/electron-main/vscloneOAuthLoopbackChannel.ts`

Functions in this file:

1. `htmlEscape`
2. `renderCompletionPage`
3. `resolveRedirectTemplate`
4. `constructor`
5. `listen`
6. `call`
7. `dispose`
8. `tokenExchange`
9. `startLoopback`
10. `waitForLoopback`
11. `stopLoopback`
12. `listenServer`
13. `getBoundPort`
14. `closeServer`
15. `handleLoopbackRequest`

| Test ID | Function(s) covered | Purpose / program path | Test inputs | Expected output |
| --- | --- | --- | --- | --- |
| OL-01 | `htmlEscape` | Verify dangerous HTML characters are escaped before being inserted into the completion page. | Input string containing `& < > " '`. | Output string contains `&amp;`, `&lt;`, `&gt;`, `&quot;`, and `&#39;`. |
| OL-02 | `renderCompletionPage` | Verify both the success page and the error page content. | One call with `undefined`; one call with an error string containing HTML characters. | Success page contains “VSClone Sign-In Complete” and no `.error` block; error page contains “VSClone Sign-In Failed” and an escaped error block. |
| OL-03 | `resolveRedirectTemplate` | Verify the loopback port placeholder is replaced only when present. | Template containing `{port}` and template without `{port}`, both with `port = 4567`. | Placeholder template returns the same URL with `4567` substituted; static template returns unchanged. |
| OL-04 | `constructor` | Verify channel construction initializes with an empty session map. | Mock log service. | Channel instance is created and has zero active sessions. |
| OL-05 | `listen` | Verify the event-listen API always rejects unsupported events. | Any context and event name. | Method throws `Error("Event not found: ...")`. |
| OL-06 | `call` | Verify IPC dispatch for each supported command. | Use spies on `startLoopback`, `waitForLoopback`, `stopLoopback`, `tokenExchange`, and mocked `shell.openExternal`; invoke `call()` with each command. | Each command delegates to the matching method and returns its resolved value; `open_external` calls Electron shell once. |
| OL-07 | `call` | Verify unsupported IPC commands fail loudly. | `command = "unknown-command"` | Method throws `Error("Call not found: unknown-command")`. |
| OL-08 | `dispose` | Verify disposal stops all active loopback sessions. | Session map contains multiple active sessions. | `stopLoopback(sessionId, true)` is called for every stored session ID; superclass disposal completes without error. |
| OL-09 | `tokenExchange` | Verify successful HTTPS token exchange request construction and response collection. | HTTPS request to `https://example.com/oauth/token`, request body string, content type, and a mocked HTTPS response with status `200` and JSON body chunks. | Outgoing request uses hostname/path/POST headers derived from the URL; body is written; returned value contains the response status code and concatenated UTF-8 body. |
| OL-10 | `tokenExchange` | Verify transport errors reject the promise. | Same as OL-09, but the mocked HTTPS request emits an `error` event. | Promise rejects with the transport error. |
| OL-11 | `startLoopback` | Verify starting a session first clears any existing session, parses callback host/path from the redirect template, listens on the preferred or ephemeral port, stores the session, and logs startup. | Request with `sessionId`, redirect template `http://127.0.0.1:{port}/auth/callback`, and `preferredPort` present or `0`. | Existing session is stopped; server is started; returned `redirectUri` contains the bound port; session map stores callback path `/auth/callback`; info log is written. |
| OL-12 | `waitForLoopback` | Verify the missing-session error path. | Request for an unknown `sessionId`. | Method rejects with `Error("Loopback session not found.")`. |
| OL-13 | `waitForLoopback` | Verify successful wait completion and timeout cleanup. | Existing session with a pending deferred promise, then resolve it before timeout. | Method resolves to the callback payload, clears the timeout, and does not reject. |
| OL-14 | `waitForLoopback` | Verify timeout rejection. | Existing session whose deferred promise never resolves and `timeoutMs` set to a very small value under fake timers. | Method rejects with `Error("Timed out waiting for OAuth callback.")`. |
| OL-15 | `stopLoopback` | Verify missing-session no-op and active-session cleanup. | One unknown `sessionId`; one active session with unsettled deferred result and listening server. | Unknown session does nothing; active session is removed from the map, unresolved deferred is rejected with the “closed before sign-in completed” error, server is closed, and logging only happens when `silent = false`. |
| OL-16 | `listenServer` | Verify server-listen success and failure branches. | Mock server that emits `listening`, then mock server that emits `error`. | Promise resolves on `listening` and rejects with the emitted error on `error`. |
| OL-17 | `getBoundPort` | Verify address parsing for both valid and invalid server address results. | Mock `server.address()` returning `{ port: 3000 }` and then `null` or a string. | Valid address returns `3000`; invalid address throws `Error("Failed to determine loopback listener port.")`. |
| OL-18 | `closeServer` | Verify close behavior for non-listening, successful close, and failed close. | Mock server with `listening = false`, then `listening = true` plus close callback success, then close callback error. | Non-listening server resolves immediately; successful close resolves; failed close rejects with the close error. |
| OL-19 | `handleLoopbackRequest` | Verify expired session, favicon request, and wrong-path handling. | No matching session; then valid session with `/favicon.ico`; then valid session with a wrong callback path. | Expired session returns HTTP `410` with an expired-session page; favicon returns `204`; wrong path returns `404` with the wrong-endpoint page. |
| OL-20 | `handleLoopbackRequest` | Verify provider error and missing-parameter callback handling. | Valid session with `?error=access_denied&error_description=denied` and then valid session with missing `code` or `state`. | Both cases return HTTP `200` with an error completion page, reject the deferred result with the corresponding error message, and stop the session. |
| OL-21 | `handleLoopbackRequest` | Verify the successful OAuth callback path. | Valid session and request URL containing both `code` and `state`. | Response status is `200` with the success page; deferred result resolves to `{ code, state, callbackUrl }`; loopback session is stopped. |
