import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { AgentConfig, TeamConfig } from './types';
import { SCRIPT_DIR, resolveClaudeModel, resolveCodexModel } from './config';
import { log, emitEvent } from './logging';
import { ensureAgentDirectory, updateAgentTeammates } from './agent-setup';

export interface InvokeResult { text: string; costUsd: number | null; }

export async function runCommand(command: string, args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: cwd || SCRIPT_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });

        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });

        child.on('error', (error) => {
            reject(error);
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
                return;
            }

            const errorMessage = stderr.trim() || `Command exited with code ${code}`;
            reject(new Error(errorMessage));
        });
    });
}

/**
 * Run Claude CLI with --output-format stream-json and parse NDJSON events in real-time.
 * Logs tool_use events as they happen for observability.
 * Returns the final result text.
 */
async function runClaudeStreaming(args: string[], cwd: string, agentId: string): Promise<InvokeResult> {
    return new Promise((resolve, reject) => {
        const child = spawn('claude', args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let buffer = '';
        let stderr = '';
        let resultText = '';
        let lastAssistantText = '';
        let costUsd: number | null = null;
        const startTime = Date.now();
        let turnCount = 0;

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        child.stdout.on('data', (chunk: string) => {
            buffer += chunk;

            // Process complete lines (NDJSON)
            let newlineIdx: number;
            while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newlineIdx).trim();
                buffer = buffer.slice(newlineIdx + 1);
                if (!line) continue;

                try {
                    const event = JSON.parse(line);
                    processStreamEvent(event, agentId, startTime, turnCount);

                    // Track turns from assistant messages containing tool_use
                    if (event.type === 'assistant' && event.message?.content) {
                        const toolUses = event.message.content.filter(
                            (block: { type: string }) => block.type === 'tool_use'
                        );
                        if (toolUses.length > 0) {
                            turnCount++;
                        }
                        // Capture text blocks as potential final response
                        const textBlocks = event.message.content
                            .filter((block: { type: string }) => block.type === 'text')
                            .map((block: { text: string }) => block.text)
                            .join('');
                        if (textBlocks) {
                            lastAssistantText = textBlocks;
                        }
                    }

                    // Capture the final result
                    if (event.type === 'result') {
                        resultText = event.result || '';
                        costUsd = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null;
                        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                        log('INFO', `Agent ${agentId} completed in ${elapsed}s (${turnCount} tool turns, cost: $${event.total_cost_usd?.toFixed(4) || '?'})`);
                        emitEvent('agent_result', {
                            agentId,
                            durationMs: Date.now() - startTime,
                            turns: turnCount,
                            costUsd: event.total_cost_usd || null,
                            isError: event.is_error || false,
                        });
                    }
                } catch {
                    // Ignore non-JSON lines
                }
            }
        });

        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });

        child.on('error', (error) => {
            reject(error);
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve({ text: resultText || lastAssistantText, costUsd });
                return;
            }
            const errorMessage = stderr.trim() || `Claude exited with code ${code}`;
            reject(new Error(errorMessage));
        });
    });
}

/**
 * Process a single stream-json event from the Claude CLI, logging tool usage.
 */
function processStreamEvent(
    event: Record<string, unknown>,
    agentId: string,
    startTime: number,
    _turnCount: number,
): void {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (event.type === 'system' && (event as { subtype?: string }).subtype === 'init') {
        log('DEBUG', `[${agentId}] Session initialized (${elapsed}s)`);
        return;
    }

    if (event.type === 'assistant') {
        const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
        if (!message?.content) return;

        for (const block of message.content) {
            if (block.type === 'tool_use') {
                const toolName = block.name as string;
                const toolInput = block.input as Record<string, unknown>;
                const summary = summarizeToolUse(toolName, toolInput);
                log('DEBUG', `[${agentId}] ▶ ${toolName}: ${summary} (${elapsed}s)`);
                emitEvent('agent_tool_use', {
                    agentId,
                    toolName,
                    toolInput: truncateForEvent(toolInput),
                    elapsedMs: Date.now() - startTime,
                });
            }
        }
        return;
    }

    if (event.type === 'user') {
        const message = event.message as { content?: Array<Record<string, unknown>> } | undefined;
        if (!message?.content) return;

        for (const block of message.content) {
            if (block.type === 'tool_result') {
                const isError = block.is_error as boolean | undefined;
                if (isError) {
                    const errText = truncateString(String(block.content || ''), 200);
                    log('WARN', `[${agentId}] ✗ tool error: ${errText} (${elapsed}s)`);
                    emitEvent('agent_tool_error', {
                        agentId,
                        error: errText,
                        elapsedMs: Date.now() - startTime,
                    });
                }
            }
        }
        return;
    }
}

