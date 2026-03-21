/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IVSCloneOAuthService } from './vscloneOAuthService.js';
import { VSCloneModelVendor } from './vscloneOAuthTypes.js';
import { IVSCloneProviderPreferenceState, IVSCloneProviderPreferencesService } from './vscloneProviderPreferencesService.js';

export type VSCloneModelCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface IVSCloneModelCatalogProviderDescriptor {
	readonly vendor: VSCloneModelVendor;
	readonly displayName: string;
	readonly status: 'available' | 'requires_sign_in';
	readonly modelCount: number;
}

export type VSCloneModelUnavailableReason = 'provider_requires_sign_in';

export interface IVSCloneModelCatalogModelDescriptor {
	readonly identifier: string;
	readonly vendor: VSCloneModelVendor;
	readonly modelId: string;
	readonly modelName: string;
	/**
	 * Optional per-model reasoning controls.
	 * Kept in catalog metadata so UI and request adapters share one source of truth.
	 */
	readonly reasoningEffortLevels?: readonly VSCloneReasoningEffortLevel[];
	readonly defaultReasoningEffort?: VSCloneReasoningEffortLevel;
	readonly isSelectable: boolean;
	readonly unavailableReason?: VSCloneModelUnavailableReason;
}

export interface IVSCloneModelCatalogState {
	readonly status: VSCloneModelCatalogStatus;
	readonly providers: readonly IVSCloneModelCatalogProviderDescriptor[];
	readonly models: readonly IVSCloneModelCatalogModelDescriptor[];
	readonly updatedAt?: number;
	readonly errorMessage?: string;
}

export interface IVSCloneModelCatalogService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeCatalog: Event<void>;
	refreshCatalog(): Promise<void>;
	getState(): IVSCloneModelCatalogState;
	getProviders(): readonly IVSCloneModelCatalogProviderDescriptor[];
	getModels(providerId?: VSCloneModelVendor): readonly IVSCloneModelCatalogModelDescriptor[];
	getModel(identifier: string): IVSCloneModelCatalogModelDescriptor | undefined;
	getSelectableModels(): readonly IVSCloneModelCatalogModelDescriptor[];
}

export const IVSCloneModelCatalogService = createDecorator<IVSCloneModelCatalogService>('vscloneModelCatalogService');

interface IModelDefinition {
	readonly vendor: VSCloneModelVendor;
	readonly modelId: string;
	readonly modelName: string;
	readonly reasoningEffortLevels?: readonly VSCloneReasoningEffortLevel[];
	readonly defaultReasoningEffort?: VSCloneReasoningEffortLevel;
}

export type VSCloneReasoningEffortLevel = 'xhigh' | 'max' | 'high' | 'medium' | 'standard' | 'low' | 'minimal' | 'lite' | 'none';

const allReasoningEffortLevels: readonly VSCloneReasoningEffortLevel[] = ['xhigh', 'max', 'high', 'medium', 'standard', 'low', 'minimal', 'lite', 'none'];

export function isVSCloneReasoningEffortLevel(value: string): value is VSCloneReasoningEffortLevel {
	return (allReasoningEffortLevels as readonly string[]).includes(value);
}

