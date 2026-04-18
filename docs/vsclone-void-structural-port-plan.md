# VSClone -> Void Structural Port Plan

This is the sequel to [`vsclone-void-refactor-plan.md`](./vsclone-void-refactor-plan.md).
The earlier plan finished deleting history-import shims, `importedFromHistory`,
legacy history types, dead pane renderers, and the dead backend surface.
Production VSClone is now runtime-first, but large subsystems are still
hand-rolled when Void ships a cleaner equivalent.

This plan drives the **next wave**: a set of vertical-slice ports where Void's
architecture replaces VSClone's open-coded version. Net target is roughly
**7,000 lines deleted, 5,500 lines ported, ~1,500 line net reduction**, matched
with a large step-change in architectural coherence.

Source of truth for Void internals: `/Users/brandonhowe/Documents/NJIT/void/src/vs/workbench/contrib/void/`.

## Core Goal

Make VSClone's execution pipeline, chat transport, model state, and prompt
assembly **match Void structurally**, so that the only places VSClone visibly
diverges from Void are the places that make VSClone VSClone — chiefly OAuth.

## Non-Negotiable Constraint: OAuth Stays

**VSClone's OAuth stack is what makes VSClone different from Void. It is NOT
deleted by this plan.**

Specifically, the following stays intact:
- `browser/vscloneOAuthService.ts` (PKCE flow, token sets, secret storage)
- `browser/vscloneOAuthActions.ts` (sign-in/out commands)
- `common/vscloneOAuthService.ts` / `vscloneOAuthTypes.ts` / `vscloneOAuthIpc.ts`
- `electron-main/vscloneOAuthLoopbackChannel.ts`
- `common/vscloneProviderConfigurationBridge.ts` — partially depends on OAuth
  state, stays as long as OAuth stays

Every step in this plan that touches the chat transport, model selection, or
settings stores **must** keep OAuth as the live credential source. VSClone will
be using OAuth throughout this port. We are **not** introducing API-key-based
provider auth as an intermediate step, a fallback path, or a compatibility
layer.

Where Void assumes `apiKey: string` from `voidSettingsService`, VSClone's
equivalent has to accept an OAuth-derived
`apiHeaders: Record<string, string>` or an OAuth bearer token at request time.
This is the one place the plan forks away from Void.

This needs to stay explicit because VSClone's current auth contract is not just
"some credential exists"; it is "provider-specific OAuth headers are resolved
from the signed-in account and sent on every request." OpenAI account headers,
Anthropic OAuth beta/version headers, and Google quota attribution continue to
flow from the OAuth stack. The Void-shaped code must adapt to that contract
instead of trying to erase it.

## OAuth-First Porting Rule

When this document says "port Void's file," read that as:

1. Port the Void structure.
2. Preserve VSClone's OAuth credential flow.
3. Add one narrow credential adapter where the port crosses from
   provider-agnostic logic into a provider SDK or HTTP client.

Concretely:
- We do **not** switch to API keys during any phase.
- We do **not** duplicate auth logic across vendors.
- We do **not** let ported services reach into settings and start reading
  `apiKey` fields that VSClone does not own.
- We do **not** scatter "if OAuth" branches through business logic; the
  transport boundary owns the adaptation.

## Non-Goals

- Replacing OAuth with API keys (see above).
- Porting Void's React UI shell. The pane stays preact; Void React ports are
  a separate project.
- Preserving persisted thread shapes across this refactor. Breakage is
  acceptable; we explicitly delete migration code.
- Feature parity with Void where Void lacks features VSClone wants (e.g. VSClone
  may keep plan mode — see L3 for the decision point).

## Guiding Rules

1. Prefer deletion over adaptation.
2. Prefer porting a Void file verbatim (with credential-source adaptation) over
   refactoring VSClone's version.
3. Every port must land as a single commit or a tight vertical slice. No
   half-landed services.
4. Each port must compile (vsclone scope) before the next one starts.
5. When Void's code assumes API keys and VSClone needs OAuth, add one
   credential adapter at the call boundary — do not scatter auth branches
   through ported code.

## Source Mapping

Below, "(V)" refers to the Void path under
`src/vs/workbench/contrib/void/…`. "(VC)" refers to the VSClone path under
`src/vs/workbench/contrib/vsclone/…`.

---

## Phase 1 — Chat Transport + Agent Loop (vertical slice)

This is the biggest and most load-bearing port. Everything downstream depends
on it, so it lands first and as a single vertical slice.

