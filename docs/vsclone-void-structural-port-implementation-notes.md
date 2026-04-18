# VSClone -> Void Structural Port Implementation Notes

## Goal

Track the live implementation state for `docs/vsclone-void-structural-port-plan.md`
so long-running work can survive compaction without losing the current slice,
ownership, or OAuth-boundary decisions.

## Constraints

- Preserve VSClone OAuth as the only credential source.
- Prefer Void-shaped vertical slices over local rewrites.
- Do not revert unrelated user changes in the already-dirty worktree.

## Working State

- Current checkpoint: the native structured tool-call transport, settings
  owner, autocomplete collapse, and the last Phase 1 cleanup residuals are now
  landed in source.
- Phase 1.1 note: `vscloneLLMMessage` is now in the normal registration path in both the
  workbench and main process; it is no longer hidden behind optional dynamic imports.
- Current sub-slice: notes sync plus final structural audit against the plan.
- Notes owner: Codex main agent
- Last updated: 2026-04-17

## OAuth Boundary Notes

- Current explicit boundary:
  `browser/vscloneOAuthService.ts#getApiHeaders(vendor)` resolves provider-
  specific OAuth headers in the renderer, and
  `browser/vscloneThreadRuntimeService.ts#runModelIteration(...)` forwards
  those headers into `browser/vscloneLLMMessageService.ts`.
- Required invariant for the transport port:
  `vscloneLLMMessage` request types must carry OAuth-derived auth material as an
  explicit input. The port must not read API keys from settings or infer auth
  implicitly from provider settings.
- Provider-specific headers that must survive the port:
  OpenAI account/beta/originator headers, Anthropic beta/version headers, and
  Google quota headers.

## Slice Tracking

| Slice | Status | Notes |
| --- | --- | --- |
| Transport (`sendLLMMessage`) | done in source | Static registration, local SDK imports, prepared-message request payloads, autocomplete reuse of the shared browser LLM transport, and native provider tool definitions/tool-call events are live. Remaining validation is build/test level rather than source integration. |
| Chat thread/runtime loop | done in source | `VSCloneChatThreadService` owns prompt/lifecycle entry points, `VSCloneThreadRuntimeService` owns the live loop directly, runtime replay is inlined, approval resume state now lives on `tool_request` messages, and execution state derives from `streamState` instead of a second persisted run flag. |
| Serializer collapse | done | Runtime persistence now uses one inlined workspace payload and the dead v1 store/serializer files are deleted. |
| Settings/model consolidation | done in source | `vscloneSettingsService.ts` is the live owner for provider visibility, ineligibility memory, per-feature defaults, and thread-effective selection policy; the older catalog/preferences/eligibility services are deleted from the live tree. |
| Prompt assembly/context tools | done in source | `vsclonePrompts.ts` now owns the pure system-message assembly function, prompt context is limited to the active editor summary, directory trees are no longer assembled every turn, and the regex tool-usage reprompt is gone. |
| Autocomplete collapse | done | The completion path now reuses `vscloneLLMMessage`, the dedicated completion helper stack is deleted, and only the test-only mock backend/types remain. |
| Cleanup/renames | done in source | The thread/action/rail rename pass is landed, `vscloneEditApplicationService.ts` is deleted, and the dead session/replay helper residuals are gone. |

## Findings Log

- The repo is already dirty in the VSClone area before this turn. Integration
  must treat existing edits as in-flight work rather than assuming a clean
  baseline.
- The dead chat-specific main-process IPC files are now out of the live tree:
  - `common/vscloneChatApiIpc.ts`
  - `electron-main/vscloneChatApiChannel.ts`
- The old renderer-side chat facade is now gone too:
  - `browser/vscloneChatApiService.ts`
- The old chat adapter module is now gone too:
  - `common/vscloneChatApiAdapters.ts`
- The last runtime-history projection helper is now gone:
  - `common/vscloneRuntimeConversationMessages.ts`
- The first structural target is the Void-style `vscloneLLMMessage*` stack:
  - `common/vscloneLLMMessageTypes.ts`
  - `browser/vscloneLLMMessageService.ts`
  - `electron-main/vscloneLLMMessageChannel.ts`
  - `electron-main/vscloneLLMMessageImpl.ts`
- Static registration for `VSCloneLLMMessageChannel` and
  `VSCloneLLMMessageService` has now landed, so future compile failures in the
  new transport surface should be visible immediately instead of being masked by
  optional imports.
