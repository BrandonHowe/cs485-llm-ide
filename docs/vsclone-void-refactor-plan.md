# VSClone -> Void Refactor Plan

This file is the durable working plan for finishing the VSClone rewrite toward the Void architecture.

It is intentionally biased toward structural cleanup over compatibility:

- There are no users to preserve.
- Backward compatibility is not a goal.
- Temporary breakage is acceptable while the architecture is being corrected.
- Tests should not drive architecture during the deletion phase.

The plan is split into two major steps:

1. Remove all the bad code.
2. Add the right code back in based on Void.

## Core Goal

Turn VSClone from a hybrid, partially migrated codebase into a runtime-first system whose ownership boundaries, UI state, execution flow, and persistence model are all close to Void rather than close to the old VSClone history-backed architecture.

In practice, that means:

- one canonical runtime thread model
- one canonical execution path
- one canonical persistence story
- fewer compatibility shims
- fewer duplicate representations of the same thread state
- fewer "legacy import" paths
- fewer UI decisions that depend on old history concepts

## Non-Goals

These should not slow the refactor down:

- preserving old storage formats
- keeping old commands/settings just because they existed
- maintaining tests for deleted architecture
- soft migrations that keep both old and new systems alive for long periods
- incremental compatibility layers unless they materially reduce rewrite cost

## Guiding Rules

Use these rules whenever there is ambiguity:

1. Prefer deletion over adaptation.
2. Prefer one owner over synchronization between multiple owners.
3. Prefer runtime state over history reconstruction.
4. Prefer explicit failure over fallback to old behavior.
5. Prefer vertical Void-shaped slices over piecemeal patching of legacy abstractions.
6. If a name encodes the wrong architecture, rename it or delete it.
7. If a subsystem only exists to bridge from the old model, remove it as soon as callers are gone.

---

## Step 1: Remove All the Bad Code

The goal of Step 1 is to leave VSClone in a smaller, harsher, cleaner state, even if some things are temporarily broken.

### 1.1 Remove Remaining History-Import Shims

Status: highest priority

The largest remaining migration leftovers are the history-import paths in the runtime service.

Delete or collapse:

- `ensureHydratedFromHistory(...)`
- `ensureCatalogImportedFromHistory(...)`
- `importedFromHistory` semantics where they only exist to track old ownership
- any branch behavior that exists only because some threads used to live outside runtime

Target files:

- [src/vs/workbench/contrib/vsclone/browser/vscloneThreadRuntimeService.ts](/Users/brandonhowe/Documents/NJIT/vsclone/src/vs/workbench/contrib/vsclone/browser/vscloneThreadRuntimeService.ts:1)
- [src/vs/workbench/contrib/vsclone/common/vscloneThreadRuntimeTypes.ts](/Users/brandonhowe/Documents/NJIT/vsclone/src/vs/workbench/contrib/vsclone/common/vscloneThreadRuntimeTypes.ts:1)

Desired result:

- runtime threads are either present or absent
- there is no "import this old thread into runtime" behavior
- there is no provenance logic that only exists because history used to be canonical

### 1.2 Remove History-Era Turn Types Where Runtime Types Can Replace Them

Right now, some UI and runtime surfaces still use `IVSCloneChatHistoryTurn` or other history-era types even though history ownership is gone.

Actions:

- replace remaining history-turn usage with runtime message types where feasible
- remove render helpers that still assume history turns as input
- shrink `vscloneChatHistoryTypes.ts` until it contains only types still truly needed

Target files:

- [src/vs/workbench/contrib/vsclone/browser/vscloneUnifiedChatViewPane.ts](/Users/brandonhowe/Documents/NJIT/vsclone/src/vs/workbench/contrib/vsclone/browser/vscloneUnifiedChatViewPane.ts:1)
- [src/vs/workbench/contrib/vsclone/common/vscloneChatHistoryTypes.ts](/Users/brandonhowe/Documents/NJIT/vsclone/src/vs/workbench/contrib/vsclone/common/vscloneChatHistoryTypes.ts:1)

Desired result:

- transcript rendering is runtime-native
- the pane does not need history-shaped turns for normal operation
- old history types become minimal transitional types or disappear entirely

### 1.3 Delete Wrong Names That Still Encode the Old Design

Even after the implementation changes, several names still encode the old architecture and keep dragging the code mentally backward.

Candidates:

- `ChatHistory` in command ids, rail types, UI labels, and internal symbol names
- old settings or telemetry/event names that still claim the rail is "history"
- comments that describe deleted ownership models