### 1.1 Port Void's `sendLLMMessage` main-process stack

Replace VSClone's hand-rolled SSE parsing with Void's vendor-SDK-based
transport.

Port:
- (V) `electron-main/llmMessage/sendLLMMessage.impl.ts` → (VC) `electron-main/vscloneLLMMessageImpl.ts`
- (V) `electron-main/llmMessage/sendLLMMessageChannel.ts` → (VC) `electron-main/vscloneLLMMessageChannel.ts`
- (V) `common/sendLLMMessageTypes.ts` → (VC) `common/vscloneLLMMessageTypes.ts`
- (V) `common/sendLLMMessage.ts` (renderer-side facade) → (VC) `browser/vscloneLLMMessageService.ts`

Delete:
- (VC) `common/vscloneChatApiAdapters.ts` (~555 loc of SSE parsing)
- (VC) `common/vscloneChatApiIpc.ts`
- (VC) `electron-main/vscloneChatApiChannel.ts`
- (VC) `browser/vscloneChatApiService.ts`

Required credential contract before the port:
- Keep VSClone's current OAuth header resolution model as the source of truth.
  Today, the renderer resolves provider-specific OAuth headers and forwards
  them over IPC. The new transport must preserve that shape unless we
  intentionally add a dedicated main-process OAuth credential facade first.
- The Phase 1.1 port is **not** complete until the new `sendLLMMessage`
  boundary has an explicit input for OAuth-derived auth material. "We will
  figure out auth while porting" is not an acceptable implementation plan for
  this step.

OAuth-specific fork in the port:
- Void's per-vendor `sendAnthropicMsg` etc. construct the SDK client with
  `apiKey`. VSClone's port constructs the client with the **OAuth bearer token
  or headers** supplied by `IVSCloneOAuthService.getApiHeaders(vendor)`.
- The vendor SDKs all accept custom `fetch` or custom auth headers — we use
  that extension point rather than rewriting the SDKs.
- Be explicit in code review that VSClone is still using OAuth even though the
  underlying transport now looks like Void. If a port reads like "API-key SDK
  with a later OAuth patch," it is wrong.

Package.json: add vendor SDK deps that Void already depends on
(`@anthropic-ai/sdk`, `openai`, `@google/genai`, `ollama`). Version-match Void.

### 1.2 Port Void's `ChatThreadService` into runtime + session consolidation

Replace the VSClone agent loop + session service + half of the runtime service
with Void's single `chatThreadService.ts`.

Port:
- (V) `browser/chatThreadService.ts` → (VC) `browser/vscloneChatThreadService.ts`
  - keep VSClone's DI decorator and export name
  - fold in the checkpoint/rewind plumbing that currently lives inside
    `vscloneThreadRuntimeService.ts`
- (V) Types that back it (`common/chatThreadServiceTypes.ts` if present)

Delete:
- (VC) `browser/vscloneAgentLoopService.ts` (567 loc) — entirely
- (VC) `browser/vscloneChatSessionService.ts` — all but the outer decorator; the
  submit entry point becomes a thin shim over `ChatThreadService.sendMessage`
- (VC) `browser/vscloneAgentTranscriptSanitizer.ts` (dead with Phase 1)
- (VC) `common/vscloneToolCallParser.ts` (dead with Phase 1)
- (VC) `common/vscloneRuntimeConversationMessages.ts` — subsumed by Void's
  typed message conversion
- Majority (~700 of ~1,440 loc) of (VC) `browser/vscloneThreadRuntimeService.ts`
  — message/tool/checkpoint state moves into `vscloneChatThreadService.ts`; the
  remainder becomes a thin catalog owner or is absorbed too

Architectural wins:
- `ThreadStreamState` becomes a proper discriminated union instead of the
  current `isRunning` + `streamState.kind` + `pausedApproval` + `cancelled` +
  `finished` flag salad.
- Tool approvals live on the message stream as `role: 'tool_request'` instead
  of a separate `pausedApproval` parallel state.
- No more `<agent_trace>` XML injection into assistant prose. Assistant trace
  becomes `role: 'tool'` structured messages.
- Re-evaluate `maxAgentIterations = 25` after the port. It may become
  unnecessary if the new loop structure makes repeated "call a tool / retry the
  same turn" churn impossible.
