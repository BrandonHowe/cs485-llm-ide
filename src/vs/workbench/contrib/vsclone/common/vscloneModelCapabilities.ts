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

/**
 * Mirror Void's `reasoningCapabilities` shape. `reasoningSlider` is a discriminated union so raw
 * token budgets stay separate from preset effort labels, matching how provider reasoning adapters
 * decide what to inject into a request payload.
 */
export type VSCloneReasoningSlider =
	| undefined
	| { readonly type: 'budget_slider'; readonly min: number; readonly max: number; readonly default: number }
	| { readonly type: 'effort_slider'; readonly values: readonly VSCloneReasoningEffortLevel[]; readonly default: VSCloneReasoningEffortLevel };

/**
 * Structurally mirrors Void's `reasoningCapabilities` (modelCapabilities.ts) so the new settings
 * and send-path helpers can share its control flow without bolting on a second capability shape.
 */
export type VSCloneReasoningCapabilities = false | {
	readonly supportsReasoning: true;
	readonly canTurnOffReasoning: boolean;
	readonly canIOReasoning: boolean;
	readonly reasoningReservedOutputTokenSpace?: number;
	readonly reasoningSlider?: VSCloneReasoningSlider;
};

export interface IVSCloneStaticModelDefinition {
	readonly vendor: VSCloneModelVendor;
	readonly modelId: string;
	readonly modelName: string;
	readonly reasoningEffortLevels?: readonly VSCloneReasoningEffortLevel[];
	readonly defaultReasoningEffort?: VSCloneReasoningEffortLevel;
	readonly reasoningCapabilities?: VSCloneReasoningCapabilities;
	readonly supportsImages?: boolean;
	readonly supportsFIM?: boolean;
	readonly supportedFeatures?: readonly VSCloneSettingsFeatureName[];
}

export interface IVSCloneModelCapabilityMetadata {
	readonly reasoningEffortLevels?: readonly VSCloneReasoningEffortLevel[];
	readonly defaultReasoningEffort?: VSCloneReasoningEffortLevel;
	readonly reasoningCapabilities?: VSCloneReasoningCapabilities;
	readonly supportsImages: boolean;
	readonly supportsFIM: boolean;
	readonly supportedFeatures: readonly VSCloneSettingsFeatureName[];
}

export interface IVSCloneProviderSettingsDefinition {
	readonly vendor: VSCloneModelVendor;
	readonly displayName: string;
}

/**
 * Phase 2 consolidates model metadata into one Void-shaped settings owner, so the static provider
 * list needs to live outside any particular service implementation. Keeping it here makes the
 * settings service, thread selection policy, and transport types share the exact same catalog.
 */
export const VSCLONE_PROVIDER_SETTINGS_DEFAULTS: readonly IVSCloneProviderSettingsDefinition[] = [
	{ vendor: 'openai', displayName: defaultOAuthProviderConfig.openai.displayName },
	{ vendor: 'anthropic', displayName: defaultOAuthProviderConfig.anthropic.displayName },
	{ vendor: 'google', displayName: defaultOAuthProviderConfig.google.displayName },
] as const;

