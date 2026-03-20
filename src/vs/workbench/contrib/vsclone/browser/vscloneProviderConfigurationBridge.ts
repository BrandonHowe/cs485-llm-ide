/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IVSCloneOAuthService } from '../common/vscloneOAuthService.js';
import { displayInfoOfOAuthProvider, VSCloneModelVendor } from '../common/vscloneOAuthTypes.js';
import { IVSCloneProviderPreferencesService } from '../common/vscloneProviderPreferencesService.js';

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
		@IVSCloneProviderPreferencesService private readonly providerPreferencesService: IVSCloneProviderPreferencesService,
		@IVSCloneOAuthService private readonly oAuthService: IVSCloneOAuthService,
	) {
	}

	async openManageProvidersPicker(): Promise<void> {
		await this.providerPreferencesService.initialize();
		await this.oAuthService.initialize();

		const providers = this.providerPreferencesService.getProviders();
		const picks: IProviderActionPick[] = [];

		// OAuth sign-in/sign-out picks per provider
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

		for (const provider of providers) {
			const providerName = displayInfoOfOAuthProvider(provider.vendor).title;
			picks.push({
				label: provider.enabled
					? localize('vsclone.providers.disable', 'Disable {0}', providerName)
					: localize('vsclone.providers.enable', 'Enable {0}', providerName),
				description: provider.enabled
					? localize('vsclone.providers.disable.description', 'Hidden from model selector')
					: localize('vsclone.providers.enable.description', 'Show in model selector'),
				actionId: 'toggleEnabled',
				vendor: provider.vendor,
			});
		}

		picks.push({
			label: localize('vsclone.providers.resetDefaults', 'Reset provider defaults'),
			description: localize('vsclone.providers.resetDefaults.description', 'Re-enable OpenAI + Anthropic, disable Google'),
			actionId: 'resetDefaults',
		});

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
			return;
		}

		if (selected.actionId === 'resetDefaults') {
			await this.providerPreferencesService.resetDefaults();
			return;
		}

		if (!selected.vendor) {
			return;
		}

		const provider = this.providerPreferencesService.getProvider(selected.vendor);
		if (!provider) {
			return;
		}

		if (selected.actionId === 'toggleEnabled') {
			await this.providerPreferencesService.setProviderEnabled(selected.vendor, !provider.enabled);
		}
	}
}
