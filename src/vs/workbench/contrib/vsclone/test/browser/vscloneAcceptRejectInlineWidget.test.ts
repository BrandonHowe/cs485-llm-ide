/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
// The inline-widget tests exercise a hand-rolled editor double; the double implements only the
// overlay and layout hooks this widget observes at runtime.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ICodeEditor, IOverlayWidget } from '../../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { VSCloneAcceptRejectInlineWidget } from '../../browser/vscloneAcceptRejectInlineWidget.js';

suite('VSCloneAcceptRejectInlineWidget', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	type TestEditor = ICodeEditor & {
		readonly addedWidgets: IOverlayWidget[];
		readonly removedWidgets: IOverlayWidget[];
		fireScrollChange(): void;
		fireContentChange(): void;
		fireLayoutChange(): void;
		setScrollTop(scrollTop: number): void;
		setLayoutInfo(layoutInfo: { width: number; minimap: { minimapWidth: number }; verticalScrollbarWidth: number }): void;
	};

	function timeout(): Promise<void> {
		// The production widget defers its first positioning pass so button width is measurable.
		return new Promise(resolve => setTimeout(resolve, 0));
	}

	function createEditor(uri: URI | null = URI.file('/workspace/src/file.ts')): TestEditor {
		const scrollChange = store.add(new Emitter<void>());
		const contentChange = store.add(new Emitter<void>());
		const layoutChange = store.add(new Emitter<void>());
		const addedWidgets: IOverlayWidget[] = [];
		const removedWidgets: IOverlayWidget[] = [];
		let scrollTop = 7;
		let layoutInfo = {
			width: 500,
			minimap: { minimapWidth: 20 },
			verticalScrollbarWidth: 15,
		};

		const editor = {
			addedWidgets,
			removedWidgets,
			fireScrollChange: () => scrollChange.fire(),
			fireContentChange: () => contentChange.fire(),
			fireLayoutChange: () => layoutChange.fire(),
			setScrollTop: value => { scrollTop = value; },
			setLayoutInfo: value => { layoutInfo = value; },
			getModel: () => uri ? ({ uri }) as ReturnType<ICodeEditor['getModel']> : null,
			getOption: option => {
				assert.strictEqual(option, EditorOption.lineHeight);
				return 18;
			},
			getTopForLineNumber: lineNumber => lineNumber * 18,
			getScrollTop: () => scrollTop,
			getLayoutInfo: () => layoutInfo as ReturnType<ICodeEditor['getLayoutInfo']>,
			onDidScrollChange: scrollChange.event,
			onDidChangeModelContent: contentChange.event,
			onDidLayoutChange: layoutChange.event,
			addOverlayWidget: widget => { addedWidgets.push(widget); },
			removeOverlayWidget: widget => { removedWidgets.push(widget); },
		};

		return editor as TestEditor;
	}

	test('creates stable buttons, forwards clicks, and registers as an overlay widget', () => {
		const editor = createEditor();
		let acceptCalls = 0;
		let rejectCalls = 0;

		const widget = store.add(new VSCloneAcceptRejectInlineWidget({
			editor,
			diffid: ':diff-1',
			startLine: 3,
			offsetLines: 2,
			onAccept: () => { acceptCalls++; },
			onReject: () => { rejectCalls++; },
		}));

		const domNode = widget.getDomNode();
		const buttons = Array.from(domNode.querySelectorAll('button'));

		assert.strictEqual(widget.getId(), '/workspace/src/file.ts:diff-1');
		assert.strictEqual(widget.getPosition(), null);
		assert.strictEqual(editor.addedWidgets[0], widget);
		assert.strictEqual(domNode.style.transform, 'translateY(36px)');
		assert.strictEqual(domNode.style.pointerEvents, 'none');
		assert.strictEqual(buttons.length, 2);
		assert.strictEqual(buttons[0].textContent, 'Accept');
		assert.strictEqual(buttons[1].textContent, 'Reject');
		assert.strictEqual(buttons[0].style.pointerEvents, 'auto');
		assert.strictEqual(buttons[1].style.pointerEvents, 'auto');

		buttons[0].click();
		buttons[1].click();

		assert.strictEqual(acceptCalls, 1);
		assert.strictEqual(rejectCalls, 1);
	});

	test('updates top and left from editor scroll, content, and layout signals', async () => {
		const editor = createEditor();
		const widget = store.add(new VSCloneAcceptRejectInlineWidget({
			editor,
			diffid: ':diff-2',
			startLine: 4,
			offsetLines: 1,
			onAccept: () => undefined,
			onReject: () => undefined,
		}));
		const domNode = widget.getDomNode();

		// Force deterministic layout math; detached buttons otherwise report a browser-dependent width.
		Object.defineProperty(domNode, 'offsetWidth', { value: 80 });
		await timeout();

		assert.strictEqual(domNode.style.top, '65px');
		assert.strictEqual(domNode.style.left, '385px');

		editor.setScrollTop(11);
		editor.fireScrollChange();
		assert.strictEqual(domNode.style.top, '61px');

		editor.setScrollTop(13);
		editor.fireContentChange();
		assert.strictEqual(domNode.style.top, '59px');

		editor.setLayoutInfo({
			width: 420,
			minimap: { minimapWidth: 10 },
			verticalScrollbarWidth: 5,
		});
		editor.fireLayoutChange();
		assert.strictEqual(domNode.style.top, '59px');
		assert.strictEqual(domNode.style.left, '325px');
	});

	test('uses a dummy node and skips overlay registration when the editor has no model URI', () => {
		const editor = createEditor(null);
		const widget = store.add(new VSCloneAcceptRejectInlineWidget({
			editor,
			diffid: ':diff-without-uri',
			startLine: 1,
			offsetLines: 0,
			onAccept: () => undefined,
			onReject: () => undefined,
		}));

		assert.strictEqual(widget.getId(), '');
		assert.strictEqual(widget.getDomNode().tagName, 'DIV');
		assert.deepStrictEqual(editor.addedWidgets, []);
	});

	test('removes the overlay widget on dispose', () => {
		const editor = createEditor();
		const widget = new VSCloneAcceptRejectInlineWidget({
			editor,
			diffid: ':diff-3',
			startLine: 1,
			offsetLines: 0,
			onAccept: () => undefined,
			onReject: () => undefined,
		});

		assert.strictEqual(editor.addedWidgets[0], widget);

		widget.dispose();

		assert.strictEqual(editor.removedWidgets[0], widget);
	});
});
