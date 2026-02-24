/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { VSCloneModelVendor } from './vscloneMockProviderService.js';
import { IVSCloneOAuthState, IVSCloneOAuthStateChangeEvent, IVSCloneOAuthTokenSet } from './vscloneOAuthTypes.js';

export const IVSCloneOAuthService = createDecorator<IVSCloneOAuthService>('vscloneOAuthService');

export interface IVSCloneOAuthService {
	readonly _serviceBrand: undefined;

	/** Void-style: immutable state snapshot, always current */
	readonly state: IVSCloneOAuthState;

	/** Fires when any provider's auth state changes */
	readonly onDidChangeState: Event<IVSCloneOAuthStateChangeEvent>;

	/** Restore persisted tokens, validate expiry, set initial states */
	initialize(): Promise<void>;

	/** Full OAuth sign-in flow for a vendor */
	signIn(vendor: VSCloneModelVendor): Promise<void>;

	/** Clear tokens, reset state */
	signOut(vendor: VSCloneModelVendor): Promise<void>;

	/** Get valid access token (auto-refreshes if near expiry). Undefined if not signed in. */
	getAccessToken(vendor: VSCloneModelVendor): Promise<string | undefined>;

	/** Get full token set for building provider-specific headers */
	getTokenSet(vendor: VSCloneModelVendor): Promise<IVSCloneOAuthTokenSet | undefined>;

	/** Get ready-to-use API headers for a vendor (auto-refreshes) */
	getApiHeaders(vendor: VSCloneModelVendor): Promise<Record<string, string> | undefined>;

	/** Synchronous check */
	isSignedIn(vendor: VSCloneModelVendor): boolean;
}
