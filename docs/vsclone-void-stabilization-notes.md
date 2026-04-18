# VSClone Structural Port Stabilization Notes

This file tracks the live execution of `vsclone-void-stabilization-plan.md` so
progress survives compaction.

## Current State

- Owner: Codex main agent
- Last updated: 2026-04-18
- Phase: Phase 3 targeted validation and review loop with compile/dev launcher green

## Current Understanding

- The structural port is source-complete enough to leave migration mode and
  enter stabilization mode.
- The strongest remaining risks are build/test/runtime validation, not missing
  source plumbing.
- The current review loop policy is:
  - use `gpt-5.4 xhigh` review subagents
  - evaluate findings in the main thread
  - fix actionable findings
  - rerun targeted validation
  - repeat

## Planned First Pass

1. `npm run build-vsclone-preact`
2. `npm run compile-check-ts-native`
3. Decide whether `npm run valid-layers-check` is worth running immediately
4. Start targeted VSClone test passes based on the failures

## Command Log

- `npm run build-vsclone-preact`
  - result: success
  - note: rebuilt the VSClone preact bundle cleanly
- `npm run compile-check-ts-native`
  - result: failed
  - note: failure is not VSClone-local; the output is dominated by broad
    `TS1270` decorator typing errors under `src/vs/base/*` and
    `src/vs/workbench/services/environment/*`
- `./scripts/test.sh --grep VSClone`
  - result: failed before VSClone tests ran
  - note: the Electron test harness could not dynamically import
    `out/vs/workbench/test/common/utils.js`, which means the current workspace
    does not yet have a usable compiled `out/` tree for unit tests
- `npm run compile`
  - result: failed
  - note: the compile still reports the broad non-VSClone decorator typing
    failures under `src/vs/base/*`, `src/vs/platform/environment/*`, and
    related core files, but it also exposed a concrete VSClone-local batch that
    is actionable in this stabilization pass:
    - `vscloneUnifiedChatStateStore.ts` DI metadata fallback typing error
    - focused test harness typings in
      `vscloneThreadRuntimeSidecarCleanup.test.ts`,
      `vsclonePlanModeIntegration.test.ts`,
      `vscloneChatThreadService.test.ts`,
      `vscloneChatExecutionIntegration.test.ts`,
      `vscloneAutocompleteService.test.ts`,
      `vscloneOAuthService.test.ts`, and
      `vscloneOAuthLoopbackChannel.test.ts`
    - `vscloneEditCodeService.test.ts` harness typing broke because the
      prototype-only test harness now intersects with private members on the
      concrete class and collapses to `never`
- `npm run compile` after the first VSClone-local fix pass
  - result: failed
  - note: the build no longer reported a VSClone-local TypeScript tail before
    stopping on a shared chat snapshot copy failure:
    `out/vs/workbench/contrib/chat/test/common/model/__snapshots__/Response_mergeable_markdown.0.snap`
- `./scripts/test.sh --grep VSClone` after the first VSClone-local fix pass
  - result: failed before VSClone tests ran
  - note: the Electron renderer still cannot dynamically import
    `out/vs/base/common/errors.js`, so the shared `out/` tree remains
    incomplete for unit tests even after the VSClone-local fixes
- targeted TypeScript transpile parse check on the location-scoped settings refactor
  - result: success
  - note: the nested thread-selection changes across the settings owner,
    unified chat backend/store, and focused settings tests parse cleanly
- `npm run gulp transpile-client`
  - result: misleading partial success
  - note: this checkout's transpile task emitted a sparse asset-heavy `out/`
    tree and was not sufficient by itself to run Electron tests against the
    migrated VSClone slice
- local transpile-only `out/vs` generation from `src/vs/**/*.ts?(x)`
  - result: success
  - note: this was used strictly as a validation artifact so the focused
    VSClone tests could run despite the shared repo build remaining blocked by
    unrelated type errors
- `VSCODE_SKIP_PRELAUNCH=1 ./scripts/test.sh --run src/vs/workbench/contrib/vsclone/test/common/vsclonePrompts.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vscloneContextGatheringService.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vscloneChatThreadService.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vscloneChatExecutionIntegration.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vsclonePlanModeIntegration.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vscloneThreadRuntimeSidecarCleanup.test.ts --grep VSClone`
  - result: success
  - note: the migrated structural-port validation slice now passes with `16
    passing`
- review-loop fix: foreign-workspace restore guard in runtime/store plus sidecar cleanup regression
  - result: success
  - note: the focused structural-port suite now passes with `17 passing`,
    including the new persisted-runtime foreign-workspace regression
- `npm run gulp transpile-client`
  - result: success
  - note: this still emitted a client tree that was incomplete for the focused
    Electron runner because `utils.js` failed on a named-export mismatch from
    the transpiled test support modules
- `npm run gulp transpile-client-esbuild`
  - result: success
  - note: the esbuild-backed transpile-only client tree restored an
    Electron-compatible `out/` artifact for the focused VSClone suite
