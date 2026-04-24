/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { IVSCloneChatLocation, IVSCloneModelSelection } from '../common/vscloneModelSelectionTypes.js';
import { IVSCloneProviderConfigurationBridge } from './vscloneProviderConfigurationBridge.js';
import { IVSCloneSettingsModelState } from '../common/vscloneSettingsTypes.js';
import { IVSCloneSettingsService } from '../common/vscloneSettingsService.js';
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
		private readonly settingsService: IVSCloneSettingsService,
		private readonly providerBridge: IVSCloneProviderConfigurationBridge,
		private readonly getContext: () => IVSCloneModelSwitcherContext,
	) {
		super();

		this._register(this.settingsService.onDidChangeState(() => this.refresh()));
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

		const state = this.settingsService.getState();
		if (state.status === 'idle') {
			void this.settingsService.refreshState();
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
		await this.settingsService.refreshState();
	}

	async manageProviders(): Promise<void> {
		await this.providerBridge.openManageProvidersPicker();
	}

	async switchToNextModel(): Promise<void> {
		const context = this.getContext();
		await this.settingsService.switchToNextModel(context.threadId, context.location);
	}

	getCurrentSelection(): IVSCloneModelSelection | undefined {
		const context = this.getContext();
		return this.settingsService.getCurrentSelectionForFeature(context.threadId, context.location);
	}

	private renderView(): void {
		if (!this.container || !this.mountedView) {
			return;
		}

		this.mountedView.rerender(this.createViewProps());
	}

	private createViewProps(): IVSCloneModelSwitcherViewProps {
		const state = this.settingsService.getState();
		const selected = this.getCurrentSelection();
		const sections = this.createSections(state.models);
		const selection = this.getCurrentSelection();
		const buttonLabel = selection?.modelName || localize('vsclone.modelSwitcher.selectModel', 'Select model');
		const buttonAriaLabel = selection
			? localize('vsclone.modelSwitcher.aria.currentModel', 'Model: {0}', selection.modelName)
			: localize('vsclone.modelSwitcher.aria.selectModel', 'Select model');

		return {
			isOpen: this.isOpen,
			buttonId: this.buttonId,
			menuId: this.menuId,
			buttonLabel,
			buttonAriaLabel,
			state,
			selected,
			sections,
			rootRef: element => { this.root = element ?? undefined; },
			buttonRef: element => { this.button = element ?? undefined; },
			onToggleOpen: () => {
				if (this.isOpen) {
					this.close({ restoreButtonFocus: true });
				} else {
					this.open();
				}
			},
			onRefreshCatalog: () => { void this.settingsService.refreshState(); },
			onManageProviders: () => { void this.providerBridge.openManageProvidersPicker(); },
			onSelectModel: model => this.selectModel(model, selected),
		};
	}

	private createSections(models: readonly IVSCloneSettingsModelState[]): readonly IVSCloneModelSwitcherSection[] {
		const state = this.settingsService.getState();
		const selected = this.getCurrentSelection();
		const sections: IVSCloneModelSwitcherSection[] = [];
		const modelByIdentifier = new Map(models.map(model => [model.identifier, model]));
		const recentModels = this.settingsService
			.getRecentModelIdentifiers(3)
			.map(identifier => modelByIdentifier.get(identifier))
			.filter((model): model is IVSCloneSettingsModelState => !!model);

		if (recentModels.length > 0) {
			sections.push({
				label: localize('vsclone.modelSwitcher.section.recent', 'RECENT'),
				models: recentModels,
			});
		}

		for (const provider of state.providers) {
			if (provider.status !== 'available') {
				continue;
			}
			const providerModels = models.filter(model => model.vendor === provider.vendor);
			if (providerModels.length === 0) {
				continue;
			}

			// Google lists Gemini in ascending generation order from the catalog, which buries the
			// newest Gemini models at the bottom. Reverse so the most recent preview surfaces first.
			const orderedModels = provider.vendor === 'google'
				? [...providerModels].reverse()
				: providerModels;

			sections.push({
				label: provider.displayName.toUpperCase(),
				count: provider.modelCount,
				models: orderedModels,
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

	private selectModel(model: IVSCloneSettingsModelState, selected: IVSCloneModelSelection | undefined): void {
		if (!model.isSelectable) {
			void this.providerBridge.openManageProvidersPicker();
			return;
		}

		const context = this.getContext();
		// Preserve every reasoning field (effort, enabled, budget) when the user reselects the same
		// model. Carrying only `reasoningEffort` silently reset `reasoningEnabled`/`reasoningBudget`
		// to undefined, which flipped an explicitly-off slider back on and erased budget tweaks.
		// Additionally drop any field whose capability is absent on the current model so a persisted
		// stale value cannot outlive a capability change. Mirrors Void's capability-shaped filtering.
		const isSameModel = selected?.modelIdentifier === model.identifier;
		const capabilities = model.capabilities.reasoningCapabilities;
		const reasoningSlider = capabilities ? capabilities.reasoningSlider : undefined;
		const canTurnOffReasoning = capabilities ? capabilities.canTurnOffReasoning === true : false;
		const preservedReasoningEffort = isSameModel && reasoningSlider?.type === 'effort_slider'
			? selected?.reasoningEffort
			: undefined;
		const preservedReasoningEnabled = isSameModel && canTurnOffReasoning
			? selected?.reasoningEnabled
			: undefined;
		const preservedReasoningBudget = isSameModel && reasoningSlider?.type === 'budget_slider'
			? selected?.reasoningBudget
			: undefined;
		const nextSelection: IVSCloneModelSelection = {
			threadId: context.threadId || undefined,
			location: context.location,
			modelIdentifier: model.identifier,
			vendor: model.vendor,
			modelId: model.modelId,
			modelName: model.modelName,
			// Preserve the user's current reasoning configuration when re-selecting the same model.
			reasoningEffort: preservedReasoningEffort,
			reasoningEnabled: preservedReasoningEnabled,
			reasoningBudget: preservedReasoningBudget,
			selectedAt: Date.now(),
		};
		void this.settingsService.setSelectionForFeature(context.threadId, nextSelection);
		this.close({ restoreButtonFocus: true });
	}
}