/**
 * Create a human-readable summary of a tool call for logging.
 */
function summarizeToolUse(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
        case 'Bash':
            return truncateString(String(input.command || ''), 120);
        case 'Read':
            return String(input.file_path || '');
        case 'Write':
            return String(input.file_path || '');
        case 'Edit':
            return String(input.file_path || '');
        case 'Glob':
            return `${input.pattern || ''}${input.path ? ` in ${input.path}` : ''}`;
        case 'Grep':
            return `/${input.pattern || ''}/`;
        case 'Task':
            return `[${input.subagent_type || '?'}] ${truncateString(String(input.description || ''), 80)}`;
        case 'WebFetch':
            return String(input.url || '');
        case 'WebSearch':
            return String(input.query || '');
        default:
            return truncateString(JSON.stringify(input), 100);
    }
}

function truncateString(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + '…';
}

function truncateForEvent(input: Record<string, unknown>): Record<string, unknown> {
    const str = JSON.stringify(input);
    if (str.length <= 500) return input;
    // For large inputs, only keep key fields
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof value === 'string' && value.length > 200) {
            result[key] = value.slice(0, 200) + '…';
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Invoke a single agent with a message. Contains all Claude/Codex invocation logic.
 * Returns the raw response text.
 */
export async function invokeAgent(
    agent: AgentConfig,
    agentId: string,
    message: string,
    workspacePath: string,
    shouldReset: boolean,
    agents: Record<string, AgentConfig> = {},
    teams: Record<string, TeamConfig> = {}
): Promise<InvokeResult> {
    // Ensure agent directory exists with config files
    const agentDir = path.join(workspacePath, agentId);
    const isNewAgent = !fs.existsSync(agentDir);
    ensureAgentDirectory(agentDir);
    if (isNewAgent) {
        log('INFO', `Initialized agent directory with config files: ${agentDir}`);
    }

    // Update AGENTS.md with current teammate info
    updateAgentTeammates(agentDir, agentId, agents, teams);

    // Resolve working directory
    const workingDir = agent.working_directory
        ? (path.isAbsolute(agent.working_directory)
            ? agent.working_directory
            : path.join(workspacePath, agent.working_directory))
        : agentDir;

    const provider = agent.provider || 'anthropic';

    if (provider === 'openai') {
        log('INFO', `Using Codex CLI (agent: ${agentId})`);

        const shouldResume = !shouldReset;

        if (shouldReset) {
            log('INFO', `🔄 Resetting Codex conversation for agent: ${agentId}`);
        }

        const modelId = resolveCodexModel(agent.model);
        const codexArgs = ['exec'];
        if (shouldResume) {
            codexArgs.push('resume', '--last');
        }
        if (modelId) {
            codexArgs.push('--model', modelId);
        }
        codexArgs.push('--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json', message);

        const codexOutput = await runCommand('codex', codexArgs, workingDir);

        // Parse JSONL output and extract final agent_message
        let response = '';
        const lines = codexOutput.trim().split('\n');
        for (const line of lines) {
            try {
                const json = JSON.parse(line);
                if (json.type === 'item.completed' && json.item?.type === 'agent_message') {
                    response = json.item.text;
                }
            } catch (e) {
                // Ignore lines that aren't valid JSON
            }
        }

        return { text: response || 'Sorry, I could not generate a response from Codex.', costUsd: null };
    } else {
        // Default to Claude (Anthropic)
        log('INFO', `Using Claude provider (agent: ${agentId})`);

        const continueConversation = !shouldReset;

        if (shouldReset) {
            log('INFO', `🔄 Resetting conversation for agent: ${agentId}`);
        }

        const modelId = resolveClaudeModel(agent.model);
        const claudeArgs = ['--dangerously-skip-permissions'];
        if (modelId) {
            claudeArgs.push('--model', modelId);
        }
        if (continueConversation) {
            claudeArgs.push('-c');
        }
        claudeArgs.push('--verbose', '--output-format', 'stream-json', '-p', message);

        return await runClaudeStreaming(claudeArgs, workingDir, agentId);
    }
}
