/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';


// Lets us attach a "consistent" item to a Model (aka URI) instead of to a single editor.

type AddItemInputs = { uri: URI; fn: (editor: ICodeEditor) => (() => void) };

export interface IVSCloneConsistentItemService {
	readonly _serviceBrand: undefined;
	getEditorsOnURI(uri: URI): ICodeEditor[];
	addConsistentItemToURI(inputs: AddItemInputs): string;
	removeConsistentItemFromURI(consistentItemId: string): void;
}

export const IVSCloneConsistentItemService = createDecorator<IVSCloneConsistentItemService>('VSCloneConsistentItemService');

export class VSCloneConsistentItemService extends Disposable implements IVSCloneConsistentItemService {

	readonly _serviceBrand: undefined;

	// The items attached to each URI, independent of which editors are currently open.
	private readonly consistentItemIdsOfURI: Record<string, Set<string> | undefined> = {};
	private readonly infoOfConsistentItemId: Record<string, AddItemInputs> = {};

	// Current state of items on each editor, plus the fns to call to remove them.
	private readonly itemIdsOfEditorId: Record<string, Set<string> | undefined> = {};
	private readonly consistentItemIdOfItemId: Record<string, string> = {};
	private readonly disposeFnOfItemId: Record<string, () => void> = {};

	constructor(
		@ICodeEditorService private readonly _editorService: ICodeEditorService,
	) {
		super();

		const removeItemsFromEditor = (editor: ICodeEditor) => {
			const editorId = editor.getId();
			for (const itemId of this.itemIdsOfEditorId[editorId] ?? []) {
				this._removeItemFromEditor(editor, itemId);
			}
		};

		// Put items on the editor based on the consistent items registered for that URI.
		const putItemsOnEditor = (editor: ICodeEditor, uri: URI | null) => {
			if (!uri) { return; }
			for (const consistentItemId of this.consistentItemIdsOfURI[uri.fsPath] ?? []) {
				this._putItemOnEditor(editor, consistentItemId);
			}
		};

		// When an editor switches tabs (models).
		const addTabSwitchListeners = (editor: ICodeEditor) => {
			this._register(
				editor.onDidChangeModel(e => {
					removeItemsFromEditor(editor);
					putItemsOnEditor(editor, e.newModelUrl);
				})
			);
		};

		// When an editor is disposed.
		const addDisposeListener = (editor: ICodeEditor) => {
			this._register(editor.onDidDispose(() => {
				// Anything on the editor has already been disposed.
				for (const itemId of this.itemIdsOfEditorId[editor.getId()] ?? []) {
					delete this.disposeFnOfItemId[itemId];
				}
			}));
		};

		const initializeEditor = (editor: ICodeEditor) => {
			addTabSwitchListeners(editor);
			addDisposeListener(editor);
			putItemsOnEditor(editor, editor.getModel()?.uri ?? null);
		};

		// Initialize current editors and any new editors.
		for (const editor of this._editorService.listCodeEditors()) { initializeEditor(editor); }
		this._register(this._editorService.onCodeEditorAdd(editor => { initializeEditor(editor); }));

		// When an editor is removed, take its items off it.
		this._register(this._editorService.onCodeEditorRemove(editor => { removeItemsFromEditor(editor); }));
	}

	private _putItemOnEditor(editor: ICodeEditor, consistentItemId: string) {
		const { fn } = this.infoOfConsistentItemId[consistentItemId];

		const dispose = fn(editor);

		const itemId = generateUuid();
		const editorId = editor.getId();

		if (!this.itemIdsOfEditorId[editorId]) {
			this.itemIdsOfEditorId[editorId] = new Set();
		}
		this.itemIdsOfEditorId[editorId]!.add(itemId);

		this.consistentItemIdOfItemId[itemId] = consistentItemId;

		this.disposeFnOfItemId[itemId] = () => {
			dispose?.();
		};
	}

	private _removeItemFromEditor(editor: ICodeEditor, itemId: string) {
		const editorId = editor.getId();
		this.itemIdsOfEditorId[editorId]?.delete(itemId);

		this.disposeFnOfItemId[itemId]?.();
		delete this.disposeFnOfItemId[itemId];

		delete this.consistentItemIdOfItemId[itemId];
	}

	getEditorsOnURI(uri: URI): ICodeEditor[] {
		return this._editorService.listCodeEditors().filter(editor => editor.getModel()?.uri.fsPath === uri.fsPath);
	}

	private consistentItemIdPool = 0;
	addConsistentItemToURI({ uri, fn }: AddItemInputs): string {
		const consistentItemId = (this.consistentItemIdPool++) + '';

		if (!this.consistentItemIdsOfURI[uri.fsPath]) {
			this.consistentItemIdsOfURI[uri.fsPath] = new Set();
		}
		this.consistentItemIdsOfURI[uri.fsPath]!.add(consistentItemId);

		this.infoOfConsistentItemId[consistentItemId] = { fn, uri };

		for (const editor of this.getEditorsOnURI(uri)) {
			this._putItemOnEditor(editor, consistentItemId);
		}

		return consistentItemId;
	}

