# Phase 3 Prompt Slice Notes

- Scope intentionally limited to prompt/context assembly files so concurrent work on model settings,
  runtime wiring, and autocomplete can proceed without merge pressure.
- `gatherContext()` now returns only active-editor context for prompt assembly. Repository structure,
  open tabs, and diagnostics are no longer gathered eagerly for every turn.
- The system message now carries:
  - base prompt instructions
  - system information
  - XML tool definitions and tool-use policy
  - active-file summary and selected-code preview
  - plan/act turn policy
- The active-file section no longer embeds the full file contents. It reports file identity, file
  size, cursor or selection location, and a capped preview of the selected code when one exists.
- Plan mode remains intact through the existing mode-specific tool filtering and turn-policy copy.
