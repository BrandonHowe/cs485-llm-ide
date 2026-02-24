/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IVSCloneMockProviderService, IVSCloneMockProviderState, VSCloneModelVendor } from './vscloneMockProviderService.js';

export type VSCloneModelCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface IVSCloneModelCatalogProviderDescriptor {
	readonly vendor: VSCloneModelVendor;
	readonly displayName: string;
	readonly status: 'available' | 'requires_config';
	readonly modelCount: number;
}

export type VSCloneModelUnavailableReason = 'provider_requires_configuration';

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

export type VSCloneReasoningEffortLevel = 'low' | 'medium' | 'high';

export function isVSCloneReasoningEffortLevel(value: string): value is VSCloneReasoningEffortLevel {
	return value === 'low' || value === 'medium' || value === 'high';
}

const openAIReasoningEffortLevels: readonly VSCloneReasoningEffortLevel[] = ['low', 'medium', 'high'];

const modelDefinitionsByProvider: Record<VSCloneModelVendor, readonly IModelDefinition[]> = {
	openai: [
		{ vendor: 'openai', modelId: 'gpt-5.3-codex', modelName: 'GPT-5.3-Codex', reasoningEffortLevels: openAIReasoningEffortLevels, defaultReasoningEffort: 'medium' },
		{ vendor: 'openai', modelId: 'gpt-5.2-codex', modelName: 'GPT-5.2-Codex', reasoningEffortLevels: openAIReasoningEffortLevels, defaultReasoningEffort: 'medium' },
		{ vendor: 'openai', modelId: 'gpt-5.1-codex-max', modelName: 'GPT-5.1-Codex-Max', reasoningEffortLevels: openAIReasoningEffortLevels, defaultReasoningEffort: 'medium' },
		{ vendor: 'openai', modelId: 'gpt-5.2', modelName: 'GPT-5.2', reasoningEffortLevels: openAIReasoningEffortLevels, defaultReasoningEffort: 'medium' },
		{ vendor: 'openai', modelId: 'gpt-5.1-codex-mini', modelName: 'GPT-5.1-Codex-Mini', reasoningEffortLevels: openAIReasoningEffortLevels, defaultReasoningEffort: 'medium' },
	],
	anthropic: [
		{ vendor: 'anthropic', modelId: 'claude-3.5-sonnet', modelName: 'Claude 3.5 Sonnet' },
		{ vendor: 'anthropic', modelId: 'claude-3-opus', modelName: 'Claude 3 Opus' },
		{ vendor: 'anthropic', modelId: 'claude-3-haiku', modelName: 'Claude 3 Haiku' },
	],
	google: [
		{ vendor: 'google', modelId: 'gemini-pro-2.0', modelName: 'Gemini Pro 2.0' },
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
		@IVSCloneMockProviderService private readonly providerService: IVSCloneMockProviderService,
	) {
		super();

		this._register(this.providerService.onDidChangeProviders(() => {
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
			await this.providerService.initialize();
			await timeout(120);

			if (this.failNextRefreshForTest) {
				this.failNextRefreshForTest = false;
				throw new Error('Failed to fetch model catalog. Check your network connection.');
			}

			const providers = this.computeProviders(this.providerService.getProviders());
			const models = this.computeModels(this.providerService.getProviders());
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

	private computeProviders(providerStates: readonly IVSCloneMockProviderState[]): IVSCloneModelCatalogProviderDescriptor[] {
		return providerStates
			.filter(providerState => providerState.enabled)
			.map(providerState => ({
				vendor: providerState.vendor,
				displayName: providerState.displayName,
				status: providerState.configured ? 'available' as const : 'requires_config' as const,
				modelCount: modelDefinitionsByProvider[providerState.vendor].length,
			}))
			.sort(byVendorOrder);
	}

	private computeModels(providerStates: readonly IVSCloneMockProviderState[]): IVSCloneModelCatalogModelDescriptor[] {
		const providerByVendor = new Map(providerStates.map(providerState => [providerState.vendor, providerState]));
		const models: IVSCloneModelCatalogModelDescriptor[] = [];

		for (const vendor of ['openai', 'anthropic', 'google'] satisfies VSCloneModelVendor[]) {
			const providerState = providerByVendor.get(vendor);
			if (!providerState || !providerState.enabled) {
				continue;
			}

			for (const model of modelDefinitionsByProvider[vendor]) {
				models.push({
					identifier: toIdentifier(vendor, model.modelId),
					vendor,
					modelId: model.modelId,
					modelName: model.modelName,
					reasoningEffortLevels: model.reasoningEffortLevels,
					defaultReasoningEffort: model.defaultReasoningEffort,
					isSelectable: providerState.configured,
					unavailableReason: providerState.configured ? undefined : 'provider_requires_configuration',
				});
			}
		}

		return models;
	}
}