Desired rename direction:

- "thread rail"
- "chat rail"
- "thread list"
- "thread catalog"
- "runtime thread"

This does not have to happen all at once, but it should happen steadily so the code starts reading like Void.

### 1.4 Collapse Pane Logic to Runtime-Only Paths

The unified pane should stop carrying dual-model logic.

Actions:

- remove any branches that exist only for legacy-only thread rows
- remove defensive import/reload behavior tied to deleted history ownership
- remove transcript logic that can display threads not backed by runtime state
- simplify explicit actions like open, copy, reuse, archive, delete around runtime state only

Target file:

- [src/vs/workbench/contrib/vsclone/browser/vscloneUnifiedChatViewPane.ts](/Users/brandonhowe/Documents/NJIT/vsclone/src/vs/workbench/contrib/vsclone/browser/vscloneUnifiedChatViewPane.ts:1)

Desired result:

- the pane becomes a renderer for runtime state, not a migration coordinator

### 1.5 Delete Tests That Defend the Old Shape

During Step 1, test deletions are often correct.

Delete or rewrite tests that:

- verify import-from-history behavior
- verify old persistence semantics
- verify legacy fallbacks that should no longer exist
- lock in naming or behavior that was only present because of the old architecture

Keep only tests that still defend desired runtime-first behavior or still describe stable product goals.

### 1.6 Delete Stale Docs and Comments

Documentation that explains deleted systems is now a liability.

Delete or rewrite:

- backend docs describing the old history stack
- comments that still talk about history as the canonical owner
- migration notes that assume dual ownership is still acceptable

Desired result:

- someone reading the repo should not be taught the wrong architecture

### 1.7 End Condition for Step 1

Step 1 is done when these statements are true:

- there is no production path that reconstructs active threads from old history state
- there is no production service whose main job is compatibility with deleted history ownership
- the pane, runtime service, and send path all assume runtime-first ownership
- remaining breakage is additive work, not "we are still carrying the wrong architecture"

---

## Step 2: Add Stuff Back In Based on Void

Step 2 is where the code stops merely being less wrong and starts becoming positively Void-shaped.

The right approach is to rebuild in vertical slices, not to reintroduce generic abstractions first.

### 2.1 Define the Void-Shaped Runtime Model Explicitly

Before adding more behavior, make the runtime model match the intended architecture.

Clarify and enforce:

- what a thread owns
- what a message owns
- what execution state owns
- what checkpoint/edit/apply state owns
- what is persisted vs reconstructed
- what belongs to the pane vs the runtime service vs the agent loop

Target artifacts:

- runtime state interfaces
- runtime serializer/store shape
- comments documenting actual ownership boundaries

Desired result:

- a single thread state model that other systems conform to instead of reinterpret

### 2.2 Port the Conversation UX to Runtime-First Void Patterns

Once the runtime model is correct, reshape the pane and surrounding UI around it.

Likely areas:

- thread selection
- thread list behavior
- composer behavior
- active branch handling
- checkpoint/rewind affordances
- tool approval / paused execution presentation
- edit application display

The rule here is not "match Void pixel-for-pixel."
The rule is "match Void structurally."

### 2.3 Rebuild Execution Flow Around the Correct Model

The agent loop, tool execution path, prompt assembly, and runtime persistence should read like one coherent pipeline.

Actions:

- remove duplicated adaptation logic between session submit, agent loop, and runtime state updates
- make run context and message production follow one obvious lifecycle
- ensure tool approvals and resume behavior are runtime-native
- keep sequence/branch semantics aligned with the runtime branch only

Target files:

- [src/vs/workbench/contrib/vsclone/browser/vscloneChatSessionService.ts](/Users/brandonhowe/Documents/NJIT/vsclone/src/vs/workbench/contrib/vsclone/browser/vscloneChatSessionService.ts:1)
- [src/vs/workbench/contrib/vsclone/browser/vscloneAgentLoopService.ts](/Users/brandonhowe/Documents/NJIT/vsclone/src/vs/workbench/contrib/vsclone/browser/vscloneAgentLoopService.ts:1)
- [src/vs/workbench/contrib/vsclone/browser/vscloneToolExecutionService.ts](/Users/brandonhowe/Documents/NJIT/vsclone/src/vs/workbench/contrib/vsclone/browser/vscloneToolExecutionService.ts:1)
- [src/vs/workbench/contrib/vsclone/browser/vscloneThreadRuntimeService.ts](/Users/brandonhowe/Documents/NJIT/vsclone/src/vs/workbench/contrib/vsclone/browser/vscloneThreadRuntimeService.ts:1)

