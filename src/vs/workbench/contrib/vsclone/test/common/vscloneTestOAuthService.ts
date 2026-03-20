/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';
import { IVSCloneOAuthService } from '../../common/vscloneOAuthService.js';
import { IVSCloneOAuthState, IVSCloneOAuthStateChangeEvent, IVSCloneOAuthTokenSet, VSCloneModelVendor } from '../../common/vscloneOAuthTypes.js';

function createProviderState(vendor: VSCloneModelVendor, isReady: boolean) {
	return {
		vendor,
		displayName: vendor === 'openai' ? 'OpenAI' : vendor === 'anthropic' ? 'Anthropic' : 'Google',
		status: isReady ? 'signed_in' as const : 'signed_out' as const,
		userDisplayName: undefined,
		errorMessage: undefined,
		isReady,
	};
}

export class TestVSCloneOAuthService implements IVSCloneOAuthService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = new Emitter<IVSCloneOAuthStateChangeEvent>();
	readonly onDidChangeState = this._onDidChangeState.event;
	private _state: IVSCloneOAuthState = {
		providers: {
			openai: createProviderState('openai', true),
			anthropic: createProviderState('anthropic', true),
			google: createProviderState('google', false),
		},
	};

	get state(): IVSCloneOAuthState {
		return this._state;
	}

	async initialize(): Promise<void> { }
	async signIn(vendor: VSCloneModelVendor): Promise<void> {
		this.setReady(vendor, true);
	}
	async signOut(vendor: VSCloneModelVendor): Promise<void> {
		this.setReady(vendor, false);
	}
	async getAccessToken(vendor: VSCloneModelVendor): Promise<string | undefined> {
		return this.state.providers[vendor].isReady ? `${vendor}-access-token` : undefined;
	}
	async getTokenSet(vendor: VSCloneModelVendor): Promise<IVSCloneOAuthTokenSet | undefined> {
		const accessToken = await this.getAccessToken(vendor);
		if (!accessToken) {
			return undefined;
		}

		return {
			vendor,
			accessToken,
			refreshToken: undefined,
			idToken: undefined,
			expiresAt: Date.now() + 60_000,
			scopes: [],
			providerMetadata: {},
		};
	}
	async getApiHeaders(vendor: VSCloneModelVendor): Promise<Record<string, string> | undefined> {
		const accessToken = await this.getAccessToken(vendor);
		return accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;
	}
	isSignedIn(vendor: VSCloneModelVendor): boolean {
		return this.state.providers[vendor].isReady;
	}

	setReady(vendor: VSCloneModelVendor, isReady: boolean): void {
		const previous = this.state.providers[vendor].status;
		this._state = {
			providers: {
				...this.state.providers,
				[vendor]: createProviderState(vendor, isReady),
			},
		};
		this._onDidChangeState.fire({
			vendor,
			previous,
			current: this.state.providers[vendor].status,
		});
	}
}