- `VSCODE_SKIP_PRELAUNCH=1 ./scripts/test.sh --run src/vs/workbench/contrib/vsclone/test/common/vsclonePrompts.test.ts --run src/vs/workbench/contrib/vsclone/test/common/vscloneSettingsService.test.ts --run src/vs/workbench/contrib/vsclone/test/common/vscloneThreadModelSelectionService.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vscloneContextGatheringService.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vscloneChatThreadService.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vscloneChatExecutionIntegration.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vsclonePlanModeIntegration.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vscloneThreadRuntimeSidecarCleanup.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vscloneThreadRuntimeApprovalRegression.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vscloneUnifiedChatViewPaneApprovalRegression.test.ts --grep VSClone`
  - result: success
  - note: the expanded focused VSClone stabilization slice is now green at `30
    passing`, covering prompts, context gathering, chat thread submission,
    runtime replay/sidecar cleanup, location-scoped settings ownership, live
    approval rejection, and pane approval scoping
- `VSCODE_SKIP_PRELAUNCH=1 ./scripts/test.sh --run src/vs/workbench/contrib/vsclone/test/common/vsclonePrompts.test.ts --run src/vs/workbench/contrib/vsclone/test/common/vscloneSettingsService.test.ts --run src/vs/workbench/contrib/vsclone/test/common/vscloneThreadModelSelectionService.test.ts --run src/vs/workbench/contrib/vsclone/test/common/vscloneUnifiedChatStateStore.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vscloneContextGatheringService.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vscloneChatThreadService.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vscloneChatExecutionIntegration.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vsclonePlanModeIntegration.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vscloneThreadRuntimeSidecarCleanup.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vscloneThreadRuntimeApprovalRegression.test.ts --run src/vs/workbench/contrib/vsclone/test/browser/vscloneUnifiedChatViewPaneApprovalRegression.test.ts --grep VSClone`
  - result: success
  - note: the focused VSClone stabilization slice is now green at `31 passing`,
    adding store-level coverage for legacy single-selection payload migration
    into the new location-scoped thread-selection map
- review-loop fix: restored pending-approval rejection resume
  - result: success
  - note: restored approval rejection now resumes the assistant follow-up after
    reload, and the expanded focused VSClone Electron slice is green at `32
    passing`
- `npm run compile-check-ts-native` after the shared decorator helper fix
  - result: success
  - note: `src/vs/base/common/decorators.ts` now exposes explicit legacy and
    modern overloads for `memoize`, which clears the broad `DecoratedFunction`
    return-type failures that had been blocking the client watch and native
    compile pass
- `./scripts/dev.sh --help`
  - result: success
  - note: the launcher now waits on the current VSClone Preact outputs
    (`thread-rail`, `model-switcher`, and `unified-conversation-surface`)
    instead of the removed `chat-history-rail` artifact, and the full startup
    path reached a real Electron app launch with `watch-client` compiling with
    `0 errors`
- `npm run compile`
  - result: success
  - note: the broader compile path is clean again after the shared decorator
    typing fix, so the earlier repo-wide core/workbench blocker is no longer
    active

## Findings Log

- The first repo-level TypeScript compile signal is currently blocked by
  pre-existing or broader workspace issues outside the VSClone slice, so it is
  not yet a useful acceptance gate for the migration itself.
- The VSClone-owned preact build path is healthy, which at least confirms the
  thread rail / conversation surface bundle still rebuilds after the migration.
- The first targeted VSClone unit-test attempt failed at harness/bootstrap time
  rather than on a VSClone test assertion, so the next honest step is to try a
  full compile that can populate the `out/` tree required by the Electron test
  runner.
- The full compile confirmed that `./scripts/test.sh --grep VSClone` was not a
  meaningful feature gate yet because the compile itself is not clean. The
  immediate stabilization work therefore shifts to clearing VSClone-local
  compile errors first, then reattempting the smallest useful runtime/test
  validations.
- After the current fix pass, the meaningful compile blocker moved off the
  VSClone slice and onto a shared chat snapshot copy failure. That is a better
  state than the earlier VSClone-local type errors, but it still blocks a clean
  repo build and therefore still blocks Electron-based VSClone tests.
- The first review pass already found two high-severity behavior regressions in
  the migrated runtime:
  - rejecting a live approval records both `rejected` and `tool_error` for the
    same invocation
  - follow-up sends on existing threads can ignore the freshly snapshotted
    model/reasoning selection and keep using the stale thread binding
- The same review also found medium issues worth addressing after the high
  items:
  - historical tool-request cards can regain live approve/reject controls when
    a later request repeats the same tool name and params
  - the settings owner currently stores a single thread selection rather than a
    location-scoped map per thread
  - regression coverage around approval/reload flows is thin after the port
- Local fixes now landed for:
  - approval rejection no longer appending a second terminal `tool_error`
  - existing-thread sends rebinding the thread selection when the explicit
    submit-time model/reasoning snapshot changes
  - runtime approval controls in the pane scoping themselves to the live
    pending request id instead of matching only on tool name/params
  - focused regression coverage for selection rebinding and approval rejection