const modelDefinitionsByProvider: Record<VSCloneModelVendor, readonly IModelDefinition[]> = {
	openai: [
		{ vendor: 'openai', modelId: 'gpt-5.3-codex', modelName: 'GPT-5.3-Codex', reasoningEffortLevels: ['xhigh', 'high', 'medium', 'low'], defaultReasoningEffort: 'medium' },
		// Keep the picker catalog explicit so newly shipped GPT variants can be surfaced without
		// changing the rest of the selection pipeline.
		{ vendor: 'openai', modelId: 'gpt-5.4', modelName: 'GPT-5.4', reasoningEffortLevels: ['high', 'medium', 'low'], defaultReasoningEffort: 'medium' },
		{ vendor: 'openai', modelId: 'gpt-5.3-codex-spark', modelName: 'GPT-5.3-Codex-Spark', reasoningEffortLevels: ['standard', 'lite'], defaultReasoningEffort: 'standard' },
		{ vendor: 'openai', modelId: 'gpt-5.2-codex', modelName: 'GPT-5.2-Codex', reasoningEffortLevels: ['high', 'medium'], defaultReasoningEffort: 'medium' },
		{ vendor: 'openai', modelId: 'gpt-5.1-codex', modelName: 'GPT-5.1-Codex', reasoningEffortLevels: ['high', 'medium'], defaultReasoningEffort: 'medium' },
		{ vendor: 'openai', modelId: 'gpt-5-pro', modelName: 'GPT-5 Pro', reasoningEffortLevels: ['xhigh', 'high', 'medium', 'low', 'minimal', 'none'], defaultReasoningEffort: 'medium' },
		{ vendor: 'openai', modelId: 'gpt-5', modelName: 'GPT-5', reasoningEffortLevels: ['high', 'medium', 'low'], defaultReasoningEffort: 'medium' },
		{ vendor: 'openai', modelId: 'gpt-5-nano', modelName: 'GPT-5 Nano', reasoningEffortLevels: ['high', 'low'], defaultReasoningEffort: 'high' },
	],
	anthropic: [
		// These entries intentionally track the marketed picker labels while the adapter resolves the
		// concrete provider-facing version aliases separately.
		{ vendor: 'anthropic', modelId: 'claude-opus-4.6', modelName: 'Claude Opus 4.6', reasoningEffortLevels: ['max', 'high', 'standard'], defaultReasoningEffort: 'high' },
		{ vendor: 'anthropic', modelId: 'claude-sonnet-4.6', modelName: 'Claude Sonnet 4.6', reasoningEffortLevels: ['max', 'high', 'medium'], defaultReasoningEffort: 'high' },
		{ vendor: 'anthropic', modelId: 'claude-sonnet-4.0', modelName: 'Claude Sonnet 4.0', reasoningEffortLevels: ['high', 'low'], defaultReasoningEffort: 'high' },
	],
	google: [
		{ vendor: 'google', modelId: 'gemini-3-pro', modelName: 'Gemini 3 Pro', reasoningEffortLevels: ['high', 'standard'], defaultReasoningEffort: 'standard' },
		{ vendor: 'google', modelId: 'gemini-2.5-pro', modelName: 'Gemini 2.5 Pro', reasoningEffortLevels: ['high', 'low'], defaultReasoningEffort: 'high' },
		{ vendor: 'google', modelId: 'gemini-2.5-flash', modelName: 'Gemini 2.5 Flash', reasoningEffortLevels: ['high', 'low'], defaultReasoningEffort: 'low' },
		{ vendor: 'google', modelId: 'gemini-2.5-flash-lite', modelName: 'Gemini 2.5 Flash Lite', reasoningEffortLevels: ['high', 'low'], defaultReasoningEffort: 'low' },
	],
};

function toIdentifier(vendor: VSCloneModelVendor, modelId: string): string {
	return `${vendor}/${modelId}`;
}

function byVendorOrder(first: { vendor: VSCloneModelVendor }, second: { vendor: VSCloneModelVendor }): number {
	const order: VSCloneModelVendor[] = ['openai', 'anthropic', 'google'];
	return order.indexOf(first.vendor) - order.indexOf(second.vendor);
}

