/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Extensions as ConfigurationExtensions, ConfigurationScope, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptor, IViewsRegistry, ViewContainer, ViewContainerLocation } from '../../../common/views.js';
import { registerVSCloneChatHistoryActions } from './vscloneChatHistoryActions.js';
import { registerVSCloneAutocompleteActions } from './vscloneAutocompleteActions.js';
import { registerVSCloneModelSwitcherActions } from './vscloneModelSwitcherActions.js';
import { registerVSCloneOAuthActions } from './vscloneOAuthActions.js';
import { VSCloneOAuthService } from './vscloneOAuthService.js';
import { IVSCloneChatApiService, VSCloneChatApiService } from './vscloneChatApiService.js';
import { IVSCloneAgentLoopService, VSCloneAgentLoopService } from './vscloneAgentLoopService.js';
import { IVSCloneChatSessionService, VSCloneChatSessionService } from './vscloneChatSessionService.js';
import { IVSCloneContextGatheringService, VSCloneContextGatheringService } from './vscloneContextGatheringService.js';
import { IVSCloneEditApplicationService, VSCloneEditApplicationService } from './vscloneEditApplicationService.js';
import { IVSCloneProviderConfigurationBridge, VSCloneProviderConfigurationBridge } from './vscloneProviderConfigurationBridge.js';
import { IVSCloneToolExecutionService, VSCloneToolExecutionService } from './vscloneToolExecutionService.js';
import { VSCloneUnifiedChatViewPane } from './vscloneUnifiedChatViewPane.js';
import { VSCloneViewContainerId, VSCloneViewId } from './vsclone.js';
import { IVSCloneChatHistoryService, VSCloneChatHistoryEnabledSetting, VSCloneChatHistoryMaxThreadsSetting, VSCloneChatHistoryMaxTurnsPerThreadSetting, VSCloneChatHistoryPersistScopeSetting, VSCloneChatHistoryRailWidthSetting, VSCloneChatHistoryRedactSecretsSetting, VSCloneChatHistoryRetentionDaysSetting, VSCloneChatHistoryService } from '../common/backend/vscloneChatHistoryService.js';
import { IVSCloneOAuthService } from '../common/vscloneOAuthService.js';
import { IVSCloneModelCatalogService, VSCloneModelCatalogService } from '../common/vscloneModelCatalogService.js';
import { IVSCloneModelEligibilityService, VSCloneModelEligibilityService } from '../common/vscloneModelEligibilityService.js';
import { IVSClonePlanModeService, VSClonePlanModeService } from '../common/vsclonePlanModeService.js';
import { IVSClonePromptAssemblyService, VSClonePromptAssemblyService } from '../common/vsclonePromptAssemblyService.js';
import { IVSCloneThreadModelSelectionService, VSCloneThreadModelSelectionService } from '../common/backend/vscloneThreadModelSelectionService.js';
import { IVSCloneCompletionBackend } from '../common/vscloneCompletionTypes.js';
import { IVSCloneCompletionPromptService, VSCloneCompletionPromptService } from '../common/vscloneCompletionPromptService.js';
import { IVSCloneProviderPreferencesService, VSCloneProviderPreferencesService } from '../common/vscloneProviderPreferencesService.js';
import { VSCloneAutocompleteService, VSCloneAutocompleteDebounceMsSetting, VSCloneAutocompleteEnabledSetting } from './vscloneAutocompleteService.js';
import { IVSCloneCompletionApiService, VSCloneCompletionApiService } from './vscloneCompletionApiService.js';
import { VSCloneCompletionBackendService } from './vscloneCompletionBackendService.js';
import { IVSCloneCompletionContextService, VSCloneCompletionContextService } from './vscloneCompletionContextService.js';
import { IVSCloneUnifiedChatBackendService, VSCloneUnifiedChatBackendService } from '../common/backend/vscloneUnifiedChatBackendService.js';

const vscloneContributionRegistrationKey = '__vscloneContributionRegistered__';
type VSCloneContributionGlobalScope = typeof globalThis & {
	readonly [vscloneContributionRegistrationKey]?: boolean;
};
const vscloneSidebarMinimumWidth = 300;

