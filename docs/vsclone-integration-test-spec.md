# VSClone Frontend/Backend Integration Test Specification

Scope: The pathway-specific test matrix in this document is still scoped to `src/vs/workbench/contrib/vsclone`, but the document now also inventories the shared repo integration harnesses that the VSClone GitHub Actions workflows execute. That broader inventory matters because the GitHub checks are the real enforcement boundary: a VSClone change is considered integrated only after the dedicated VSClone suites and the shared backend/frontend integration harnesses both pass. A "frontend/backend pathway" here means a renderer/workbench service coordinating with either the unified backend persistence layer or an Electron main-process IPC channel. This document therefore inventories the deterministic cross-stack VSClone coverage, the repo-wide integration suite buckets that run in CI, and the opt-in live-provider transport smoke coverage that calls the real OpenAI, Claude, and Gemini backends when credentials are configured locally. The live suite exercises the real renderer service and the real main-process channel implementation in-process through a test `IMainProcessService` adapter; it does not boot a full Electron workbench.

## Implementation Locations

- Common deterministic VSClone coverage lives in `src/vs/workbench/contrib/vsclone/test/common/`. These tests cover backend-safe helpers, prompt/state formatting, and persistence adapters that are exercised by the dedicated backend workflow.
- Browser-layer integration coverage lives in `src/vs/workbench/contrib/vsclone/test/browser/`. These tests cover renderer-owned services coordinating with the unified backend persistence layer and other frontend-side VSClone services.
- Renderer-to-main-process bridge coverage lives in `src/vs/workbench/contrib/vsclone/test/electron-main/`. These tests cover the real IPC/channel seam and the optional live-provider transport smoke runs.
- Live-provider CI support for the `electron-main` smoke suite lives in `.github/workflows/run-vsclone-live-provider-smoke.yml` and `build/azure-pipelines/common/mintVSCloneLiveProviderTokens.ts`.

## CI Execution Matrix

The plan is enforced by four distinct GitHub Actions surfaces. The dedicated VSClone workflows run VSClone-owned test globs directly, while the integration workflow runs the broader upstream VS Code harnesses that share the same compiled `out/` tree and extension bundles.

| Workflow / job | Command | Coverage surface |
| --- | --- | --- |
| `.github/workflows/run-backend-tests.yml` / `VSClone Backend Tests` | `npm run test-node -- --runGlob '**/vsclone/test/common/**/*.test.js'` | Dedicated VSClone common/backend-safe deterministic tests under `src/vs/workbench/contrib/vsclone/test/common/`. |
| `.github/workflows/run-backend-tests.yml` / `VSClone Backend Tests` | `xvfb-run -a ./scripts/test.sh --no-sandbox --disable-gpu-sandbox --runGlob '**/vsclone/test/electron-main/**/*.test.js'` | Dedicated VSClone Electron main-process bridge tests under `src/vs/workbench/contrib/vsclone/test/electron-main/`. |
| `.github/workflows/run-frontend-tests.yml` / `VSClone Frontend Tests` | `npm run test-browser-no-install -- --browser chromium --runGlob '**/vsclone/test/browser/**/*.test.js'` | Dedicated VSClone browser/workbench tests under `src/vs/workbench/contrib/vsclone/test/browser/`. |
| `.github/workflows/run-integration-tests.yml` / `VSClone Backend Integration Tests` | `xvfb-run -a ./scripts/test-integration.sh --no-sandbox --disable-gpu-sandbox --tfs "Integration Tests"` | Shared Electron integration harness. This is broader than VSClone and executes the repo-wide backend integration suite buckets listed below. |
| `.github/workflows/run-integration-tests.yml` / `VSClone Frontend Integration Tests` | `./scripts/test-web-integration.sh --browser chromium` | Shared browser integration harness. This is broader than VSClone and executes the repo-wide frontend integration suite buckets listed below. |
| `.github/workflows/run-vsclone-live-provider-smoke.yml` / `VSClone Live Provider Smoke` | `npm run test-node -- --runGlob '**/vsclone/test/electron-main/vscloneLLMMessageLiveProviderSmoke.test.js'` | Opt-in live OpenAI, Anthropic, and Google transport smoke coverage using real credentials. |

## Current VSClone-Owned Suite Files

The dedicated VSClone workflow globs currently expand to the following test files. This list is intentionally explicit so a newly added VSClone suite file does not silently drift outside the written plan.