	removeConsistentItemFromURI(consistentItemId: string): void {
		const info = this.infoOfConsistentItemId[consistentItemId];
		if (!info) {
			return;
		}

		const { uri } = info;
		const editors = this.getEditorsOnURI(uri);

		for (const editor of editors) {
			for (const itemId of this.itemIdsOfEditorId[editor.getId()] ?? []) {
				if (this.consistentItemIdOfItemId[itemId] === consistentItemId) {
					this._removeItemFromEditor(editor, itemId);
				}
			}
		}

		this.consistentItemIdsOfURI[uri.fsPath]?.delete(consistentItemId);
		delete this.infoOfConsistentItemId[consistentItemId];
	}
}

registerSingleton(IVSCloneConsistentItemService, VSCloneConsistentItemService, InstantiationType.Eager);


// Sibling service: same idea, but bound to a single editor rather than a URI. Used by CtrlK zones
// in Phase 3.

export interface IVSCloneConsistentEditorItemService {
	readonly _serviceBrand: undefined;
	addToEditor(editor: ICodeEditor, fn: () => () => void): string;
	removeFromEditor(itemId: string): void;
}

export const IVSCloneConsistentEditorItemService = createDecorator<IVSCloneConsistentEditorItemService>('VSCloneConsistentEditorItemService');

export class VSCloneConsistentEditorItemService extends Disposable implements IVSCloneConsistentEditorItemService {
	readonly _serviceBrand: undefined;

	// For each editorId, track the set of itemIds that have been "added" to that editor.
	// This does not necessarily mean they are mounted right now; the user may have switched models.
	private readonly itemIdsByEditorId: Record<string, Set<string>> = {};

	// For each itemId, store enough info to (re-)mount and dispose.
	private readonly itemInfoById: Record<
		string,
		{
			editorId: string;
			uriFsPath: string;
			fn: (editor: ICodeEditor) => () => void;
			disposeFn?: () => void;
		}
	> = {};

	constructor(
		@ICodeEditorService private readonly _editorService: ICodeEditorService,
	) {
		super();

		for (const editor of this._editorService.listCodeEditors()) {
			this._initializeEditor(editor);
		}

		this._register(
			this._editorService.onCodeEditorAdd((editor) => {
				this._initializeEditor(editor);
			})
		);

		this._register(
			this._editorService.onCodeEditorRemove((editor) => {
				this._removeAllItemsFromEditor(editor);
			})
		);
	}

	private _initializeEditor(editor: ICodeEditor) {
		const editorId = editor.getId();

		this._register(
			editor.onDidChangeModel((e) => {
				this._removeAllItemsFromEditor(editor);
				if (!e.newModelUrl) { return; }
				const itemsForEditor = this.itemIdsByEditorId[editorId];
				if (itemsForEditor) {
					for (const itemId of itemsForEditor) {
						const itemInfo = this.itemInfoById[itemId];
						if (itemInfo && itemInfo.uriFsPath === e.newModelUrl.fsPath) {
							this._mountItemOnEditor(editor, itemId);
						}
					}
				}
			})
		);

		this._register(
			editor.onDidDispose(() => {
				this._removeAllItemsFromEditor(editor);
			})
		);

		const uri = editor.getModel()?.uri;
		if (!uri) { return; }

		const itemsForEditor = this.itemIdsByEditorId[editorId];
		if (itemsForEditor) {
			for (const itemId of itemsForEditor) {
				const itemInfo = this.itemInfoById[itemId];
				if (itemInfo && itemInfo.uriFsPath === uri.fsPath) {
					this._mountItemOnEditor(editor, itemId);
				}
			}
		}
	}

	private _mountItemOnEditor(editor: ICodeEditor, itemId: string) {
		const info = this.itemInfoById[itemId];
		if (!info) { return; }
		const { fn } = info;
		info.disposeFn = fn(editor);
	}

	private _removeItemFromEditor(_editor: ICodeEditor, itemId: string) {
		const info = this.itemInfoById[itemId];
		if (info?.disposeFn) {
			info.disposeFn();
			info.disposeFn = undefined;
		}
	}

	private _removeAllItemsFromEditor(editor: ICodeEditor) {
		const editorId = editor.getId();
		const itemsForEditor = this.itemIdsByEditorId[editorId];
		if (!itemsForEditor) { return; }

		for (const itemId of itemsForEditor) {
			this._removeItemFromEditor(editor, itemId);
		}
	}

	addToEditor(editor: ICodeEditor, fn: () => () => void): string {
		const uri = editor.getModel()?.uri;
		if (!uri) {
			throw new Error('No URI on the provided editor.');
		}

		const editorId = editor.getId();
		const itemId = generateUuid();

		this.itemInfoById[itemId] = {
			editorId,
			uriFsPath: uri.fsPath,
			fn,
		};

		if (!this.itemIdsByEditorId[editorId]) {
			this.itemIdsByEditorId[editorId] = new Set();
		}
		this.itemIdsByEditorId[editorId].add(itemId);

		if (editor.getModel()?.uri.fsPath === uri.fsPath) {
			this._mountItemOnEditor(editor, itemId);
		}

		return itemId;
	}

	removeFromEditor(itemId: string): void {
		const info = this.itemInfoById[itemId];
		if (!info) { return; }

		const { editorId } = info;

		const editor = this._editorService.listCodeEditors().find((ed) => ed.getId() === editorId);
		if (editor) {
			this._removeItemFromEditor(editor, itemId);
		}

		this.itemIdsByEditorId[editorId]?.delete(itemId);
		delete this.itemInfoById[itemId];
	}
}

registerSingleton(IVSCloneConsistentEditorItemService, VSCloneConsistentEditorItemService, InstantiationType.Eager);
