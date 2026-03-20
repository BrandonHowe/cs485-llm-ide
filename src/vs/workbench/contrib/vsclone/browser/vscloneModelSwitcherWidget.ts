/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IVSCloneModelCatalogModelDescriptor, IVSCloneModelCatalogService, IVSCloneModelCatalogState } from '../common/vscloneModelCatalogService.js';
import { IVSCloneChatLocation, IVSCloneModelSelection, IVSCloneThreadModelSelectionService } from '../common/vscloneThreadModelSelectionService.js';
import { IVSCloneProviderConfigurationBridge } from './vscloneProviderConfigurationBridge.js';

export interface IVSCloneModelSwitcherContext {
	threadId: string;
	location: IVSCloneChatLocation;
}

let switcherIdPool = 0;

export class VSCloneModelSwitcherWidget extends Disposable {
	private root: HTMLElement | undefined;
	private button: HTMLButtonElement | undefined;
	private menu: HTMLElement | undefined;
	private isOpen = false;
	private readonly switcherId = ++switcherIdPool;
	private readonly buttonId = `vsclone-model-switcher-button-${this.switcherId}`;
	private readonly menuId = `vsclone-model-switcher-menu-${this.switcherId}`;
	private readonly menuDisposables = this._register(new DisposableStore());
	private readonly windowDisposables = this._register(new DisposableStore());

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
		container.replaceChildren();
		this.windowDisposables.clear();

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

		const root = document.createElement('div');
		root.className = 'vsclone-model-switcher-root';
		this.root = root;

		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'vsclone-model-switcher-button';
		button.id = this.buttonId;
		button.setAttribute('aria-haspopup', 'dialog');
		button.setAttribute('aria-controls', this.menuId);
		this.button = button;
		root.appendChild(button);

		const menu = document.createElement('div');
		menu.className = 'vsclone-model-switcher-menu hidden';
		menu.id = this.menuId;
		menu.setAttribute('role', 'dialog');
		menu.setAttribute('aria-modal', 'false');
		menu.setAttribute('aria-labelledby', this.buttonId);
		this.menu = menu;
		root.appendChild(menu);

		container.appendChild(root);

		this._register(addDisposableListener(button, EventType.CLICK, () => {
			if (this.isOpen) {
				this.close({ restoreButtonFocus: true });
			} else {
				this.open();
			}
		}));

