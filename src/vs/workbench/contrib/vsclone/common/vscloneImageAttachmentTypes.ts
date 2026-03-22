/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Image attachments are persisted as base64 payloads so chat history restore can reconstruct the
 * exact multimodal prompt the model originally received without depending on temporary blob URLs.
 */
export interface IVSCloneImageAttachment {
	readonly mimeType: string;
	readonly base64Data: string;
}

export function toVSCloneImageDataUrl(image: IVSCloneImageAttachment): string {
	return `data:${image.mimeType};base64,${image.base64Data}`;
}
