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
import { registerVSCloneModelSwitcherActions } from './vscloneModelSwitcherActions.js';
import { registerVSCloneOAuthActions } from './vscloneOAuthActions.js';
import { VSCloneOAuthService } from './vscloneOAuthService.js';
import { VSCloneChatRuntimeService } from './vscloneChatRuntimeService.js';
import { IVSCloneChatApiService, VSCloneChatApiService } from './vscloneChatApiService.js';
import { IVSCloneChatSessionService, VSCloneChatSessionService } from './vscloneChatSessionService.js';
import { IVSCloneProviderConfigurationBridge, VSCloneProviderConfigurationBridge } from './vscloneProviderConfigurationBridge.js';
import { VSCloneUnifiedChatViewPane } from './vscloneUnifiedChatViewPane.js';
import { VSCloneViewContainerId, VSCloneViewId } from './vsclone.js';
import { IVSCloneChatHistoryMigrationService, VSCloneChatHistoryMigrationService } from '../common/vscloneChatHistoryMigrationService.js';
import { IVSCloneChatHistoryService, VSCloneChatHistoryEnabledSetting, VSCloneChatHistoryMaxThreadsSetting, VSCloneChatHistoryMaxTurnsPerThreadSetting, VSCloneChatHistoryPersistScopeSetting, VSCloneChatHistoryRailWidthSetting, VSCloneChatHistoryRedactSecretsSetting, VSCloneChatHistoryRetentionDaysSetting, VSCloneChatHistoryService } from '../common/vscloneChatHistoryService.js';
import { IVSCloneMockProviderService, VSCloneMockProviderService } from '../common/vscloneMockProviderService.js';
import { IVSCloneOAuthService } from '../common/vscloneOAuthService.js';
import { IVSCloneModelCatalogService, VSCloneModelCatalogService } from '../common/vscloneModelCatalogService.js';
import { VSCloneUseVSCodeChatBackendSetting } from '../common/vscloneChatSettings.js';
import { IVSCloneThreadModelSelectionService, VSCloneThreadModelSelectionService } from '../common/vscloneThreadModelSelectionService.js';

const vscloneContributionRegistrationKey = '__vscloneContributionRegistered__';
type VSCloneContributionGlobalScope = typeof globalThis & {
	readonly [vscloneContributionRegistrationKey]?: boolean;
};

function registerVSCloneContribution(): void {
	const vscloneViewIcon = registerIcon('vsclone-view-icon', Codicon.chatSparkle, localize('vsclone.viewIcon', 'View icon of the VSClone chat view.'));

	const vscloneViewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
		id: VSCloneViewContainerId,
		title: localize2('vsclone.viewContainer.label', 'VSClone'),
		icon: vscloneViewIcon,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VSCloneViewContainerId, { mergeViewWithContainerWhenSingleView: false }]),
		storageId: VSCloneViewContainerId,
		hideIfEmpty: false,
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

	registerSingleton(IVSCloneChatHistoryMigrationService, VSCloneChatHistoryMigrationService, InstantiationType.Delayed);
	registerSingleton(IVSCloneChatHistoryService, VSCloneChatHistoryService, InstantiationType.Delayed);
	registerSingleton(IVSCloneMockProviderService, VSCloneMockProviderService, InstantiationType.Delayed);
	registerSingleton(IVSCloneModelCatalogService, VSCloneModelCatalogService, InstantiationType.Delayed);
	registerSingleton(IVSCloneThreadModelSelectionService, VSCloneThreadModelSelectionService, InstantiationType.Delayed);
	registerSingleton(IVSCloneProviderConfigurationBridge, VSCloneProviderConfigurationBridge, InstantiationType.Delayed);
	registerSingleton(IVSCloneChatApiService, VSCloneChatApiService, InstantiationType.Delayed);
	registerSingleton(IVSCloneChatSessionService, VSCloneChatSessionService, InstantiationType.Delayed);
	registerSingleton(IVSCloneOAuthService, VSCloneOAuthService, InstantiationType.Delayed);

	registerVSCloneChatHistoryActions();
	registerVSCloneModelSwitcherActions();
	registerVSCloneOAuthActions();
	registerWorkbenchContribution2(VSCloneChatRuntimeService.ID, VSCloneChatRuntimeService, WorkbenchPhase.BlockRestore);

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
			[VSCloneUseVSCodeChatBackendSetting]: {
				type: 'boolean',
				default: false,
				description: localize('vsclone.configuration.chat.useVSCodeChatBackend', 'Route VSClone sends through VS Code chat providers. Disabled keeps VSClone decoupled from Copilot/login-dependent chat backends.'),
				scope: ConfigurationScope.WINDOW,
			},
			['vsclone.modelSwitcher.enabled']: {
				type: 'boolean',
				default: true,
				description: localize('vsclone.configuration.modelSwitcher.enabled', 'Enable the VSClone model selector in the unified chat composer.'),
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
