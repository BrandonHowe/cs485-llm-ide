/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { VSCloneConsistentEditorItemService, VSCloneConsistentItemService } from '../../browser/helperServices/vscloneConsistentItemService.js';

class TestCodeEditor extends Disposable {
	private readonly _onDidChangeModel = this._register(new Emitter<{ oldModelUrl: URI | null; newModelUrl: URI | null }>());
	readonly onDidChangeModel = this._onDidChangeModel.event;
	private readonly _onDidDispose = this._register(new Emitter<void>());
	readonly onDidDispose = this._onDidDispose.event;

	constructor(private readonly id: string, private uri: URI | null) {
		super();
	}

	getId(): string {
		return this.id;
	}

	getModel(): { uri: URI } | null {
		return this.uri ? { uri: this.uri } : null;
	}

	setModel(uri: URI | null): void {
		const oldModelUrl = this.uri;
		this.uri = uri;
		this._onDidChangeModel.fire({ oldModelUrl, newModelUrl: uri });
	}

	override dispose(): void {
		this._onDidDispose.fire();
		super.dispose();
	}
}

class TestCodeEditorService extends Disposable {
	private readonly _onCodeEditorAdd = this._register(new Emitter<ICodeEditor>());
	readonly onCodeEditorAdd = this._onCodeEditorAdd.event;
	private readonly _onCodeEditorRemove = this._register(new Emitter<ICodeEditor>());
	readonly onCodeEditorRemove = this._onCodeEditorRemove.event;
	private readonly editors: ICodeEditor[] = [];

	constructor(initialEditors: readonly TestCodeEditor[]) {
		super();
		this.editors.push(...initialEditors.map(editor => editor as unknown as ICodeEditor));
	}

	listCodeEditors(): ICodeEditor[] {
		return [...this.editors];
	}

	addEditor(editor: TestCodeEditor): void {
		const codeEditor = editor as unknown as ICodeEditor;
		this.editors.push(codeEditor);
		this._onCodeEditorAdd.fire(codeEditor);
	}

	removeEditor(editor: TestCodeEditor): void {
		const codeEditor = editor as unknown as ICodeEditor;
		const index = this.editors.indexOf(codeEditor);
		if (index >= 0) {
			this.editors.splice(index, 1);
		}
		this._onCodeEditorRemove.fire(codeEditor);
	}
}

function createService(disposables: DisposableStore, editors: readonly TestCodeEditor[]): { service: VSCloneConsistentItemService; editorService: TestCodeEditorService } {
	const editorService = disposables.add(new TestCodeEditorService(editors));
	const service = disposables.add(new VSCloneConsistentItemService(editorService as unknown as ICodeEditorService));
	return { service, editorService };
}

suite('VSCloneConsistentItemService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('adds a URI item to every currently matching editor and removes only that item later', () => {
		const disposables = store.add(new DisposableStore());
		const target = URI.file('/workspace/src/app.ts');
		const other = URI.file('/workspace/src/other.ts');
		const matchingA = disposables.add(new TestCodeEditor('a', target));
		const matchingB = disposables.add(new TestCodeEditor('b', target));
		const nonMatching = disposables.add(new TestCodeEditor('c', other));
		const { service } = createService(disposables, [matchingA, matchingB, nonMatching]);
		const mounts: string[] = [];
		const disposes: string[] = [];

		const itemId = service.addConsistentItemToURI({
			uri: target,
			fn: editor => {
				const editorId = editor.getId();
				mounts.push(editorId);
				return () => disposes.push(editorId);
			},
		});

		assert.deepStrictEqual(mounts, ['a', 'b']);
		assert.deepStrictEqual(service.getEditorsOnURI(target).map(editor => editor.getId()), ['a', 'b']);

		service.removeConsistentItemFromURI(itemId);

		assert.deepStrictEqual(disposes, ['a', 'b']);
	});

	test('mounts and unmounts URI items as an editor switches models', () => {
		const disposables = store.add(new DisposableStore());
		const target = URI.file('/workspace/src/app.ts');
		const other = URI.file('/workspace/src/other.ts');
		const editor = disposables.add(new TestCodeEditor('editor', other));
		const { service } = createService(disposables, [editor]);
		const events: string[] = [];

		service.addConsistentItemToURI({
			uri: target,
			fn: currentEditor => {
				events.push(`mount:${currentEditor.getId()}`);
				return () => events.push(`dispose:${currentEditor.getId()}`);
			},
		});

		assert.deepStrictEqual(events, []);

		editor.setModel(target);
		assert.deepStrictEqual(events, ['mount:editor']);

		editor.setModel(other);
		assert.deepStrictEqual(events, ['mount:editor', 'dispose:editor']);
	});

	test('applies existing URI items to editors added after registration', () => {
		const disposables = store.add(new DisposableStore());
		const target = URI.file('/workspace/src/app.ts');
		const initialEditor = disposables.add(new TestCodeEditor('initial', target));
		const addedEditor = disposables.add(new TestCodeEditor('added', target));
		const { service, editorService } = createService(disposables, [initialEditor]);
		const mounts: string[] = [];

		service.addConsistentItemToURI({
			uri: target,
			fn: editor => {
				mounts.push(editor.getId());
				return () => undefined;
			},
		});

		editorService.addEditor(addedEditor);

		assert.deepStrictEqual(mounts, ['initial', 'added']);
	});

	test('removing an editor disposes mounted items without removing the URI registration', () => {
		const disposables = store.add(new DisposableStore());
		const target = URI.file('/workspace/src/app.ts');
		const firstEditor = disposables.add(new TestCodeEditor('first', target));
		const secondEditor = disposables.add(new TestCodeEditor('second', target));
		const { service, editorService } = createService(disposables, [firstEditor]);
		const events: string[] = [];

		service.addConsistentItemToURI({
			uri: target,
			fn: editor => {
				events.push(`mount:${editor.getId()}`);
				return () => events.push(`dispose:${editor.getId()}`);
			},
		});

		editorService.removeEditor(firstEditor);
		editorService.addEditor(secondEditor);

		assert.deepStrictEqual(events, ['mount:first', 'dispose:first', 'mount:second']);
	});
});

