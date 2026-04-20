/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

interface IPackageJsonLike {
	scripts?: Record<string, string | undefined>;
}

suite('VSClone build scripts', () => {
	const currentDirectory = dirname(fileURLToPath(import.meta.url));
	const repositoryRoot = join(currentDirectory, '..', '..', '..');
	const packageJsonPath = join(repositoryRoot, 'package.json');
	const devScriptPath = join(repositoryRoot, 'scripts', 'dev.sh');
	const workflowsDirectory = join(repositoryRoot, '.github', 'workflows');

	function readPackageScripts(): Record<string, string | undefined> {
		// This test intentionally locks the package-script wiring because the generated VSClone Preact
		// bundles are hard imports in workbench code. If these scripts drift, clean-checkout builds
		// regress long before a browser-level test gets a useful failure message.
		const packageJson = JSON.parse(
			readFileSync(packageJsonPath, 'utf8'),
		) as IPackageJsonLike;
		return packageJson.scripts ?? {};
	}

	function readDevScript(): string {
		// The dev launcher waits on concrete emitted bundle paths before opening Electron.
		// Keeping those paths under test prevents silent hangs where startup blocks forever
		// on a renamed VSClone surface that is no longer part of the active bundle graph.
		return readFileSync(devScriptPath, 'utf8');
	}

	function readWorkflow(name: string): string {
		// CI runs from clean checkouts where the VSClone preact bundles do not exist until the build
		// script emits them. Lock the workflow wiring so transpile steps cannot drift ahead of that build.
		return readFileSync(join(workflowsDirectory, name), 'utf8');
	}

	function assertWorkflowBuildsVSClonePreactBeforeTranspile(name: string): void {
		const workflow = readWorkflow(name);
		const buildMatches = Array.from(workflow.matchAll(/build-vsclone-preact/g));
		const transpileMatches = Array.from(workflow.matchAll(/transpile-client-esbuild["']?\s+["']?transpile-extensions/g));

		assert.ok(
			transpileMatches.length > 0,
			`Expected ${name} to transpile the client and extensions.`,
		);
		assert.strictEqual(
			buildMatches.length,
			transpileMatches.length,
			`Expected ${name} to build the VSClone preact bundles once per client transpile step.`,
		);

		for (let index = 0; index < transpileMatches.length; index++) {
			const buildIndex = buildMatches[index]?.index ?? -1;
			const transpileIndex = transpileMatches[index]?.index ?? -1;
			assert.ok(
				buildIndex >= 0 && buildIndex < transpileIndex,
				`Expected ${name} to build the VSClone preact bundles before transpile step ${index + 1}.`,
			);
		}
	}

	test('compile builds the vsclone preact bundle before gulp compile', () => {
		const compileScript = readPackageScripts().compile;

		assert.ok(compileScript, 'Expected package.json to define a compile script.');
		assert.ok(
			compileScript.includes('build-vsclone-preact'),
			'Expected compile to build the VSClone Preact bundle.',
		);
		assert.ok(
			compileScript.includes('gulp compile'),
			'Expected compile to continue invoking the standard gulp compile step.',
		);
		assert.ok(
			compileScript.indexOf('build-vsclone-preact') < compileScript.indexOf('gulp compile'),
			'Expected the VSClone Preact bundle to build before gulp compile consumes it.',
		);
	});

	test('watch keeps the vsclone preact watcher inside the standard watch graph', () => {
		const watchScript = readPackageScripts().watch;

		assert.ok(watchScript, 'Expected package.json to define a watch script.');
		assert.ok(
			watchScript.includes('watch-client'),
			'Expected watch to keep the main client watcher.',
		);
		assert.ok(
			watchScript.includes('watch-extensions'),
			'Expected watch to keep the extension watcher.',
		);
		assert.ok(
			watchScript.includes('watch-vsclone-preact'),
			'Expected watch to include the VSClone Preact bundle watcher.',
		);
	});

	test('compile-web builds the vsclone preact bundle before gulp compile-web', () => {
		const compileWebScript = readPackageScripts()['compile-web'];

		assert.ok(compileWebScript, 'Expected package.json to define a compile-web script.');
		assert.ok(
			compileWebScript.includes('build-vsclone-preact'),
			'Expected compile-web to build the VSClone Preact bundle.',
		);
		assert.ok(
			compileWebScript.includes('gulp compile-web'),
			'Expected compile-web to continue invoking the standard gulp compile-web step.',
		);
		assert.ok(
			compileWebScript.indexOf('build-vsclone-preact') < compileWebScript.indexOf('gulp compile-web'),
			'Expected the VSClone Preact bundle to build before gulp compile-web consumes it.',
		);
	});

	test('watch-web keeps the vsclone preact watcher inside the standard web watch graph', () => {
		const scripts = readPackageScripts();
		const watchWebScript = scripts['watch-web'];
		const watchWebClientScript = scripts['watch-web-client'];

		assert.ok(watchWebScript, 'Expected package.json to define a watch-web script.');
		assert.ok(
			watchWebScript.includes('watch-vsclone-preact'),
			'Expected watch-web to include the VSClone Preact bundle watcher.',
		);
		assert.ok(
			watchWebScript.includes('watch-web-client'),
			'Expected watch-web to delegate the web gulp watcher through a named package script.',
		);
		assert.ok(
			watchWebClientScript,
			'Expected package.json to define a watch-web-client script.',
		);
		assert.ok(
			watchWebClientScript.includes('gulp watch-web'),
			'Expected watch-web-client to continue invoking the standard gulp watch-web step.',
		);
	});

	test('dev launcher waits for the current VSClone preact entrypoints', () => {
		const devScript = readDevScript();

		assert.ok(
			devScript.includes('preact/out/thread-rail/index.js'),
			'Expected scripts/dev.sh to wait for the current thread rail bundle.',
		);
		assert.ok(
			devScript.includes('preact/out/model-switcher/index.js'),
			'Expected scripts/dev.sh to wait for the model switcher bundle.',
		);
		assert.ok(
			devScript.includes('preact/out/unified-conversation-surface/index.js'),
			'Expected scripts/dev.sh to wait for the unified conversation surface bundle.',
		);
		assert.ok(
			!devScript.includes('preact/out/chat-history-rail/index.js'),
			'Expected scripts/dev.sh to stop waiting on the deleted chat history rail bundle.',
		);
	});

	test('CI workflows build the VSClone preact bundles before transpiling clean checkouts', () => {
		assertWorkflowBuildsVSClonePreactBeforeTranspile('run-backend-tests.yml');
		assertWorkflowBuildsVSClonePreactBeforeTranspile('run-frontend-tests.yml');
		assertWorkflowBuildsVSClonePreactBeforeTranspile('run-integration-tests.yml');
		assertWorkflowBuildsVSClonePreactBeforeTranspile('run-vsclone-live-provider-smoke.yml');
		assertWorkflowBuildsVSClonePreactBeforeTranspile('pr-linux-test.yml');
		assertWorkflowBuildsVSClonePreactBeforeTranspile('pr-darwin-test.yml');
		assertWorkflowBuildsVSClonePreactBeforeTranspile('pr-win32-test.yml');
	});
});
