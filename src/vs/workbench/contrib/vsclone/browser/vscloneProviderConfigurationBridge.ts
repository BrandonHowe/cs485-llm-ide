/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IVSCloneOAuthService } from '../common/vscloneOAuthService.js';
import { displayInfoOfOAuthProvider, VSCloneModelVendor } from '../common/vscloneOAuthTypes.js';

export interface IVSCloneProviderConfigurationBridge {
	readonly _serviceBrand: undefined;
	openManageProvidersPicker(): Promise<void>;
}

export const IVSCloneProviderConfigurationBridge = createDecorator<IVSCloneProviderConfigurationBridge>('vscloneProviderConfigurationBridge');

interface IProviderActionPick extends IQuickPickItem {
	readonly actionId: string;
	readonly vendor?: VSCloneModelVendor;
}

export class VSCloneProviderConfigurationBridge implements IVSCloneProviderConfigurationBridge {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IVSCloneOAuthService private readonly oAuthService: IVSCloneOAuthService,
	) {
	}

	async openManageProvidersPicker(): Promise<void> {
		await this.oAuthService.initialize();

		const picks: IProviderActionPick[] = [];

		// Keep provider management focused on auth state so the picker no longer exposes
		// experimental visibility toggles that can unexpectedly hide models from the selector.
		const allVendors: readonly VSCloneModelVendor[] = ['openai', 'anthropic', 'google'];
		for (const vendor of allVendors) {
			const oAuthState = this.oAuthService.state.providers[vendor];
			const displayInfo = displayInfoOfOAuthProvider(vendor);

			if (oAuthState.isReady) {
				picks.push({
					label: localize('vsclone.providers.signOut', 'Sign Out of {0}', displayInfo.title),
					description: oAuthState.userDisplayName
						? localize('vsclone.providers.signedInAs', 'Signed in as {0}', oAuthState.userDisplayName)
						: localize('vsclone.providers.signedIn', 'Currently signed in'),
					actionId: 'oauthSignOut',
					vendor,
				});
			} else {
				picks.push({
					label: displayInfo.signInLabel,
					description: displayInfo.description,
					actionId: 'oauthSignIn',
					vendor,
				});
			}
		}

		const selected = await this.quickInputService.pick(picks, {
			canPickMany: false,
			placeHolder: localize('vsclone.providers.manage.placeholder', 'Manage VSClone providers'),
			title: localize('vsclone.providers.manage.title', 'Manage Providers'),
		});

		if (!selected) {
			return;
		}

		if (selected.actionId === 'oauthSignIn' && selected.vendor) {
			await this.oAuthService.signIn(selected.vendor);
			return;
		}

		if (selected.actionId === 'oauthSignOut' && selected.vendor) {
			await this.oAuthService.signOut(selected.vendor);
		}
	}
}