### Common deterministic files

- `src/vs/workbench/contrib/vsclone/test/common/vscloneModelCapabilities.test.ts`
- `src/vs/workbench/contrib/vsclone/test/common/vsclonePlanModeService.test.ts`
- `src/vs/workbench/contrib/vsclone/test/common/vsclonePrompts.test.ts`
- `src/vs/workbench/contrib/vsclone/test/common/vscloneSettingsService.test.ts`
- `src/vs/workbench/contrib/vsclone/test/common/vscloneThreadModelSelectionService.test.ts`
- `src/vs/workbench/contrib/vsclone/test/common/vscloneToolDefinitions.test.ts`
- `src/vs/workbench/contrib/vsclone/test/common/vscloneToolResultDiff.test.ts`
- `src/vs/workbench/contrib/vsclone/test/common/vscloneUnifiedChatStateStore.test.ts`

### Browser/workbench files

- `src/vs/workbench/contrib/vsclone/test/browser/vsclone.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneAutocompleteActions.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneAutocompleteService.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneChatExecutionIntegration.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneChatThreadLifecycle.integration.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneChatThreadService.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneContextGatheringService.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneContribution.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneConvertToLLMMessageService.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneEditCodeService.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneMockCompletionBackend.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneModelSwitcherActions.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneModelSwitcherWidget.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneOAuthActions.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneOAuthService.integration.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneOAuthService.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vsclonePlanModeIntegration.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneProviderConfigurationBridge.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneThreadActions.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneThreadRail.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneThreadRailTree.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneThreadRuntimeApprovalRegression.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneThreadRuntimeService.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneThreadRuntimeSidecarCleanup.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneToolExecutionService.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneUnifiedChatBackend.integration.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneUnifiedChatViewPane.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneUnifiedChatViewPaneApprovalRegression.test.ts`

### Electron main-process files

- `src/vs/workbench/contrib/vsclone/test/electron-main/vscloneLLMMessageBridge.test.ts`
- `src/vs/workbench/contrib/vsclone/test/electron-main/vscloneOAuthBridge.test.ts`
- `src/vs/workbench/contrib/vsclone/test/electron-main/vscloneOAuthLoopbackChannel.test.ts`

### Live smoke file

- `src/vs/workbench/contrib/vsclone/test/electron-main/vscloneLLMMessageLiveProviderSmoke.test.ts`

## Shared Backend Integration Harness

The `Run Backend Integration Tests` step in `.github/workflows/run-integration-tests.yml` delegates to `scripts/test-integration.sh`. That script emits the following top-level log headings in order. These are repo-wide VS Code integration suites, not VSClone-owned suites, but they are part of the plan because the VSClone integration job does not pass unless every one of these harness entrypoints succeeds.

| Log heading | Launch command in `scripts/test-integration.sh` | Primary coverage surface |
| --- | --- | --- |
| `### node.js integration tests` | `./scripts/test.sh --runGlob **/*.integrationTest.js "$@"` | Shared Electron/node integration tests selected by the `*.integrationTest.js` glob across compiled `out/**`. |
| `### API tests (folder)` | `"$INTEGRATION_TEST_ELECTRON_PATH" ... --extensionTestsPath=$ROOT/extensions/vscode-api-tests/out/singlefolder-tests ...` | Single-folder extension host API contract coverage. |
| `### API tests (workspace)` | `"$INTEGRATION_TEST_ELECTRON_PATH" ... --extensionTestsPath=$ROOT/extensions/vscode-api-tests/out/workspace-tests ...` | Multi-root/workspace extension host API contract coverage. |
| `### Colorize tests` | `npm run test-extension -- -l vscode-colorize-tests` | TextMate grammar and token colorization extension integration. |
| `### Terminal Suggest tests` | `npm run test-extension -- -l terminal-suggest --enable-proposed-api=vscode.vscode-api-tests` | Terminal completion and shell-integration suggestion workflows. |
| `### TypeScript tests` | `"$INTEGRATION_TEST_ELECTRON_PATH" ... --extensionDevelopmentPath=$ROOT/extensions/typescript-language-features ...` | TypeScript/JavaScript language feature extension integration. |
| `### Markdown tests` | `npm run test-extension -- -l markdown-language-features` | Markdown extension rendering and command integration. |
| `### Emmet tests` | `"$INTEGRATION_TEST_ELECTRON_PATH" ... --extensionDevelopmentPath=$ROOT/extensions/emmet ...` | Emmet editor integration. |
| `### Git tests` | `"$INTEGRATION_TEST_ELECTRON_PATH" $(mktemp -d 2>/dev/null) --extensionDevelopmentPath=$ROOT/extensions/git ...` | Git extension integration against a temporary workspace. |
| `### Git Base tests` | `npm run test-extension -- -l git-base` | Shared git-base extension support layer coverage. |
| `### Ipynb tests` | `npm run test-extension -- -l ipynb` | Notebook document and renderer extension integration for `.ipynb`. |
| `### Notebook Output tests` | `npm run test-extension -- -l notebook-renderers` | Notebook output renderer integration. |
| `### Configuration editing tests` | `npm run test-extension -- -l configuration-editing` | Settings editing and JSON configuration extension integration. |
| `### GitHub Authentication tests` | `npm run test-extension -- -l github-authentication` | GitHub auth provider extension integration. |
| `### CSS tests` | `cd $ROOT/extensions/css-language-features/server && $ROOT/scripts/node-electron.sh test/index.js` | Standalone CSS language server tests running under Electron's Node runtime. |
| `### HTML tests` | `cd $ROOT/extensions/html-language-features/server && $ROOT/scripts/node-electron.sh test/index.js` | Standalone HTML language server tests running under Electron's Node runtime. |

