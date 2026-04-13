/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import cp from 'child_process';

export interface PythonPackageInstallPlan {
	readonly command: string;
	readonly args: readonly string[];
}

/**
 * Normalize package names once so every macOS CI path uses the same pip flags.
 *
 * Homebrew-managed Python on hosted macOS runners now enforces PEP 668, which
 * blocks the old `python3 -m pip install <pkg>` pattern. Installing into the
 * current user's site-packages keeps the dependency scoped to the build account,
 * while `--break-system-packages` opts into the explicit pip escape hatch that
 * Homebrew now requires even for user installs.
 */
export function getPythonPackageInstallPlan(packageNames: readonly string[]): PythonPackageInstallPlan {
	const normalizedPackageNames = packageNames
		.map(packageName => packageName.trim())
		.filter(packageName => packageName.length > 0);

	if (normalizedPackageNames.length === 0) {
		throw new Error('Expected at least one Python package name to install.');
	}

	return {
		command: 'python3',
		args: ['-m', 'pip', 'install', '--user', '--break-system-packages', ...normalizedPackageNames]
	};
}

export function installPythonPackages(packageNames: readonly string[]): void {
	const plan = getPythonPackageInstallPlan(packageNames);
	const result = cp.spawnSync(plan.command, [...plan.args], { stdio: 'inherit' });

	if (result.error) {
		throw result.error;
	}

	if (result.signal) {
		throw new Error(`Python package installation was terminated by signal ${result.signal}.`);
	}

	if (typeof result.status === 'number' && result.status !== 0) {
		throw new Error(`Python package installation exited with status ${result.status}.`);
	}
}

if (import.meta.main) {
	installPythonPackages(process.argv.slice(2));
}