- The medium settings mismatch is now being addressed in source as well:
  thread-bound selections are normalized to per-location maps, and the unified
  chat store/backend now tolerate the legacy single-selection payload shape so
  restores can migrate forward without silently dropping old thread bindings.
- The strongest current validation signal is now the focused structural-port
  Electron suite rather than the full repo compile, because the shared compile
  still stops on broad non-VSClone decorator typing failures.
- The targeted structural-port slice is currently green after updating two test
  assumptions to match the migrated behavior:
  - the prompt summary now reports the correct sample-file character count
  - the sidecar cleanup harness now provides the workspace id that persistence
    stamps into runtime payloads
- Review loop 3 surfaced and fixed one more persistence bug:
  - persisted runtime and unified sidecar payloads now reject restores whose
    stored `workspaceId` does not match the current workspace
  - focused regression coverage now verifies the runtime sidecar path drops
    foreign-workspace payloads instead of silently restoring them
- The focused stabilization slice is now broader and still green:
  the current `30 passing` run includes the new location-scoped settings tests
  plus explicit runtime and pane approval regressions, so the remaining risk is
  increasingly concentrated in unexercised flows and the repo-wide harness
  rather than in the ported structural surfaces themselves.
- The focused baseline is now stronger again at `31 passing` because the
  unified-chat state store has explicit regression coverage for restoring the
  legacy single-selection thread payload shape into the new per-location map.
- Review loop 5 found and fixed one more medium runtime consistency bug:
  restored pending-approval rejection now follows the same assistant-resume
  path as the live rejection flow instead of terminating the restored thread at
  the reload boundary.
- The shared build blocker is now cleared:
  - `@memoize` is typed compatibly for both legacy descriptor decorators and
    the modern runtime path, which removed the repo-wide watch/compile failures
  - `scripts/dev.sh` no longer waits on the deleted `chat-history-rail` bundle
    and now reaches a real app launch again
- Full compile validation is now materially stronger than it was earlier in the
  stabilization pass because both `npm run compile-check-ts-native` and
  `npm run compile` complete successfully.
- Manual smoke still matters, but it is now a product-behavior question rather
  than a blocked-build question.

## Review Loop Log

- Review loop 1:
  - reviewer subagent completed against runtime/thread/prompt/view/settings/LLM transport
  - status: actionable
  - high findings:
    - approval rejection double-records a terminal tool outcome
    - existing-thread sends can ignore the latest selected model/reasoning
  - medium findings:
    - repeated tool requests can reactivate approval buttons on historical cards
    - settings thread snapshots are not yet location-scoped
    - approval/reload regression coverage is incomplete
- Active implementation lanes:
  - worker lane A: fixing VSClone-local compile/test typing failures
  - worker lane B: fixing runtime approval/model-selection regressions plus regression tests
  - explorer lane: sizing the settings-service location-scoped thread-selection follow-up
- Review loop 2:
  - next reviewer should evaluate the post-fix runtime/thread/view/settings
    state while the shared build/test harness remains blocked outside VSClone
- Review loop 3:
  - targeted structural-port validation was green at `16 passing`
  - a main-thread review caught missing workspace-id restore validation in the
  persisted runtime/store paths
  - that fix is now validated and the same focused suite is green at `17
    passing`
- Review loop 4:
  - expanded focused validation is green at `30 passing`
  - next step: run another `gpt-5.4 xhigh` review pass against the current
    runtime/thread/view/settings/test baseline
- Review loop 5:
  - expanded focused validation is green at `31 passing`
  - next step: evaluate the current xhigh review pass against the latest
    runtime/thread/view/settings/store baseline
- Review loop 6:
  - xhigh review found one medium issue in the restored rejection branch
  - the restored rejection path now resumes the assistant follow-up after
    reload
  - focused validation is green at `32 passing`
- Review loop 7:
  - the shared TypeScript/decorator blocker is fixed in the central decorator
    helper instead of being worked around at each call site
  - `./scripts/dev.sh` now tracks the post-port VSClone Preact artifacts and
    reaches a successful launch again
  - both native compile-check and full `npm run compile` are green

## Known Caveats Before Validation

- The stock Electron `--grep VSClone` path is still not a trustworthy gate
  because Mocha applies the grep after unrelated test modules are imported.
- Manual smoke coverage is still worth doing on real user flows even though the
  compile/dev-launcher gates are now green.
- During the `./scripts/dev.sh --help` launch validation, local Anthropic token
  refresh logged an invalid-scope error from the current credential setup; that
  did not block app startup or the compile/watch path, but it is still a local
  environment issue if Anthropic auth needs to be exercised manually.
- The source tree still intentionally differs from Void in one notable way:
  submit/lifecycle ownership remains split between `vscloneChatThreadService.ts`
  and `vscloneThreadRuntimeService.ts`.