The cleaned backend log captures in `github-run-backend-integration-step.txt` and `local-run-backend-integration-step.txt` mirror these exact headings. That log shape is intentional and should remain stable enough to diagnose which harness bucket failed without reopening the raw GitHub Actions export.

## Shared Frontend Integration Harness

The `Run Frontend Integration Tests` step in `.github/workflows/run-integration-tests.yml` delegates to `scripts/test-web-integration.sh`. That browser harness is narrower than the Electron harness, but it is still broader than VSClone-specific tests and remains part of the integration plan because the same transpiled browser assets and extension bundles are involved.

| Log heading | Launch command in `scripts/test-web-integration.sh` | Primary coverage surface |
| --- | --- | --- |
| `### API tests (folder)` | `node test/integration/browser/out/index.js --workspacePath $ROOT/extensions/vscode-api-tests/testWorkspace ... --extensionTestsPath=$ROOT/extensions/vscode-api-tests/out/singlefolder-tests "$@"` | Single-folder browser extension host API contract coverage. |
| `### API tests (workspace)` | `node test/integration/browser/out/index.js --workspacePath $ROOT/extensions/vscode-api-tests/testworkspace.code-workspace ... --extensionTestsPath=$ROOT/extensions/vscode-api-tests/out/workspace-tests "$@"` | Multi-root/workspace browser extension host API contract coverage. |
| `### TypeScript tests` | `node test/integration/browser/out/index.js --workspacePath $ROOT/extensions/typescript-language-features/test-workspace ...` | Browser-hosted TypeScript/JavaScript language feature extension integration. |
| `### Markdown tests` | `node test/integration/browser/out/index.js --workspacePath $ROOT/extensions/markdown-language-features/test-workspace ...` | Browser-hosted Markdown extension integration. |
| `### Emmet tests` | `node test/integration/browser/out/index.js --workspacePath $ROOT/extensions/emmet/test-workspace ...` | Browser-hosted Emmet extension integration. |
| `### Git tests` | `node test/integration/browser/out/index.js --workspacePath $(mktemp -d 2>/dev/null) --extensionDevelopmentPath=$ROOT/extensions/git ...` | Browser-hosted Git extension integration. |
| `### Ipynb tests` | `node test/integration/browser/out/index.js --workspacePath $(mktemp -d 2>/dev/null) --extensionDevelopmentPath=$ROOT/extensions/ipynb ...` | Browser-hosted notebook document integration. |
| `### Configuration editing tests` | `node test/integration/browser/out/index.js --workspacePath $(mktemp -d 2>/dev/null) --extensionDevelopmentPath=$ROOT/extensions/configuration-editing ...` | Browser-hosted configuration editing integration. |

## Functionality That Must Be Tested

