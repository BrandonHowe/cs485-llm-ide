/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IVSCloneModelCatalogModelDescriptor, IVSCloneModelCatalogService } from '../common/vscloneModelCatalogService.js';
import { IVSCloneChatLocation, IVSCloneModelSelection, IVSCloneThreadModelSelectionService } from '../common/backend/vscloneThreadModelSelectionService.js';
import { IVSCloneProviderConfigurationBridge } from './vscloneProviderConfigurationBridge.js';
import { mountVSCloneModelSwitcher } from './preact/out/model-switcher/index.js';
import type { IVSCloneMountedView, IVSCloneModelSwitcherSection, IVSCloneModelSwitcherViewProps } from './vscloneViewContracts.js';

export interface IVSCloneModelSwitcherContext {
	threadId: string;
	location: IVSCloneChatLocation;
}

let switcherIdPool = 0;

export class VSCloneModelSwitcherWidget extends Disposable {
	private container: HTMLElement | undefined;
	private root: HTMLElement | undefined;
	private button: HTMLButtonElement | undefined;
	private isOpen = false;
	private readonly switcherId = ++switcherIdPool;
	private readonly buttonId = `vsclone-model-switcher-button-${this.switcherId}`;
	private readonly menuId = `vsclone-model-switcher-menu-${this.switcherId}`;
	private readonly windowDisposables = this._register(new DisposableStore());
	private mountedView: IVSCloneMountedView<IVSCloneModelSwitcherViewProps> | undefined;

	constructor(
		private readonly catalogService: IVSCloneModelCatalogService,
		private readonly selectionService: IVSCloneThreadModelSelectionService,
		private readonly providerBridge: IVSCloneProviderConfigurationBridge,
		private readonly getContext: () => IVSCloneModelSwitcherContext,
	) {
		super();

		this._register(this.catalogService.onDidChangeCatalog(() => this.refresh()));
		this._register(this.selectionService.onDidChangeSelection(() => this.refresh()));
	}

	render(container: HTMLElement): void {
		this.container = container;
		this.windowDisposables.clear();

		// Keep the document-level dismissal behavior outside the component tree so the Preact view
		// can stay a pure projection of the current selection/menu state.
		const targetWindow = getWindow(container);
		this.windowDisposables.add(addDisposableListener(targetWindow.document, EventType.MOUSE_DOWN, (event: MouseEvent) => {
			if (!this.isOpen || !this.root) {
				return;
			}
			const target = event.target as Node | null;
			if (target && this.root.contains(target)) {
				return;
			}
			this.close();
		}));
		this.windowDisposables.add(addDisposableListener(targetWindow.document, EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (this.isOpen && event.key === 'Escape') {
				event.preventDefault();
				this.close({ restoreButtonFocus: true });
			}
		}));