export class VSCloneModelCatalogService extends Disposable implements IVSCloneModelCatalogService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeCatalog = this._register(new Emitter<void>());
	readonly onDidChangeCatalog = this._onDidChangeCatalog.event;

	private state: IVSCloneModelCatalogState = {
		status: 'idle',
		providers: [],
		models: [],
	};

	private failNextRefreshForTest = false;
	private refreshing = false;

	constructor(
		@IVSCloneProviderPreferencesService private readonly providerPreferencesService: IVSCloneProviderPreferencesService,
		@IVSCloneOAuthService private readonly oauthService: IVSCloneOAuthService,
	) {
		super();

		this._register(this.providerPreferencesService.onDidChangeProviders(() => {
			void this.refreshCatalog();
		}));
		this._register(this.oauthService.onDidChangeState(() => {
			void this.refreshCatalog();
		}));
	}

	/**
	 * Test-only hook to cover error transitions without wiring fake transport layers.
	 */
	setFailNextRefreshForTest(): void {
		this.failNextRefreshForTest = true;
	}

	async refreshCatalog(): Promise<void> {
		if (this.refreshing) {
			return;
		}
		this.refreshing = true;

		this.state = {
			status: 'loading',
			providers: this.state.providers,
			models: this.state.models,
			updatedAt: this.state.updatedAt,
			errorMessage: undefined,
		};
		this._onDidChangeCatalog.fire();

		try {
			await this.providerPreferencesService.initialize();
			await this.oauthService.initialize();
			// Yield once so the model switcher can render a loading state even when auth state was already warm.
			await timeout(0);

			if (this.failNextRefreshForTest) {
				this.failNextRefreshForTest = false;
				throw new Error('Failed to fetch model catalog. Check your network connection.');
			}

			const providerPreferences = this.providerPreferencesService.getProviders();
			const providers = this.computeProviders(providerPreferences);
			const models = this.computeModels(providerPreferences);
			this.state = {
				status: 'ready',
				providers,
				models,
				updatedAt: Date.now(),
				errorMessage: undefined,
			};
			this._onDidChangeCatalog.fire();
		} catch (error) {
			this.state = {
				status: 'error',
				providers: this.state.providers,
				models: this.state.models,
				updatedAt: this.state.updatedAt,
				errorMessage: error instanceof Error ? error.message : 'Failed to fetch model catalog.',
			};
			this._onDidChangeCatalog.fire();
		} finally {
			this.refreshing = false;
		}
	}

	getState(): IVSCloneModelCatalogState {
		return {
			...this.state,
			providers: [...this.state.providers],
			models: [...this.state.models],
		};
	}

	getProviders(): readonly IVSCloneModelCatalogProviderDescriptor[] {
		return [...this.state.providers];
	}

	getModels(providerId?: VSCloneModelVendor): readonly IVSCloneModelCatalogModelDescriptor[] {
		if (!providerId) {
			return [...this.state.models];
		}
		return this.state.models.filter(model => model.vendor === providerId);
	}

	getModel(identifier: string): IVSCloneModelCatalogModelDescriptor | undefined {
		return this.state.models.find(model => model.identifier === identifier);
	}

	getSelectableModels(): readonly IVSCloneModelCatalogModelDescriptor[] {
		return this.state.models.filter(model => model.isSelectable);
	}

	private computeProviders(providerPreferences: readonly IVSCloneProviderPreferenceState[]): IVSCloneModelCatalogProviderDescriptor[] {
		return providerPreferences
			.filter(providerPreference => providerPreference.enabled)
			.map(providerPreference => ({
				vendor: providerPreference.vendor,
				displayName: providerPreference.displayName,
				status: this.oauthService.state.providers[providerPreference.vendor].isReady ? 'available' as const : 'requires_sign_in' as const,
				modelCount: modelDefinitionsByProvider[providerPreference.vendor].length,
			}))
			.sort(byVendorOrder);
	}

	private computeModels(providerPreferences: readonly IVSCloneProviderPreferenceState[]): IVSCloneModelCatalogModelDescriptor[] {
		const providerByVendor = new Map(providerPreferences.map(providerPreference => [providerPreference.vendor, providerPreference]));
		const models: IVSCloneModelCatalogModelDescriptor[] = [];

		for (const vendor of ['openai', 'anthropic', 'google'] satisfies VSCloneModelVendor[]) {
			const providerPreference = providerByVendor.get(vendor);
			if (!providerPreference || !providerPreference.enabled) {
				continue;
			}

			const providerReady = this.oauthService.state.providers[vendor].isReady;
			for (const model of modelDefinitionsByProvider[vendor]) {
				models.push({
					identifier: toIdentifier(vendor, model.modelId),
					vendor,
					modelId: model.modelId,
					modelName: model.modelName,
					reasoningEffortLevels: model.reasoningEffortLevels,
					defaultReasoningEffort: model.defaultReasoningEffort,
					isSelectable: providerReady,
					unavailableReason: providerReady ? undefined : 'provider_requires_sign_in',
				});
			}
		}

		return models;
	}
}
