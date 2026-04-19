/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// OAuth still participates in browser-side workbench wiring, but the service logic itself only
// depends on common platform contracts. Re-exporting from `common` keeps existing browser imports
// stable while allowing electron-main bridge tests to exercise the implementation legally.
export { VSCloneOAuthService } from '../common/vscloneOAuthServiceImpl.js';