		// The widget's controller keeps global dismissal logic outside the component tree, while the
		// generated bundle owns the DOM subtree and is updated through a single mount handle.
		this.mountedView?.dispose();
		this.mountedView = mountVSCloneModelSwitcher(container, this.createViewProps()) as IVSCloneMountedView<IVSCloneModelSwitcherViewProps> | undefined;
	}

	override dispose(): void {
		this.mountedView?.dispose();
		this.mountedView = undefined;
		super.dispose();
	}

	open(): void {
		if (!this.container) {
			return;
		}

		this.isOpen = true;
		this.renderView();

		const state = this.catalogService.getState();
		if (state.status === 'idle') {
			void this.catalogService.refreshCatalog();
		}
	}

	close(options?: { restoreButtonFocus?: boolean }): void {
		if (!this.container) {
			return;
		}
		this.isOpen = false;
		this.renderView();
		if (options?.restoreButtonFocus) {
			this.button?.focus();
		}
	}

	refresh(): void {
		this.renderView();
	}

	async refreshCatalog(): Promise<void> {
		await this.catalogService.refreshCatalog();
	}

	async manageProviders(): Promise<void> {
		await this.providerBridge.openManageProvidersPicker();
	}

	async resetCurrentSelection(): Promise<void> {
		const context = this.getContext();
		if (!context.threadId) {
			return;
		}
		await this.selectionService.resetSelectionForThread(context.threadId);
	}

	async switchToNextModel(): Promise<void> {
		const context = this.getContext();
		await this.selectionService.switchToNextModel(context.threadId, context.location);
	}

	getCurrentSelection(): IVSCloneModelSelection | undefined {
		const context = this.getContext();
		return this.selectionService.getCurrentSelectionForThread(context.threadId, context.location);
	}

	private renderView(): void {
		if (!this.container || !this.mountedView) {
			return;
		}

		this.mountedView.rerender(this.createViewProps());
	}

	private createViewProps(): IVSCloneModelSwitcherViewProps {
		const state = this.catalogService.getState();
		const selected = this.getCurrentSelection();
		const sections = this.createSections(state.models);
		const selection = this.getCurrentSelection();
		const buttonLabel = selection?.modelName || localize('vsclone.modelSwitcher.selectModel', 'Select model');
		const buttonAriaLabel = selection
			? localize('vsclone.modelSwitcher.aria.currentModel', 'Model: {0}', selection.modelName)
			: localize('vsclone.modelSwitcher.aria.selectModel', 'Select model');
		const context = this.getContext();
		const showResetAction = !!context.threadId && this.selectionService.hasSelectionForThread(context.threadId);

		return {
			isOpen: this.isOpen,
			buttonId: this.buttonId,
			menuId: this.menuId,
			buttonLabel,
			buttonAriaLabel,
			state,
			selected,
			sections,
			showResetAction,
			rootRef: element => { this.root = element ?? undefined; },
			buttonRef: element => { this.button = element ?? undefined; },
			onToggleOpen: () => {
				if (this.isOpen) {
					this.close({ restoreButtonFocus: true });
				} else {
					this.open();
				}
			},
			onRefreshCatalog: () => { void this.catalogService.refreshCatalog(); },
			onManageProviders: () => { void this.providerBridge.openManageProvidersPicker(); },
			onResetSelection: () => {
				if (!context.threadId) {
					return;
				}
				void this.selectionService.resetSelectionForThread(context.threadId);
			},
			onSelectModel: model => this.selectModel(model, selected),
		};
	}

	private createSections(models: readonly IVSCloneModelCatalogModelDescriptor[]): readonly IVSCloneModelSwitcherSection[] {
		const state = this.catalogService.getState();
		const selected = this.getCurrentSelection();
		const sections: IVSCloneModelSwitcherSection[] = [];
		const modelByIdentifier = new Map(models.map(model => [model.identifier, model]));
		const recentModels = this.selectionService
			.getRecentModelIdentifiers(3)
			.map(identifier => modelByIdentifier.get(identifier))
			.filter((model): model is IVSCloneModelCatalogModelDescriptor => !!model);

		if (recentModels.length > 0) {
			sections.push({
				label: localize('vsclone.modelSwitcher.section.recent', 'RECENT'),
				models: recentModels,
			});
		}

		for (const provider of state.providers) {
			const providerModels = models.filter(model => model.vendor === provider.vendor);
			if (providerModels.length === 0) {
				continue;
			}

			sections.push({
				label: provider.displayName.toUpperCase(),
				count: provider.modelCount,
				models: providerModels,
			});
		}

		// Keep the selected model visible even if catalog grouping becomes temporarily inconsistent
		// during provider refreshes so the menu never appears to "lose" the user's current choice.
		if (selected && !sections.some(section => section.models.some(model => model.identifier === selected.modelIdentifier))) {
			const selectedModel = models.find(model => model.identifier === selected.modelIdentifier);
			if (selectedModel) {
				sections.unshift({
					label: localize('vsclone.modelSwitcher.section.selected', 'SELECTED'),
					models: [selectedModel],
				});
			}
		}

		return sections;
	}

	private selectModel(model: IVSCloneModelCatalogModelDescriptor, selected: IVSCloneModelSelection | undefined): void {
		if (!model.isSelectable) {
			void this.providerBridge.openManageProvidersPicker();
			return;
		}

		const context = this.getContext();
		const preservedReasoningEffort = selected?.modelIdentifier === model.identifier && selected.reasoningEffort
			? selected.reasoningEffort
			: undefined;
		const nextSelection: IVSCloneModelSelection = {
			threadId: context.threadId || undefined,
			location: context.location,
			modelIdentifier: model.identifier,
			vendor: model.vendor,
			modelId: model.modelId,
			modelName: model.modelName,
			// Preserve the user's current level when re-selecting the same reasoning model.
			reasoningEffort: preservedReasoningEffort,
			selectedAt: Date.now(),
		};
		void this.selectionService.setSelectionForThread(context.threadId, nextSelection);
		this.close({ restoreButtonFocus: true });
	}
}
