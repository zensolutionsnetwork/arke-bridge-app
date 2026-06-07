/**
 * Hub client — the 3080's read/write access to the live council hub (architectscouncil.com). Token
 * comes from the env (never the config file). Until Mathieu issues a Console/admin token for this
 * machine, `configured()` is false and hub-dependent rituals skip cleanly rather than fail.
 */
export class HubClient {
  constructor(private baseUrl: string, private token: string | undefined) {}
  configured(): boolean { return !!this.token; }
  private h() { return { 'x-admin-token': this.token || '', 'content-type': 'application/json' }; }

  async getBacklog(): Promise<{ content: string; updatedAt: string | null }> {
    const r = await fetch(this.baseUrl.replace(/\/+$/, '') + '/api/council/admin/backlog', { headers: this.h() });
    if (!r.ok) throw new Error(`backlog GET HTTP ${r.status}`);
    return (await r.json()) as any;
  }
  async setBacklog(content: string, updatedBy = 'arke-3080'): Promise<void> {
    const r = await fetch(this.baseUrl.replace(/\/+$/, '') + '/api/council/admin/backlog', {
      method: 'POST', headers: this.h(), body: JSON.stringify({ content, updatedBy }),
    });
    if (!r.ok) throw new Error(`backlog POST HTTP ${r.status}`);
  }
  async health(): Promise<boolean> {
    try { const r = await fetch(this.baseUrl.replace(/\/+$/, '') + '/api/health'); return r.ok; } catch { return false; }
  }
}
