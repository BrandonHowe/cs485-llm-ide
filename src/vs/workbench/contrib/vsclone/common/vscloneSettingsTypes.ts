/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IVSCloneChatLocation, IVSCloneModelSelection, type IVSCloneThreadSelectionMap } from './vscloneModelSelectionTypes.js';
import { VSCLONE_SETTINGS_FEATURE_NAMES, type VSCloneReasoningEffortLevel, type VSCloneSettingsFeatureName, type IVSCloneModelCapabilityMetadata } from './vscloneModelCapabilities.js';
import { VSCloneModelVendor } from './vscloneOAuthTypes.js';

export type VSCloneSettingsStatus = 'idle' | 'loading' | 'ready' | 'error';
export type VSCloneFeatureModelSelection = Pick<IVSCloneModelSelection, 'location' | 'modelIdentifier' | 'vendor' | 'modelId' | 'modelName' | 'reasoningEffort' | 'selectedAt'>;

export interface IVSCloneSettingsFeatureDefinition {
	readonly featureName: VSCloneSettingsFeatureName;
	readonly location: IVSCloneChatLocation;
	readonly displayName: string;
}

/**
 * The consolidated settings service speaks in feature names to mirror Void, but the rest of
 * VSClone still persists location-scoped selections. This table is the explicit bridge between
 * those two concepts so we do not scatter ad hoc string conversions across the codebase.
 */
export const VSCLONE_SETTINGS_FEATURE_DEFINITIONS: readonly IVSCloneSettingsFeatureDefinition[] = [
	{ featureName: 'Chat', location: 'chat', displayName: 'Chat' },
	{ featureName: 'Autocomplete', location: 'editorInline', displayName: 'Autocomplete' },
	{ featureName: 'Notebook', location: 'notebook', displayName: 'Notebook' },
	{ featureName: 'Terminal', location: 'terminal', displayName: 'Terminal' },
] as const;

const featureNameByLocation = new Map<IVSCloneChatLocation, VSCloneSettingsFeatureName>(
	VSCLONE_SETTINGS_FEATURE_DEFINITIONS.map(definition => [definition.location, definition.featureName]),
);

const featureLocationByName = new Map<VSCloneSettingsFeatureName, IVSCloneChatLocation>(
	VSCLONE_SETTINGS_FEATURE_DEFINITIONS.map(definition => [definition.featureName, definition.location]),
);

export function isVSCloneSettingsFeatureName(value: string): value is VSCloneSettingsFeatureName {
	return (VSCLONE_SETTINGS_FEATURE_NAMES as readonly string[]).includes(value);
}

export function toVSCloneFeatureName(location: IVSCloneChatLocation): VSCloneSettingsFeatureName | undefined {
	return featureNameByLocation.get(location);
}

export function toVSCloneFeatureLocation(featureName: VSCloneSettingsFeatureName): IVSCloneChatLocation {
	const location = featureLocationByName.get(featureName);
	if (!location) {
		throw new Error(`Unknown VSClone settings feature: ${featureName}`);
	}
	return location;
}

export function createEmptyVSCloneModelSelectionOfFeature(): Record<VSCloneSettingsFeatureName, VSCloneFeatureModelSelection | undefined> {
	return Object.fromEntries(
		VSCLONE_SETTINGS_FEATURE_DEFINITIONS.map(definition => [definition.featureName, undefined]),
	) as Record<VSCloneSettingsFeatureName, VSCloneFeatureModelSelection | undefined>;
}

export interface IVSCloneSettingsProviderState {
	readonly vendor: VSCloneModelVendor;
	readonly displayName: string;
	readonly enabled: boolean;
	readonly status: 'available' | 'requires_sign_in';
	readonly modelCount: number;
	readonly selectableModelCount: number;
	readonly definedModelCount: number;
}

export type VSCloneModelUnavailableReason =
	| 'provider_requires_sign_in'
	| 'account_ineligible';

export interface IVSCloneSettingsModelState {
	readonly identifier: string;
	readonly vendor: VSCloneModelVendor;
	readonly modelId: string;
	readonly modelName: string;
	readonly reasoningEffortLevels?: readonly VSCloneReasoningEffortLevel[];
	readonly defaultReasoningEffort?: VSCloneReasoningEffortLevel;
	readonly supportsImages: boolean;
	readonly supportsFIM: boolean;
	readonly supportedFeatures: readonly VSCloneSettingsFeatureName[];
	readonly selectableFeatures: readonly VSCloneSettingsFeatureName[];
	readonly capabilities: IVSCloneModelCapabilityMetadata;
	readonly isSelectable: boolean;
	readonly unavailableReason?: VSCloneModelUnavailableReason;
	readonly ineligibilityReason?: string;
}

