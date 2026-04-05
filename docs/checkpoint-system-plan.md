# Checkpoint System Implementation Plan

## Research Summary

### How Other Tools Do It

#### Cursor
- **Storage**: Zips up pre-change state into local hidden directory, separate from git history
- **Scope**: Whole-workspace snapshots, not per-file
- **Automatic**: Every AI agent request creates a checkpoint automatically
- **UI**: "Restore Checkpoint" button in the chat input box area; "+" button appears on hover over messages in chat history
- **Manual edits**: NOT captured. If you restore a checkpoint, manual edits made after that point are lost
- **Branching**: No explicit branching. After restoring, you just write a new message
- **Cleanup**: Ephemeral, session-specific. Wiped when no longer useful

#### Claude Code (CLI)
- **Storage**: Tracks file edits made through its file editing tools
- **Scope**: All files touched by Claude's editing tools in the session
- **Automatic**: Every user prompt creates a checkpoint
- **UI**: Press Esc twice or `/rewind` to open a scrollable list of prompts. Select one, then choose an action
- **Restore options**: Three modes:
  1. **Code + conversation** - revert both
  2. **Code only** - revert files but keep Claude's understanding
  3. **Conversation only** - keep code but reset context
- **Limitations**: Does NOT track files modified by bash commands. Only direct file edits
- **Persistence**: Checkpoints persist across sessions (30-day cleanup)

#### Windsurf (Cascade)
- **Storage**: Snapshots of project state at each step
- **Scope**: Whole project state
- **Automatic**: Per-message revert via hover arrow. Also supports named/manual checkpoints
- **UI**: Hover over original prompt -> click revert arrow, or use table of contents
- **Critical limitation**: Reverts are currently irreversible

### Common Patterns Across Tools
1. Checkpoints are automatic, created at each AI interaction
2. They track AI-initiated changes only, not user manual edits
3. Restoration is all-or-nothing for a given checkpoint point
4. They complement git, not replace it
5. UI is typically inline in the chat message timeline

---

## Current State in VSClone

VSClone already has a substantial checkpoint/timeline infrastructure:

### Existing Components
| File | Purpose |
|------|---------|
| `chatEditingCheckpointTimeline.ts` | Interface: `IChatEditingCheckpointTimeline` with create/navigate/undo/redo checkpoint methods |
| `chatEditingCheckpointTimelineImpl.ts` | Implementation: epoch-based timeline tracking operations and checkpoints |
| `chatEditingOperations.ts` | Data model: `FileOperation` types (Create, Delete, Rename, TextEdit, NotebookEdit) |
| `chatEditingSession.ts` | Session: `restoreSnapshot()`, undo/redo interaction, snapshot content APIs |
| `chatEditingSessionStorage.ts` | Persistence: `StoredSessionState` for serializing/restoring sessions |
| `chatEditingActions.ts` | Actions: `restoreSnapshotWithConfirmation`, `RestoreCheckpoint` action, `UndoEdits` action |
| `chatListRenderer.ts` | UI: `checkpointContainer`, `checkpointRestoreContainer`, bookmark icons, toolbars |
| `chatModel.ts` | Model: `checkpoint` property, `setCheckpoint()`, `resetCheckpoint()`, request blocking |
| `constants.ts` | Config: `ChatConfiguration.CheckpointsEnabled` setting |

### How It Currently Works
1. **Checkpoint creation**: `createCheckpoint(requestId, undoStopId, label)` in the timeline impl creates epoch-stamped checkpoints
2. **Operations tracked**: Every file create/delete/rename/text-edit/notebook-edit is recorded as a `FileOperation` with an epoch
3. **Navigation**: `navigateToCheckpoint()` reconstructs file state by replaying operations up to the target epoch
4. **UI**: Checkpoint bookmark icon and toolbar appear on chat request messages. A "Checkpoint Restored" bar shows when rewound
5. **Blocked requests**: When a checkpoint is set, all requests after it are "blocked" (grayed out visually)
6. **Restore flow**: User clicks checkpoint action -> confirmation dialog -> `restoreSnapshot()` called -> files reverted on disk

### What's Missing / Needs Enhancement

Based on the user's request ("save diffs after every single message the agent does that has diffs and then rewind back to that point"), the existing infrastructure is largely in place but may need:

1. **Verification**: Confirm checkpoints are actually being created for every agent response that produces file edits
2. **User-facing polish**: The checkpoint UI (behind `chat.checkpoints.enabled` config) may need to be enabled by default or made more discoverable
3. **Handling user edits on rewind**: The key subtlety - what happens to manual edits made between checkpoints

---

## Implementation Plan

### Phase 1: Audit & Enable Existing Checkpoint System

**Goal**: Verify the existing system works end-to-end and is enabled.

1. **Check default config** - Ensure `chat.checkpoints.enabled` defaults to `true` (or change it)
   - File: `src/vs/workbench/contrib/chat/common/constants.ts`
   - File: `src/vs/workbench/contrib/chat/browser/chat.contribution.ts` (registration)

2. **Verify checkpoint creation per agent response** - Trace the code path from chat response completion to checkpoint creation
   - File: `src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingSession.ts`
   - Confirm `createCheckpoint()` is called at the right time (after each response with diffs)

3. **Test the restore flow** - Manually test: send agent request -> get edits -> click checkpoint -> verify files revert

### Phase 2: Handle the "User Edits After Checkpoint" Problem