- `electron-main/vscloneLLMMessageImpl.ts` now uses SDK-managed request/stream
  handling for OpenAI and Anthropic while keeping Google on an explicit
  header-driven fallback. That Google exception is deliberate: the public
  `@google/genai` auth surface does not line up cleanly with VSClone's
  renderer-owned OAuth-header contract yet.
- The transport implementation now imports `@anthropic-ai/sdk` and `openai`
  from VSClone's own installed dependencies instead of reaching into the
  sibling Void checkout's `node_modules` tree.
- `vscloneLLMMessageTypes.ts`, `vscloneLLMMessageService.ts`, and
  `vscloneLLMMessageImpl.ts` now expose a richer Void-shaped event surface:
  `fullReasoning` on streaming/final payloads, optional structured `toolCall`
  metadata, and final `anthropicReasoning` blocks. OpenAI and Google currently
  emit the new fields as empty/default values, while Anthropic populates
  reasoning data opportunistically from the SDK stream.
- The browser now has a dedicated `vscloneConvertToLLMMessageService.ts`
  seam that prepares provider-native chat payloads from the still-legacy
  runtime transcript shape. `VSCloneThreadRuntimeService` sends those prepared
  payloads straight into `vscloneLLMMessageService`, so the old chat facade is
  no longer in the execution path.
- `vscloneLLMMessageTypes.ts` now carries a prepared chat payload union with
  provider-native message shapes (`OpenAI`, `Anthropic`, `Gemini`) instead of
  routing chat requests through the old `options.previousTurns` envelope at the
  transport boundary.
- `electron-main/vscloneLLMMessageImpl.ts` now consumes those prepared message
  payloads directly. The main-process transport still owns model-id mapping,
  OAuth-header application, and SDK invocation, but it no longer reconstructs
  chat history from `promptText` plus `previousTurns`.
- `package.json` and `package-lock.json` now include the Void transport SDK
  dependencies after `npm install --ignore-scripts`.
- `browser/vscloneChatSessionService.ts` is now deleted. The pane and focused
  browser tests submit directly through `IVSCloneChatThreadService`, so the
  older session decorator is no longer part of the live graph.
- `vscloneAgentLoopService.ts` is now deleted from the live tree. Its loop
  logic, tool timeout guard, reprompt heuristics, and cancel flow now live
  inside `vscloneThreadRuntimeService.ts`.
- `VSCloneLLMMessageImpl` now advertises native provider tool schemas for
  OpenAI, Anthropic, and Google from the shared `VSCLONE_TOOL_DEFINITIONS`
  metadata, while preserving VSClone's OAuth-derived auth-material boundary.
- The runtime loop no longer reparses assistant XML. `VSCloneThreadRuntime`
  now consumes `toolCall` directly from the shared LLM transport final payload
  and replays tool history as structured assistant + tool messages.
- `vscloneChatTransportTypes.ts` now carries an explicit `currentTurn` plus
  structured `role: 'tool'` transport messages so resumed tool-result turns no
  longer need to masquerade as synthetic user prompts.
- `vscloneConvertToLLMMessageService.ts` no longer tries to recover tool calls
  from assistant prose. It now performs a straight role-based conversion from
  runtime history into provider-native request payloads.
- Runtime conversation replay is now inlined inside
  `browser/vscloneThreadRuntimeService.ts`, so resumed approvals and follow-up
  sends project structured `role: 'tool'` history straight from runtime state
  without depending on a separate helper module.
- `IVSCloneThreadRuntimeState` no longer keeps a separate `pausedApproval`
  field. Approval-required resume metadata now persists directly on the
  `tool_request` message, which keeps reload/approve/reject state anchored to
  the runtime transcript instead of splitting it across message history plus a
  parallel sidecar object.
- `IVSCloneThreadRuntimeState` also no longer persists a separate `isRunning`
  flag. Runtime status now comes from `streamState`, and the pane derives the
  narrower "actively executing" concept only where `awaiting_user` should stay
  interactive.
- The XML-era parser/sanitizer files are now deleted from the live tree:
  - `common/vscloneToolCallParser.ts`
  - `common/vscloneAgentTranscriptSanitizer.ts`
- Their dedicated common tests are deleted too:
  - `test/common/vscloneToolCallParser.test.ts`
  - `test/common/vscloneAgentTranscriptSanitizer.test.ts`
- `<agent_trace>` emission is no longer part of the live runtime loop. The pane
  still strips that markup defensively, but the structured tool rail is now the
  canonical activity surface.
- `vscloneUnifiedChatStateStore.ts` remains the correct keeper for
  selection/plan sidecars, but thread persistence itself now lives directly
  inside `vscloneThreadRuntimeService.ts` under one versioned workspace storage
  payload instead of the old per-thread store/serializer split.
