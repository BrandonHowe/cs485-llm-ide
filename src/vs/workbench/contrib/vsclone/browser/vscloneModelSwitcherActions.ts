/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { VSCloneViewId } from './vsclone.js';
import { VSCloneUnifiedChatViewPane } from './vscloneUnifiedChatViewPane.js';

export const VSCloneModelSwitcherCommandIds = {
	openPicker: 'vsclone.modelSwitcher.openPicker',
	refreshCatalog: 'vsclone.modelSwitcher.refreshCatalog',
	manageProviders: 'vsclone.modelSwitcher.manageProviders',
	openSettings: 'vsclone.openSettings',
	resetSelection: 'vsclone.modelSwitcher.resetSelection',
	switchToNextModel: 'vsclone.modelSwitcher.switchToNextModel',
} as const;

async function getVSCloneView(accessor: ServicesAccessor, focus: boolean): Promise<VSCloneUnifiedChatViewPane | undefined> {
	const viewsService = accessor.get(IViewsService);
	const existing = viewsService.getViewWithId(VSCloneViewId) as VSCloneUnifiedChatViewPane | undefined;
	if (existing) {
		if (focus) {
			existing.focus();
		}
		return existing;
	}

	const opened = await viewsService.openView<VSCloneUnifiedChatViewPane>(VSCloneViewId, focus);
	return opened ?? undefined;
}

const registrationKey = '__vscloneModelSwitcherActionsRegistered__';
type GlobalScope = typeof globalThis & {
	readonly [registrationKey]?: boolean;
};

export function registerVSCloneModelSwitcherActions(): void {
	const globalScope = globalThis as GlobalScope;
	if (globalScope[registrationKey]) {
		return;
	}
	(globalScope as { [registrationKey]: boolean })[registrationKey] = true;

	registerAction2(class VSCloneOpenModelPickerAction extends Action2 {
		constructor() {
			super({
				id: VSCloneModelSwitcherCommandIds.openPicker,
				title: localize2('vsclone.modelSwitcher.openPicker', 'Open VSClone Model Picker'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const view = await getVSCloneView(accessor, true);
			view?.openModelPicker();
		}
	});

	registerAction2(class VSCloneRefreshModelCatalogAction extends Action2 {
		constructor() {
			super({
				id: VSCloneModelSwitcherCommandIds.refreshCatalog,
				title: localize2('vsclone.modelSwitcher.refreshCatalog', 'Refresh VSClone Model Catalog'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const view = await getVSCloneView(accessor, true);
			await view?.refreshModelCatalog();
		}
	});

	registerAction2(class VSCloneManageProvidersAction extends Action2 {
		constructor() {
			super({
				id: VSCloneModelSwitcherCommandIds.manageProviders,
				title: localize2('vsclone.modelSwitcher.manageProviders', 'Manage VSClone Providers'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const view = await getVSCloneView(accessor, true);
			await view?.manageProviders();
		}
	});

	registerAction2(class VSCloneOpenSettingsAction extends Action2 {
		constructor() {
			super({
				id: VSCloneModelSwitcherCommandIds.openSettings,
				title: localize2('vsclone.openSettings', 'Open VSClone Settings'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const view = await getVSCloneView(accessor, true);
			view?.openSettingsPage();
		}
	});

	registerAction2(class VSCloneResetModelSelectionAction extends Action2 {
		constructor() {
			super({
				id: VSCloneModelSwitcherCommandIds.resetSelection,
				title: localize2('vsclone.modelSwitcher.resetSelection', 'Reset VSClone Model Selection'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const view = await getVSCloneView(accessor, true);
			await view?.resetModelSelection();
		}
	});

	registerAction2(class VSCloneSwitchToNextModelAction extends Action2 {
		constructor() {
			super({
				id: VSCloneModelSwitcherCommandIds.switchToNextModel,
				title: localize2('vsclone.modelSwitcher.switchToNextModel', 'Switch VSClone To Next Model'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const view = await getVSCloneView(accessor, true);
			await view?.switchToNextModel();
		}
	});
}