- **Do not delete `toolExecutionTimeoutMs = 90_000` yet.** Native SDK tool-call
  objects remove XML parsing and fake-tool-transcript failure modes, but they do
  not make local tool execution incapable of hanging. Keep the timeout/cancel
  guard until there is a replacement with equivalent protection.

Keep behind an adapter (OAuth-specific):
- `sendLLMMessage` calls inside `chatThreadService.ts` must go through the
  Phase 1.1 OAuth-aware transport. Do not inline API-key reads.

### 1.3 Serializer collapse

Port:
- Void inlines ~40 lines of thread serialization (`_readAllThreads` /
  `_storeAllThreads`) into `chatThreadService.ts`. Do the same in VSClone.

Delete:
- (VC) `common/backend/vscloneThreadRuntimeSerializer.ts` (762 loc)
- (VC) `common/backend/vscloneThreadRuntimeStore.ts` (184 loc)
- Keep `vscloneUnifiedChatStateStore.ts` — it persists selection + plan-mode
  sidecars, which stay.

Risk: loses per-thread-file persistence. Migration is explicitly rejected —
existing threads are expected to be dropped.

### 1.4 Phase 1 exit criteria

- Chat submit → agent loop → tool execution → stream rendering all flow through
  the Void-shaped `ChatThreadService`.
- OAuth still gates every provider request.
- No `<agent_trace>`, no XML tool-call parsing, no `sanitizeAgentModelOutput`
  call in the pane.
- vsclone scope compiles with no new errors.
- Commit: one commit per 1.1 / 1.2 / 1.3 so rollback is granular.

---

## Phase 2 — Model Settings Consolidation

Collapse three model services into one Void-shaped settings service, but keep
OAuth-specific eligibility logic where the user's plan actually limits
available models.

### 2.1 Port Void's `voidSettingsService`

Port:
- (V) `common/voidSettingsService.ts` (~615 loc) → (VC) `common/vscloneSettingsService.ts`
- (V) `common/voidSettingsTypes.ts` (~524 loc) → (VC) `common/vscloneSettingsTypes.ts`
- (V) `common/modelCapabilities.ts` (~1,586 loc mostly data) → (VC) `common/vscloneModelCapabilities.ts`
  - Trim to models VSClone actually ships. Do not port Void's provider list
    wholesale.

Delete:
- (VC) `common/vscloneModelCatalogService.ts` (432 loc)
- (VC) `common/vscloneProviderPreferencesService.ts` (168 loc)
- Most of (VC) `common/backend/vscloneThreadModelSelectionService.ts` (~300 of
  465 loc) — but **do not** blindly delete the notion of a thread-effective
  model.

Keep (this is the OAuth fork):
- (VC) `common/vscloneModelEligibilityService.ts` **stays in some form**.
  Eligibility encodes "your OAuth account's plan does not include model X".
  Void can delete its equivalent because it only sees API keys, but VSClone
  needs this information to surface "upgrade your plan" affordances. Options:
  - (a) Keep the service as-is, and have `vscloneSettingsService` treat
    ineligibility as a "disabled" flag mix-in.
  - (b) Fold the eligibility map into `vscloneSettingsService` as an
    OAuth-derived override, so all disable paths flow through one store.
  - **Recommended: (b)** — eliminates cross-service sync.

Required VSClone-specific behavior:
- Per-feature selection becomes the default chooser for **new** threads.
- Once a thread sends its first request, VSClone stores the effective model
  selection used for that thread in runtime/catalog state so restores, retries,
  rewind, and transcript inspection stay aligned with what actually ran.
- Reopened threads may surface the current feature default as a suggested next
  choice, but they must not silently rewrite the model identity of historical
  turns.

Architectural wins:
- Storage drops from three keys (`vsclone.modelEligibility.v1`,
  `vsclone.modelSwitcher.providers.v1`, catalog runtime state) to one.
- Cross-service sync code in the pane collapses.
- Per-feature selection matches user intuition for **new** work, while
  thread-effective model snapshots preserve historical/runtime correctness for
  existing work.

### 2.2 Pane wiring

- `vscloneModelSwitcherWidget` + `vscloneModelSwitcherActions` adapt to read
  per-feature selections via `vscloneSettingsService`.
- Delete cross-service sync logic in `vscloneUnifiedChatViewPane.ts` that
  merged catalog + eligibility + preferences manually.

### 2.3 Phase 2 exit criteria

- One settings service owns providers, models, per-feature selections, and
  OAuth-derived eligibility.
- New-thread selection is feature-scoped.
- Each existing thread still has an explicit effective model snapshot so
  resend/retry/rewind flows do not silently hop providers or models.
