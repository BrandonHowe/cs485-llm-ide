/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defaultOAuthProviderConfig, VSCloneModelVendor } from './vscloneOAuthTypes.js';

/**
 * Void exposes per-feature model settings rather than location-only defaults. VSClone still routes
 * its live agent path through location-based services, so this feature list intentionally mirrors
 * the entry points VSClone can select today instead of inventing future-only feature names.
 */
export const VSCLONE_SETTINGS_FEATURE_NAMES = ['Chat', 'Autocomplete', 'Notebook', 'Terminal'] as const;
export type VSCloneSettingsFeatureName = typeof VSCLONE_SETTINGS_FEATURE_NAMES[number];

export type VSCloneReasoningEffortLevel =
	| 'xhigh'
	| 'max'
	| 'high'
	| 'medium'
	| 'standard'
	| 'low'
	| 'minimal'
	| 'lite'
	| 'none';

const allReasoningEffortLevels: readonly VSCloneReasoningEffortLevel[] = [
	'xhigh',
	'max',
	'high',
	'medium',
	'standard',
	'low',
	'minimal',
	'lite',
	'none',
];

export function isVSCloneReasoningEffortLevel(value: string): value is VSCloneReasoningEffortLevel {
	return (allReasoningEffortLevels as readonly string[]).includes(value);
}

const chatScopedFeatureSupport = ['Chat', 'Notebook', 'Terminal'] as const satisfies readonly VSCloneSettingsFeatureName[];
const autocompleteCapableFeatureSupport = ['Chat', 'Autocomplete', 'Notebook', 'Terminal'] as const satisfies readonly VSCloneSettingsFeatureName[];

export interface IVSCloneStaticModelDefinition {
	readonly vendor: VSCloneModelVendor;
	readonly modelId: string;
	readonly modelName: string;
	readonly reasoningEffortLevels?: readonly VSCloneReasoningEffortLevel[];
	readonly defaultReasoningEffort?: VSCloneReasoningEffortLevel;
	readonly supportsImages?: boolean;
	readonly supportsFIM?: boolean;
	readonly supportedFeatures?: readonly VSCloneSettingsFeatureName[];
}

export interface IVSCloneModelCapabilityMetadata {
	readonly reasoningEffortLevels?: readonly VSCloneReasoningEffortLevel[];
	readonly defaultReasoningEffort?: VSCloneReasoningEffortLevel;
	readonly supportsImages: boolean;
	readonly supportsFIM: boolean;
	readonly supportedFeatures: readonly VSCloneSettingsFeatureName[];
}

export interface IVSCloneProviderSettingsDefinition {
	readonly vendor: VSCloneModelVendor;
	readonly displayName: string;
	readonly enabled: boolean;
}

/**
 * Phase 2 consolidates model metadata into one Void-shaped settings owner, so the static provider
 * list needs to live outside any particular service implementation. Keeping it here makes the
 * settings service, thread selection policy, and transport types share the exact same catalog.
 */
export const VSCLONE_PROVIDER_SETTINGS_DEFAULTS: readonly IVSCloneProviderSettingsDefinition[] = [
	{ vendor: 'openai', displayName: defaultOAuthProviderConfig.openai.displayName, enabled: true },
	{ vendor: 'anthropic', displayName: defaultOAuthProviderConfig.anthropic.displayName, enabled: true },
	// Keep Google visible by default so OAuth-backed Gemini discovery stays obvious in the picker.
	{ vendor: 'google', displayName: defaultOAuthProviderConfig.google.displayName, enabled: true },
] as const;

