/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type VSCloneChatMode } from './vsclonePlanModeTypes.js';
import {
	type IVSCloneToolDefinition as IVSCloneToolDefinitionBase,
	type IVSCloneToolParameterDefinition as IVSCloneToolParameterDefinitionBase,
	type IVSCloneToolResultPayload as IVSCloneToolResultPayloadBase,
} from './vscloneToolRuntimeTypes.js';

/**
 * Tool metadata stays centralized so prompt assembly and runtime dispatch keep the same contract.
 * That matters even more now that VSClone has both file tools and terminal tools with approval
 * classes that future thread-runtime code will need to reason about.
 */
export interface IVSCloneToolParameterDefinition extends IVSCloneToolParameterDefinitionBase {}

export interface IVSCloneToolDefinition extends IVSCloneToolDefinitionBase {}

export interface IVSCloneToolResultPayload extends IVSCloneToolResultPayloadBase {}

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
		approvalType: 'edits',
		planModeAllowed: false,
		parameters: [
			{ name: 'path', required: true, description: 'Absolute or workspace-relative file path.' },
			{ name: 'changes', required: true, description: 'SEARCH/REPLACE edit blocks.' },
		],
	},
	{
		name: 'create_file',
		description: 'Create a new file with full contents.',
		approvalType: 'edits',
		planModeAllowed: false,
		parameters: [
			{ name: 'path', required: true, description: 'Absolute or workspace-relative file path.' },
			{ name: 'content', required: true, description: 'Full contents for the new file.' },
		],
	},
	{
		name: 'run_command',
		description: 'Run a one-off shell command in a temporary terminal and return the captured output.',
		approvalType: 'terminal',
		planModeAllowed: false,
		parameters: [
			{ name: 'command', required: true, description: 'Shell command to execute.' },
			{ name: 'cwd', required: false, description: 'Optional workspace-relative or absolute working directory.' },
		],
	},
	{
		name: 'open_persistent_terminal',
		description: 'Create a persistent terminal that can be reused by later terminal commands.',
		approvalType: 'terminal',
		planModeAllowed: false,
		parameters: [
			{ name: 'cwd', required: false, description: 'Optional workspace-relative or absolute working directory.' },
		],
	},
	{
		name: 'run_persistent_command',
		description: 'Run a shell command inside an existing persistent terminal.',
		approvalType: 'terminal',
		planModeAllowed: false,
		parameters: [
			{ name: 'persistent_terminal_id', required: true, description: 'Identifier returned by open_persistent_terminal.' },
			{ name: 'command', required: true, description: 'Shell command to execute.' },
		],
	},
	{
		name: 'kill_persistent_terminal',
		description: 'Close a persistent terminal that is no longer needed.',
		approvalType: 'terminal',
		planModeAllowed: false,
		parameters: [
			{ name: 'persistent_terminal_id', required: true, description: 'Identifier returned by open_persistent_terminal.' },
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
		if (tool.approvalType) {
			lines.push(`Approval class: ${tool.approvalType}`);
		}
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
		lines.push('- Do not attempt to edit files, run terminal commands, or propose executable SEARCH/REPLACE patches in plan mode.');
		lines.push('- When you have enough context, call attempt_completion with a detailed implementation plan.');
	} else {
		lines.push('- Read a file before editing it.');
		lines.push('- Use search_files and list_directory to explore unfamiliar areas.');
		lines.push('- Use run_command for one-off shell output and open_persistent_terminal/run_persistent_command when a shell needs to stay open.');
	}
	// Keep follow-up reads grounded in observed evidence rather than guessed starter files.
	lines.push('- Only call read_file for paths you directly observed in list_directory/search_files results, the active file, or the open-files list.');
	lines.push('- If list_directory returns no entries, treat the directory as empty and do not infer framework starter files.');
	lines.push('- Before each tool call, include one short planning sentence prefixed with "Thinking:".');
	lines.push('- The "Thinking:" sentence must be a standalone line immediately followed by a single <tool_call> block; do not append user-facing prose to that line.');
	lines.push('- After emitting a <tool_call> block, stop and wait for the tool result.');
	lines.push('- Never invent or emit <tool_result> blocks yourself. Tool results are provided only by the runtime.');
	lines.push('- Never pretend a tool succeeded, never fabricate directory listings/file contents/search matches, and never continue the task as if the tool already ran.');
	lines.push('- For attempt_completion, put the entire user-facing summary inside <result> and do not repeat that summary after the tool call.');
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
