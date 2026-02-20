/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../../nls.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { VSCloneViewId } from './vsclone.js';
import { VSCloneUnifiedChatViewPane } from './vscloneUnifiedChatViewPane.js';
import { IVSCloneChatHistoryService } from '../common/vscloneChatHistoryService.js';

export const VSCloneChatHistoryCommandIds = {
	open: 'vsclone.chat.open',
	focusRail: 'vsclone.chatHistory.focusRail',
	toggleRail: 'vsclone.chatHistory.toggleRail',
	copyPrompt: 'vsclone.chatHistory.copyPrompt',
	copyResponse: 'vsclone.chatHistory.copyResponse',
	reusePrompt: 'vsclone.chatHistory.reusePrompt',
	openSession: 'vsclone.chatHistory.openSession',
	deleteThread: 'vsclone.chatHistory.deleteThread',
	clearAllWorkspace: 'vsclone.chatHistory.clearAllWorkspace',
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

const vscloneChatHistoryActionsRegistrationKey = '__vscloneChatHistoryActionsRegistered__';
type VSCloneActionsGlobalScope = typeof globalThis & {
	readonly [vscloneChatHistoryActionsRegistrationKey]?: boolean;
};

export function registerVSCloneChatHistoryActions(): void {
	const globalScope = globalThis as VSCloneActionsGlobalScope;
	if (globalScope[vscloneChatHistoryActionsRegistrationKey]) {
		return;
	}
	(globalScope as { [vscloneChatHistoryActionsRegistrationKey]: boolean })[vscloneChatHistoryActionsRegistrationKey] = true;

	registerAction2(class VSCloneOpenChatAction extends Action2 {
		constructor() {
			super({
				id: VSCloneChatHistoryCommandIds.open,
				title: localize2('vsclone.chat.open', 'Open VSClone Chat'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const view = await getVSCloneView(accessor, true);
			view?.focusInput();
		}
	});

	registerAction2(class VSCloneFocusRailAction extends Action2 {
		constructor() {
			super({
				id: VSCloneChatHistoryCommandIds.focusRail,
				title: localize2('vsclone.chat.focusRail', 'Focus VSClone History Rail'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const view = await getVSCloneView(accessor, true);
			view?.focusRail();
		}
	});

	registerAction2(class VSCloneToggleRailAction extends Action2 {
		constructor() {
			super({
				id: VSCloneChatHistoryCommandIds.toggleRail,
				title: localize2('vsclone.chat.toggleRail', 'Toggle VSClone History Rail'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const view = await getVSCloneView(accessor, true);
			view?.toggleRail();
		}
	});

	registerAction2(class VSCloneCopyPromptAction extends Action2 {
		constructor() {
			super({
				id: VSCloneChatHistoryCommandIds.copyPrompt,
				title: localize2('vsclone.chat.copyPrompt', 'Copy Prompt From VSClone Thread'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const view = await getVSCloneView(accessor, true);
			await view?.copyPrompt();
		}
	});

	registerAction2(class VSCloneCopyResponseAction extends Action2 {
		constructor() {
			super({
				id: VSCloneChatHistoryCommandIds.copyResponse,
				title: localize2('vsclone.chat.copyResponse', 'Copy Response From VSClone Thread'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const view = await getVSCloneView(accessor, true);
			await view?.copyResponse();
		}
	});

	registerAction2(class VSCloneReusePromptAction extends Action2 {
		constructor() {
			super({
				id: VSCloneChatHistoryCommandIds.reusePrompt,
				title: localize2('vsclone.chat.reusePrompt', 'Reuse Prompt From VSClone Thread'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const view = await getVSCloneView(accessor, true);
			view?.reusePrompt();
		}
	});

	registerAction2(class VSCloneOpenSessionAction extends Action2 {
		constructor() {
			super({
				id: VSCloneChatHistoryCommandIds.openSession,
				title: localize2('vsclone.chat.openSession', 'Open Selected VSClone Thread'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const view = await getVSCloneView(accessor, true);
			await view?.openSession();
		}
	});

	registerAction2(class VSCloneDeleteThreadAction extends Action2 {
		constructor() {
			super({
				id: VSCloneChatHistoryCommandIds.deleteThread,
				title: localize2('vsclone.chat.deleteThread', 'Delete Selected VSClone Thread'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const view = await getVSCloneView(accessor, true);
			await view?.deleteActiveThread();
		}
	});

	registerAction2(class VSCloneClearWorkspaceHistoryAction extends Action2 {
		constructor() {
			super({
				id: VSCloneChatHistoryCommandIds.clearAllWorkspace,
				title: localize2('vsclone.chat.clearWorkspace', 'Clear VSClone Workspace Chat History'),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const historyService = accessor.get(IVSCloneChatHistoryService);
			await historyService.clearAll('workspace');
		}
	});
}