function registerVSCloneContribution(): void {
	const vscloneViewIcon = registerIcon('vsclone-view-icon', Codicon.chatSparkle, localize('vsclone.viewIcon', 'View icon of the VSClone chat view.'));

	const vscloneViewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
		id: VSCloneViewContainerId,
		title: localize2('vsclone.viewContainer.label', 'VSClone'),
		icon: vscloneViewIcon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VSCloneViewContainerId, { mergeViewWithContainerWhenSingleView: false }]),
		storageId: VSCloneViewContainerId,
		hideIfEmpty: false,
		// Keep the unified chat pane from being resized below a usable width.
		minimumWidth: vscloneSidebarMinimumWidth,
	}, ViewContainerLocation.Sidebar, { isDefault: false, doNotRegisterOpenCommand: true });

	const viewDescriptor: IViewDescriptor = {
		id: VSCloneViewId,
		containerIcon: vscloneViewContainer.icon,
		containerTitle: vscloneViewContainer.title.value,
		singleViewPaneContainerTitle: vscloneViewContainer.title.value,
		name: localize2('vsclone.viewContainer.name', 'VSClone Chat'),
		canToggleVisibility: true,
		canMoveView: false,
		ctorDescriptor: new SyncDescriptor(VSCloneUnifiedChatViewPane),
	};

	Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([viewDescriptor], vscloneViewContainer);

	registerSingleton(IVSCloneUnifiedChatBackendService, VSCloneUnifiedChatBackendService, InstantiationType.Delayed);
	registerSingleton(IVSCloneChatHistoryService, VSCloneChatHistoryService, InstantiationType.Delayed);
	registerSingleton(IVSCloneProviderPreferencesService, VSCloneProviderPreferencesService, InstantiationType.Delayed);
	registerSingleton(IVSCloneModelEligibilityService, VSCloneModelEligibilityService, InstantiationType.Delayed);
	registerSingleton(IVSCloneModelCatalogService, VSCloneModelCatalogService, InstantiationType.Delayed);
	registerSingleton(IVSCloneThreadModelSelectionService, VSCloneThreadModelSelectionService, InstantiationType.Delayed);
	registerSingleton(IVSClonePlanModeService, VSClonePlanModeService, InstantiationType.Delayed);
	registerSingleton(IVSCloneContextGatheringService, VSCloneContextGatheringService, InstantiationType.Delayed);
	registerSingleton(IVSClonePromptAssemblyService, VSClonePromptAssemblyService, InstantiationType.Delayed);
	registerSingleton(IVSCloneEditApplicationService, VSCloneEditApplicationService, InstantiationType.Delayed);
	registerSingleton(IVSCloneProviderConfigurationBridge, VSCloneProviderConfigurationBridge, InstantiationType.Delayed);
	registerSingleton(IVSCloneChatApiService, VSCloneChatApiService, InstantiationType.Delayed);
	registerSingleton(IVSCloneCompletionApiService, VSCloneCompletionApiService, InstantiationType.Delayed);
	registerSingleton(IVSCloneCompletionContextService, VSCloneCompletionContextService, InstantiationType.Delayed);
	registerSingleton(IVSCloneToolExecutionService, VSCloneToolExecutionService, InstantiationType.Delayed);
	registerSingleton(IVSCloneAgentLoopService, VSCloneAgentLoopService, InstantiationType.Delayed);
	registerSingleton(IVSCloneChatSessionService, VSCloneChatSessionService, InstantiationType.Delayed);
	registerSingleton(IVSCloneOAuthService, VSCloneOAuthService, InstantiationType.Delayed);
	registerSingleton(IVSCloneCompletionPromptService, VSCloneCompletionPromptService, InstantiationType.Delayed);
	registerSingleton(IVSCloneCompletionBackend, VSCloneCompletionBackendService, InstantiationType.Delayed);

	registerVSCloneChatHistoryActions();
	registerVSCloneAutocompleteActions();
	registerVSCloneModelSwitcherActions();
	registerVSCloneOAuthActions();
	registerWorkbenchContribution2(VSCloneAutocompleteService.ID, VSCloneAutocompleteService, WorkbenchPhase.AfterRestored);

	Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
		id: 'vsclone',
		title: localize('vsclone.configuration.title', 'VSClone'),
		type: 'object',
		properties: {
			[VSCloneChatHistoryEnabledSetting]: {
				type: 'boolean',
				default: true,
				description: localize('vsclone.configuration.chatHistory.enabled', 'Enable VSClone chat history tracking.'),
				scope: ConfigurationScope.WINDOW,
			},
			[VSCloneChatHistoryMaxThreadsSetting]: {
				type: 'number',
				default: 200,
				minimum: 1,
				description: localize('vsclone.configuration.chatHistory.maxThreads', 'Maximum number of VSClone chat threads to persist.'),
				scope: ConfigurationScope.WINDOW,
			},
			[VSCloneChatHistoryMaxTurnsPerThreadSetting]: {
				type: 'number',
				default: 100,
				minimum: 1,
				description: localize('vsclone.configuration.chatHistory.maxTurnsPerThread', 'Maximum number of turns to persist per VSClone thread.'),
				scope: ConfigurationScope.WINDOW,
			},
			[VSCloneChatHistoryRetentionDaysSetting]: {
				type: 'number',
				default: 30,
				minimum: 1,
				description: localize('vsclone.configuration.chatHistory.retentionDays', 'Number of days to retain VSClone chat history.'),
				scope: ConfigurationScope.WINDOW,
			},
			[VSCloneChatHistoryRailWidthSetting]: {
				type: 'number',
				default: 320,
				minimum: 220,
				maximum: 520,
				description: localize('vsclone.configuration.chatHistory.railWidth', 'Default width in pixels for the VSClone chat history rail.'),
				scope: ConfigurationScope.WINDOW,
			},
			[VSCloneChatHistoryPersistScopeSetting]: {
				type: 'string',
				default: 'workspace',
				enum: ['workspace', 'profile'],
				enumDescriptions: [
					localize('vsclone.configuration.chatHistory.persistScope.workspace', 'Store VSClone chat history in workspace storage.'),
					localize('vsclone.configuration.chatHistory.persistScope.profile', 'Store VSClone chat history in profile-global storage.'),
				],
				description: localize('vsclone.configuration.chatHistory.persistScope', 'Persistence scope for VSClone chat history.'),
				scope: ConfigurationScope.WINDOW,
			},
			[VSCloneChatHistoryRedactSecretsSetting]: {
				type: 'boolean',
				default: true,
				description: localize('vsclone.configuration.chatHistory.redactSecrets', 'Redact simple secret-like text patterns before persisting VSClone chat history.'),
				scope: ConfigurationScope.WINDOW,
			},
			['vsclone.modelSwitcher.enabled']: {
				type: 'boolean',
				default: true,
				description: localize('vsclone.configuration.modelSwitcher.enabled', 'Enable the VSClone model selector in the unified chat composer.'),
				scope: ConfigurationScope.WINDOW,
			},
			[VSCloneAutocompleteEnabledSetting]: {
				type: 'boolean',
				default: true,
				description: localize('vsclone.configuration.autocomplete.enabled', 'Enable VSClone inline code completions.'),
				scope: ConfigurationScope.WINDOW,
			},
			[VSCloneAutocompleteDebounceMsSetting]: {
				type: 'number',
				default: 500,
				minimum: 0,
				description: localize('vsclone.configuration.autocomplete.debounceMs', 'Delay in milliseconds before VSClone requests an inline completion after typing stops.'),
				scope: ConfigurationScope.WINDOW,
			},
		},
	});
}

const globalScope = globalThis as VSCloneContributionGlobalScope;
if (!globalScope[vscloneContributionRegistrationKey]) {
	(globalScope as { [vscloneContributionRegistrationKey]: boolean })[vscloneContributionRegistrationKey] = true;
	registerVSCloneContribution();
}
