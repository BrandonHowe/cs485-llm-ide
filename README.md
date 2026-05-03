# Visual Studio Code - Open Source ("Code - OSS")
[![Feature Requests](https://img.shields.io/github/issues/microsoft/vscode/feature-request.svg)](https://github.com/microsoft/vscode/issues?q=is%3Aopen+is%3Aissue+label%3Afeature-request+sort%3Areactions-%2B1-desc)
[![Bugs](https://img.shields.io/github/issues/microsoft/vscode/bug.svg)](https://github.com/microsoft/vscode/issues?utf8=✓&q=is%3Aissue+is%3Aopen+label%3Abug)
[![Gitter](https://img.shields.io/badge/chat-on%20gitter-yellow.svg)](https://gitter.im/Microsoft/vscode)

## The Repository

This repository ("`Code - OSS`") is where we (Microsoft) develop the [Visual Studio Code](https://code.visualstudio.com) product together with the community. Not only do we work on code and issues here, we also publish our [roadmap](https://github.com/microsoft/vscode/wiki/Roadmap), [monthly iteration plans](https://github.com/microsoft/vscode/wiki/Iteration-Plans), and our [endgame plans](https://github.com/microsoft/vscode/wiki/Running-the-Endgame). This source code is available to everyone under the standard [MIT license](https://github.com/microsoft/vscode/blob/main/LICENSE.txt).

## VSClone Local Setup

This fork includes VSClone-specific OAuth wiring and launch scripts that are not covered by the stock Code - OSS README. Use the steps below when you want to install dependencies and run the desktop app locally.

### Shared prerequisites

* `git`
* Node.js `22.21.1` or later (the repo checks `.nvmrc` during install)
* `npm` (`yarn` is rejected by the repo preinstall step)

### macOS

1. Install the Apple command line toolchain:

   ```bash
   xcode-select --install
   ```

2. Install and select Node.js `22.21.1` or later. If you use `nvm`, the commands are:

   ```bash
   nvm install 22.21.1
   nvm use 22.21.1
   ```

3. Create the local VSClone OAuth file and fill in your real values:

   ```bash
   cp .env.vsclone.example .env.vsclone
   ```

   Required values:
   * `VSCODE_VSCLONE_GOOGLE_CLIENT_ID`
   * `VSCODE_VSCLONE_GOOGLE_CLIENT_SECRET`
   * `VSCODE_VSCLONE_GOOGLE_QUOTA_PROJECT` (optional)

4. Install dependencies:

   ```bash
   npm ci
   ```

5. Start the desktop dev app:

   ```bash
   ./scripts/dev.sh
   ```

   `./scripts/dev.sh` starts the watch build, waits for the first set of required artifacts, and then launches Electron. After the initial build, you can relaunch more directly with:

   ```bash
   VSCODE_SKIP_PRELAUNCH=1 ./scripts/code.sh
   ```

### Windows

1. Install the native build prerequisites:
   * Visual Studio 2022 or 2019 with Desktop development with C++
   * Node.js `22.21.1` or later

   If Visual Studio is installed outside the default location, set `vs2022_install` or `vs2019_install` before running `npm ci`.

2. Copy the local VSClone OAuth template:

   ```powershell
   Copy-Item .env.vsclone.example .env.vsclone
   ```

3. Export the VSClone OAuth variables in the shell you will launch from. `.\scripts\code.bat` does not currently load `.env.vsclone` automatically:

   ```powershell
   $env:VSCODE_VSCLONE_GOOGLE_CLIENT_ID="your-client-id"
   $env:VSCODE_VSCLONE_GOOGLE_CLIENT_SECRET="your-client-secret"
   $env:VSCODE_VSCLONE_GOOGLE_QUOTA_PROJECT="your-quota-project" # optional
   ```

4. Install dependencies:

   ```powershell
   npm ci
   ```

5. Start the desktop dev app:

   ```powershell
   .\scripts\code.bat
   ```

   For a faster edit/run loop, keep the watcher running in one terminal:

   ```powershell
   npm run watch
   ```

   Then launch from a second terminal with the prelaunch compile skipped:

   ```powershell
   $env:VSCODE_SKIP_PRELAUNCH="1"
   .\scripts\code.bat
   ```

### Packaging installers

Before creating a distributable desktop installer, keep the same Google OAuth values in either build-machine environment variables or the repo-local `.env.vsclone` file. The packaging step copies those values into the packaged `product.json` because an installed app does not run through the development launcher scripts and cannot read this repository's local `.env.vsclone` file from an end user's machine.

## VSClone Local Test Setup

The GitHub Actions workflows in [`.github/workflows/run-frontend-tests.yml`](.github/workflows/run-frontend-tests.yml) and [`.github/workflows/run-backend-tests.yml`](.github/workflows/run-backend-tests.yml) use the commands in this section. If you can run these locally, you are running the same VSClone test slices that CI runs on GitHub.

### Shared prerequisites for frontend and backend tests

* Node.js `22.21.1` or later and `npm`
* The root workspace dependencies installed with `npm ci`
* The `build/` workspace dependencies installed with `cd build && npm ci`
* A current transpiled `out/` tree. For a one-time compile, run:

  ```bash
  npm run gulp transpile-client-esbuild transpile-extensions
  ```

  If you are iterating on VSClone code, keep `npm run watch` running in another terminal so the compiled test targets stay fresh.

* Linux-only native packages for browser and Electron test runs:

  ```bash
  sudo apt-get update
  sudo apt-get install -y pkg-config xvfb libgtk-3-0 libxkbfile-dev libkrb5-dev libgbm1 rpm
  ```

### Run the frontend tests locally

VSClone frontend tests are the browser suites in `src/vs/workbench/contrib/vsclone/test/browser`. They run through Playwright, so you need Chromium installed for Playwright before the first run:

```bash
npm exec -- playwright install chromium
```

Run the full VSClone frontend test slice:

```bash
npm run test-browser-no-install -- --browser chromium --runGlob '**/vsclone/test/browser/**/*.test.js'
```

Run a single frontend suite when you only need one file:

```bash
npm run test-browser-no-install -- --browser chromium --run src/vs/workbench/contrib/vsclone/test/browser/vscloneUnifiedChatViewPane.test.ts
```

### Run the backend tests locally

VSClone backend coverage is split across shared/common backend services and Electron main-process channel code.

Run the shared/common backend suites with Node.js:

```bash
npm run test-node -- --runGlob '**/vsclone/test/common/**/*.test.js'
```

Run the Electron main-process backend suites:

macOS/Linux:

```bash
./scripts/test.sh --runGlob '**/vsclone/test/electron-main/**/*.test.js'
```

Windows:

```powershell
.\scripts\test.bat --runGlob '**/vsclone/test/electron-main/**/*.test.js'
```

On Linux systems without an active desktop session, wrap the Electron command with `xvfb-run -a` so Electron still has a display server:

```bash
xvfb-run -a ./scripts/test.sh --runGlob '**/vsclone/test/electron-main/**/*.test.js'
```

### Important runtime note

Use the desktop launchers above when validating VSClone. `./scripts/code-server.sh`, `.\scripts\code-server.bat`, and the web entrypoints do not register the Electron-only VSClone IPC channels.

## Visual Studio Code

<p align="center">
  <img alt="VS Code in action" src="https://user-images.githubusercontent.com/35271042/118224532-3842c400-b438-11eb-923d-a5f66fa6785a.png">
</p>

[Visual Studio Code](https://code.visualstudio.com) is a distribution of the `Code - OSS` repository with Microsoft-specific customizations released under a traditional [Microsoft product license](https://code.visualstudio.com/License/).

[Visual Studio Code](https://code.visualstudio.com) combines the simplicity of a code editor with what developers need for their core edit-build-debug cycle. It provides comprehensive code editing, navigation, and understanding support along with lightweight debugging, a rich extensibility model, and lightweight integration with existing tools.

Visual Studio Code is updated monthly with new features and bug fixes. You can download it for Windows, macOS, and Linux on [Visual Studio Code's website](https://code.visualstudio.com/Download). To get the latest releases every day, install the [Insiders build](https://code.visualstudio.com/insiders).

## Contributing

There are many ways in which you can participate in this project, for example:

* [Submit bugs and feature requests](https://github.com/microsoft/vscode/issues), and help us verify as they are checked in
* Review [source code changes](https://github.com/microsoft/vscode/pulls)
* Review the [documentation](https://github.com/microsoft/vscode-docs) and make pull requests for anything from typos to additional and new content

If you are interested in fixing issues and contributing directly to the code base,
please see the document [How to Contribute](https://github.com/microsoft/vscode/wiki/How-to-Contribute), which covers the following:

* [How to build and run from source](https://github.com/microsoft/vscode/wiki/How-to-Contribute)
* [The development workflow, including debugging and running tests](https://github.com/microsoft/vscode/wiki/How-to-Contribute#debugging)
* [Coding guidelines](https://github.com/microsoft/vscode/wiki/Coding-Guidelines)
* [Submitting pull requests](https://github.com/microsoft/vscode/wiki/How-to-Contribute#pull-requests)
* [Finding an issue to work on](https://github.com/microsoft/vscode/wiki/How-to-Contribute#where-to-contribute)
* [Contributing to translations](https://aka.ms/vscodeloc)

## Feedback

* Ask a question on [Stack Overflow](https://stackoverflow.com/questions/tagged/vscode)
* [Request a new feature](CONTRIBUTING.md)
* Upvote [popular feature requests](https://github.com/microsoft/vscode/issues?q=is%3Aopen+is%3Aissue+label%3Afeature-request+sort%3Areactions-%2B1-desc)
* [File an issue](https://github.com/microsoft/vscode/issues)
* Connect with the extension author community on [GitHub Discussions](https://github.com/microsoft/vscode-discussions/discussions) or [Slack](https://aka.ms/vscode-dev-community)
* Follow [@code](https://x.com/code) and let us know what you think!

See our [wiki](https://github.com/microsoft/vscode/wiki/Feedback-Channels) for a description of each of these channels and information on some other available community-driven channels.

## Related Projects

Many of the core components and extensions to VS Code live in their own repositories on GitHub. For example, the [node debug adapter](https://github.com/microsoft/vscode-node-debug) and the [mono debug adapter](https://github.com/microsoft/vscode-mono-debug) repositories are separate from each other. For a complete list, please visit the [Related Projects](https://github.com/microsoft/vscode/wiki/Related-Projects) page on our [wiki](https://github.com/microsoft/vscode/wiki).

## Bundled Extensions

VS Code includes a set of built-in extensions located in the [extensions](extensions) folder, including grammars and snippets for many languages. Extensions that provide rich language support (inline suggestions, Go to Definition) for a language have the suffix `language-features`. For example, the `json` extension provides coloring for `JSON` and the `json-language-features` extension provides rich language support for `JSON`.

## Development Container

This repository includes a Visual Studio Code Dev Containers / GitHub Codespaces development container.

* For [Dev Containers](https://aka.ms/vscode-remote/download/containers), use the **Dev Containers: Clone Repository in Container Volume...** command which creates a Docker volume for better disk I/O on macOS and Windows.
  * If you already have VS Code and Docker installed, you can also click [here](https://vscode.dev/redirect?url=vscode://ms-vscode-remote.remote-containers/cloneInVolume?url=https://github.com/microsoft/vscode) to get started. This will cause VS Code to automatically install the Dev Containers extension if needed, clone the source code into a container volume, and spin up a dev container for use.

* For Codespaces, install the [GitHub Codespaces](https://marketplace.visualstudio.com/items?itemName=GitHub.codespaces) extension in VS Code, and use the **Codespaces: Create New Codespace** command.

Docker / the Codespace should have at least **4 Cores and 6 GB of RAM (8 GB recommended)** to run a full build. See the [development container README](.devcontainer/README.md) for more information.

## Code of Conduct

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## License

Copyright (c) Microsoft Corporation. All rights reserved.

Licensed under the [MIT](LICENSE.txt) license.