		this.refresh();
	}

	open(): void {
		if (!this.root || !this.menu) {
			return;
		}

		this.isOpen = true;
		this.root.classList.add('open');
		this.menu.classList.remove('hidden');
		this.refresh();

		const state = this.catalogService.getState();
		if (state.status === 'idle') {
			void this.catalogService.refreshCatalog();
		}
	}

	close(options?: { restoreButtonFocus?: boolean }): void {
		if (!this.root || !this.menu) {
			return;
		}
		this.isOpen = false;
		this.root.classList.remove('open');
		this.menu.classList.add('hidden');
		this.refresh();
		if (options?.restoreButtonFocus) {
			this.button?.focus();
		}
	}

	refresh(): void {
		if (!this.button) {
			return;
		}

		const selection = this.getCurrentSelection();
		this.button.replaceChildren(this.createButtonModelLabel(selection));
		if (selection) {
			this.button.appendChild(this.createButtonProviderLabel(selection.vendor.toLowerCase()));
		}
		this.button.appendChild(this.createButtonChevron());
		this.button.setAttribute('aria-expanded', String(this.isOpen));
		// Announce the current model in the control name so assistive tech users can verify selection quickly.
		this.button.setAttribute('aria-label', selection
			? localize('vsclone.modelSwitcher.aria.currentModel', 'Model: {0}', selection.modelName)
			: localize('vsclone.modelSwitcher.aria.selectModel', 'Select model'));

		if (this.isOpen) {
			this.renderMenu();
		}
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

	private renderMenu(): void {
		if (!this.menu) {
			return;
		}
		this.menuDisposables.clear();

		this.menu.replaceChildren();

		const header = document.createElement('div');
		header.className = 'vsclone-model-switcher-menu-header';

		const title = document.createElement('div');
		title.className = 'vsclone-model-switcher-menu-title';
		title.textContent = localize('vsclone.modelSwitcher.menu.title', 'Select model');
		header.appendChild(title);

		const refresh = document.createElement('button');
		refresh.type = 'button';
		refresh.className = 'vsclone-model-switcher-refresh';
		const refreshLabel = localize('vsclone.modelSwitcher.refresh', 'Refresh models');
		refresh.title = refreshLabel;
		refresh.setAttribute('aria-label', refreshLabel);
		refresh.appendChild(this.createCodicon('codicon-refresh'));
		header.appendChild(refresh);

		this.menuDisposables.add(addDisposableListener(refresh, EventType.CLICK, (event: MouseEvent) => {
			event.stopPropagation();
			void this.catalogService.refreshCatalog();
		}));

		const body = document.createElement('div');
		body.className = 'vsclone-model-switcher-menu-body';

		const footer = document.createElement('div');
		footer.className = 'vsclone-model-switcher-menu-footer';

		this.menu.appendChild(header);
		this.menu.appendChild(body);
		this.menu.appendChild(footer);

		this.renderBodyState(body);
		this.renderFooter(footer);
	}

	private createButtonModelLabel(selection: IVSCloneModelSelection | undefined): HTMLElement {
		const model = document.createElement('span');
		model.className = 'vsclone-model-switcher-button-model';
		model.textContent = selection?.modelName || localize('vsclone.modelSwitcher.selectModel', 'Select model');
		return model;
	}

	private createButtonProviderLabel(provider: string): HTMLElement {
		const providerLabel = document.createElement('span');
		providerLabel.className = 'vsclone-model-switcher-button-provider';
		providerLabel.textContent = provider;
		return providerLabel;
	}

	private createButtonChevron(): HTMLElement {
		const chevron = document.createElement('span');
		chevron.className = `vsclone-model-switcher-button-chevron codicon ${this.isOpen ? 'codicon-chevron-up' : 'codicon-chevron-down'}`;
		return chevron;
	}

	private renderBodyState(body: HTMLElement): void {
		const state = this.catalogService.getState();
		if (state.status === 'loading') {
			body.appendChild(this.createLoadingState());
			return;
		}

		if (state.status === 'error') {
			body.appendChild(this.createErrorState(state));
			return;
		}

		if (state.models.length === 0) {
			body.appendChild(this.createEmptyState());
			return;
		}

		const selected = this.getCurrentSelection();
		const modelByIdentifier = new Map(state.models.map(model => [model.identifier, model]));
		const recentModels = this.selectionService
			.getRecentModelIdentifiers(3)
			.map(identifier => modelByIdentifier.get(identifier))
			.filter((model): model is IVSCloneModelCatalogModelDescriptor => !!model);

		if (recentModels.length > 0) {
			body.appendChild(this.createSectionHeader(localize('vsclone.modelSwitcher.section.recent', 'RECENT')));
			for (const model of recentModels) {
				body.appendChild(this.createModelRow(model, selected));
			}
		}

		for (const provider of state.providers) {
			const models = state.models.filter(model => model.vendor === provider.vendor);
			if (models.length === 0) {
				continue;
			}

			body.appendChild(this.createSectionHeader(provider.displayName.toUpperCase(), provider.modelCount));
			for (const model of models) {
				body.appendChild(this.createModelRow(model, selected));
			}
		}
	}

	private renderFooter(footer: HTMLElement): void {
		const manage = document.createElement('button');
		manage.type = 'button';
		manage.className = 'vsclone-model-switcher-footer-button';
		manage.appendChild(this.createCodicon('codicon-settings-gear'));
		const manageLabel = document.createElement('span');
		manageLabel.textContent = localize('vsclone.modelSwitcher.manageProviders', 'Manage Providers');
		manage.appendChild(manageLabel);
		footer.appendChild(manage);
		this.menuDisposables.add(addDisposableListener(manage, EventType.CLICK, (event: MouseEvent) => {
			event.stopPropagation();
			void this.providerBridge.openManageProvidersPicker();
		}));

		const context = this.getContext();
		if (!context.threadId || !this.selectionService.hasSelectionForThread(context.threadId)) {
			footer.classList.add('single-action');
			return;
		}

		const reset = document.createElement('button');
		reset.type = 'button';
		reset.className = 'vsclone-model-switcher-footer-button';
		reset.appendChild(this.createCodicon('codicon-history'));
		const resetLabel = document.createElement('span');
		resetLabel.textContent = localize('vsclone.modelSwitcher.resetSelection', 'Reset Selection');
		reset.appendChild(resetLabel);
		footer.appendChild(reset);
		this.menuDisposables.add(addDisposableListener(reset, EventType.CLICK, (event: MouseEvent) => {
			event.stopPropagation();
			void this.selectionService.resetSelectionForThread(context.threadId);
		}));
	}

	private createModelRow(model: IVSCloneModelCatalogModelDescriptor, selected: IVSCloneModelSelection | undefined): HTMLElement {
		const row = document.createElement('button');
		row.type = 'button';
		row.className = 'vsclone-model-switcher-row';
		if (selected?.modelIdentifier === model.identifier) {
			row.classList.add('selected');
		}
		row.setAttribute('aria-pressed', String(selected?.modelIdentifier === model.identifier));
		if (!model.isSelectable) {
			row.classList.add('locked');
		}
		row.setAttribute(
			'aria-label',
			model.isSelectable
				? localize('vsclone.modelSwitcher.row.aria', '{0} model', model.modelName)
				: localize('vsclone.modelSwitcher.row.requiresSignIn.aria', '{0} model, provider requires sign in', model.modelName),
		);

		const title = document.createElement('span');
		title.className = 'vsclone-model-switcher-row-label';
		title.textContent = model.modelName;
		row.appendChild(title);

		if (selected?.modelIdentifier === model.identifier) {
			const selectedGlyph = document.createElement('span');
			selectedGlyph.className = 'vsclone-model-switcher-row-check codicon codicon-check';
			row.appendChild(selectedGlyph);
		}

		if (!model.isSelectable) {
			const lockGlyph = document.createElement('span');
			lockGlyph.className = 'vsclone-model-switcher-row-lock codicon codicon-lock';
			row.appendChild(lockGlyph);

			const subtext = document.createElement('div');
			subtext.className = 'vsclone-model-switcher-row-subtext';
			subtext.textContent = localize('vsclone.modelSwitcher.requiresSignIn', 'Sign in to use this provider');
			row.appendChild(subtext);
		}

		this.menuDisposables.add(addDisposableListener(row, EventType.CLICK, (event: MouseEvent) => {
			event.stopPropagation();
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
		}));

		return row;
	}

	private createSectionHeader(label: string, count?: number): HTMLElement {
		const header = document.createElement('div');
		header.className = 'vsclone-model-switcher-section';

		const title = document.createElement('span');
		title.className = 'vsclone-model-switcher-section-label';
		title.textContent = label;
		header.appendChild(title);

		if (count !== undefined) {
			const suffix = document.createElement('span');
			suffix.className = 'vsclone-model-switcher-section-count';
			suffix.textContent = `${count}`;
			header.appendChild(suffix);
		}

		return header;
	}

	private createLoadingState(): HTMLElement {
		const root = document.createElement('div');
		root.className = 'vsclone-model-switcher-state';

		const spinner = document.createElement('span');
		spinner.className = 'vsclone-model-switcher-spinner codicon codicon-loading codicon-modifier-spin';
		root.appendChild(spinner);

		const text = document.createElement('div');
		text.className = 'vsclone-model-switcher-state-title';
		text.textContent = localize('vsclone.modelSwitcher.loading', 'Loading models...');
		root.appendChild(text);

		return root;
	}

	private createErrorState(state: IVSCloneModelCatalogState): HTMLElement {
		const root = document.createElement('div');
		root.className = 'vsclone-model-switcher-state error';

		const leading = document.createElement('div');
		leading.className = 'vsclone-model-switcher-state-leading';
		const icon = this.createCodicon('codicon-error');
		icon.classList.add('vsclone-model-switcher-state-icon');
		leading.appendChild(icon);

		const title = document.createElement('div');
		title.className = 'vsclone-model-switcher-state-title';
		title.textContent = localize('vsclone.modelSwitcher.errorTitle', 'Error loading models');
		leading.appendChild(title);
		root.appendChild(leading);

		const description = document.createElement('div');
		description.className = 'vsclone-model-switcher-state-description';
		description.textContent = state.errorMessage || localize('vsclone.modelSwitcher.errorDescription', 'Failed to fetch model catalog. Check your network connection.');
		root.appendChild(description);

		const retry = document.createElement('button');
		retry.type = 'button';
		retry.className = 'vsclone-model-switcher-state-action';
		retry.textContent = localize('vsclone.modelSwitcher.tryAgain', 'Try again');
		root.appendChild(retry);
		this.menuDisposables.add(addDisposableListener(retry, EventType.CLICK, (event: MouseEvent) => {
			event.stopPropagation();
			void this.catalogService.refreshCatalog();
		}));

		return root;
	}

	private createEmptyState(): HTMLElement {
		const root = document.createElement('div');
		root.className = 'vsclone-model-switcher-state';

		const icon = this.createCodicon('codicon-info');
		icon.classList.add('vsclone-model-switcher-state-icon');
		root.appendChild(icon);

		const title = document.createElement('div');
		title.className = 'vsclone-model-switcher-state-title';
		title.textContent = localize('vsclone.modelSwitcher.emptyTitle', 'No models available');
		root.appendChild(title);

		const description = document.createElement('div');
		description.className = 'vsclone-model-switcher-state-description';
		description.textContent = localize('vsclone.modelSwitcher.emptyDescription', 'Sign in to a provider to get started');
		root.appendChild(description);

		const manage = document.createElement('button');
		manage.type = 'button';
		manage.className = 'vsclone-model-switcher-state-action';
		manage.appendChild(this.createCodicon('codicon-settings-gear'));
		const manageLabel = document.createElement('span');
		manageLabel.textContent = localize('vsclone.modelSwitcher.emptyAction', 'Manage Providers');
		manage.appendChild(manageLabel);
		root.appendChild(manage);
		this.menuDisposables.add(addDisposableListener(manage, EventType.CLICK, (event: MouseEvent) => {
			event.stopPropagation();
			void this.providerBridge.openManageProvidersPicker();
		}));

		return root;
	}

	private createCodicon(codicon: string): HTMLElement {
		const icon = document.createElement('span');
		icon.className = `codicon ${codicon}`;
		// Codicon-only spans are decorative next to text labels and should not be announced separately.
		icon.setAttribute('aria-hidden', 'true');
		return icon;
	}
}
