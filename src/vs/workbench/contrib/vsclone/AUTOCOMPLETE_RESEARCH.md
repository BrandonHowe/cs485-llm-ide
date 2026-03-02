# Tab Autocomplete / Ghost Text Research

Research collected Feb 2026 on how AI coding tools implement inline code completions.

---

## How It Works (All Tools)

1. User types code and pauses (~200-500ms debounce)
2. Editor sends **prefix** (code before cursor) + **suffix** (code after cursor) to a fast model
3. Model predicts what goes **in the middle** (Fill-in-the-Middle / FIM)
4. Prediction appears as **ghost text** (semi-transparent) inline in the editor
5. **Tab** accepts full suggestion, **Ctrl+Right** accepts word-by-word, **Esc** dismisses

---

## Cursor Tab (Most Advanced)

### Model
- Custom **Mixture of Experts (MoE)** architecture, fine-tuned from Llama base
- Trained with **online reinforcement learning** on real user accept/reject signals
- The model learns **when NOT to show suggestions** (not heuristic-based)
- New models deployed **several times per day**, training loop completes in 1.5-2 hours
- Result: 21% fewer suggestions shown, but 28% higher acceptance rate

### Infrastructure
- Hosted on **Fireworks** inference engine across US/Europe/Asia
- **~1000+ tokens/sec** via speculative decoding
- **1M+ queries/sec** at peak, billions of completions daily
- Tens of thousands of H100 GPUs on Azure

### Speculative Edits (Cursor's Secret Sauce)
Rather than traditional speculative decoding with a draft model, Cursor exploits the fact that most edits preserve existing code:
- Feeds chunks of the **original code** as speculated tokens
- Model "mostly agrees" with unchanged lines, processing them in parallel
- Only generates new tokens at points of disagreement
- ~13x speedup over vanilla inference

### Three-Layer Cache
1. **Cache warming**: Pre-computes KV cache with file contents as user types
2. **Caching-aware prompt design**: Static context first (cacheable), dynamic context last
3. **Speculative caching**: Pre-computes next suggestion before user presses Tab

### Beyond Simple FIM
- Predicts edits **above** the cursor (e.g., adding imports)
- Multi-location edits within a file
- Cross-file edits
- After accepting, predicts **next editing location** and jumps to it

---

## GitHub Copilot

### Model
- Evolution: 12B Cushman -> GPT-4o mini (fine-tuned) -> **GPT-4.1 Copilot** (current)
- Three-stage training: mid-training on ~10M repos, supervised FIM fine-tuning, RL on quality/relevance

### Context Gathering
1. Collect prefix/suffix from active file
2. Query **20 most recently accessed files** of same language
3. Slice into 60-line sliding windows
4. Compute **Jaccard similarity** between windows and current file
5. Assemble with **"Prompt Wishlist"** system (6 element types, sorted by priority)
6. ~15% of token budget for suffix

### When NOT to Show (Pre-Request Filter)
- **11-feature logistic regression model** decides before making API call
- Features: language, previous accept/reject, time since action, last char before cursor, etc.
- Score < 15% = no request made
- Suppresses after `)` and `]`, activates after `(` and `[`

### Post-Generation Filters
- **Repetition detection**: `foo = foo = foo...` discarded
- **Duplication avoidance**: Already-typed code discarded

---

## Supermaven (Acquired by Cursor)

- **Custom neural architecture** (NOT a Transformer)
- **300K token context window** with cost of 4K-token Transformer
- **Babble model**: Trained on **edit sequences** (`git diff`) not static files
- **Sub-100ms latency** (~250ms in benchmarks)
- Context cached locally, predictions start before you finish typing

---

## Reference Implementation

### Core Architecture
**File:** `src/vs/workbench/contrib/vsclone/browser/vscloneAutocompleteService.ts`

- Registers as `InlineCompletionsProvider` via `ILanguageFeaturesService`
- Provider method: `provideInlineCompletions(model, position, context, token)`

### Constants
```
DEBOUNCE_TIME = 500ms
TIMEOUT_TIME = 60,000ms
MAX_CACHE_SIZE = 20 per document
MAX_PENDING_REQUESTS = 2
MAX_PREFIX_SUFFIX_CHARS = 20,000
Prefix: last 25 lines
Suffix: first 25 lines
```

### Four Prediction Types
1. **`single-line-fill-middle`**: Cursor between code on a line
2. **`single-line-redo-suffix`**: Rewrite rest of line after user edits
3. **`multi-line-start-on-next-line`**: Multi-line after accepting previous completion
4. **`do-not-predict`**: Conditions not met

### Decision Logic
- Empty line -> multiline
- Line prefix empty, suffix >3 chars -> don't predict
- Line suffix <=3 chars -> redo suffix
- Line has prefix content -> fill-middle

### FIM Message Format
```typescript
type LLMFIMMessage = {
    prefix: string;
    suffix: string;
    stopTokens: string[];
}
```
- Single-line stop tokens: `['\r\n', '\n']`
- Multi-line stop tokens: `['\n\n']`

### Post-Processing Pipeline
1. Strip markdown artifacts (backticks, code fences)
2. Remove leading whitespace if cursor already indented
3. Suffix deduplication (truncate at overlap with existing suffix)
4. Single-line enforcement (truncate after first newline)
5. Bracket balancing (track open brackets from prefix, truncate at unbalanced close)

### LRU Cache
- Max 20 entries per document
- Cache key: autocompletion ID
- **Cache matching**: Checks if current prefix extends cached completion prefix
- On cache hit, returns cached result trimmed to new position

### Request Management
- Tracks pending completions per document
- If >=2 pending, cancels oldest
- Each request has 60s timeout

---

## Fill-in-the-Middle (FIM) Details