- Model switcher widget reads one source.
- Commit as one phase-level commit.

---

## Phase 3 — Prompt Assembly + Context Gathering

Move from "dump directory tree and diagnostics into every system message" to
"expose those as tools the model can call."

### 3.1 Port Void's prompt stack

Port:
- (V) `common/prompt/prompts.ts` (~1,069 loc, mostly static strings) → (VC)
  `common/vsclonePrompts.ts` — trim to what VSClone ships; keep Void's
  `chat_systemMessage` and tool descriptions.
- (V) `common/directoryStrService.ts` → (VC) split: the tree builder becomes a
  tool backend; keep only the piece that currently lives in
  `vscloneContextGatheringService.ts`.
- (V) `browser/convertToLLMMessageService.ts` message shaping → likely folded
  into the Phase 1.2 `ChatThreadService` port. Confirm during Phase 1.

Delete:
- (VC) `common/vsclonePromptAssemblyService.ts` (205 loc)
- Bulk (~160 loc) of (VC) `browser/vscloneContextGatheringService.ts` — keep
  only the active-file/selection summary, which stays in the system message.

Architectural wins:
- Token cost per turn drops substantially (directory tree no longer streamed
  every message).
- Deletes `truncateActiveFileContent`, byte-budget math, diagnostics-slicing
  logic.
- Matches Void's tool-first interaction model.

### 3.2 Tool inventory adjustments

- VSClone's tool descriptions (currently XML in `vscloneToolDefinitions.ts`)
  become the native tool-call descriptions Void emits from its SDK wrappers.
- Delete `shouldRepromptForToolUse` regex heuristic — Void's loop trusts the
  model.
- If plan mode stays, keep an explicit VSClone-owned read-only tool filter even
  after moving to native SDK tool calls. Void does not have plan/act mode, so
  this remains a VSClone-specific policy layer rather than something we expect
  the ported code to provide for free.

### 3.3 Phase 3 exit criteria

- System message is small and static (base instructions + tool list + active
  selection).
- `ls_dir`, `read_file`, `search_for_files` tools exist and are invoked
  lazily.
- No per-turn directory-tree assembly.

---

## Phase 4 — Autocomplete Collapse

Blocked on Phase 1.1 (needs `ILLMMessageService`).

### 4.1 Port Void's `autocompleteService`

Port:
- (V) `browser/autocompleteService.ts` (~949 loc — one file) → (VC)
  `browser/vscloneAutocompleteService.ts` (absorbs the scattered stack).

Delete:
- (VC) `browser/vscloneCompletionApiService.ts` (96)
- (VC) `browser/vscloneCompletionBackendService.ts` (186)
- (VC) `browser/vscloneCompletionContextService.ts` (165)
- (VC) `common/vscloneCompletionPostProcessor.ts` (259)
- (VC) `common/vscloneCompletionPromptService.ts` (182)
- (VC) `common/backend/vscloneCompletionApiAdapters.ts` (140)
- (VC) `electron-main/vscloneCompletionChannel.ts` (272)
- Keep `vscloneMockCompletionBackend.ts` as a test-only stub.

Architectural wins:
- 9 files → 1 file.
- Reuses the Phase 1 transport (FIM message type flows through the same
  `ILLMMessageService`).

### 4.2 Phase 4 exit criteria

- Autocomplete runs through the unified LLM transport with OAuth-derived
  credentials, not API keys.
- All per-feature autocomplete configuration lives in
  `vscloneSettingsService` from Phase 2.

---

## Phase 5 — Edit-Code Service Partial Port

Full port is Phase D work (touches the preact shell). This phase does only the
cleanly scoped wins.

### 5.1 Flatten the wrapper

Delete:
- (VC) `browser/vscloneEditApplicationService.ts` (70 loc pure forwarder).
- Update ~4 import sites to consume `IVSCloneEditCodeService` directly.

### 5.2 Optional: port Void's SEARCH/REPLACE core

If Phase 1–4 landed cleanly and there's appetite:
- Port (V) `browser/helpers/findDiffs.ts`
- Port the non-streaming SEARCH/REPLACE path from (V) `browser/editCodeService.ts`
- Hook into `IUndoRedoService` so accept/reject become real VS Code undo stack
  elements.

