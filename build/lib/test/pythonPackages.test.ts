/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import cp from 'child_process';
import { getPythonPackageInstallPlan, installPythonPackages } from '../pythonPackages.ts';

suite('Python Package Install Helper', () => {
	const childProcess = cp as typeof cp & {
		spawnSync: typeof cp.spawnSync;
	};

	const originalSpawnSync = childProcess.spawnSync;

	teardown(() => {
		// Keep the test isolated because the implementation talks to the process layer directly.
		childProcess.spawnSync = originalSpawnSync;
	});

	test('builds the expected pip command with macOS-specific flags', () => {
		const plan = getPythonPackageInstallPlan(['  first-package  ', 'second-package', '\tthird-package\n']);

		assert.deepStrictEqual(plan, {
			command: 'python3',
			args: [
				'-m',
				'pip',
				'install',
				'--user',
				'--break-system-packages',
				'first-package',
				'second-package',
				'third-package'
			]
		});
	});

	test('trims whitespace, drops empty package names, and preserves order', () => {
		const input = ['  alpha  ', '', '   ', '\nbeta\n', '\t gamma\t'];
		const plan = getPythonPackageInstallPlan(input);

		assert.deepStrictEqual(plan.args.slice(5), ['alpha', 'beta', 'gamma']);
		assert.deepStrictEqual(input, ['  alpha  ', '', '   ', '\nbeta\n', '\t gamma\t']);
	});

	test('throws when every package name is removed by normalization', () => {
		assert.throws(
			() => getPythonPackageInstallPlan([' ', '\t', '\n']),
			/Expected at least one Python package name to install\./
		);
	});

	test('passes the normalized install plan to spawnSync', () => {
		let capturedCommand: string | undefined;
		let capturedArgs: readonly string[] | undefined;
		let capturedOptions: unknown;

		childProcess.spawnSync = ((command: string, args: readonly string[], options: unknown) => {
			capturedCommand = command;
			capturedArgs = args;
			capturedOptions = options;

			return { status: 0 } as ReturnType<typeof cp.spawnSync>;
		}) as typeof cp.spawnSync;

		installPythonPackages(['  package-one  ', 'package-two']);

		assert.strictEqual(capturedCommand, 'python3');
		assert.deepStrictEqual(capturedArgs, [
			'-m',
			'pip',
			'install',
			'--user',
			'--break-system-packages',
			'package-one',
			'package-two'
		]);
		assert.deepStrictEqual(capturedOptions, { stdio: 'inherit' });
	});

	test('surfaces spawn errors unchanged', () => {
		const error = new Error('spawn failed');

		childProcess.spawnSync = (() => ({ error })) as unknown as typeof cp.spawnSync;

		assert.throws(() => installPythonPackages(['package']), error);
	});

	test('fails when the process is terminated by a signal', () => {
		childProcess.spawnSync = (() => ({ signal: 'SIGTERM' })) as unknown as typeof cp.spawnSync;

		assert.throws(
			() => installPythonPackages(['package']),
			/Python package installation was terminated by signal SIGTERM\./
		);
	});

	test('fails when pip exits with a non-zero status', () => {
		childProcess.spawnSync = (() => ({ status: 42 })) as unknown as typeof cp.spawnSync;

		assert.throws(
			() => installPythonPackages(['package']),
			/Python package installation exited with status 42\./
		);
	});
});
