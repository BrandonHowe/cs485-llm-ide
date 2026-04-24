/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSCloneUnifiedChatViewPane } from '../../browser/vscloneUnifiedChatViewPane.js';
import type {
	IVSCloneThreadRuntimeMessage,
	IVSCloneThreadRuntimeRunContext,
	IVSCloneThreadRuntimeState,
	IVSCloneThreadRuntimeToolRequestMessage,
} from '../../common/vscloneThreadRuntimeTypes.js';
import { createEmptyVSCloneFeatureDefaults, createEmptyVSCloneModelSelectionOfFeature, type IVSCloneSettingsState } from '../../common/vscloneSettingsTypes.js';

interface IVSCloneUnifiedChatViewPaneHarness {
	threadRuntimeService: {
		approveLatestToolRequest(threadId: string): boolean;
		rejectLatestToolRequest(threadId: string, reason?: string): boolean;
	};
	notificationService: {
		warn(message: string): void;
	};
	renderRuntimeToolActions(
		threadId: string,
		state: IVSCloneThreadRuntimeState,
		message: Extract<IVSCloneThreadRuntimeMessage, { readonly role: 'tool' }>,
	): HTMLElement | undefined;
}

interface ISettingsHarness {
	pane: VSCloneUnifiedChatViewPane;
	host: HTMLElement;
	settingsContainer: HTMLElement;
	configurationWrites: Array<{ key: string; value: unknown }>;
	oauthCalls: string[];
}

function createRunContext(): IVSCloneThreadRuntimeRunContext {
	return {
		turnId: 'thread-1:turn-1',
		sequence: 1,
		sessionResource: 'vsclone://api/thread-1',
		mode: 'act',
		vendor: 'openai',
		modelId: 'gpt-5.3-codex',
		modelIdentifier: 'openai/gpt-5.3-codex',
	};
}

function createToolRequestMessage(id: string, requestedAt: number): IVSCloneThreadRuntimeToolRequestMessage {
	return {
		id,
		role: 'tool',
		createdAt: requestedAt,
		type: 'tool_request',
		toolName: 'run_terminal_command',
		approvalType: 'terminal',
		params: { command: 'pwd' },
		requestedAt,
		snapshots: [],
		run: createRunContext(),
	};
}

function createHarness(): IVSCloneUnifiedChatViewPaneHarness {
	// The full pane constructor wires a large DOM/service graph that is unrelated to this regression.
	// A prototype-only harness keeps the test pinned to the approval-card gating logic.
	const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as IVSCloneUnifiedChatViewPaneHarness;
	pane.threadRuntimeService = {
		approveLatestToolRequest: () => true,
		rejectLatestToolRequest: () => true,
	};
	pane.notificationService = {
		warn: () => undefined,
	};
	return pane;
}

function createSettingsState(): IVSCloneSettingsState {
	return {
		status: 'ready',
		providers: [{
			vendor: 'openai',
			displayName: 'OpenAI',
			status: 'available',
			modelCount: 2,
			selectableModelCount: 2,
			definedModelCount: 2,
		}],
		models: [{
			identifier: 'openai/gpt-5.3-codex',
			vendor: 'openai',
			modelId: 'gpt-5.3-codex',
			modelName: 'GPT-5.3 Codex',
			supportsImages: true,
			supportsFIM: false,
			supportedFeatures: ['Chat'],
			selectableFeatures: ['Chat'],
			capabilities: {
				supportsImages: true,
				supportsFIM: false,
				supportedFeatures: ['Chat'],
			},
			isSelectable: true,
		}],
		featureSelections: {},
		modelSelectionOfFeature: createEmptyVSCloneModelSelectionOfFeature(),
		featureDefaults: createEmptyVSCloneFeatureDefaults(),
		threadSelections: {},
		threadSelectionSnapshots: {},
		recentModels: [],
		recentModelIdentifiers: [],
		eligibilityRecords: [],
		ineligibilityRecords: [],
		updatedAt: 1,
	};
}

function createSettingsHarness(configurationValues: Record<string, unknown> = {}): ISettingsHarness {
	const host = document.createElement('div');
	const settingsContainer = document.createElement('div');
	settingsContainer.className = 'vsclone-settings-page hidden';
	const conversationList = document.createElement('div');
	const emptyState = document.createElement('div');
	const composer = document.createElement('div');
	composer.className = 'vsclone-thread-composer';
	const input = document.createElement('textarea');
	composer.appendChild(input);
	host.append(settingsContainer, conversationList, emptyState, composer);
	document.body.appendChild(host);

	const configurationWrites: Array<{ key: string; value: unknown }> = [];
	const oauthCalls: string[] = [];
	// The settings page methods do not require a live ViewPane instance; these collaborators are
	// the narrow service surface they read while rendering and while writing local controls.
	const pane = Object.create(VSCloneUnifiedChatViewPane.prototype) as VSCloneUnifiedChatViewPane;
	Object.assign(pane as object, {
		settingsContainer,
		conversationList,
		conversationEmptyState: emptyState,
		composerInput: input,
		conversationHasContent: false,
		settingsVisible: false,
		railVisible: false,
		settingsService: {
			getState: () => createSettingsState(),
			refreshState: async () => undefined,
		},
		oauthService: {
			state: {
				providers: {
					openai: {
						vendor: 'openai',
						displayName: 'OpenAI',
						status: 'signed_out',
						userDisplayName: undefined,
						errorMessage: undefined,
						isReady: false,
					},
					anthropic: {
						vendor: 'anthropic',
						displayName: 'Anthropic',
						status: 'signed_in',
						userDisplayName: 'Claude User',
						errorMessage: undefined,
						isReady: true,
					},
					google: {
						vendor: 'google',
						displayName: 'Google',
						status: 'signed_out',
						userDisplayName: undefined,
						errorMessage: undefined,
						isReady: false,
					},
				},
			},
			signIn: async (vendor: string) => {
				oauthCalls.push(`signIn:${vendor}`);
			},
			signOut: async (vendor: string) => {
				oauthCalls.push(`signOut:${vendor}`);
			},
		},
		threadRuntimeService: {
			isAutoApproveEdits: () => false,
		},
		configurationService: {
			getValue: (key: string) => configurationValues[key],
			updateValue: async (key: string, value: unknown) => {
				configurationWrites.push({ key, value });
			},
		},
		applyRailLayout: () => undefined,
		focusInput: () => {
			input.focus();
		},
		refreshModelCatalog: async () => undefined,
		refreshModelControls: () => undefined,
	});

	return {
		pane,
		host,
		settingsContainer,
		configurationWrites,
		oauthCalls,
	};
}

