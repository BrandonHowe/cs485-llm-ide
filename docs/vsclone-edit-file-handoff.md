## VSClone `edit_file` Handoff

### Issue Summary

VSClone was frequently failing `edit_file` calls even when the model had already read the target file. The failure showed up in the UI as either:

- `No SEARCH/REPLACE blocks found in changes parameter.`
- `One or more SEARCH blocks did not match ...`

The logs showed that the model was often calling `edit_file` with malformed `changes` payloads instead of valid newline-delimited SEARCH/REPLACE blocks. One observed example was:

```text
[VSCloneToolExecution] Executing edit_file (path=main.js, changes=<<<<<<< SEARCH "Bike courier chaos in a ti)
```

That payload starts with the delimiter token, but it is not a valid block in the required format.

### Root Causes

1. Prompt and tool-contract guidance for `edit_file` was too weak.
The prompt said to use SEARCH/REPLACE blocks, but it did not make the required block shape explicit enough. In practice, the model still emitted prose or partial block syntax inside the `changes` field.

2. The edit engine had a parser mismatch for single-file tool edits.
`edit_file` already resolves a concrete target URI before handing the payload to the edit engine, but the shared parser still expected nearby `File:` headers. That mismatch meant a single-file payload could pass tool-level preflight and still be dropped by the engine.

### Changes Made

#### 1. Strengthened the `edit_file` contract in prompts and tool metadata

Updated:

- `src/vs/workbench/contrib/vsclone/common/vscloneToolDefinitions.ts`
- `src/vs/workbench/contrib/vsclone/common/vsclonePrompts.ts`

What changed:

- The `edit_file` parameter description now says that `changes` must contain only SEARCH/REPLACE blocks using the exact delimiter lines.
- The act-mode prompt now includes the literal required format:

```text
<<<<<<< SEARCH
<exact existing text>
=======
<replacement text>
>>>>>>> REPLACE
```

- The turn-policy text now explicitly tells the model not to put prose, explanations, or summaries into the `changes` field.

#### 2. Improved malformed-payload handling and logging

Updated:

- `src/vs/workbench/contrib/vsclone/browser/vscloneToolExecutionService.ts`

What changed:

- Malformed `edit_file` payloads now return an error message that includes the exact required block format instead of only saying that no SEARCH/REPLACE blocks were found.
- Added warning logs for:
  - `edit_file` called without SEARCH/REPLACE blocks
  - `edit_file` called with an empty SEARCH block
- The warning includes a short preview of the bad payload so the failure is diagnosable from logs.

#### 3. Fixed the single-file parser mismatch in the edit engine

Updated:

- `src/vs/workbench/contrib/vsclone/browser/vscloneEditCodeService.ts`

What changed:

- `parseSearchReplaceBlocks(...)` now accepts a default target file path.
- When `edit_file` has already resolved the target URI, the engine now accepts bare SEARCH/REPLACE blocks without requiring a `File:` line.

### Test Coverage Added

Updated:

- `src/vs/workbench/contrib/vsclone/test/browser/vscloneEditCodeService.test.ts`
- `src/vs/workbench/contrib/vsclone/test/browser/vscloneToolExecutionService.test.ts`
- `src/vs/workbench/contrib/vsclone/test/common/vsclonePrompts.test.ts`
- `src/vs/workbench/contrib/vsclone/test/common/vscloneToolDefinitions.test.ts`

Coverage added for:

- single-file `instantlyApplySearchReplaceBlocks(...)` with bare SEARCH/REPLACE blocks
- prompt text including the exact `edit_file` format guidance
- malformed `edit_file` payloads producing the stronger error message
- malformed `edit_file` payloads emitting warning logs

### Validation

Completed:

- `git diff --check`
- `npm run compile-check-ts-native -- --pretty false`

Not completed in this handoff:

- manual end-to-end validation in the running dev app after rebuild

### Rebuild / Run

`./scripts/dev.sh` is the right local workflow for this repo. It:

- starts `npm run watch`
- waits for fresh build artifacts in `out/`
- launches the dev app via `scripts/code.sh`

That means it should rebuild VSClone changes and keep watching them.

### Remaining Follow-Up

The current fix improves the contract and makes failures diagnosable, but one further improvement is still worth considering:

- add a runtime corrective reprompt when `edit_file` fails specifically because the `changes` field is malformed, so the next model turn gets an explicit hidden reminder instead of relying only on the tool error text

