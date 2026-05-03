# Tab Completion Research Notes

This note summarizes public approaches used by modern AI code-completion systems and translates
them into practical VSClone improvements. The goal is not to reproduce Cursor's custom
post-trained autocomplete model, but to capture the parts of the product architecture that can
improve VSClone with ordinary FIM-capable models, better context, stricter post-processing, and
local editor signals.

## Current VSClone Baseline

VSClone already has a useful inline-completion foundation:

- an editor inline-completions provider
- bounded prefix and suffix extraction
- adaptive debounce
- a short-lived per-document completion cache
- single-line versus multi-line prediction modes
- limited open-tab cross-file context for multi-line requests
- dedicated FIM request shaping and provider fallback
- post-processing for markdown wrappers, suffix overlap, repeated lines, and bracket imbalance

The main weakness is that too many situations are handled as the same generic `<CURSOR>` fill
request. That makes quality depend heavily on the model's raw behavior, while stronger tools
combine specialized autocomplete models with richer retrieval, editor semantics, and aggressive
quality gates before showing ghost text.

## What Other Systems Emphasize

### Cursor

Cursor presents Tab as more than text continuation. Public docs describe multi-line edit
suggestions, automatic import edits, next-cursor jumps, cross-file suggestions, partial accepts,
and configuration for comments, whitespace-only suggestions, and imports.

The key product lesson is that "tab completion" is increasingly a next-edit system. Cursor can
invest in a custom post-trained model, but the visible user experience also depends on editor
signals that VSClone can approximate without training: recent edits, imports, diagnostics, syntax,
and next-location prediction.

Source: <https://docs.cursor.com/tab/overview>

### GitHub Copilot

Copilot's inline suggestions in VS Code use ghost text, partial acceptance, and context from the
current editor plus surrounding workspace/editor state. VS Code's public Copilot docs also
highlight next edit suggestions, where the assistant proposes edits beyond the current cursor when
there is enough local signal.

The practical lesson is latency and mode discipline. Inline suggestions need to feel immediate,
and suggestions that arrive too late are usually worse than no suggestion. Fallback chains that are
reasonable for chat can make inline completion feel stale when the user keeps typing.

Sources:

- <https://code.visualstudio.com/docs/copilot/ai-powered-suggestions>
- <https://code.visualstudio.com/docs/copilot/copilot-vscode-features>

### Continue

Continue explicitly treats autocomplete as a separate model role from chat. Its documentation
recommends models designed for fill-in-the-middle completion, and its autocomplete flow describes
prefix/suffix construction, context selection, caching, debouncing, stop tokens, and output
filtering.

The important lesson for VSClone is model routing. A general chat model can be excellent in chat
and still mediocre at inline completion. Autocomplete should prefer FIM-capable coding models,
then fall back to general models only when no better option is available.

Sources:

- <https://docs.continue.dev/customize/model-roles/autocomplete>
- <https://docs.continue.dev/features/autocomplete/context-selection>
- <https://docs.continue.dev/ide-extensions/autocomplete/how-it-works>

### Tabby

Tabby separates completion, embedding, and repository context. Public docs describe code
completion backed by server-side models, plus context providers that can use repository indexing,
language-server declarations, source parsing, recent files, and other local signals.

The practical lesson is that cross-file context should not be "first N characters of open tabs."
Completion quality improves when retrieval can find definitions, imports, sibling files, and
recently edited code that share symbols with the cursor location.

Sources:

- <https://tabby.tabbyml.com/docs/administration/model/>
- <https://tabby.tabbyml.com/docs/administration/context/>
- <https://tabby.tabbyml.com/api/completion/>

## Research Direction

Fill-in-the-middle training is a real advantage. Research on FIM shows that models trained to
condition on both prefix and suffix are better suited to code insertion than models prompted as
generic chat assistants. Cross-file studies also show that repository-level context helps when the
current file depends on declarations elsewhere. Syntax-aware infilling work points in the same
direction: completions improve when generation and filtering respect parse structure rather than
plain strings alone.

Useful references:

- "Efficient Training of Language Models to Fill in the Middle":
  <https://arxiv.org/abs/2207.14255>
- "CoCoMIC: Code Completion By Jointly Modeling In-file and Cross-file Context":
  <https://arxiv.org/abs/2212.10007>
- "Syntax-Aware Fill-in-the-Middle":
  <https://arxiv.org/abs/2403.04814>

## Recommended VSClone Improvements

### 1. Prefer FIM-Capable Autocomplete Models