suite('VSCloneConsistentEditorItemService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createEditorService(disposables: DisposableStore, editors: readonly TestCodeEditor[]): TestCodeEditorService {
		return disposables.add(new TestCodeEditorService(editors));
	}

	test('keeps editor-bound items mounted only while the editor is on its original URI', () => {
		const disposables = store.add(new DisposableStore());
		const target = URI.file('/workspace/src/app.ts');
		const other = URI.file('/workspace/src/other.ts');
		const editor = disposables.add(new TestCodeEditor('editor', target));
		const editorService = createEditorService(disposables, [editor]);
		const service = disposables.add(new VSCloneConsistentEditorItemService(editorService as unknown as ICodeEditorService));
		const events: string[] = [];

		const itemId = service.addToEditor(editor as unknown as ICodeEditor, () => {
			events.push('mount');
			return () => events.push('dispose');
		});

		editor.setModel(other);
		editor.setModel(target);
		service.removeFromEditor(itemId);

		assert.deepStrictEqual(events, ['mount', 'dispose', 'mount', 'dispose']);
	});

	test('throws for editor-bound items without a model URI and ignores unknown removals', () => {
		const disposables = store.add(new DisposableStore());
		const editor = disposables.add(new TestCodeEditor('editor', null));
		const editorService = createEditorService(disposables, [editor]);
		const service = disposables.add(new VSCloneConsistentEditorItemService(editorService as unknown as ICodeEditorService));

		assert.throws(() => service.addToEditor(editor as unknown as ICodeEditor, () => () => undefined), /No URI/);
		assert.doesNotThrow(() => service.removeFromEditor('missing'));
	});

	test('disposes editor-bound items when the editor service removes or disposes an editor', () => {
		const disposables = store.add(new DisposableStore());
		const target = URI.file('/workspace/src/app.ts');
		const removedEditor = disposables.add(new TestCodeEditor('removed', target));
		const disposedEditor = disposables.add(new TestCodeEditor('disposed', target));
		const editorService = createEditorService(disposables, [removedEditor, disposedEditor]);
		const service = disposables.add(new VSCloneConsistentEditorItemService(editorService as unknown as ICodeEditorService));
		const events: string[] = [];

		service.addToEditor(removedEditor as unknown as ICodeEditor, () => {
			events.push('mount:removed');
			return () => events.push('dispose:removed');
		});
		service.addToEditor(disposedEditor as unknown as ICodeEditor, () => {
			events.push('mount:disposed');
			return () => events.push('dispose:disposed');
		});

		editorService.removeEditor(removedEditor);
		disposedEditor.dispose();

		assert.deepStrictEqual(events, ['mount:removed', 'mount:disposed', 'dispose:removed', 'dispose:disposed']);
	});
});
