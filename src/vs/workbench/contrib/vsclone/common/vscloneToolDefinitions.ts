/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { type VSCloneChatMode } from './vsclonePlanModeTypes.js';

/**
 * Tool approvals stay intentionally coarse because the runtime only needs a small set of policy
 * buckets for gating edits and terminal access. Keeping the approval union next to the tool
 * metadata lets the message stream, prompt text, and execution service share one definition.
 */
export type VSCloneToolApprovalType = 'edits' | 'terminal' | 'MCP tools';

/**
 * Tool metadata stays centralized so prompt assembly and runtime dispatch keep the same contract.
 * That matters even more now that VSClone has both file tools and terminal tools with approval
 * classes that future thread-runtime code will need to reason about.
 */
export interface IVSCloneToolParameterDefinition {
	readonly name: string;
	readonly required: boolean;
	readonly description: string;
}

export interface IVSCloneToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly approvalType?: VSCloneToolApprovalType;
	readonly planModeAllowed: boolean;
	readonly parameters: readonly IVSCloneToolParameterDefinition[];
}

export interface IVSCloneToolResultPayload {
	readonly success: boolean;
	readonly output: string;
}

export interface IVSCloneToolJsonSchema {
	readonly type: 'object';
	readonly properties: Readonly<Record<string, {
		readonly type: 'string';
		readonly description: string;
	}>>;
	readonly required?: readonly string[];
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
		// Match Void's tool-facing name so the prompt, prepared-message seam, and future native
		// tool-call transport all converge on one read/list/search vocabulary. Runtime still accepts
		// the historical `list_directory` alias while older transcripts exist in the wild.
		name: 'ls_dir',
		description: 'List files and folders for a directory.',
		planModeAllowed: true,
		parameters: [
			{ name: 'path', required: true, description: 'Absolute or workspace-relative directory path.' },
			{ name: 'recursive', required: false, description: 'Set to true for recursive traversal.' },
		],
	},
	{
		// Keep the user-visible tool name aligned with Void now that the directory tree is no longer
		// injected eagerly into the system prompt. Search is expected to be a first-class lazy tool.
		name: 'search_for_files',
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

export function getVSCloneVisibleToolDefinitions(mode: VSCloneChatMode = 'act'): readonly IVSCloneToolDefinition[] {
	return mode === 'plan'
		? VSCLONE_TOOL_DEFINITIONS.filter(tool => tool.planModeAllowed)
		: VSCLONE_TOOL_DEFINITIONS;
}

/**
 * Native tool calling expects JSON-schema input contracts rather than the old XML examples. The
 * same schema is shared across providers so plan-mode filtering remains VSClone-owned while each
 * transport only has to adapt field names at the final SDK boundary.
 */
export function toVSCloneToolJsonSchema(tool: IVSCloneToolDefinition): IVSCloneToolJsonSchema {
	const properties: Record<string, { type: 'string'; description: string }> = {};
	const required: string[] = [];

	for (const parameter of tool.parameters) {
		properties[parameter.name] = {
			type: 'string',
			description: parameter.description,
		};
		if (parameter.required) {
			required.push(parameter.name);
		}
	}

	return {
		type: 'object',
		properties,
		...(required.length > 0 ? { required } : {}),
	};
}

/**
 * Prompt formatting still filters the visible tool list by mode, but the instructions now match
 * native tool calling instead of teaching the model to emit XML wrappers in assistant text.
 */
export function formatToolDefinitionsForPrompt(mode: VSCloneChatMode = 'act'): string {
	const visibleTools = getVSCloneVisibleToolDefinitions(mode);
	const lines: string[] = [
		'## Available Tools',
		mode === 'plan'
			? 'You can inspect the codebase via tool calls, but this turn is read-only.'
			: 'You can explore and modify the codebase via tool calls.',
		'',
		'Use the native tool-calling interface provided by the model.',
		'Call one tool at a time and wait for its tool result before calling another tool.',
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
		lines.push('- Use read_file, search_for_files, and ls_dir to gather codebase context before answering.');
		lines.push('- Do not attempt to edit files, run terminal commands, or propose executable SEARCH/REPLACE patches in plan mode.');
		lines.push('- When you have enough context, call attempt_completion with a detailed implementation plan in its `result` argument.');
	} else {
		lines.push('- Read a file before editing it.');
		lines.push('- Use search_for_files and ls_dir to explore unfamiliar areas.');
		lines.push('- Use run_command for one-off shell output and open_persistent_terminal/run_persistent_command when a shell needs to stay open.');
	}
	lines.push('- The system prompt does not include a precomputed workspace tree, open-files list, or diagnostics dump. Discover that context lazily with tools.');
	// Keep follow-up reads grounded in observed evidence rather than guessed starter files.
	lines.push('- Only call read_file for paths you directly observed in ls_dir/search_for_files results, the active file summary, or earlier tool results.');
	lines.push('- If ls_dir returns no entries, treat the directory as empty and do not infer framework starter files.');
	lines.push('- Before each tool call, briefly state why you need the tool in plain language.');
	lines.push('- Do not hand-write XML or pseudo-tool syntax. Use the model\'s tool-calling mechanism only.');
	lines.push('- Never invent tool results yourself. Tool results are provided only by the runtime.');
	lines.push('- Never pretend a tool succeeded, never fabricate directory listings/file contents/search matches, and never continue the task as if the tool already ran.');
	lines.push('- For attempt_completion, put the final user-facing summary in the `result` argument and do not emit a duplicate prose answer outside the tool call.');
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
 * Tool results stay wrapped in one stable text envelope so replay preserves success/failure
 * metadata across providers even though the live tool dispatch path is now native.
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