export const VSCLONE_MODEL_DEFINITIONS_BY_PROVIDER: Record<VSCloneModelVendor, readonly IVSCloneStaticModelDefinition[]> = {
	openai: [
		{
			vendor: 'openai',
			modelId: 'gpt-5.4',
			modelName: 'GPT-5.4',
			reasoningEffortLevels: ['xhigh', 'high', 'medium', 'low'],
			defaultReasoningEffort: 'medium',
		},
		{
			vendor: 'openai',
			modelId: 'gpt-5.3-codex-spark',
			modelName: 'GPT-5.3-Codex-Spark',
			reasoningEffortLevels: ['standard', 'lite'],
			defaultReasoningEffort: 'standard',
			supportsImages: false,
			// Spark is the primary inline-completion model today, so the consolidated settings state
			// needs to advertise it as Autocomplete-capable before the dedicated inline picker lands.
			supportsFIM: true,
		},
		{
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelName: 'GPT-5.3-Codex',
			reasoningEffortLevels: ['xhigh', 'high', 'medium', 'low'],
			defaultReasoningEffort: 'medium',
		},
		{
			vendor: 'openai',
			modelId: 'gpt-5.2-codex',
			modelName: 'GPT-5.2-Codex',
			reasoningEffortLevels: ['high', 'medium'],
			defaultReasoningEffort: 'medium',
		},
		{
			vendor: 'openai',
			modelId: 'gpt-5-nano',
			modelName: 'GPT-5 Nano',
			// Inline completions intentionally bias to Nano when Spark is unavailable, so the catalog
			// must allow `none` here to keep that fallback cheap without weakening chat defaults.
			reasoningEffortLevels: ['high', 'low', 'none'],
			defaultReasoningEffort: 'high',
			supportsFIM: true,
		},
	],
	anthropic: [
		{
			vendor: 'anthropic',
			modelId: 'claude-haiku-4-5-20251001',
			modelName: 'Haiku 4.5',
			supportsFIM: true,
		},
		{
			vendor: 'anthropic',
			modelId: 'claude-3-haiku-20240307',
			modelName: 'Haiku 3',
		},
	],
	google: [
		{
			vendor: 'google',
			modelId: 'gemini-3.1-pro-preview',
			modelName: 'Gemini 3.1 Pro',
			reasoningEffortLevels: ['high', 'medium', 'low', 'minimal'],
			defaultReasoningEffort: 'medium',
		},
		{
			vendor: 'google',
			modelId: 'gemini-3-flash-preview',
			modelName: 'Gemini 3 Flash',
			reasoningEffortLevels: ['high', 'medium', 'low', 'minimal'],
			defaultReasoningEffort: 'medium',
		},
		{
			vendor: 'google',
			modelId: 'gemini-3.1-flash-lite-preview',
			modelName: 'Gemini 3.1 Flash Lite',
			reasoningEffortLevels: ['high', 'medium', 'low', 'minimal'],
			defaultReasoningEffort: 'medium',
			supportsFIM: true,
		},
	],
};

export function toVSCloneModelIdentifier(vendor: VSCloneModelVendor, modelId: string): string {
	return `${vendor}/${modelId}`;
}

export function getVSCloneStaticModelDefinition(
	vendor: VSCloneModelVendor,
	modelId: string,
): IVSCloneStaticModelDefinition | undefined {
	return VSCLONE_MODEL_DEFINITIONS_BY_PROVIDER[vendor].find(model => model.modelId === modelId);
}

export function getVSCloneStaticModelDefinitionByIdentifier(modelIdentifier: string): IVSCloneStaticModelDefinition | undefined {
	const [vendor, ...modelIdParts] = modelIdentifier.split('/');
	if (vendor !== 'openai' && vendor !== 'anthropic' && vendor !== 'google') {
		return undefined;
	}
	return getVSCloneStaticModelDefinition(vendor, modelIdParts.join('/'));
}

export const VSCLONE_MODEL_IDENTIFIERS = Object.freeze(
	(Object.entries(VSCLONE_MODEL_DEFINITIONS_BY_PROVIDER) as readonly [VSCloneModelVendor, readonly IVSCloneStaticModelDefinition[]][])
		.flatMap(([vendor, definitions]) => definitions.map(definition => toVSCloneModelIdentifier(vendor, definition.modelId))),
);

/**
 * The settings service needs one normalized capability shape regardless of whether the caller is
 * rendering a picker row, filtering models by feature, or adapting a request payload. Centralizing
 * that derivation here prevents the catalog and future settings UI from drifting apart.
 */
export function getVSCloneModelCapabilityMetadata(definition: IVSCloneStaticModelDefinition): IVSCloneModelCapabilityMetadata {
	const supportsFIM = definition.supportsFIM === true;
	const supportedFeatures = definition.supportedFeatures
		? [...definition.supportedFeatures]
		: [...(supportsFIM ? autocompleteCapableFeatureSupport : chatScopedFeatureSupport)];

	return {
		reasoningEffortLevels: definition.reasoningEffortLevels ? [...definition.reasoningEffortLevels] : undefined,
		defaultReasoningEffort: definition.defaultReasoningEffort,
		supportsImages: definition.supportsImages !== false,
		supportsFIM,
		supportedFeatures,
	};
}

export function supportsVSCloneFeature(
	vendor: VSCloneModelVendor,
	modelId: string,
	featureName: VSCloneSettingsFeatureName,
): boolean {
	const definition = getVSCloneStaticModelDefinition(vendor, modelId);
	return !!definition && getVSCloneModelCapabilityMetadata(definition).supportedFeatures.includes(featureName);
}
