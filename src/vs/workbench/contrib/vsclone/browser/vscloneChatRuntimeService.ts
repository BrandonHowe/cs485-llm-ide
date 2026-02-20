/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { ChatAgentLocation } from '../../chat/common/constants.js';
import { IChatModel } from '../../chat/common/model/chatModel.js';
import { IVSCloneChatHistoryService } from '../common/vscloneChatHistoryService.js';
import { VSCloneChatSessionBridge } from './vscloneChatSessionBridge.js';

export class VSCloneChatRuntimeService extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vsclone.chatRuntimeService';

	private readonly bridgeStoresBySessionResource = new Map<string, DisposableStore>();
	private historyInitialized = false;

	constructor(
		@IVSCloneChatHistoryService private readonly historyService: IVSCloneChatHistoryService,
		@IChatService private readonly chatService: IChatService,
		@ILogService logService: ILogService,
	) {
		super();

		// Keep history initialization startup-scoped so rail state is ready even before the view opens.
		void this.historyService.initialize().then(() => {
			this.historyInitialized = true;
			for (const model of this.chatService.chatModels.get()) {
				this.attachModel(model);
			}
		}).catch(error => {
			logService.error('Failed to initialize VSClone history runtime', error);
		});

		this._register(this.chatService.onDidCreateModel(model => {
			if (!this.historyInitialized) {
				return;
			}
			this.attachModel(model);
		}));
		this._register(this.chatService.onDidDisposeSession(event => {
			for (const sessionResource of event.sessionResource) {
				this.detachModel(sessionResource.toString());
			}
		}));
	}

	override dispose(): void {
		for (const store of this.bridgeStoresBySessionResource.values()) {
			store.dispose();
		}
		this.bridgeStoresBySessionResource.clear();
		super.dispose();
	}

	private attachModel(model: IChatModel): void {
		if (model.initialLocation !== ChatAgentLocation.Chat) {
			return;
		}

		const sessionResource = model.sessionResource.toString();
		if (this.bridgeStoresBySessionResource.has(sessionResource)) {
			return;
		}

		const store = new DisposableStore();
		this.bridgeStoresBySessionResource.set(sessionResource, store);

		const bridge = store.add(new VSCloneChatSessionBridge(model));
		store.add(bridge.onDidEmitTurnUpdate(update => {
			this.historyService.applyTurnUpdate(update);
		}));
		store.add(model.onDidDispose(() => this.detachModel(sessionResource)));
	}

	private detachModel(sessionResource: string): void {
		const store = this.bridgeStoresBySessionResource.get(sessionResource);
		if (!store) {
			return;
		}

		store.dispose();
		this.bridgeStoresBySessionResource.delete(sessionResource);
	}
}
