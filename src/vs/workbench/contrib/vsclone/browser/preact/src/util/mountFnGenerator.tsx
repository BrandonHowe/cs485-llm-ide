/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { h, render } from 'preact';
import type { FunctionComponent } from 'preact';

// VS Code workbench code still owns the DOM container lifetime, but this helper centralizes the
// framework root so feature controllers only deal with `rerender` and `dispose`.
export const mountFnGenerator = <Props,>(Component: FunctionComponent<Props>) => {
	return (rootElement: HTMLElement, initialProps: Props) => {
		if (typeof document === 'undefined') {
			console.error('vsclone preact mount failed because document was undefined');
			return undefined;
		}

		const rerender = (props: Props) => {
			render(h(Component, props), rootElement);
		};

		const dispose = () => {
			render(null, rootElement);
		};

		rerender(initialProps);

		return {
			rerender,
			dispose,
		};
	};
};
