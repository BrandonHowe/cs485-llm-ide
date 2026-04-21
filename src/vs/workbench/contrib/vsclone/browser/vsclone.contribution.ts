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
import { registerVSCloneThreadActions } from './vscloneThreadActions.js';
import { registerVSCloneAutocompleteActions } from './vscloneAutocompleteActions.js';
import { registerVSCloneModelSwitcherActions } from './vscloneModelSwitcherActions.js';
import { registerVSCloneOAuthActions } from './vscloneOAuthActions.js';
import { VSCloneOAuthService } from './vscloneOAuthService.js';
import { VSCloneEditCodeService } from './vscloneEditCodeService.js';
import { IVSCloneEditCodeService } from './vscloneEditCodeServiceInterface.js';
import { IVSCloneChatThreadService, VSCloneChatThreadService } from './vscloneChatThreadService.js';
import { IVSCloneConvertToLLMMessageService, VSCloneConvertToLLMMessageService } from './vscloneConvertToLLMMessageService.js';
import { IVSCloneContextGatheringService, VSCloneContextGatheringService } from './vscloneContextGatheringService.js';
import { IVSCloneProviderConfigurationBridge, VSCloneProviderConfigurationBridge } from './vscloneProviderConfigurationBridge.js';
import { IVSCloneToolExecutionService, IVSCloneToolRuntimeService, VSCloneToolExecutionService, VSCloneToolRuntimeService } from './vscloneToolExecutionService.js';
import { IVSCloneTerminalToolService, VSCloneTerminalToolService } from './vscloneTerminalToolService.js';
import { VSCloneUnifiedChatViewPane } from './vscloneUnifiedChatViewPane.js';
import { VSCloneViewContainerId, VSCloneViewId } from './vsclone.js';
import { IVSCloneOAuthService } from '../common/vscloneOAuthService.js';
import { IVSClonePlanModeService, VSClonePlanModeService } from '../common/vsclonePlanModeService.js';
import { IVSCloneSettingsService, VSCloneSettingsService } from '../common/vscloneSettingsService.js';
import { IVSCloneThreadModelSelectionService, VSCloneThreadModelSelectionService } from '../common/backend/vscloneThreadModelSelectionService.js';
import { VSCloneAutocompleteService, VSCloneAutocompleteDebounceMsSetting, VSCloneAutocompleteEnabledSetting } from './vscloneAutocompleteService.js';
import { IVSCloneLLMMessageService, VSCloneLLMMessageService } from './vscloneLLMMessageService.js';
import { IVSCloneMentionSearchService, VSCloneMentionSearchService } from './vscloneMentionSearchService.js';
import { IVSCloneThreadRuntimeService, VSCloneThreadRuntimeService } from './vscloneThreadRuntimeService.js';
import { IVSCloneUnifiedChatBackendService, VSCloneUnifiedChatBackendService } from '../common/backend/vscloneUnifiedChatBackendService.js';
import { VSCloneChatRailWidthSetting } from '../common/vscloneChatViewSettings.js';

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
		// Merging collapses the pane's own "VSCLONE CHAT" header into the container title so the
		// transcript isn't stacked under two redundant labels. The outer sidebar title bar is
		// still rendered by the workbench chrome because its 35px height reservation lives in
		// core PartLayout, outside CSS reach.
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VSCloneViewContainerId, { mergeViewWithContainerWhenSingleView: true }]),
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
	registerSingleton(IVSCloneSettingsService, VSCloneSettingsService, InstantiationType.Delayed);
	registerSingleton(IVSCloneThreadModelSelectionService, VSCloneThreadModelSelectionService, InstantiationType.Delayed);
	registerSingleton(IVSClonePlanModeService, VSClonePlanModeService, InstantiationType.Delayed);
	registerSingleton(IVSCloneContextGatheringService, VSCloneContextGatheringService, InstantiationType.Delayed);
	registerSingleton(IVSCloneConvertToLLMMessageService, VSCloneConvertToLLMMessageService, InstantiationType.Delayed);
	registerSingleton(IVSCloneEditCodeService, VSCloneEditCodeService, InstantiationType.Delayed);
	registerSingleton(IVSCloneProviderConfigurationBridge, VSCloneProviderConfigurationBridge, InstantiationType.Delayed);
	// Phase 1.1 is now part of the normal service graph so compile-time wiring fails fast instead of
	// being hidden behind best-effort dynamic imports.
	registerSingleton(IVSCloneLLMMessageService, VSCloneLLMMessageService, InstantiationType.Delayed);
	// The tool execution/runtime pair intentionally split the old monolithic service into two
	// decorators, but both classes still use standard DI metadata generated by TS decorators.
	// The helper's constructor typing is stricter than the emitted metadata shape here, so we cast
	// at registration time instead of contorting the service classes purely for the helper generic.
	registerSingleton(IVSCloneToolExecutionService, VSCloneToolExecutionService as never, InstantiationType.Delayed);
	registerSingleton(IVSCloneToolRuntimeService, VSCloneToolRuntimeService as never, InstantiationType.Delayed);
	registerSingleton(IVSCloneTerminalToolService, VSCloneTerminalToolService, InstantiationType.Delayed);
	registerSingleton(IVSCloneThreadRuntimeService, VSCloneThreadRuntimeService as never, InstantiationType.Delayed);
	registerSingleton(IVSCloneChatThreadService, VSCloneChatThreadService, InstantiationType.Delayed);
	registerSingleton(IVSCloneMentionSearchService, VSCloneMentionSearchService, InstantiationType.Delayed);
	registerSingleton(IVSCloneOAuthService, VSCloneOAuthService, InstantiationType.Delayed);

	registerVSCloneThreadActions();
	registerVSCloneAutocompleteActions();
	registerVSCloneModelSwitcherActions();
	registerVSCloneOAuthActions();
	registerWorkbenchContribution2(VSCloneAutocompleteService.ID, VSCloneAutocompleteService, WorkbenchPhase.AfterRestored);

	Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
		id: 'vsclone',
		title: localize('vsclone.configuration.title', 'VSClone'),
		type: 'object',
		properties: {
			[VSCloneChatRailWidthSetting]: {
				type: 'number',
				default: 320,
				minimum: 220,
				maximum: 520,
				description: localize('vsclone.configuration.chat.railWidth', 'Default width in pixels for the VSClone chat rail.'),
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