- Chat submission must preserve runtime-owned transcript context when a frontend send targets an existing thread.
- Submit-time plan/act mode must be snapshotted before slow frontend dependencies can drift the request into a different mode.
- Renderer OAuth refresh work must not resurrect a provider after the user signs out during an in-flight backend token exchange.
- Renderer OAuth sign-in must be able to fall back to manual code entry when the main-process loopback listener cannot start.
- Renderer OAuth sign-in must be able to drive the main-process loopback bridge end to end: start loopback, launch the browser, wait for the callback, exchange the authorization code, persist tokens, and mark the provider ready.
- Renderer LLM requests must cross the main-process transport boundary, stream incremental output back to the browser observer, and finalize with the accumulated response text.
- Renderer cancellation of an in-flight LLM request must abort the main-process transport signal instead of leaving the backend request running.
- The repo must also support an opt-in live-provider transport smoke layer that proves the real renderer service plus the real main-process channel implementation can receive actual provider responses from OpenAI, Anthropic, and Google without local fetch stubs and while honoring each provider's production header contract.
- Frontend settings state must resynchronize when unified backend selection state changes after initialization, including thread-bound selections and recent-model history.
- Frontend plan-mode state must persist per thread through the unified backend store and restore correctly after a service restart.
- Runtime-owned thread deletion must clear unified backend sidecars after runtime state is removed.
- Runtime-owned clear-all must clear unified backend sidecars for every thread after runtime history is reset.
- Public chat thread lifecycle APIs must clear unified backend sidecars when a thread is deleted.
- Public chat thread lifecycle APIs must clear unified backend sidecars for every thread when chat history is fully cleared.
- The dedicated VSClone backend, frontend, backend-integration, and frontend-integration GitHub workflows must continue to execute the suite entrypoints listed above, because those jobs are the concrete CI gates that guard the VSClone shipping path.

## Test Table