export const VSCLONE_MODEL_DEFINITIONS_BY_PROVIDER: Record<VSCloneModelVendor, readonly IVSCloneStaticModelDefinition[]> = {
	openai: [
		{
			vendor: 'openai',
			modelId: 'gpt-5.4',
			modelName: 'GPT-5.4',
			reasoningEffortLevels: ['xhigh', 'high', 'medium', 'low'],
			defaultReasoningEffort: 'medium',
			reasoningCapabilities: {
				supportsReasoning: true,
				canTurnOffReasoning: false,
				canIOReasoning: false,
				reasoningSlider: { type: 'effort_slider', values: ['xhigh', 'high', 'medium', 'low'], default: 'medium' },
			},
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
			reasoningCapabilities: {
				supportsReasoning: true,
				canTurnOffReasoning: false,
				canIOReasoning: false,
				reasoningSlider: { type: 'effort_slider', values: ['standard', 'lite'], default: 'standard' },
			},
		},
		{
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelName: 'GPT-5.3-Codex',
			reasoningEffortLevels: ['xhigh', 'high', 'medium', 'low'],
			defaultReasoningEffort: 'medium',
			reasoningCapabilities: {
				supportsReasoning: true,
				canTurnOffReasoning: false,
				canIOReasoning: false,
				reasoningSlider: { type: 'effort_slider', values: ['xhigh', 'high', 'medium', 'low'], default: 'medium' },
			},
		},
		{
			vendor: 'openai',
			modelId: 'gpt-5.2-codex',
			modelName: 'GPT-5.2-Codex',
			reasoningEffortLevels: ['high', 'medium'],
			defaultReasoningEffort: 'medium',
			reasoningCapabilities: {
				supportsReasoning: true,
				canTurnOffReasoning: false,
				canIOReasoning: false,
				reasoningSlider: { type: 'effort_slider', values: ['high', 'medium'], default: 'medium' },
			},
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
			reasoningCapabilities: {
				supportsReasoning: true,
				canTurnOffReasoning: true,
				canIOReasoning: false,
				reasoningSlider: { type: 'effort_slider', values: ['high', 'low', 'none'], default: 'high' },
			},
		},
	],
	anthropic: [
		{
			vendor: 'anthropic',
			modelId: 'claude-haiku-4-5-20251001',
			modelName: 'Haiku 4.5',
			reasoningEffortLevels: ['none', 'low', 'medium', 'high', 'max'],
			defaultReasoningEffort: 'medium',
			supportsFIM: true,
			reasoningCapabilities: {
				supportsReasoning: true,
				canTurnOffReasoning: true,
				canIOReasoning: true,
				// Anthropic caps Haiku 4.5 output at 64k and requires `budget_tokens < max_tokens`.
				// Expose coarse Claude Code-style presets in the UI and map them to concrete
				// `budget_tokens` in the Anthropic adapter so users are not tuning raw token counts.
				reasoningReservedOutputTokenSpace: 64_000,
				reasoningSlider: { type: 'effort_slider', values: ['none', 'low', 'medium', 'high', 'max'], default: 'medium' },
			},
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
			modelId: 'gemini-2.5-pro',
			modelName: 'Gemini 2.5 Pro',
			// Gemini's native tool path requires thought signatures when explicit thinking is replayed
			// with function calls. Until the runtime preserves those signatures, rely on Google's
			// model-side presets instead of exposing a generic VSClone thinking slider.
			reasoningCapabilities: false,
		},
		{
			vendor: 'google',
			modelId: 'gemini-2.5-flash',
			modelName: 'Gemini 2.5 Flash',
			// Keep Google thinking preset-based for the same reason as Pro: replaying explicit
			// thinking alongside function calls needs provider-issued thought signatures.
			reasoningCapabilities: false,
		},
		{
			vendor: 'google',
			modelId: 'gemini-2.5-flash-lite',
			modelName: 'Gemini 2.5 Flash Lite',
			supportsFIM: true,
			// Flash Lite is the autocomplete fallback too, so do not attach chat thinking controls that
			// would make the native Gemini tool loop depend on unpersisted thought signatures.
			reasoningCapabilities: false,
		},
		{
			vendor: 'google',
			modelId: 'gemini-3.1-pro-preview',
			modelName: 'Gemini 3.1 Pro',
			// Preview entries are retained for existing persisted selections, but they follow the same
			// preset-only thinking policy as the stable Gemini 2.5 family.
			reasoningCapabilities: false,
		},
		{
			vendor: 'google',
			modelId: 'gemini-3-flash-preview',
			modelName: 'Gemini 3 Flash',
			// Keep Google thinking preset-based for the same reason as Pro: replaying explicit
			// thinking alongside function calls needs provider-issued thought signatures.
			reasoningCapabilities: false,
		},
		{
			vendor: 'google',
			modelId: 'gemini-3.1-flash-lite-preview',
			modelName: 'Gemini 3.1 Flash Lite',
			supportsFIM: true,
			// Flash Lite is the autocomplete fallback too, so do not attach chat thinking controls that
			// would make the native Gemini tool loop depend on unpersisted thought signatures.
			reasoningCapabilities: false,
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
		reasoningCapabilities: definition.reasoningCapabilities,
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


/**
 * Mirror Void's `ModelSelectionOptions`. VSClone already persists `reasoningEffort` on the picker
 * selection; the extra `reasoningEnabled` / `reasoningBudget` fields preserve older budget-slider
 * selections and any future provider that still needs a raw token budget.
 */
export interface IVSCloneModelSelectionOptions {
	readonly reasoningEnabled?: boolean;
	readonly reasoningBudget?: number;
	readonly reasoningEffort?: VSCloneReasoningEffortLevel;
}

/**
 * Runtime-side resolved reasoning info. Mirrors Void's `SendableReasoningInfo`: null when reasoning
 * is turned off, otherwise a variant carrying either a raw token budget or a preset effort keyword
 * that the provider adapter can inject directly into the request payload.
 */
export type VSCloneSendableReasoningInfo =
	| null
	| {
		readonly type: 'budget_slider_value';
		readonly isReasoningEnabled: true;
		readonly reasoningBudget: number;
	}
	| {
		readonly type: 'effort_slider_value';
		readonly isReasoningEnabled: true;
		readonly reasoningEffort: VSCloneReasoningEffortLevel;
	};

/**
 * Mirrors Void's `ProviderReasoningIOSettings`. `input.includeInPayload` returns the provider-
 * specific request fragment (e.g. `{ thinking: { type: 'enabled', budget_tokens: N } }` for
 * Anthropic) and `output` describes how reasoning arrives in the streaming delta so the send path
 * knows when to read a named field versus manually parsing `<think>`-style tags.
 */
export interface IVSCloneProviderReasoningIOSettings {
	readonly input?: {
		readonly includeInPayload?: (reasoningInfo: VSCloneSendableReasoningInfo) => Record<string, unknown> | null;
	};
	readonly output?:
	| { readonly nameOfFieldInDelta?: string; readonly needsManualParse?: undefined }
	| { readonly nameOfFieldInDelta?: undefined; readonly needsManualParse?: true };
}

function toVSCloneAnthropicThinkingBudget(level: VSCloneReasoningEffortLevel): number | undefined {
	switch (level) {
		case 'low':
		case 'lite':
		case 'minimal':
			return 4_096;
		case 'medium':
		case 'standard':
			return 16_384;
		case 'high':
		case 'xhigh':
			return 32_768;
		case 'max':
			// Anthropic requires the thinking budget to be strictly below `max_tokens`, and Haiku's
			// output cap is 64k, so the largest valid thinking budget is one token under that cap.
			return 63_999;
		case 'none':
			return undefined;
	}
}

// Anthropic sends the selected preset as a concrete `thinking.budget_tokens` value. Keep the mapping
// here, beside the provider IO adapter, so the UI can stay preset-based while the wire payload
// remains Anthropic-native.
const anthropicReasoningIOSettings: IVSCloneProviderReasoningIOSettings = {
	input: {
		includeInPayload: (reasoningInfo) => {
			if (!reasoningInfo?.isReasoningEnabled) {
				return null;
			}
			if (reasoningInfo.type === 'budget_slider_value') {
				return { thinking: { type: 'enabled', budget_tokens: reasoningInfo.reasoningBudget } };
			}
			if (reasoningInfo.type === 'effort_slider_value') {
				const budget = toVSCloneAnthropicThinkingBudget(reasoningInfo.reasoningEffort);
				return budget === undefined ? null : { thinking: { type: 'enabled', budget_tokens: budget } };
			}
			return null;
		},
	},
};

/**
 * VSClone targets the OpenAI Responses API (`client.responses.stream`), so the reasoning fragment
 * needs the nested `reasoning: { effort }` shape rather than Chat Completions' flat
 * `reasoning_effort` field. VSClone also exposes finer-grained effort labels than the API accepts,
 * so the outgoing effort value is normalized to the supported `minimal | low | medium | high` set
 * before it hits the wire.
 *
 * Reference: https://platform.openai.com/docs/guides/reasoning?api-mode=responses
 */
export type VSCloneOpenAIReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export function toVSCloneOpenAIReasoningEffort(level: VSCloneReasoningEffortLevel): VSCloneOpenAIReasoningEffort {
	switch (level) {
		case 'xhigh':
		case 'max':
		case 'high':
			return 'high';
		case 'medium':
		case 'standard':
			return 'medium';
		case 'low':
		case 'lite':
			return 'low';
		case 'minimal':
		// `'none'` is the off sentinel for effort-slider models and is filtered out by
		// `getVSCloneSendableReasoningInfo` before this function runs, so this branch is defensive
		// for unreachable callers only.
		case 'none':
			return 'minimal';
	}
}

const openAIResponsesIncludeInPayloadReasoning = (reasoningInfo: VSCloneSendableReasoningInfo): Record<string, unknown> | null => {
	if (!reasoningInfo?.isReasoningEnabled) {
		return null;
	}
	if (reasoningInfo.type === 'effort_slider_value') {
		return { reasoning: { effort: toVSCloneOpenAIReasoningEffort(reasoningInfo.reasoningEffort) } };
	}
	return null;
};

const openAIReasoningIOSettings: IVSCloneProviderReasoningIOSettings = {
	input: { includeInPayload: openAIResponsesIncludeInPayloadReasoning },
};

const googleReasoningIOSettings: IVSCloneProviderReasoningIOSettings = {
	input: {
		includeInPayload: (reasoningInfo) => {
			if (!reasoningInfo?.isReasoningEnabled) {
				return null;
			}
			if (reasoningInfo.type === 'budget_slider_value') {
				return { thinkingConfig: { thinkingBudget: reasoningInfo.reasoningBudget } };
			}
			return null;
		},
	},
};

const VSCLONE_PROVIDER_REASONING_IO_SETTINGS: Record<VSCloneModelVendor, IVSCloneProviderReasoningIOSettings> = {
	anthropic: anthropicReasoningIOSettings,
	openai: openAIReasoningIOSettings,
	google: googleReasoningIOSettings,
};

export function getVSCloneProviderReasoningIOSettings(vendor: VSCloneModelVendor): IVSCloneProviderReasoningIOSettings {
	return VSCLONE_PROVIDER_REASONING_IO_SETTINGS[vendor];
}

/**
 * Mirrors Void's `getIsReasoningEnabledState`: a model either always reasons (cannot turn off) or
 * the caller opts in through `reasoningEnabled`. For Chat we default to enabled to match Void.
 */
export function getVSCloneIsReasoningEnabledState(
	featureName: VSCloneSettingsFeatureName,
	vendor: VSCloneModelVendor,
	modelId: string,
	modelSelectionOptions: IVSCloneModelSelectionOptions | undefined,
): boolean {
	const definition = getVSCloneStaticModelDefinition(vendor, modelId);
	if (!definition) {
		return false;
	}
	const capabilities = definition.reasoningCapabilities;
	if (!capabilities) {
		return false;
	}
	const { supportsReasoning, canTurnOffReasoning } = capabilities;
	if (!supportsReasoning) {
		return false;
	}
	// default to enabled if can't turn off, or if the featureName is Chat.
	const defaultEnabledVal = featureName === 'Chat' || !canTurnOffReasoning;
	return modelSelectionOptions?.reasoningEnabled ?? defaultEnabledVal;
}

/**
 * Mirrors Void's `getReservedOutputTokenSpace` contract adapted to VSClone's lighter capability
 * shape. There is no separate `reservedOutputTokenSpace` field on the model definition yet, so the
 * helper simply returns the reasoning-specific override when reasoning is enabled.
 */
export function getVSCloneReservedOutputTokenSpaceForReasoning(
	vendor: VSCloneModelVendor,
	modelId: string,
	opts: { isReasoningEnabled: boolean },
): number | undefined {
	const definition = getVSCloneStaticModelDefinition(vendor, modelId);
	const capabilities = definition?.reasoningCapabilities;
	if (!opts.isReasoningEnabled || !capabilities) {
		return undefined;
	}
	return capabilities.reasoningReservedOutputTokenSpace;
}

/**
 * Mirrors Void's `getSendableReasoningInfo`. Budget-slider models use the numeric `reasoningBudget`;
 * effort-slider models pass a preset `VSCloneReasoningEffortLevel` through so each provider adapter
 * can map it to the native wire shape. Gemini intentionally has no slider here because its
 * tool-call replay needs provider-issued thought signatures when explicit thinking is included in
 * the request history.
 */
export function getVSCloneSendableReasoningInfo(
	featureName: VSCloneSettingsFeatureName,
	vendor: VSCloneModelVendor,
	modelId: string,
	modelSelectionOptions: IVSCloneModelSelectionOptions | undefined,
): VSCloneSendableReasoningInfo {
	const definition = getVSCloneStaticModelDefinition(vendor, modelId);
	const reasoningSlider = definition?.reasoningCapabilities ? definition.reasoningCapabilities.reasoningSlider : undefined;
	const isReasoningEnabled = getVSCloneIsReasoningEnabledState(featureName, vendor, modelId, modelSelectionOptions);
	if (!isReasoningEnabled) {
		return null;
	}

	// check for reasoning budget
	const reasoningBudget = reasoningSlider?.type === 'budget_slider'
		? modelSelectionOptions?.reasoningBudget ?? reasoningSlider.default
		: undefined;
	if (reasoningBudget !== undefined) {
		return { type: 'budget_slider_value', isReasoningEnabled: true, reasoningBudget };
	}

	// check for reasoning effort
	const reasoningEffort = reasoningSlider?.type === 'effort_slider'
		? modelSelectionOptions?.reasoningEffort ?? reasoningSlider.default
		: undefined;
	// VSClone lists `'none'` as a real slider value for the off slot (Void uses a synthetic -1 index
	// instead). Treat `'none'` as "no reasoning" at the send path so the provider builder omits the
	// `reasoning` field entirely rather than falling back to `{ effort: 'minimal' }`.
	if (reasoningEffort !== undefined && reasoningEffort !== 'none') {
		return { type: 'effort_slider_value', isReasoningEnabled: true, reasoningEffort };
	}

	return null;
}