Autocomplete should have its own model policy. Chat-quality models should not automatically be
treated as good inline-completion models. VSClone should score models for the Autocomplete feature
by:

- native FIM support
- low latency
- coding specialization
- low verbosity
- stable stop-token behavior
- low cost per keystroke

This is the closest practical substitute for Cursor's custom model. It does not require training,
but it does require treating autocomplete as its own workload.

### 2. Split Prediction Modes More Precisely

The current `single-line` and `multi-line` split should become a richer internal mode set:

- line continuation
- empty-line block continuation
- fill-middle
- member access after `.`
- argument completion inside calls
- comment/docstring continuation
- diagnostics-driven fix

Each mode should have different prompt wording, token budgets, stop tokens, and quality gates. A
member-access completion should be short and conservative; an empty-line block continuation can be
longer and should include more cross-file context.

### 3. Improve Retrieval Beyond Open Tabs

Cross-file context should be selected from signals that correlate with the current cursor:

- imported files
- same-directory files
- files edited recently in the session
- files with matching symbols from the current prefix
- language-server definitions and declarations
- diagnostics near the cursor
- test files paired with implementation files

Snippets should be extracted around relevant symbols or imports instead of taking the beginning of
a file. The current open-tab sampling is useful as a fallback, but it should not be the main
retrieval strategy.

### 4. Add Deterministic Local Suggestions Before Network Calls

Some completions should not require a model request:

- closing brackets and quotes
- repeated local patterns
- recently accepted completion continuations
- import paths
- object keys visible in the current file
- enum members and obvious identifier completions from the language server

This makes the system feel faster and reduces the number of weak model calls.

### 5. Make Post-Processing Language-Aware

Current post-processing is mostly string-based. It should use language configuration and editor
services where possible:

- reject closing delimiters already present in the suffix
- normalize indentation using the surrounding block
- suppress suggestions that start with impossible tokens for the mode
- detect comment/string contexts
- avoid completing scope exits unless the cursor is already at that structural boundary
- reject output that repeats suffix lines or existing prefix lines

This is especially important when using general models as fallback, because they are more likely to
wrap, explain, or over-complete.

### 6. Tighten Cache Keys

The completion cache should preserve indentation and suffix-sensitive state. Cache keys should
include:

- exact prefix tail, not only a trimmed prefix
- suffix hash
- language id
- prediction mode
- model selection
- nearby model version or alternative version id

Bad cache reuse is highly visible because it makes ghost text feel disconnected from the current
cursor state.

### 7. Reduce Inline Timeout and Retry Aggressively Less

An 8 second request timeout is too long for inline completion. VSClone should use a short inline
budget, likely around 1.2 to 2 seconds, and avoid model fallback chains while the user is actively
typing. If the first autocomplete model misses the latency window, the UI should usually show
nothing and wait for the next trigger.

Longer retries can still be useful for explicit commands, but ghost text should optimize for
freshness over eventual success.

### 8. Track Acceptance Telemetry

VSClone needs quality feedback even without training a model. Track:

- request latency
- prediction mode
- model identifier
- context source mix
- shown suggestions
- accepted suggestions
- partial accepts
- dismissed suggestions
- suggestions overwritten shortly after accept
- cache hits versus model hits

This enables local tuning of debounce, mode selection, model routing, and context retrieval. The
data does not need to leave the machine to be useful.

### 9. Add a Minimal Next-Edit Layer

After a completion is accepted, VSClone can cheaply predict where the user is likely to edit next:

- next placeholder-like token
- next diagnostic
- next TODO/import error
- next repeated edit location in the same file
- next matching symbol occurrence

This would approximate one of Cursor and Copilot's strongest product features without requiring a
custom next-edit model.

## Suggested Implementation Order

1. Add telemetry for shown, accepted, rejected, latency, mode, and model.
2. Reduce inline timeout and disable slow fallback retries for normal typing.
3. Split prompt modes for line continuation, blank-line block continuation, fill-middle, and member
   access.
4. Replace open-tab-only context scoring with imported-file, same-directory, recent-edit, and
   symbol-overlap scoring.
5. Prefer FIM-capable models in Autocomplete model selection.
6. Tighten cache keys around exact prefix/suffix/mode/version state.
7. Add language-aware post-processing guards.
8. Add deterministic local suggestions for low-risk completions.
9. Add same-file next-edit prediction after accepted completions.

The first four items should noticeably improve quality and feel before attempting larger
repository indexing or next-edit workflows.