| Pathway | Purpose of the test | Test inputs to the function | Expected output if the test passes |
| --- | --- | --- | --- |
| Chat submit ↔ runtime transcript context | Verify that `VSCloneChatThreadService.sendMessage(...)` replays runtime-owned prior turns instead of dropping existing frontend/backend conversation state on follow-up sends. | `sendMessage('Follow up on the earlier answer', { threadId: 'thread-1', sessionResource: 'vsclone://api/thread-1' })` with runtime state already containing one user turn and one assistant turn. | The returned result keeps `thread-1`, the runtime run options include the existing user and assistant turns as `previousTurns`, and the assembled system message still includes the tool section. |
| Plan-mode submit snapshot | Verify that submit-time mode is captured before slow frontend initialization can drift the backend-bound request. | `setModeForThread('thread-1', 'plan')`, then `sendMessage(...)` while settings initialization is blocked, then `setModeForThread('thread-1', 'act')` before the blocked dependency resolves. | The submitted runtime options still use `plan`, the system prompt contains plan-mode guidance, mutating tools are absent from that prompt snapshot, and backend plan-mode state remains `plan` for `thread-1`. |
| OAuth sign-out vs. refresh race | Verify that a renderer sign-out wins over an in-flight backend token refresh. | `getAccessToken('openai')` on a signed-in provider while the token exchange channel is held open, followed by `signOut('openai')` before the exchange completes. | OpenAI ends in `signed_out`, the persisted secret is cleared, and the late refresh response does not restore the signed-in state. |
| OAuth manual fallback path | Verify that renderer sign-in can fall back to manual code entry when the loopback listener cannot start. | `signIn('openai')` where `startLoopback` throws, `openExternal` still launches the authorization URL, quick input returns `manual-auth-code`, and token exchange succeeds. | OpenAI ends in `signed_in`, the token exchange uses `grant_type=authorization_code` with the manual code and preferred redirect URI, and the flow never waits on loopback completion. |
| OAuth renderer ↔ main-process bridge | Verify that `VSCloneOAuthService.signIn('openai')` completes a real loopback-based sign-in through `VSCloneOAuthLoopbackChannel` and persists the resulting token set. | `signIn('openai')` with a main-process service that returns the real loopback channel, a loopback callback containing `code=auth-code`, and a successful token exchange response. | OpenAI ends in `signed_in`, persisted secrets contain the exchanged token set, and the authorization-code request body sent to the token endpoint matches the OpenAI OAuth contract. |
| LLM renderer ↔ main-process bridge | Verify that `VSCloneLLMMessageService.sendRequest(...)` streams FIM text through `VSCloneLLMMessageChannel` and delivers the final accumulated response. | `sendRequest(fimRequest, observer)` where the backend `fetch` returns SSE payloads for two text deltas followed by completion. | The observer receives two ordered text deltas, the final payload contains the full concatenated text, and the backend request uses the expected SSE headers. |
| LLM cancellation path | Verify that cancelling a renderer request propagates to the main-process abort signal. | `handle.cancel()` on an in-flight FIM request whose backend stream stays open until its `AbortSignal` is triggered. | The backend `AbortSignal` becomes aborted, the renderer observer records an abort, and the request handle settles without a final message. |
| Live OpenAI backend transport smoke | Verify that the real renderer service plus the real main-process channel implementation can receive an actual OpenAI backend response when an OAuth bearer token is provided via the local environment. | An opt-in smoke run with `VSCODE_VSCLONE_E2E_LIVE_PROVIDER_TESTS=1`, `VSCODE_VSCLONE_E2E_OPENAI_ACCESS_TOKEN`, production OpenAI transport headers, and a chat request that asks for the marker `VSCLONE_OPENAI_LIVE_OK`. | The request completes without abort or transport error, and the final response contains `VSCLONE_OPENAI_LIVE_OK`. |
| Live Anthropic backend transport smoke | Verify that the real renderer service plus the real main-process channel implementation can receive an actual Anthropic backend response when an OAuth bearer token is provided via the local environment. | An opt-in smoke run with `VSCODE_VSCLONE_E2E_LIVE_PROVIDER_TESTS=1`, `VSCODE_VSCLONE_E2E_ANTHROPIC_ACCESS_TOKEN`, production Anthropic OAuth headers, and a chat request that asks for the marker `VSCLONE_ANTHROPIC_LIVE_OK`. | The request completes without abort or transport error, and the final response contains `VSCLONE_ANTHROPIC_LIVE_OK`. |
| Live Google backend transport smoke | Verify that the real renderer service plus the real main-process channel implementation can receive an actual Gemini backend response when an OAuth bearer token is provided via the local environment. | An opt-in smoke run with `VSCODE_VSCLONE_E2E_LIVE_PROVIDER_TESTS=1`, `VSCODE_VSCLONE_E2E_GOOGLE_ACCESS_TOKEN`, the resolved Google quota header when configured, optional header overrides, and a chat request that asks for the marker `VSCLONE_GOOGLE_LIVE_OK`. | The request completes without abort or transport error, and the final response contains `VSCLONE_GOOGLE_LIVE_OK`. |
| Settings ↔ unified backend persistence | Verify that `VSCloneSettingsService` resynchronizes when the real unified backend selection state changes after initialization. | `backendService.replaceSelectionState(...)` with thread-bound chat/inline selections and recent-model identifiers after `settingsService.initialize()`. | `VSCloneSettingsService` exposes the new thread selections, snapshots, and recent-model identifiers without needing a manual refresh call. |
| Plan mode ↔ unified backend persistence | Verify that `VSClonePlanModeService` persists thread mode through the real backend store and restores it in a fresh service instance. | `setModeForThread('thread-1', 'plan')` on one service instance, followed by a new backend/service pair over the same workspace storage. | The restored plan-mode service returns `plan` for `thread-1`, proving the frontend state survived through backend persistence. |
| Runtime delete ↔ backend sidecar cleanup | Verify that `VSCloneThreadRuntimeService.deleteThread('thread-1')` clears selection and plan-mode sidecars after runtime-owned deletion. | `deleteThread('thread-1')` on a runtime instance with persisted runtime state plus backend selection and plan-mode entries for `thread-1`. | Runtime deletion returns `true`, and backend `selectedByThread['thread-1']` plus `modeByThread['thread-1']` are removed after the async cleanup settles. |
| Runtime clear-all ↔ backend sidecar cleanup | Verify that `VSCloneThreadRuntimeService.clearAll()` clears selection and plan-mode sidecars for every thread. | `clearAll()` on a runtime instance with persisted history plus backend thread selections, location selections, recent-model identifiers, and plan-mode entries for multiple threads. | Backend selection state resets to empty thread/location maps with no recent models, and backend plan-mode state resets to an empty map. |
| Chat thread delete lifecycle | Verify that `VSCloneChatThreadService.deleteThread('thread-1')` clears backend selection and plan-mode sidecars through the public lifecycle API. | `deleteThread('thread-1')` with runtime deletion succeeding and backend state seeded with selection + plan-mode records for that thread. | The call returns `true`, the runtime receives the delete request, and backend `selectedByThread['thread-1']` plus `modeByThread['thread-1']` are removed. |
| Chat thread clear-all lifecycle | Verify that `VSCloneChatThreadService.clearAll()` clears backend sidecars for every thread through the public lifecycle API. | `clearAll()` with runtime history present and backend state seeded with multiple thread selections plus plan-mode entries. | The runtime clear-all hook runs once and backend selection/plan-mode state is reset to empty maps for all threads. |