Skip:
- Streaming diff zones
- Ctrl+K zone widgets (need the React mount point that VSClone doesn't have)

### 5.3 Phase 5 exit criteria

- Pane consumes the edit code service directly.
- If M2 was done, apply/undo is VS Code undoable.

---

## Phase 6 — Cleanup Wave

Small deletes that fall out of Phases 1–5.

### 6.1 Delete now-dead types

- `common/vscloneToolRuntimeTypes.ts` — if Phase 1 folded approvals into
  the message stream, the approval-type enum collapses into Void's
  `approvalTypeOfBuiltinToolName` map.
- `common/vscloneImageAttachmentTypes.ts` — if Phase 1 absorbed image
  attachments into the shared message union, delete.

### 6.2 Rename pass (Phase D from the earlier plan)

- `vscloneChatHistoryActions.ts` → `vscloneThreadActions.ts`
- `vscloneChatHistoryRail.ts` → `vscloneThreadRail.ts`
- `vscloneChatHistoryRailTree.ts` → `vscloneThreadRailTree.ts`
- `VSCloneChatHistoryRail` class → `VSCloneThreadRail`
- `VSCloneChatHistoryCommandIds` const → `VSCloneThreadCommandIds`
- Parallel strings in `preact/src/views.tsx`.

### 6.3 Product decision: plan mode

VSClone has `vsclonePlanModeService` (~137 loc). Void has no plan/act mode.
Decide once:
- Keep → stays as a VSClone-specific feature alongside OAuth.
- Delete → removes the service, the per-turn mode snapshot, plan-mode storage
  scope, and the composer toggle.

Default recommendation: keep, but only if product wants it. Audit whether it's
actually used before committing to keeping it.

---

## Execution Order

Strict dependencies:

```
Phase 1 (transport + loop)
   ├── Phase 2 (settings) can run after 1.1 lands
   ├── Phase 3 (prompts) can run after 1.2 lands
   ├── Phase 4 (autocomplete) requires 1.1
   └── Phase 5 (edit code) is independent
Phase 6 (cleanup) runs last
```

Recommended calendar order:
1. Phase 1.1 (transport)
2. Phase 1.2 (agent loop + session merge)
3. Phase 1.3 (serializer)
4. Phase 2 (settings)
5. Phase 3 (prompts)
6. Phase 4 (autocomplete)
7. Phase 5.1 (wrapper flatten) — cheap, do anytime
8. Phase 5.2 (edit code core port) — only if appetite remains
9. Phase 6 (cleanup + rename + plan-mode decision)

---

## Checkpoint Strategy

Commit after each numbered sub-phase (1.1, 1.2, 1.3, 2.1, ...). The branch may
break tests between sub-phases; it must compile vsclone scope at each
checkpoint. Test rebuilding is explicitly deferred to post-Phase-6.

Before starting each checkpoint, write down the OAuth impact in the commit or
PR notes:
- What still uses OAuth after this step.
- Where OAuth headers/tokens enter the ported code.
- What API-key-shaped Void assumptions were adapted at the boundary.

If that note is hard to write, the port boundary is probably too implicit.

---

## Scope Estimate

| Phase | VSClone lines deleted | Void lines ported | Net delta |
|-------|----------------------:|------------------:|----------:|
| 1.1 (transport)         |   ~880 |   ~1,100 | +220  |
| 1.2 (loop + session)    | ~2,000 |     ~900 | −1,100 |
| 1.3 (serializer)        | ~1,000 |      ~60 | −940  |
| 2 (settings)            | ~1,300 |     ~900 | −400  |
| 3 (prompts)             |   ~440 |     ~350 | −90   |
| 4 (autocomplete)        | ~1,500 |     ~900 | −600  |
| 5.1 (wrapper flatten)   |    ~70 |        0 | −70   |
| 5.2 (edit code, optional) | ~700 |   ~500 | −200  |
| 6 (cleanup + renames)   |   ~200 |        0 | −200  |
| **Total**               | **~8,090** | **~4,710** | **~−3,380** |

---

## Final Standard

Phase 6 is considered complete when:

- VSClone's execution pipeline, chat transport, model settings, and prompt
  assembly structurally match Void.
- OAuth is still the differentiator — it's the only non-trivial subsystem
  where VSClone deliberately diverges from Void.
- A reviewer can point to one explicit OAuth credential boundary in the new
  transport and say, without ambiguity, "VSClone is still using OAuth here."
- Someone reading VSClone alongside Void should think: "this is Void with
  OAuth bolted in," not "this is an unrelated hybrid."

That is the bar.