suite('VSCloneUnifiedChatViewPane', () => {
	test('renders approval controls only for the latest awaiting tool request', () => {
		const harness = createHarness();
		const firstRequest = createToolRequestMessage('tool-request-1', 1);
		const repeatedRequest = createToolRequestMessage('tool-request-2', 2);
		const state: IVSCloneThreadRuntimeState = {
			threadId: 'thread-1',
			catalog: {
				threadId: 'thread-1',
				title: 'Existing thread',
				createdAt: 1,
				updatedAt: 2,
				status: 'active',
				archived: false,
				turnCount: 1,
				lastTurnPreview: 'Need approval',
			},
			streamState: { kind: 'awaiting_user', toolName: 'run_terminal_command', approvalType: 'terminal' },
			messages: [firstRequest, repeatedRequest],
			checkpoints: [],
			lastUpdatedAt: 2,
		};

		assert.strictEqual(harness.renderRuntimeToolActions('thread-1', state, firstRequest), undefined);
		assert.ok(harness.renderRuntimeToolActions('thread-1', state, repeatedRequest));
	});

	test('opens settings into the conversation surface and closes back to the composer', () => {
		const harness = createSettingsHarness();
		try {
			harness.pane.openSettingsPage();

			assert.strictEqual(harness.settingsContainer.classList.contains('hidden'), false);
			assert.ok(harness.settingsContainer.querySelector('.vsclone-settings-header'));
			const closeButton = harness.settingsContainer.querySelector('.vsclone-settings-icon-button') as HTMLButtonElement | null;
			assert.ok(closeButton);
			assert.strictEqual(document.activeElement, closeButton);

			closeButton.click();

			assert.strictEqual(harness.settingsContainer.classList.contains('hidden'), true);
			assert.strictEqual(document.activeElement, harness.host.querySelector('textarea'));
		} finally {
			harness.host.remove();
		}
	});

	test('writes settings controls through the configuration service', () => {
		const harness = createSettingsHarness({
			'vsclone.modelSwitcher.enabled': true,
			'vsclone.autocomplete.enabled': true,
			'vsclone.autocomplete.debounceMs': 120,
		});
		try {
			harness.pane.openSettingsPage();

			const autocompleteToggle = Array.from(harness.settingsContainer.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
				.find(input => input.getAttribute('aria-label') === 'Inline autocomplete');
			assert.ok(autocompleteToggle);
			autocompleteToggle.checked = false;
			autocompleteToggle.dispatchEvent(new Event('change'));

			const debounceSlider = Array.from(harness.settingsContainer.querySelectorAll<HTMLInputElement>('input[type="range"]'))
				.find(input => input.getAttribute('aria-label') === 'Autocomplete delay');
			assert.ok(debounceSlider);
			debounceSlider.value = '240';
			debounceSlider.dispatchEvent(new Event('change'));

			assert.deepStrictEqual(harness.configurationWrites, [
				{ key: 'vsclone.autocomplete.enabled', value: false },
				{ key: 'vsclone.autocomplete.debounceMs', value: 240 },
			]);
		} finally {
			harness.host.remove();
		}
	});

	test('renders provider sign-in and sign-out actions', async () => {
		const harness = createSettingsHarness();
		try {
			harness.pane.openSettingsPage();

			assert.strictEqual(harness.settingsContainer.textContent?.includes('Choose model'), false);
			const providerButtons = Array.from(harness.settingsContainer.querySelectorAll<HTMLButtonElement>('.vsclone-settings-action-button'));
			const openAiButton = providerButtons.find(button => button.textContent === 'Sign in' && button.closest('.vsclone-settings-row')?.textContent?.includes('OpenAI'));
			const anthropicButton = providerButtons.find(button => button.textContent === 'Sign out' && button.closest('.vsclone-settings-row')?.textContent?.includes('Anthropic'));
			assert.ok(openAiButton);
			assert.ok(anthropicButton);

			openAiButton.click();
			anthropicButton.click();
			await Promise.resolve();
			await Promise.resolve();

			assert.deepStrictEqual(harness.oauthCalls, ['signIn:openai', 'signOut:anthropic']);
		} finally {
			harness.host.remove();
		}
	});
});
