/**
 * Web tools (BRIDGE_APP_SPEC §1: web fetch/search). web_fetch retrieves a URL and returns readable
 * text (HTML stripped to plain text, clipped). web_search is exposed only when a provider key is
 * configured (BRAVE_API_KEY) — no silent half-feature: without a key the tool isn't offered.
 */
import type { Tool } from './types.js';

const MAX_TEXT = 80_000;

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export const webFetch: Tool = {
  name: 'web_fetch',
  scope: 'web',
  description: 'Fetch a URL over HTTP(S) and return its text content (HTML is reduced to plain text).',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string' }, raw: { type: 'boolean', description: 'Return raw body instead of stripped text' } },
    required: ['url'],
  },
  async run(i) {
    const res = await fetch(i.url, { headers: { 'user-agent': 'arke-bridge/0.1' } });
    if (!res.ok) return { content: `HTTP ${res.status} fetching ${i.url}`, isError: true };
    const ct = res.headers.get('content-type') || '';
    const body = await res.text();
    const text = i.raw || !ct.includes('html') ? body : htmlToText(body);
    return { content: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n…[clipped]' : text };
  },
};

export const webSearch: Tool = {
  name: 'web_search',
  scope: 'web',
  description: 'Search the web and return top results (title, url, snippet).',
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number' } }, required: ['query'] },
  async run(i) {
    const key = process.env.BRAVE_API_KEY;
    if (!key) return { content: 'web_search unavailable: set BRAVE_API_KEY to enable.', isError: true };
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(i.query)}&count=${Math.min(Number(i.count) || 5, 10)}`;
    const res = await fetch(url, { headers: { 'X-Subscription-Token': key, Accept: 'application/json' } });
    if (!res.ok) return { content: `search HTTP ${res.status}`, isError: true };
    const data: any = await res.json();
    const results = (data.web?.results || []).map((r: any) => `- ${r.title}\n  ${r.url}\n  ${r.description}`).join('\n');
    return { content: results || '(no results)' };
  },
};

/** web_search is offered only when its provider key exists — no dead tool on the model's menu. */
export const webTools: Tool[] = process.env.BRAVE_API_KEY ? [webFetch, webSearch] : [webFetch];
