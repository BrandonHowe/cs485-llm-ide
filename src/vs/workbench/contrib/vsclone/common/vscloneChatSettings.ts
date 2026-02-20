/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Opt-in escape hatch for wiring VSClone prompt sends to VS Code's built-in chat transport.
 * Default stays false so VSClone remains provider/runtime decoupled.
 */
export const VSCloneUseVSCodeChatBackendSetting = 'vsclone.chat.useVSCodeChatBackend';