export interface IVSCloneModelIneligibilityRecord {
	readonly modelIdentifier: string;
	readonly reason: string;
	readonly markedAt: number;
}

/**
 * Provider visibility stays profile-scoped because it is a user preference rather than a property
 * of any one workspace's thread graph. The settings service persists only the override bit here
 * and recomputes the rest of the provider/model projection from OAuth plus static model metadata.
 */
export interface IVSCloneStoredProviderPreference {
	readonly enabled: boolean;
}

/**
 * Eligibility remains an OAuth-account-side effect, so the persisted payload stores the raw
 * reason text and timestamp while the live settings projection decides whether that record should
 * currently surface as a disabled picker entry.
 */
export interface IVSCloneStoredModelIneligibility {
	readonly reason: string;
	readonly markedAt: number;
}

export interface IVSCloneStoredSettingsState {
	readonly providers: Partial<Record<VSCloneModelVendor, IVSCloneStoredProviderPreference>>;
	readonly ineligibility: Record<string, IVSCloneStoredModelIneligibility>;
}

export interface IVSCloneSettingsFeatureState {
	readonly featureName: VSCloneSettingsFeatureName;
	readonly location: IVSCloneChatLocation;
	readonly selection: VSCloneFeatureModelSelection | undefined;
}

export function createEmptyVSCloneFeatureDefaults(): Record<VSCloneSettingsFeatureName, IVSCloneSettingsFeatureState> {
	return Object.fromEntries(
		VSCLONE_SETTINGS_FEATURE_DEFINITIONS.map(definition => [definition.featureName, {
			featureName: definition.featureName,
			location: definition.location,
			selection: undefined,
		}]),
	) as Record<VSCloneSettingsFeatureName, IVSCloneSettingsFeatureState>;
}

export interface IVSCloneSettingsThreadSelectionSnapshot {
	readonly threadId: string;
	readonly featureName: VSCloneSettingsFeatureName;
	readonly selection: IVSCloneModelSelection;
}

export type IVSCloneSettingsThreadSelections = IVSCloneThreadSelectionMap;
export type IVSCloneSettingsThreadSelectionSnapshotMap = Partial<Record<VSCloneSettingsFeatureName, IVSCloneSettingsThreadSelectionSnapshot>>;

export interface IVSCloneSettingsRecentModelState {
	readonly identifier: string;
	readonly model: IVSCloneSettingsModelState | undefined;
	readonly lastSelectedAt?: number;
}

export interface IVSCloneSettingsEligibilityRecord {
	readonly scope: 'provider' | 'model';
	readonly source: 'oauth_sign_in' | 'oauth_account';
	readonly vendor: VSCloneModelVendor;
	readonly identifier: string;
	readonly displayName: string;
	readonly status: 'requires_sign_in' | 'account_ineligible';
	readonly reason?: string;
	readonly markedAt?: number;
	readonly modelIdentifier?: string;
	readonly modelId?: string;
	readonly modelName?: string;
}

export interface IVSCloneSettingsState {
	readonly status: VSCloneSettingsStatus;
	readonly providers: readonly IVSCloneSettingsProviderState[];
	readonly models: readonly IVSCloneSettingsModelState[];
	readonly featureSelections: Partial<Record<IVSCloneChatLocation, VSCloneFeatureModelSelection>>;
	readonly modelSelectionOfFeature: Record<VSCloneSettingsFeatureName, VSCloneFeatureModelSelection | undefined>;
	readonly featureDefaults: Record<VSCloneSettingsFeatureName, IVSCloneSettingsFeatureState>;
	// Thread-effective snapshots stay explicit so restores/retries keep the model identity that
	// actually ran, even if the feature default changes later.
	readonly threadSelections: Record<string, IVSCloneSettingsThreadSelections>;
	readonly threadSelectionSnapshots: Record<string, IVSCloneSettingsThreadSelectionSnapshotMap>;
	readonly recentModels: readonly IVSCloneSettingsRecentModelState[];
	readonly recentModelIdentifiers: readonly string[];
	readonly eligibilityRecords: readonly IVSCloneSettingsEligibilityRecord[];
	readonly ineligibilityRecords: readonly IVSCloneModelIneligibilityRecord[];
	readonly updatedAt?: number;
	readonly errorMessage?: string;
}
