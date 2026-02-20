/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export type VSCloneModelVendor = 'openai' | 'anthropic' | 'google';

export interface IVSCloneMockProviderState {
	readonly vendor: VSCloneModelVendor;
	readonly displayName: string;
	readonly enabled: boolean;
	readonly configured: boolean;
}

interface IVSCloneMockProviderStorage {
	version: 1;
	providers: Partial<Record<VSCloneModelVendor, { enabled: boolean; configured: boolean }>>;
}

export interface IVSCloneMockProviderService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeProviders: Event<void>;
	initialize(): Promise<void>;
	getProviders(): readonly IVSCloneMockProviderState[];
	getProvider(vendor: VSCloneModelVendor): IVSCloneMockProviderState | undefined;
	setProviderEnabled(vendor: VSCloneModelVendor, enabled: boolean): Promise<void>;
	setProviderConfigured(vendor: VSCloneModelVendor, configured: boolean): Promise<void>;
	resetDefaults(): Promise<void>;
}

export const IVSCloneMockProviderService = createDecorator<IVSCloneMockProviderService>('vscloneMockProviderService');

const providerStorageKey = 'vsclone.modelSwitcher.providers.v1';

const providerDefaults: readonly IVSCloneMockProviderState[] = [
	{ vendor: 'openai', displayName: 'OpenAI', enabled: true, configured: true },
	{ vendor: 'anthropic', displayName: 'Anthropic', enabled: true, configured: true },
	{ vendor: 'google', displayName: 'Google', enabled: false, configured: false },
] as const;

function cloneDefaults(): IVSCloneMockProviderState[] {
	return providerDefaults.map(provider => ({ ...provider }));
}

function toStorageShape(providers: readonly IVSCloneMockProviderState[]): IVSCloneMockProviderStorage {
	const persisted: IVSCloneMockProviderStorage = { version: 1, providers: {} };
	for (const provider of providers) {
		persisted.providers[provider.vendor] = {
			enabled: provider.enabled,
			configured: provider.configured,
		};
	}
	return persisted;
}

function parseStorage(raw: string | undefined): Partial<Record<VSCloneModelVendor, { enabled: boolean; configured: boolean }>> {
	if (!raw) {
		return {};
	}

	try {
		const parsed = JSON.parse(raw) as IVSCloneMockProviderStorage;
		if (!parsed || parsed.version !== 1 || typeof parsed.providers !== 'object') {
			return {};
		}
		return parsed.providers;
	} catch {
		return {};
	}
}

export class VSCloneMockProviderService extends Disposable implements IVSCloneMockProviderService {
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

		const stored = parseStorage(this.storageService.get(providerStorageKey, StorageScope.PROFILE));
		this.providers = cloneDefaults().map(provider => {
			const storedProvider = stored[provider.vendor];
			if (!storedProvider) {
				return provider;
			}

			return {
				...provider,
				enabled: typeof storedProvider.enabled === 'boolean' ? storedProvider.enabled : provider.enabled,
				configured: typeof storedProvider.configured === 'boolean' ? storedProvider.configured : provider.configured,
			};
		});

		this.initialized = true;
	}

	getProviders(): readonly IVSCloneMockProviderState[] {
		return this.providers.map(provider => ({ ...provider }));
	}

	getProvider(vendor: VSCloneModelVendor): IVSCloneMockProviderState | undefined {
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
		await this.store();
		this._onDidChangeProviders.fire();
	}

	async setProviderConfigured(vendor: VSCloneModelVendor, configured: boolean): Promise<void> {
		await this.initialize();
		const idx = this.providers.findIndex(provider => provider.vendor === vendor);
		if (idx === -1 || this.providers[idx].configured === configured) {
			return;
		}

		this.providers = [
			...this.providers.slice(0, idx),
			{
				...this.providers[idx],
				configured,
			},
			...this.providers.slice(idx + 1),
		];
		await this.store();
		this._onDidChangeProviders.fire();
	}

	async resetDefaults(): Promise<void> {
		await this.initialize();
		this.providers = cloneDefaults();
		await this.store();
		this._onDidChangeProviders.fire();
	}

	private async store(): Promise<void> {
		const data = JSON.stringify(toStorageShape(this.providers));
		this.storageService.store(providerStorageKey, data, StorageScope.PROFILE, StorageTarget.USER);
	}
}
