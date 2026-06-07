/**
 * The agentic tool loop — what turns the agent core from "answers" into "acts".
 *
 * Drive the model with the tool schemas; while it returns tool_use blocks, run each one through the
 * permission gate (fail-closed) and the audit log, feed the tool_results back, and repeat until the
 * model stops asking for tools or the iteration cap is hit. Every assistant text and every tool step
 * is persisted to the session transcript so nothing is lost between runs (BRIDGE_APP_SPEC §1/§2).
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { ModelClient } from './model.js';
import type { ModelTier } from './config.js';
import type { Permissions } from './permissions.js';
import type { Audit } from './audit.js';
import type { Session } from './session.js';
import type { ToolRegistry } from './tools/registry.js';
import type { Tool, ToolContext, ToolResult } from './tools/types.js';

export interface LoopResult {
  text: string;
  iterations: number;
  toolCalls: number;
  usage: { input: number; output: number };
}

const clip = (s: string, n = 200) => (s.length > n ? s.slice(0, n) + '…' : s).replace(/\s+/g, ' ').trim();

async function execute(tool: Tool, input: any, ctx: ToolContext): Promise<ToolResult> {
  const started = Date.now();
  const base = { at: new Date().toISOString(), session: ctx.session, tool: tool.name, scope: tool.scope, summary: clip(JSON.stringify(input ?? {})) };

  const scope = ctx.perms.scopeAllowed(tool.scope);
  if (!scope.allow) { ctx.audit.write({ ...base, decision: 'deny', reason: scope.reason }); return { content: `permission denied: ${scope.reason}`, isError: true }; }

  const target = tool.pathArg?.(input);
  if (target !== undefined) {
    const p = ctx.perms.pathAllowed(target);
    if (!p.allow) { ctx.audit.write({ ...base, decision: 'deny', reason: p.reason }); return { content: `permission denied: ${p.reason}`, isError: true }; }
  }

  try {
    const res = await tool.run(input, ctx);
    ctx.audit.write({ ...base, decision: 'allow', ok: !res.isError, error: res.isError ? clip(res.content) : undefined, ms: Date.now() - started });
    return res;
  } catch (e) {
    const error = (e as Error).message;
    ctx.audit.write({ ...base, decision: 'allow', ok: false, error: clip(error), ms: Date.now() - started });
    return { content: `tool error: ${error}`, isError: true };
  }
}

export async function runLoop(opts: {
  model: ModelClient;
  system: string;
  registry: ToolRegistry;
  ctx: ToolContext;
  session: Session;
  history: Anthropic.MessageParam[]; // prior conversation (text turns)
  userText: string;
  tier?: ModelTier;
  maxTokens?: number;
  maxIterations?: number;
  maxToolCalls?: number; // hard backstop on total tool executions (safety against runaway autonomous work)
}): Promise<LoopResult> {
  const { model, system, registry, ctx, session, tier, maxTokens } = opts;
  const maxIterations = opts.maxIterations ?? 24;
  const maxToolCalls = opts.maxToolCalls ?? Infinity;
  const now = () => new Date().toISOString();

  const messages: Anthropic.MessageParam[] = [...opts.history, { role: 'user', content: opts.userText }];
  session.append({ role: 'user', content: opts.userText, at: now() });

  const usage = { input: 0, output: 0 };
  let toolCalls = 0;
  let finalText = '';
  let iterations = 0;

  for (; iterations < maxIterations; iterations++) {
    const res = await model.createMessage({ tier, system, messages, tools: registry.schemas(), maxTokens });
    usage.input += res.usage.input_tokens;
    usage.output += res.usage.output_tokens;
    messages.push({ role: 'assistant', content: res.content });

    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('').trim();
    if (text) { finalText = text; session.append({ role: 'assistant', content: text, at: now(), model: res.model, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens } }); }

    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || toolUses.length === 0) break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      toolCalls++;
      // Hard backstop: once the budget is spent, refuse further tools with a guiding message so the
      // model wraps up instead of grinding. Heavy work is meant to go to Cowork, not run away here.
      const overBudget = toolCalls > maxToolCalls;
      const tool = overBudget ? undefined : registry.get(tu.name);
      const out = overBudget
        ? { content: `tool budget (${maxToolCalls}) exceeded — stop and do not call more tools. If this task needs more work it is too heavy for the 3080; report that it should be queued to Cowork-Arke.`, isError: true }
        : tool ? await execute(tool, tu.input, ctx) : { content: `unknown tool: ${tu.name}`, isError: true };
      session.append({ role: 'system', content: `[tool ${tu.name} → ${out.isError ? 'error' : 'ok'}] ${clip(out.content)}`, at: now() });
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.content, is_error: out.isError });
    }
    messages.push({ role: 'user', content: results });
  }

  return { text: finalText, iterations: iterations + 1, toolCalls, usage };
}