## Live Smoke Configuration

The live-provider transport smoke suite is intentionally separate from the deterministic integration tests because it depends on real credentials, network reachability, provider availability, and spend controls. It is only meant for explicit local or gated CI runs.

- Enable the suite with `VSCODE_VSCLONE_E2E_LIVE_PROVIDER_TESTS=1`.
- Provide bearer tokens with `VSCODE_VSCLONE_E2E_OPENAI_ACCESS_TOKEN`, `VSCODE_VSCLONE_E2E_ANTHROPIC_ACCESS_TOKEN`, and `VSCODE_VSCLONE_E2E_GOOGLE_ACCESS_TOKEN`.
- The smoke harness automatically adds the same provider-required defaults the browser OAuth service uses today:
  OpenAI: `OpenAI-Beta: responses=v1`, `OpenAI-Originator: codex`
  Anthropic: `anthropic-version: 2023-06-01`, `anthropic-beta: oauth-2025-04-20`
  Google: `x-goog-user-project` when `defaultOAuthProviderConfig.google.quotaProject` resolves
- Optional per-provider header overrides can still be supplied via `VSCODE_VSCLONE_E2E_OPENAI_HEADERS_JSON`, `VSCODE_VSCLONE_E2E_ANTHROPIC_HEADERS_JSON`, and `VSCODE_VSCLONE_E2E_GOOGLE_HEADERS_JSON` for cases such as `ChatGPT-Account-Id`.
- Run the suite with `npm run test-node -- --runGlob '**/vsclone/test/electron-main/vscloneLLMMessageLiveProviderSmoke.test.js'`.

## GitHub Actions Configuration

GitHub-hosted runners do not share any local VSClone secret storage or interactive browser session, so the CI path must mint fresh access tokens during the job. The repository now includes [.github/workflows/run-vsclone-live-provider-smoke.yml](/Users/brandonhowe/Documents/NJIT/vsclone/.github/workflows/run-vsclone-live-provider-smoke.yml) plus [build/azure-pipelines/common/mintVSCloneLiveProviderTokens.ts](/Users/brandonhowe/Documents/NJIT/vsclone/build/azure-pipelines/common/mintVSCloneLiveProviderTokens.ts), which exchange provider refresh tokens for short-lived access tokens and export them into `GITHUB_ENV` under the names the smoke suite already reads.

- Configure a GitHub Actions environment named `vsclone-live-providers`.
- Store refresh-token secrets in that environment:
  `VSCODE_VSCLONE_E2E_OPENAI_REFRESH_TOKEN`, `VSCODE_VSCLONE_E2E_ANTHROPIC_REFRESH_TOKEN`, `VSCODE_VSCLONE_E2E_GOOGLE_REFRESH_TOKEN`
- Store the Google desktop OAuth client configuration there as well:
  `VSCODE_VSCLONE_GOOGLE_CLIENT_ID`, `VSCODE_VSCLONE_GOOGLE_CLIENT_SECRET`
- If Google billing/quota must target a specific project instead of the project inferred from the client ID, also store `VSCODE_VSCLONE_GOOGLE_QUOTA_PROJECT`.
- Optional provider-specific header overrides can still be supplied as environment secrets through `VSCODE_VSCLONE_E2E_OPENAI_HEADERS_JSON`, `VSCODE_VSCLONE_E2E_ANTHROPIC_HEADERS_JSON`, and `VSCODE_VSCLONE_E2E_GOOGLE_HEADERS_JSON`.
- The minting helper warns when a provider rotates its refresh token, because GitHub Actions jobs cannot update repository secrets automatically. In that case the stored refresh-token secret must be refreshed manually before the next scheduled run.