### Two Ordering Schemes
- **PSM**: `<PRE> prefix <SUF> suffix <MID>` (model generates middle)
- **SPM**: `<PRE> <SUF> suffix <MID> prefix` (suffix first, better for caching)

### Model-Specific FIM Tokens
```
CodeLlama:   <PRE> {prefix} <SUF>{suffix} <MID>
Qwen2.5:     <|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>
DeepSeek:    <|fim_begin|>{prefix}<|fim_hole|>{suffix}<|fim_end|>
StarCoder:   <fim_prefix>{prefix}<fim_suffix>{suffix}<fim_middle>
Codestral:   [SUFFIX]{suffix}[PREFIX]{prefix}  (supports multi-file)
```

### Training Findings
- Best results with 50-90% FIM rate during training
- Character-level splitting superior for mid-word cursor positions
- Must be trained with FIM from inception (not fine-tuned after)

---

## VS Code InlineCompletions API

### Provider Interface
```typescript
interface InlineCompletionsProvider {
    provideInlineCompletions(
        model: ITextModel,
        position: Position,
        context: InlineCompletionContext,
        token: CancellationToken
    ): ProviderResult<InlineCompletions>;

    handleItemDidShow?(completions, item, updatedInsertText): void;
    handlePartialAccept?(completions, item, acceptedCharacters): void;
    handleRejection?(completions, item): void;
    disposeInlineCompletions(completions): void;
}
```

### Registration
```typescript
languageFeaturesService.inlineCompletionsProvider.register(
    { pattern: '**' },  // all files
    provider
);
```

### InlineCompletion Item
```typescript
interface InlineCompletion {
    insertText: string | { snippet: string };
    range?: IRange;           // single-line range to replace
    additionalTextEdits?: ISingleEditOperation[];
    command?: Command;        // run after accepting
    completeBracketPairs?: boolean;
}
```

### Trigger Kinds
- `Automatic` (0): Triggered while typing (after debounce)
- `Explicit` (1): Triggered by user gesture (Ctrl+Space / Alt+\)

### Ghost Text Rendering
- Uses `GhostText` and `GhostTextPart` classes
- Rendered as CSS decorations with muted color
- Multi-line supported natively
- File: `src/vs/editor/contrib/inlineCompletions/browser/view/ghostText/ghostTextView.ts`

### Key Commands
- `AcceptInlineCompletion` (Tab)
- `AcceptNextWordOfInlineCompletion` (Ctrl+Right)
- `AcceptNextLineOfInlineCompletion`
- `ShowNextInlineSuggestionAction` (Alt+])
- `ShowPreviousInlineSuggestionAction` (Alt+[)

### Key Import Paths
```typescript
import { InlineCompletionsProvider, InlineCompletion, InlineCompletionContext, InlineCompletionTriggerKind } from 'vs/editor/common/languages';
import { ILanguageFeaturesService } from 'vs/editor/common/services/languageFeatures';
```

---

## Debouncing Across Tools

| Tool | Debounce | Cancellation |
|------|----------|-------------|
| VS Code core | ~50ms max | CancellationToken to providers |
| Copilot | Internal | Adapts cached results |
| Cursor | Activity monitoring | HTTP cancellation |
| Continue.dev | 250ms default | Cancel pending on new keystrokes |
| VSClone implementation | 500ms | Cancel oldest if >=2 pending |

---

## Open-Source Implementations

### Continue.dev
- TypeScript, VS Code + JetBrains
- FIM templates for all major models in `AutocompleteTemplate.ts`
- 250ms debounce, 150ms model timeout, max 1024 prompt tokens
- https://github.com/continuedev/continue

### Tabby
- Rust server + TypeScript extension, self-hosted
- Tree-sitter for symbol extraction, BM25 for snippet retrieval
- https://github.com/TabbyML/tabby

### llama.vscode (GGML p1)
- Fully local via llama.cpp, 3B-20B models
- Ring buffer of recent file activities for context
- Speculative decoding with draft models on CPU
- https://github.com/ggml-org/llama.vscode

### Sourcegraph Cody
- Default model: DeepSeek V2, 500ms latency target
- https://github.com/sourcegraph/cody

---

## Backend Options for VSClone

### Option A: Existing Cloud APIs (OpenAI / Anthropic / Google)
- **Pros**: Already integrated, no extra setup
- **Cons**: Higher latency (~500ms-2s), cost per completion, chat models not ideal for FIM
- **Approach**: Use system message + `<CURSOR>` marker to simulate FIM via chat API
- **Best models**: GPT-4o-mini, Claude 3 Haiku, Gemini Flash (fast + cheap)

### Option B: Local FIM Server (Ollama / vLLM / llama.cpp)
- **Pros**: Fastest latency (~100-300ms), free, native FIM support, purpose-built models
- **Cons**: Requires server setup, hardware requirements
- **Best models**: Qwen2.5-Coder-7B, DeepSeek-Coder-V2-Lite, StarCoder2-3B
- **Approach**: HTTP endpoint accepting `{ prefix, suffix, max_tokens }`, returns raw completion text
- **Setup**: `ollama run qwen2.5-coder:7b` then POST to `http://localhost:11434/api/generate`

### Option C: Custom Server Running FIM Model
- **Pros**: Full control over model, caching, batching
- **Cons**: Most setup work
- **Approach**: vLLM or TGI server with a FIM model, exposed as HTTP API
- **FIM-native**: Send actual FIM tokens to the model, get raw completion back

### Recommendation
Start with **Option B or C** (local model) for the best experience. A 7B FIM model on a decent GPU gives ~100-300ms latency. Fall back to **Option A** (cloud API) for users without local GPU. The architecture should support both via a simple interface:

```typescript
interface ICompletionBackend {
    complete(prefix: string, suffix: string, maxTokens: number): Promise<string>;
}
```
