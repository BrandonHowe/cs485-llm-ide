/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type VSCloneChatMode } from './vsclonePlanModeTypes.js';

/**
 * Tool metadata is centralized here so prompt assembly and runtime tool dispatch stay aligned.
 * Keeping one source of truth prevents prompt/tool drift when we add or evolve capabilities.
 */
export interface IVSCloneToolParameterDefinition {
	readonly name: string;
	readonly required: boolean;
	readonly description: string;
}

export interface IVSCloneToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly planModeAllowed: boolean;
	readonly parameters: readonly IVSCloneToolParameterDefinition[];
}

export interface IVSCloneToolResultPayload {
	readonly success: boolean;
	readonly output: string;
}

export const VSCLONE_TOOL_DEFINITIONS: readonly IVSCloneToolDefinition[] = [
	{
		name: 'read_file',
		description: 'Read the contents of a file.',
		planModeAllowed: true,
		parameters: [
			{ name: 'path', required: true, description: 'Absolute or workspace-relative file path.' },
		],
	},
	{
		name: 'list_directory',
		description: 'List files and folders for a directory.',
		planModeAllowed: true,
		parameters: [
			{ name: 'path', required: true, description: 'Absolute or workspace-relative directory path.' },
			{ name: 'recursive', required: false, description: 'Set to true for recursive traversal.' },
		],
	},
	{
		name: 'search_files',
		description: 'Search across files using a regular expression pattern.',
		planModeAllowed: true,
		parameters: [
			{ name: 'path', required: true, description: 'Absolute or workspace-relative directory path.' },
			{ name: 'pattern', required: true, description: 'Regular expression pattern to search for.' },
			{ name: 'file_glob', required: false, description: 'Optional glob to limit searched files.' },
		],
	},
	{
		name: 'edit_file',
		description: 'Apply SEARCH/REPLACE edits to an existing file.',
		planModeAllowed: false,
		parameters: [
			{ name: 'path', required: true, description: 'Absolute or workspace-relative file path.' },
			{ name: 'changes', required: true, description: 'SEARCH/REPLACE edit blocks.' },
		],
	},
	{
		name: 'create_file',
		description: 'Create a new file with full contents.',
		planModeAllowed: false,
		parameters: [
			{ name: 'path', required: true, description: 'Absolute or workspace-relative file path.' },
			{ name: 'content', required: true, description: 'Full contents for the new file.' },
		],
	},
	{
		name: 'attempt_completion',
		description: 'Signal that the requested task is complete.',
		planModeAllowed: true,
		parameters: [
			{ name: 'result', required: true, description: 'A concise completion summary for the user.' },
		],
	},
] as const;

/**
 * Prompt formatting filters the visible tool list by mode so the model is never shown edit tools
 * during plan-only turns. Runtime gating still enforces the contract in case the model ignores it.
 */
export function formatToolDefinitionsForPrompt(mode: VSCloneChatMode = 'act'): string {
	const visibleTools = mode === 'plan'
		? VSCLONE_TOOL_DEFINITIONS.filter(tool => tool.planModeAllowed)
		: VSCLONE_TOOL_DEFINITIONS;
	const lines: string[] = [
		'## Available Tools',
		mode === 'plan'
			? 'You can inspect the codebase via XML tool calls, but this turn is read-only.'
			: 'You can explore and modify the codebase via XML tool calls.',
		'',
		'Use this format exactly:',
		'<tool_call>',
		'<tool_name>TOOL_NAME</tool_name>',
		'<param_name>value</param_name>',
		'</tool_call>',
		'',
		'After each tool call, wait for a tool result before making the next call.',
		'',
	];

	for (const tool of visibleTools) {
		lines.push(`### ${tool.name}`);
		lines.push(tool.description);
		if (tool.parameters.length === 0) {
			lines.push('Parameters: (none)');
		} else {
			lines.push('Parameters:');
			for (const param of tool.parameters) {
				const requiredLabel = param.required ? 'required' : 'optional';
				lines.push(`- ${param.name} (${requiredLabel}) - ${param.description}`);
			}
		}
		lines.push('');
	}

	lines.push('## Tool Guidelines');
	if (mode === 'plan') {
		lines.push('- Use read_file, search_files, and list_directory to gather codebase context before answering.');
		lines.push('- Do not attempt to edit files or propose executable SEARCH/REPLACE patches in plan mode.');
		lines.push('- When you have enough context, call attempt_completion with a detailed implementation plan.');
	} else {
		lines.push('- Read a file before editing it.');
		lines.push('- Use search_files and list_directory to explore unfamiliar areas.');
	}
	lines.push('- Before each tool call, include one short planning sentence prefixed with "Thinking:".');
	lines.push('- Do not ask the user to open/share/paste file contents; use tools instead.');
	lines.push('- Call one tool at a time.');
	lines.push('- Always finish with attempt_completion when the task is done.');
	return lines.join('\n');
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

/**
 * Results are wrapped in XML so the model can feed tool outputs back into the next loop turn
 * without relying on vendor-specific tool-call payloads.
 */
export function formatToolResult(toolName: string, payload: IVSCloneToolResultPayload): string {
	const safeName = escapeXmlAttribute(toolName);
	const successFlag = payload.success ? 'true' : 'false';
	return [
		`<tool_result tool_name="${safeName}" success="${successFlag}">`,
		payload.output,
		'</tool_result>',
	].join('\n');
}