**Goal**: Address the key subtlety - what happens when a user has made manual edits after an AI checkpoint and wants to rewind.

**Options** (in order of recommended priority):

#### Option A: Warn-and-Confirm (Simplest, matches Cursor)
- When restoring a checkpoint, detect if there are uncommitted user-initiated changes to any file that would be affected
- Show a confirmation dialog listing files with manual changes that will be lost
- This is essentially what the existing `restoreSnapshotWithConfirmation` already does

**Implementation**:
- Enhance `restoreSnapshotWithConfirmationByRequestId` to also detect user-initiated changes (not just agent changes)
- Compare current file contents against the last checkpoint's recorded state
- If there are differences not attributable to agent edits, warn the user

#### Option B: Stash User Changes (More Sophisticated)
- Before restoring a checkpoint, automatically save the user's manual edits to a stash
- After restoring, offer to re-apply the stashed changes (like `git stash pop`)
- This prevents data loss but adds complexity

**Implementation**:
- Create a `ChatEditingCheckpointStash` that saves current file contents before restore
- Add "Re-apply stashed changes" action after restore
- Store stashes as in-memory snapshots (not git stash)

#### Option C: Three-Way Merge (Most Sophisticated)
- Treat checkpoint restore as a three-way merge between: original (checkpoint state), theirs (agent changes), ours (user changes)
- This is complex and probably overkill for v1

**Recommendation**: Start with Option A (warn-and-confirm), which largely exists already. Consider Option B as a follow-up enhancement.

### Phase 3: UI Enhancements

**Goal**: Make the checkpoint system more visible and intuitive.

1. **Per-message checkpoint indicator** - Show a small diff summary badge on each chat message that produced file changes
   - File: `src/vs/workbench/contrib/chat/browser/widget/chatListRenderer.ts`
   - Use the existing `getDiffsForFilesInRequest()` to compute per-request diff stats
   - Show something like: "3 files changed (+45 / -12)" next to the checkpoint bookmark

2. **Checkpoint timeline sidebar** (optional, more ambitious)
   - A mini-timeline view showing all checkpoints in the session
   - Each entry shows: timestamp, request summary, files changed, diff stats
   - Click to preview, double-click to restore
   - Similar to Windsurf's "table of contents" approach

3. **Restore feedback** - After restoring, show a toast/notification listing what was reverted
   - File: `src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingActions.ts`

### Phase 4: Persistence & Cleanup

**Goal**: Ensure checkpoints survive across sessions and are cleaned up properly.

1. **Verify persistence** - The `ChatEditingSessionStorage` already handles serialization. Confirm it captures all checkpoint state
   - File: `src/vs/workbench/contrib/chat/browser/chatEditing/chatEditingSessionStorage.ts`

2. **Cleanup policy** - Ensure old checkpoints are cleaned up (disk space concern for large workspaces)
   - Checkpoints for closed/old sessions should be pruned

### Phase 5: Edge Cases & Robustness

1. **File deleted externally** - If a user deletes a file that a checkpoint references, handle gracefully
2. **Concurrent editing** - If another process (terminal, other editor) modifies a file, those changes are not in any checkpoint. Document this limitation
3. **Large binary files** - Skip binary files from checkpoint snapshots or limit snapshot size
4. **New file creation then rewind** - If the agent created a new file and user rewinds past that point, the file should be deleted from disk

---

## Key Architecture Decisions

### Q: Should checkpoints use git under the hood?
**A: No.** The existing implementation uses an epoch-based operation log, which is lightweight and doesn't pollute git history. This matches Cursor and Claude Code's approach. Git remains the user's tool for permanent history.

### Q: Per-file or whole-workspace snapshots?
**A: Operation-based (effectively per-file).** The existing `FileOperation` system records individual file operations, which is more efficient than zipping the whole workspace. State is reconstructed by replaying operations.

### Q: What about files modified by terminal/bash commands?
**A: Not tracked**, matching Claude Code's limitation. Only edits made through the chat editing system are checkpointed. Document this clearly.

### Q: Can the user "branch" from a checkpoint?
**A: Yes, implicitly.** After restoring to a checkpoint, the user can send a new message which effectively creates a new branch of history. The "blocked" requests after the checkpoint remain in the UI but are grayed out. This matches Cursor's behavior.

---

## Files to Modify (Summary)

| Priority | File | Change |
|----------|------|--------|
| P0 | `chat.contribution.ts` | Verify/enable `checkpoints.enabled` default |
| P0 | `chatEditingSession.ts` | Verify checkpoint creation on every response with diffs |
| P1 | `chatEditingActions.ts` | Enhance restore confirmation to detect user manual changes |
| P1 | `chatListRenderer.ts` | Add per-message diff stats badge |
| P2 | `chatEditingSessionStorage.ts` | Verify persistence works correctly |
| P2 | `chatChangesSummaryPart.ts` | Enhance the changes summary display |
| P3 | New file: checkpoint timeline view | Optional sidebar timeline |

## Estimated Scope
- **Phase 1** (Audit & Enable): Small - mostly verification and config changes
- **Phase 2** (User edits handling): Medium - enhance existing confirmation flow  
- **Phase 3** (UI): Medium - add badges and improve discoverability
- **Phase 4** (Persistence): Small - verify existing infrastructure
- **Phase 5** (Edge cases): Ongoing - handle as discovered
