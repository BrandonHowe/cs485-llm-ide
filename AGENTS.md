# VS Code Agents Instructions

This file provides instructions for AI coding agents working with the VS Code codebase.

For detailed project overview, architecture, coding guidelines, and validation steps, see the [Copilot Instructions](.github/copilot-instructions.md).

## Additional rules

- Avoid using excessive callbacks or writing spaghetti code
- ALWAYS comment everything you do explaining the rationale and design, don't add useless comments that just describe the code, add useful comments that explain the why
- ALWAYS update comments when you change something in a way that invalidates previous comments or warrants additional specifications
- ALWAYS DOCUMENT NON OBVIOUS BEHAVIOR AND INTENT. If something is not immediately obvious or clear from just reading the code in that file, document it with comments. This is of utmost importance.
- ALWAYS REMOVE OR UPDATE COMMENTS IF THEY ARE OUT OF DATE.

### Testing

- Whenever adding or updating VSClone code, make sure to add or update tests for the code.
- Do not write flaky tests or hardcoded tests, it is perfectly fine if tests fail!
- When removing code or updating functionality, make sure to update or remove the tests accordingly. Do not leave outdated tests.
- Always spawn a subagent to write tests, tell the subagent that someone else wrote the code and you are unsure of its quality and that you would like to write some tests to see if the code is buggy.
