/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Widget } from '../../../../base/browser/ui/widget.js';
import { ICodeEditor, IOverlayWidget } from '../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { acceptBg, acceptBorder, buttonFontSize, buttonTextColor, rejectBg, rejectBorder } from '../common/helpers/vscloneEditColors.js';

/**
 * Inline overlay widget that shows per-diff Accept / Reject buttons at the top-right of a diff's
 * start line. Native `IOverlayWidget`; matches Void's `AcceptRejectInlineWidget`.
 */
export class VSCloneAcceptRejectInlineWidget extends Widget implements IOverlayWidget {

	public getId(): string {
		return this.ID || '';
	}

	public getDomNode(): HTMLElement {
		return this._domNode;
	}

	public getPosition() {
		return null;
	}

	private readonly _domNode: HTMLElement;
	private readonly editor: ICodeEditor;
	private readonly ID: string;
	private readonly startLine: number;

	constructor(
		{ editor, onAccept, onReject, diffid, startLine, offsetLines }: {
			editor: ICodeEditor;
			onAccept: () => void;
			onReject: () => void;
			diffid: string;
			startLine: number;
			offsetLines: number;
		},
	) {
		super();

		const uri = editor.getModel()?.uri;
		this.ID = '';
		this.editor = editor;
		this.startLine = startLine;

		if (!uri) {
			const { dummyDiv } = dom.h('div@dummyDiv');
			this._domNode = dummyDiv;
			return;
		}

		this.ID = uri.fsPath + diffid;

		const lineHeight = editor.getOption(EditorOption.lineHeight);

		const acceptText = 'Accept';
		const rejectText = 'Reject';

		const { acceptButton, rejectButton, buttons } = dom.h('div@buttons', [
			dom.h('button@acceptButton', []),
			dom.h('button@rejectButton', [])
		]);

		buttons.style.display = 'flex';
		buttons.style.position = 'absolute';
		buttons.style.gap = '4px';
		buttons.style.paddingRight = '4px';
		buttons.style.zIndex = '1';
		buttons.style.transform = `translateY(${offsetLines * lineHeight}px)`;
		buttons.style.justifyContent = 'flex-end';
		buttons.style.width = '100%';
		buttons.style.pointerEvents = 'none';

		acceptButton.onclick = onAccept;
		acceptButton.textContent = acceptText;
		acceptButton.style.backgroundColor = acceptBg;
		acceptButton.style.border = acceptBorder;
		acceptButton.style.color = buttonTextColor;
		acceptButton.style.fontSize = buttonFontSize;
		acceptButton.style.borderTop = 'none';
		acceptButton.style.padding = '1px 4px';
		acceptButton.style.borderBottomLeftRadius = '6px';
		acceptButton.style.borderBottomRightRadius = '6px';
		acceptButton.style.borderTopLeftRadius = '0';
		acceptButton.style.borderTopRightRadius = '0';
		acceptButton.style.cursor = 'pointer';
		acceptButton.style.height = '100%';
		acceptButton.style.boxShadow = '0 2px 3px rgba(0,0,0,0.2)';
		acceptButton.style.pointerEvents = 'auto';

		rejectButton.onclick = onReject;
		rejectButton.textContent = rejectText;
		rejectButton.style.backgroundColor = rejectBg;
		rejectButton.style.border = rejectBorder;
		rejectButton.style.color = buttonTextColor;
		rejectButton.style.fontSize = buttonFontSize;
		rejectButton.style.borderTop = 'none';
		rejectButton.style.padding = '1px 4px';
		rejectButton.style.borderBottomLeftRadius = '6px';
		rejectButton.style.borderBottomRightRadius = '6px';
		rejectButton.style.borderTopLeftRadius = '0';
		rejectButton.style.borderTopRightRadius = '0';
		rejectButton.style.cursor = 'pointer';
		rejectButton.style.height = '100%';
		rejectButton.style.boxShadow = '0 2px 3px rgba(0,0,0,0.2)';
		rejectButton.style.pointerEvents = 'auto';

		this._domNode = buttons;

		const updateTop = () => {
			const topPx = editor.getTopForLineNumber(this.startLine) - editor.getScrollTop();
			this._domNode.style.top = `${topPx}px`;
		};
		const updateLeft = () => {
			const layoutInfo = editor.getLayoutInfo();
			const minimapWidth = layoutInfo.minimap.minimapWidth;
			const verticalScrollbarWidth = layoutInfo.verticalScrollbarWidth;
			const buttonWidth = this._domNode.offsetWidth;

			const leftPx = layoutInfo.width - minimapWidth - verticalScrollbarWidth - buttonWidth;
			this._domNode.style.left = `${leftPx}px`;
		};

		setTimeout(() => {
			updateTop();
			updateLeft();
		}, 0);

		this._register(editor.onDidScrollChange(() => { updateTop(); }));
		this._register(editor.onDidChangeModelContent(() => { updateTop(); }));
		this._register(editor.onDidLayoutChange(() => { updateTop(); updateLeft(); }));

		editor.addOverlayWidget(this);
	}

	public override dispose(): void {
		this.editor.removeOverlayWidget(this);
		super.dispose();
	}
}
