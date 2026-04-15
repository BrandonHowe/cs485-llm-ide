/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineConfig } from 'tsup';

export default defineConfig({
	entry: [
		'./src/chat-history-rail/index.tsx',
		'./src/model-switcher/index.tsx',
		'./src/unified-conversation-surface/index.tsx',
	],
	outDir: './out',
	format: ['esm'],
	splitting: false,
	clean: false,
	platform: 'browser',
	target: 'esnext',
	outExtension: () => ({ js: '.js' }),
	noExternal: [
		/^(?!\.).*$/
	],
	// Repository runtime imports like `../../../../nls.js` must stay external so the generated
	// bundles reuse VS Code's existing browser modules instead of snapshotting them into `out/`.
	external: [
		/^\.\.\/(?:\.\.\/){2,}.*\.js$/
	],
	treeshake: true,
	esbuildOptions(options) {
		options.outbase = 'src';
	}
});
