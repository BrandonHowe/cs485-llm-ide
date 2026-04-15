/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execSync, spawn } from 'child_process';

const args = process.argv.slice(2);
const isWatch = args.includes('--watch') || args.includes('-w');

if (isWatch) {
	const watcher = spawn('npx', ['tsup', '--watch'], { stdio: 'inherit' });
	process.on('SIGINT', () => {
		watcher.kill();
		process.exit();
	});
} else {
	execSync('npx tsup', { stdio: 'inherit' });
}
