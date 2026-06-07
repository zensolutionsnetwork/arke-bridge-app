/**
 * Thin model client over the official Anthropic SDK (BRIDGE_APP_SPEC §1: Agent SDK on the owner's
 * Console ANTHROPIC_API_KEY). Tier-selected per task — Opus for council/code-review, a cheap tier
 * for routine rituals. This is the foundation the tool/MCP loop grows on; today it does one turn.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AgentConfig, ModelTier } from './config.js';

export interface CompleteResult { text: string; model: string; usage: { input: number; output: number } }

export class ModelClient {
  private client: Anthropic;
  constructor(private cfg: AgentConfig) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set — the agent core cannot reach the model.');
    this.client = new Anthropic({ apiKey });
  }

  async complete(opts: {
    tier?: ModelTier;
    system: string;
    messages: Anthropic.MessageParam[];
    maxTokens?: number;
  }): Promise<CompleteResult> {
    const model = this.cfg.models[opts.tier ?? 'default'];
    const res = await this.client.messages.create({
      model,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      messages: opts.messages,
    });
    const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('').trim();
    return { text, model, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens } };
  }

  /** Raw tool-capable turn — the loop inspects stop_reason and the tool_use blocks itself. */
  createMessage(opts: {
    tier?: ModelTier;
    system: string;
    messages: Anthropic.MessageParam[];
    tools?: Anthropic.Tool[];
    maxTokens?: number;
  }): Promise<Anthropic.Message> {
    return this.client.messages.create({
      model: this.cfg.models[opts.tier ?? 'default'],
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.system,
      messages: opts.messages,
      ...(opts.tools && opts.tools.length ? { tools: opts.tools } : {}),
    });
  }
  modelFor(tier: ModelTier = 'default'): string { return this.cfg.models[tier]; }
}
