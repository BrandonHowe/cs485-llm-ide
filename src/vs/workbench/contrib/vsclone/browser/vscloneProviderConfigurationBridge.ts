/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IVSCloneMockProviderService, VSCloneModelVendor } from '../common/vscloneMockProviderService.js';

export interface IVSCloneProviderConfigurationBridge {
	readonly _serviceBrand: undefined;
	openManageProvidersPicker(): Promise<void>;
}

export const IVSCloneProviderConfigurationBridge = createDecorator<IVSCloneProviderConfigurationBridge>('vscloneProviderConfigurationBridge');

interface IProviderActionPick extends IQuickPickItem {
	readonly actionId: string;
	readonly vendor?: VSCloneModelVendor;
}

const providerNames: Record<VSCloneModelVendor, string> = {
	openai: 'OpenAI',
	anthropic: 'Anthropic',
	google: 'Google',
};

export class VSCloneProviderConfigurationBridge implements IVSCloneProviderConfigurationBridge {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IVSCloneMockProviderService private readonly mockProviderService: IVSCloneMockProviderService,
	) {
	}

	async openManageProvidersPicker(): Promise<void> {
		await this.mockProviderService.initialize();
		const providers = this.mockProviderService.getProviders();
		const picks: IProviderActionPick[] = [];

		for (const provider of providers) {
			const providerName = providerNames[provider.vendor];
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

			picks.push({
				label: provider.configured
					? localize('vsclone.providers.markUnconfigured', 'Mark {0} as unconfigured', providerName)
					: localize('vsclone.providers.markConfigured', 'Mark {0} as configured', providerName),
				description: provider.configured
					? localize('vsclone.providers.unconfigured.description', 'Models will appear locked')
					: localize('vsclone.providers.configured.description', 'Models become selectable'),
				actionId: 'toggleConfigured',
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
			placeHolder: localize('vsclone.providers.manage.placeholder', 'Manage VSClone mock providers'),
			title: localize('vsclone.providers.manage.title', 'Manage Providers'),
		});

		if (!selected) {
			return;
		}

		if (selected.actionId === 'resetDefaults') {
			await this.mockProviderService.resetDefaults();
			return;
		}

		if (!selected.vendor) {
			return;
		}

		const provider = this.mockProviderService.getProvider(selected.vendor);
		if (!provider) {
			return;
		}

		if (selected.actionId === 'toggleEnabled') {
			await this.mockProviderService.setProviderEnabled(selected.vendor, !provider.enabled);
			return;
		}

		if (selected.actionId === 'toggleConfigured') {
			await this.mockProviderService.setProviderConfigured(selected.vendor, !provider.configured);
		}
	}
}
