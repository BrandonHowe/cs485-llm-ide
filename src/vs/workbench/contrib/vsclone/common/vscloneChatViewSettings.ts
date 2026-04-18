/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The rail width is still a real user-facing preference, but it is a view concern rather than a
// history concern. Give it a neutral key so the remaining UI stops depending on history naming.
export const VSCloneChatRailWidthSetting = 'vsclone.chat.railWidth';