- There was a real stale-sidecar bug after the runtime-first cleanup:
  `VSCloneThreadRuntimeService.deleteThread()` and `clearAll()` removed runtime
  threads without clearing the persisted selection/plan-mode sidecars in
  `VSCloneUnifiedChatBackendService`.
- That lifecycle bug is now fixed in the runtime service itself so every delete
  and clear path, including the rail and workspace-wide history clear action,
  purges the sidecar maps from one place instead of relying on UI call sites to
  remember the cleanup.
- `VSCloneUnifiedChatBackendService` now exposes `clearAll()` in addition to
  `deleteThread()`, and both methods initialize the backing store before
  mutating persisted state.
- A focused `vscloneThreadRuntimeSidecarCleanup.test.ts` now guards the
  runtime-owned sidecar cleanup for both single-thread delete and workspace-
  wide clear.
- That same runtime-owner test now also covers the new inline persistence path:
  one restore round-trip through `vsclone.threadRuntime.v2`, plus malformed-
  blob handling that drops corrupted payloads instead of crashing restore.
- `browser/vscloneChatThreadService.ts` now owns prompt submission directly and
  delegates into the runtime service without any `vscloneChatSessionService`
  compatibility layer.
- `vscloneUnifiedChatViewPane.ts` now submits and cancels through
  `IVSCloneChatThreadService`, and `vscloneChatThreadService.test.ts` locks in
  that delegation contract.
- `vscloneThreadRuntimeSidecarCleanup.test.ts` now instantiates the runtime
  with the direct OAuth/LLM transport dependencies instead of the deleted chat
  facade, so the cleanup test still guards the runtime-owned delete/clear path.
- `vscloneThreadRuntimeStore.ts` and `vscloneThreadRuntimeSerializer.ts` are
  now deleted. The runtime intentionally writes a new `vsclone.threadRuntime.v2`
  workspace payload so the old persistence shape is dropped instead of carried
  forward through migration code.
- The dedicated store/serializer test suites are now deleted, and the runtime-
  owned browser test adds a restore-path assertion against the new inlined
  storage payload.
- `vscloneConvertToLLMMessageService.test.ts` now snapshot-tests the prepared
  transport seam for OpenAI, Anthropic, and Google, including structured tool
  replay and current-turn multimodal handling.
- `vscloneEditApplicationService.ts` is now deleted. The pane injects
  `IVSCloneEditCodeService` directly, and the remaining helper imports now come
  from `vscloneEditCodeService.ts` / `vscloneEditCodeServiceInterface.ts`
  instead of the removed forwarder.
- `common/vsclonePromptAssemblyService.ts` is now deleted. Prompt assembly
  lives directly in `common/vsclonePrompts.ts` as a pure function that emits a
  much smaller system prompt focused on base instructions, tool inventory, and
  the active-file summary.
- `VSCloneContextGatheringService.gatherContext()` no longer resolves the
  directory tree on the hot path. Repository discovery is expected to happen
  lazily through `ls_dir`, `read_file`, and `search_for_files`.
- `vscloneToolDefinitions.ts` now advertises Void-aligned read/list/search tool
  names (`read_file`, `ls_dir`, `search_for_files`) while
  `VSCloneToolExecutionService` still accepts the old `list_directory` and
  `search_files` aliases so older transcripts and prepared-message tests remain
  executable.
- `VSCloneThreadRuntimeService` no longer uses the
  `shouldRepromptForToolUse` regex heuristic. The loop now trusts the model and
  either executes the parsed tool calls or completes the turn.
- `vscloneSettingsService.ts`, `vscloneSettingsTypes.ts`, and
  `vscloneModelCapabilities.ts` are now present in the tree and registered in
  `vsclone.contribution.ts`.
- The old projection-only settings shim is gone. `VSCloneSettingsService` now
  owns:
  - provider visibility state persisted in `vsclone.settings.v1`
  - OAuth-derived provider readiness projection
  - model ineligibility persistence migrated from `vsclone.modelEligibility.v1`
  - per-feature default selection resolution for new work
  - thread-effective model snapshots persisted via the unified chat backend
- The settings owner now exposes the compatibility surface the runtime and
  thread-selection adapter already expected:
  `onDidChangeSelection`, `getCurrentSelectionForFeature(...)`,
  `markModelIneligible(...)`, `clearIneligibilityForVendor(...)`, and the
  test-only `setFailNextRefreshForTest()` hook retained for model-switcher
  loading/error coverage.
