/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IVSCloneOAuthService } from '../common/vscloneOAuthService.js';
import { defaultOAuthProviderConfig, displayInfoOfOAuthProvider, VSCloneModelVendor } from '../common/vscloneOAuthTypes.js';

export const VSCloneOAuthCommandIds = {
	signIn: 'vsclone.oauth.signIn',
	signOut: 'vsclone.oauth.signOut',
	showStatus: 'vsclone.oauth.showStatus',
} as const;

const allVendors: readonly VSCloneModelVendor[] = ['openai', 'anthropic', 'google'];

interface IVendorPick extends IQuickPickItem {
	readonly vendor: VSCloneModelVendor;
}

const registrationKey = '__vscloneOAuthActionsRegistered__';
type GlobalScope = typeof globalThis & {
	readonly [registrationKey]?: boolean;
};

export function registerVSCloneOAuthActions(): void {
	const globalScope = globalThis as GlobalScope;
	if (globalScope[registrationKey]) {
		return;
	}
	(globalScope as { [registrationKey]: boolean })[registrationKey] = true;

	// -- Sign In --

	registerAction2(class VSCloneOAuthSignInAction extends Action2 {
		constructor() {
			super({
				id: VSCloneOAuthCommandIds.signIn,
				title: localize2('vsclone.oauth.signIn', 'Sign In to VSClone Provider'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const oAuthService = accessor.get(IVSCloneOAuthService);
			const quickInputService = accessor.get(IQuickInputService);

			await oAuthService.initialize();

			// Show only providers that are not yet ready
			const picks: IVendorPick[] = [];
			for (const vendor of allVendors) {
				const providerState = oAuthService.state.providers[vendor];
				if (!providerState.isReady) {
					const displayInfo = displayInfoOfOAuthProvider(vendor);
					picks.push({
						label: displayInfo.signInLabel,
						description: displayInfo.description,
						vendor,
					});
				}
			}

			if (picks.length === 0) {
				quickInputService.pick([], {
					placeHolder: localize('vsclone.oauth.signIn.allSignedIn', 'All providers are already signed in'),
				});
				return;
			}

			const selected = await quickInputService.pick(picks, {
				canPickMany: false,
				placeHolder: localize('vsclone.oauth.signIn.placeholder', 'Select a provider to sign in'),
				title: localize('vsclone.oauth.signIn.title', 'Sign In to Provider'),
			});

			if (selected) {
				await oAuthService.signIn(selected.vendor);
			}
		}
	});

	// -- Sign Out --

	registerAction2(class VSCloneOAuthSignOutAction extends Action2 {
		constructor() {
			super({
				id: VSCloneOAuthCommandIds.signOut,
				title: localize2('vsclone.oauth.signOut', 'Sign Out of VSClone Provider'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const oAuthService = accessor.get(IVSCloneOAuthService);
			const quickInputService = accessor.get(IQuickInputService);

			await oAuthService.initialize();

			// Show only providers that are currently signed in
			const picks: IVendorPick[] = [];
			for (const vendor of allVendors) {
				const providerState = oAuthService.state.providers[vendor];
				if (providerState.isReady) {
					const displayInfo = displayInfoOfOAuthProvider(vendor);
					picks.push({
						label: localize('vsclone.oauth.signOut.label', 'Sign Out of {0}', displayInfo.title),
						description: providerState.userDisplayName
							? localize('vsclone.oauth.signOut.description', 'Signed in as {0}', providerState.userDisplayName)
							: undefined,
						vendor,
					});
				}
			}

			if (picks.length === 0) {
				quickInputService.pick([], {
					placeHolder: localize('vsclone.oauth.signOut.noneSignedIn', 'No providers are currently signed in'),
				});
				return;
			}

			const selected = await quickInputService.pick(picks, {
				canPickMany: false,
				placeHolder: localize('vsclone.oauth.signOut.placeholder', 'Select a provider to sign out'),
				title: localize('vsclone.oauth.signOut.title', 'Sign Out of Provider'),
			});

			if (selected) {
				await oAuthService.signOut(selected.vendor);
			}
		}
	});

	// -- Show Status --

	registerAction2(class VSCloneOAuthShowStatusAction extends Action2 {
		constructor() {
			super({
				id: VSCloneOAuthCommandIds.showStatus,
				title: localize2('vsclone.oauth.showStatus', 'Show VSClone Auth Status'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const oAuthService = accessor.get(IVSCloneOAuthService);
			const quickInputService = accessor.get(IQuickInputService);

			await oAuthService.initialize();

			const picks: IQuickPickItem[] = [];
			for (const vendor of allVendors) {
				const providerState = oAuthService.state.providers[vendor];
				const config = defaultOAuthProviderConfig[vendor];
				const statusLabel = getStatusLabel(providerState.status);

				picks.push({
					label: config.displayName,
					description: providerState.userDisplayName
						? `${statusLabel} - ${providerState.userDisplayName}`
						: statusLabel,
					detail: providerState.errorMessage
						? localize('vsclone.oauth.status.error', 'Error: {0}', providerState.errorMessage)
						: undefined,
				});
			}

			await quickInputService.pick(picks, {
				canPickMany: false,
				placeHolder: localize('vsclone.oauth.status.placeholder', 'VSClone Provider Authentication Status'),
				title: localize('vsclone.oauth.status.title', 'Auth Status'),
			});
		}
	});
}

function getStatusLabel(status: string): string {
	switch (status) {
		case 'signed_in': return localize('vsclone.oauth.status.signedIn', 'Signed In');
		case 'signed_out': return localize('vsclone.oauth.status.signedOut', 'Signed Out');
		case 'signing_in': return localize('vsclone.oauth.status.signingIn', 'Signing In...');
		case 'refreshing': return localize('vsclone.oauth.status.refreshing', 'Refreshing...');
		case 'error': return localize('vsclone.oauth.status.errorStatus', 'Error');
		default: return status;
	}
}
