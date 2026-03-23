/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { defaultOAuthProviderConfig, VSCloneModelVendor } from './vscloneOAuthTypes.js';

export interface IVSCloneProviderPreferenceState {
	readonly vendor: VSCloneModelVendor;
	readonly displayName: string;
	readonly enabled: boolean;
}

interface IVSCloneProviderPreferencesStorage {
	version: 1;
	providers: Partial<Record<VSCloneModelVendor, { enabled: boolean }>>;
}

export interface IVSCloneProviderPreferencesService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeProviders: Event<void>;
	initialize(): Promise<void>;
	getProviders(): readonly IVSCloneProviderPreferenceState[];
	getProvider(vendor: VSCloneModelVendor): IVSCloneProviderPreferenceState | undefined;
	setProviderEnabled(vendor: VSCloneModelVendor, enabled: boolean): Promise<void>;
	resetDefaults(): Promise<void>;
}

export const IVSCloneProviderPreferencesService = createDecorator<IVSCloneProviderPreferencesService>('vscloneProviderPreferencesService');

const providerPreferencesStorageKey = 'vsclone.providerPreferences.v1';
const legacyProviderStorageKey = 'vsclone.modelSwitcher.providers.v1';

const providerDefaults: readonly IVSCloneProviderPreferenceState[] = [
	{ vendor: 'openai', displayName: defaultOAuthProviderConfig.openai.displayName, enabled: true },
	{ vendor: 'anthropic', displayName: defaultOAuthProviderConfig.anthropic.displayName, enabled: true },
	// Keep Google visible on first run so the model picker and provider management UI stay aligned
	// without requiring a hidden preference toggle before users can discover Gemini sign-in.
	{ vendor: 'google', displayName: defaultOAuthProviderConfig.google.displayName, enabled: true },
] as const;

function cloneDefaults(): IVSCloneProviderPreferenceState[] {
	return providerDefaults.map(provider => ({ ...provider }));
}

function toStorageShape(providers: readonly IVSCloneProviderPreferenceState[]): IVSCloneProviderPreferencesStorage {
	const persisted: IVSCloneProviderPreferencesStorage = { version: 1, providers: {} };
	for (const provider of providers) {
		persisted.providers[provider.vendor] = {
			enabled: provider.enabled,
		};
	}
	return persisted;
}

function parseStorage(raw: string | undefined): Partial<Record<VSCloneModelVendor, { enabled: boolean }>> {
	if (!raw) {
		return {};
	}

	try {
		const parsed = JSON.parse(raw) as {
			version?: number;
			providers?: Partial<Record<VSCloneModelVendor, { enabled?: boolean; configured?: boolean }>>;
		};
		if (!parsed || parsed.version !== 1 || typeof parsed.providers !== 'object' || !parsed.providers) {
			return {};
		}

		const providers: Partial<Record<VSCloneModelVendor, { enabled: boolean }>> = {};
		for (const vendor of ['openai', 'anthropic', 'google'] satisfies VSCloneModelVendor[]) {
			const parsedProvider = parsed.providers[vendor];
			if (typeof parsedProvider?.enabled !== 'boolean') {
				continue;
			}
			providers[vendor] = { enabled: parsedProvider.enabled };
		}
		return providers;
	} catch {
		return {};
	}
}

export class VSCloneProviderPreferencesService extends Disposable implements IVSCloneProviderPreferencesService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeProviders = this._register(new Emitter<void>());
	readonly onDidChangeProviders = this._onDidChangeProviders.event;

	private initialized = false;
	private providers = cloneDefaults();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
	}

	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		// Reuse enabled flags from the old provider storage shape so the backend-driven selector
		// preserves each profile's visibility choices while dropping the mock readiness bits.
		const stored = parseStorage(this.storageService.get(providerPreferencesStorageKey, StorageScope.PROFILE));
		const legacyStored = Object.keys(stored).length === 0
			? parseStorage(this.storageService.get(legacyProviderStorageKey, StorageScope.PROFILE))
			: {};
		this.providers = cloneDefaults().map(provider => {
			const storedProvider = stored[provider.vendor] ?? legacyStored[provider.vendor];
			if (!storedProvider) {
				return provider;
			}

			return {
				...provider,
				enabled: typeof storedProvider.enabled === 'boolean' ? storedProvider.enabled : provider.enabled,
			};
		});

		this.initialized = true;
	}

	getProviders(): readonly IVSCloneProviderPreferenceState[] {
		return this.providers.map(provider => ({ ...provider }));
	}

	getProvider(vendor: VSCloneModelVendor): IVSCloneProviderPreferenceState | undefined {
		const provider = this.providers.find(candidate => candidate.vendor === vendor);
		return provider ? { ...provider } : undefined;
	}

	async setProviderEnabled(vendor: VSCloneModelVendor, enabled: boolean): Promise<void> {
		await this.initialize();
		const idx = this.providers.findIndex(provider => provider.vendor === vendor);
		if (idx === -1 || this.providers[idx].enabled === enabled) {
			return;
		}

		this.providers = [
			...this.providers.slice(0, idx),
			{
				...this.providers[idx],
				enabled,
			},
			...this.providers.slice(idx + 1),
		];
		this.store();
		this._onDidChangeProviders.fire();
	}

	async resetDefaults(): Promise<void> {
		await this.initialize();
		this.providers = cloneDefaults();
		this.store();
		this._onDidChangeProviders.fire();
	}

	private store(): void {
		const data = JSON.stringify(toStorageShape(this.providers));
		this.storageService.store(providerPreferencesStorageKey, data, StorageScope.PROFILE, StorageTarget.USER);
	}
}