Desired result:

- one obvious path from prompt submit to runtime updates to UI

### 2.4 Rebuild Persistence Only for the Data That Matters

After the runtime model is right, make persistence match it exactly.

This means:

- persist only runtime state that actually matters across reloads
- avoid rebuilding old index/thread-store complexity unless Void truly needs it
- avoid storing redundant projections when they can be derived cheaply
- ensure the persisted shape serves runtime restoration, not history browsing

The current reduced unified backend is already a good direction:

- selection state
- plan mode state

That approach should continue:

- small, intentional durable state
- no extra architecture just because the old system had it

### 2.5 Port Void Behaviors in Priority Order

Add back behavior in this order:

1. core runtime thread lifecycle
2. correct conversation rendering
3. correct execution/tool loop behavior
4. checkpoint and edit-application behavior
5. rail/list UX and thread actions
6. secondary polish and edge cases

Do not start with polish or peripheral features.

### 2.6 Reintroduce Tests After the Shape Settles

Only once the main ownership model is correct should test rebuilding become a major effort.

Rebuild tests around:

- runtime service invariants
- session submit behavior
- thread lifecycle
- plan mode and selection persistence
- execution/tool approval state transitions
- pane behavior that is truly intended to survive future cleanup

Avoid writing tests for temporary compatibility shims.

### 2.7 End Condition for Step 2

Step 2 is done when:

- the core runtime architecture looks like Void instead of looking like old VSClone with patches
- new features are being added onto the correct substrate
- the remaining work is product polish, not foundational migration

---

## Recommended Execution Order

This is the concrete order I would follow from here.

### Phase A: Finish Deleting the Remaining Wrong Architecture

1. Remove the history-import shims from the runtime service.
2. Remove `importedFromHistory` semantics that no longer matter.
3. Convert pane rendering and thread actions to runtime-native types only.
4. Delete stale tests and comments attached to those shims.
5. Rename obviously wrong history-era identifiers where the rename is cheap.

### Phase B: Normalize the Runtime Model

1. Tighten `vscloneThreadRuntimeTypes.ts`.
2. Simplify serialization/persistence around the real runtime model.
3. Make deletion/archive/clear/reload semantics fully runtime-native.
4. Reconcile any remaining duplicated state between runtime service and UI.

### Phase C: Port Void-Shaped Flow

1. Align session submit and agent loop around one execution pipeline.
2. Align tool execution and approval handling around runtime-owned state.
3. Align pane UX around the runtime model and Void-like thread flow.
4. Align checkpoints and edit application with the intended Void workflow.

### Phase D: Rename and Polish

1. Remove stale names and terminology.
2. Remove leftover dead helpers and compatibility comments.
3. Rebuild focused tests for the architecture that remains.
4. Write fresh docs that describe the new actual shape.

---

## Checkpoint Strategy

Because this branch is intentionally destructive, make checkpoint commits after each major deletion wave.

Recommended checkpoint points:

1. after deleting runtime history-import shims
2. after making the pane fully runtime-native
3. after normalizing runtime persistence/state
4. after the first substantial Void-shaped execution flow pass

The branch does not need to stay green between checkpoints.
It does need to stay directionally correct.

---

## Practical Decision Rule

When choosing between two implementation strategies:

- If one strategy preserves more old code and the other deletes more wrong structure, choose the more destructive one.
- If one strategy makes the next Void-style addition easier, choose that one even if it causes short-term breakage.
- If a subsystem feels hard to migrate because it is structurally wrong, strongly consider deleting it first rather than adapting it.

---

## Current Best Guess for the Biggest Remaining Production Leftovers

These are the parts most likely to still need deletion or heavy reshaping:

- history-import APIs in `vscloneThreadRuntimeService.ts`
- history-era transcript rendering in `vscloneUnifiedChatViewPane.ts`
- history-shaped shared types in `vscloneChatHistoryTypes.ts`
- old naming around "chat history" in commands, rail types, and UI wiring
- any logic that still assumes thread state can exist meaningfully outside runtime

---

## Final Standard

The refactor should be considered successful when VSClone no longer feels like:

- "old VSClone with a Void-inspired cleanup"

and instead feels like:

- "a Void-shaped system implemented inside this codebase"

That is the bar.