- `VSCloneThreadModelSelectionService` is now just the thin adapter over
  `VSCloneSettingsService`; the old catalog/preferences/eligibility services no
  longer participate in the live read/write path.
- `VSCloneSettingsService` now migrates provider visibility from both legacy
  provider keys (`vsclone.providerPreferences.v1`,
  `vsclone.modelSwitcher.providers.v1`) and collapses ineligibility into the
  same settings blob (`vsclone.settings.v1`).
- Settings-owner syntax validation was run with a direct TypeScript
  `transpileModule(...)` pass over:
  - `common/vscloneSettingsService.ts`
  - `test/common/vscloneSettingsService.test.ts`
  - `test/browser/vscloneThreadRuntimeSidecarCleanup.test.ts`
  That check only validates parse-level correctness, but it caught no syntax
  errors in the new settings slice.
- The native-tool-call cutover was syntax-validated with a direct TypeScript
  parse/transpile pass over:
  - `common/vscloneChatTransportTypes.ts`
  - `common/vscloneLLMMessageTypes.ts`
  - `common/vsclonePrompts.ts`
  - `common/vscloneThreadRuntimeTypes.ts`
  - `common/vscloneToolDefinitions.ts`
  - `browser/vscloneUnifiedChatViewPane.ts`
  - `browser/vscloneConvertToLLMMessageService.ts`
  - `browser/vscloneChatThreadService.ts`
  - `browser/vscloneContextGatheringService.ts`
  - `browser/vscloneThreadRuntimeService.ts`
  - `browser/vsclone.contribution.ts`
  - `electron-main/vscloneLLMMessageImpl.ts`
  - `test/common/vsclonePrompts.test.ts`
  - `test/browser/vscloneContextGatheringService.test.ts`
  - `test/browser/vscloneChatThreadService.test.ts`
  - `test/browser/vscloneChatExecutionIntegration.test.ts`
  - `test/browser/vsclonePlanModeIntegration.test.ts`
  That check is still parse-level only, but it caught no syntax errors in the
  structured tool-call slice.
- `VSCloneModelSwitcherWidget` and `VSCloneUnifiedChatViewPane` now read model
  picker state through `IVSCloneSettingsService` instead of directly merging
  catalog and selection services in the view layer.
- `VSCloneAutocompleteService` now routes inline-completion prompts through
  the shared `vscloneLLMMessage` browser transport instead of any dedicated
  completion IPC path.
- The old completion transport files are now deleted:
  - `common/backend/vscloneCompletionApiIpc.ts`
  - `common/backend/vscloneCompletionApiAdapters.ts`
  - `electron-main/vscloneCompletionChannel.ts`
- The corresponding completion-channel tests are deleted too because the shared
  `vscloneLLMMessage` path now owns main-process request submission.
- The broader completion helper stack is now deleted too:
  - `browser/vscloneCompletionBackendService.ts`
  - `browser/vscloneCompletionContextService.ts`
  - `common/vscloneCompletionPromptService.ts`
  - `common/vscloneCompletionPostProcessor.ts`
  - `test/browser/vscloneCompletionBackendService.test.ts`
  - `test/browser/vscloneCompletionContextService.test.ts`
  - `test/common/vscloneCompletionPromptService.test.ts`
  - `test/common/vscloneCompletionPostProcessor.test.ts`

## Next Actions

1. Run a fresh VS Code build when available so the browser test suites can
   execute against newly compiled `out/` artifacts rather than stale modules.
2. Decide whether to keep the current split between
   `VSCloneChatThreadService` and `VSCloneThreadRuntimeService`, or finish the
   last owner-collapse step toward Void's single monolithic thread-service
   shape.
3. If a stricter "plan complete" bar is required, audit the remaining owner-
   split/routing differences against Void rather than the already-landed
   transport/tool/persistence behavior.

## Validation Notes

- The available browser test command (`npm run test-browser-no-install`) runs
  against `out/` artifacts. In this environment the required `VS Code - Build`
  task output is not available, so a browser test rerun can report stale
  failures if the updated TypeScript has not been recompiled into `out/` yet.
- File-scoped reruns are resolving against stale or missing `out/` modules in
  this environment and can return `BAD ... 0 passing` instead of executing the
  updated sources.
- `npm run compile-check-ts-native` is also not a useful gate for this branch
  right now because the repo already fails with broad decorator-type errors
  outside VSClone scope; the command did not surface a VSClone-specific signal.
- The safe read is that local browser-test validation is currently limited to
  source hygiene plus whatever compiled artifacts already exist in `out/`; a
  fresh build is still needed before browser tests can validate the latest
  transport edits.
