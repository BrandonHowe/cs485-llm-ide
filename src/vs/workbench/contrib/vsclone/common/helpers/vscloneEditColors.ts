/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Color, RGBA } from '../../../../../base/common/color.js';
import { registerColor } from '../../../../../platform/theme/common/colorUtils.js';

// editCodeService decoration backgrounds
const sweepBG = new Color(new RGBA(100, 100, 100, .2));
const highlightBG = new Color(new RGBA(100, 100, 100, .1));
const sweepIdxBG = new Color(new RGBA(100, 100, 100, .5));

const acceptBG = new Color(new RGBA(155, 185, 85, .1));
const rejectBG = new Color(new RGBA(255, 0, 0, .1));

// Inline Accept/Reject widget button colors
export const acceptAllBg = 'rgb(30, 133, 56)';
export const acceptBg = 'rgb(26, 116, 48)';
export const acceptBorder = '1px solid rgb(20, 86, 38)';

export const rejectAllBg = 'rgb(207, 40, 56)';
export const rejectBg = 'rgb(180, 35, 49)';
export const rejectBorder = '1px solid rgb(142, 28, 39)';

export const buttonFontSize = '11px';
export const buttonTextColor = 'white';

const configOfBG = (color: Color) => ({ dark: color, light: color, hcDark: color, hcLight: color });

// Registered IDs become the --vscode-vsclone-* CSS variables referenced from vscloneEditDecorations.css.
registerColor('vsclone.greenBG', configOfBG(acceptBG), '', true);
registerColor('vsclone.redBG', configOfBG(rejectBG), '', true);
registerColor('vsclone.sweepBG', configOfBG(sweepBG), '', true);
registerColor('vsclone.highlightBG', configOfBG(highlightBG), '', true);
registerColor('vsclone.sweepIdxBG', configOfBG(sweepIdxBG), '', true);
