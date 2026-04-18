# VSClone Structural Port Stabilization Plan

This document starts after the source-level implementation of
`vsclone-void-structural-port-plan.md` is landed. The migration work is largely
done in source; the goal now is to turn that source-complete state into a
verified, shippable application state.

## Goal

Establish real confidence in the migrated VSClone stack by replacing
"source-level looks correct" with repeatable build, test, smoke, and review
signals.

## Working Assumptions

- OAuth remains the live credential path.
- Large structural rewrites are now lower priority than validation and bug
  fixing.
- The highest-risk surfaces are:
  - `vscloneLLMMessage` transport and provider SDK wiring
  - thread/runtime execution and tool approval resume
  - prompt/context shaping
  - view wiring and model/settings integration
  - autocomplete through the shared transport

## Stabilization Phases

### Phase 1: Baseline Validation

1. Rebuild any local generated artifacts needed by VSClone-owned surfaces.
2. Run the fastest trustworthy TypeScript/build checks available in this repo.
3. Record failures in a durable notes file before fixing anything.

Initial command candidates:
- `npm run build-vsclone-preact`
- `npm run compile-check-ts-native`
- `npm run valid-layers-check` once the faster compile pass is clean enough to
  justify the more expensive check

### Phase 2: Focused Test Pass

Run the most relevant automated checks first instead of jumping straight to full
repo validation.

Priority areas:
- prompt/context tests
- thread/runtime tests
- chat thread submission / plan-mode integration tests
- autocomplete tests
- any VSClone-specific browser tests that directly exercise the migrated
  services

If targeted tests fail, fix the failure and rerun only the smallest useful
validation slice before widening the scope.

### Phase 3: Manual Smoke Checklist

If automated validation gets reasonably clean, verify the migrated user-facing
flows manually or document blockers that prevent doing so.

Smoke targets:
- send a normal chat prompt
- stream a tool-calling turn
- approve and reject tool requests
- reload while waiting on approval, then resume
- confirm plan mode remains read-only
- verify autocomplete still requests through the shared transport
- verify model switching and OAuth-backed provider selection still behave

### Phase 4: Review/Fix Loop

Once a pass looks "done enough," do not stop. Enter a review loop:

1. Spawn a `gpt-5.4 xhigh` code-review subagent.
2. Evaluate the findings in the main thread.
3. If findings are actionable, spawn a `gpt-5.4 xhigh` worker or fix locally.
4. Rerun the smallest validation slice that proves the fix.
5. Repeat until reviews return no actionable high-severity issues or only known,
   explicitly accepted residuals.

## Prioritization Rules

1. Fix build/compile errors before tests.
2. Fix correctness regressions before cleanup.
3. Fix persisted-state/runtime bugs before UI polish.
4. Prefer small, validated patches over another broad architectural sweep.

## Exit Criteria

The stabilization effort is only "done" when all of the following are true:

- The best available compile/build checks for the migrated VSClone surfaces are
  clean, or failures are clearly unrelated and documented.
- Relevant targeted tests are passing, or any remaining failures are documented
  as pre-existing / blocked by environment.
- A review/fix loop produces no unresolved high-severity findings.
- Manual smoke coverage is complete or blocked with a concrete reason.
- The notes file reflects:
  - commands run
  - failures found
  - fixes landed
  - residual known risks
