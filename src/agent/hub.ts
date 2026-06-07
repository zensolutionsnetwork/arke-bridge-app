/**
 * Hub client — the 3080's access to the live council hub (architectscouncil.com). Credentials come
 * from the env (never the config file): the admin token for owner surfaces (backlog), and this
 * agent's MEMBER secret for the environment channel — the 3080 authenticates AS the architect-council
 * member (same auth canon as everything else; the credential resolves the actor). Each access degrades
 * cleanly when its credential is absent, so nothing fails just because Mathieu hasn't issued it yet.
 */
export interface EnvTask {
  id: string; from_actor: string; to_actor: string; kind: string; title: string | null;
  payload: any; priority: string; status: string;
}

export class HubClient {
  private base: string;
  constructor(baseUrl: string, private cred: { adminToken?: string; memberSecret?: string; selfMember?: string } = {}) {
    this.base = baseUrl.replace(/\/+$/, '');
  }
  // --- owner surface (admin token) ---
  configured(): boolean { return !!this.cred.adminToken; }
  private adminH() { return { 'x-admin-token': this.cred.adminToken || '', 'content-type': 'application/json' }; }
  async getBacklog(): Promise<{ content: string; updatedAt: string | null }> {
    const r = await fetch(this.base + '/api/council/admin/backlog', { headers: this.adminH() });
    if (!r.ok) throw new Error(`backlog GET HTTP ${r.status}`);
    return (await r.json()) as any;
  }
  async setBacklog(content: string, updatedBy = 'arke-3080'): Promise<void> {
    const r = await fetch(this.base + '/api/council/admin/backlog', { method: 'POST', headers: this.adminH(), body: JSON.stringify({ content, updatedBy }) });
    if (!r.ok) throw new Error(`backlog POST HTTP ${r.status}`);
  }

  // --- environment channel (member secret) ---
  envConfigured(): boolean { return !!this.cred.memberSecret && !!this.cred.selfMember; }
  private memberH() { return { 'x-bridge-secret': this.cred.memberSecret || '', 'content-type': 'application/json' }; }
  /** This agent's env-channel inbox (queued + claimed tasks addressed to it). */
  async getEnvTasks(): Promise<EnvTask[]> {
    const r = await fetch(this.base + `/api/env/tasks?for=${encodeURIComponent(this.cred.selfMember!)}`, { headers: this.memberH() });
    if (!r.ok) throw new Error(`env tasks HTTP ${r.status}`);
    return ((await r.json()) as any).tasks || [];
  }
  /** Optimistic claim; false means another poller already took it. */
  async claimEnvTask(id: string): Promise<boolean> {
    const r = await fetch(this.base + `/api/env/task/${id}/claim`, { method: 'POST', headers: this.memberH() });
    if (!r.ok) throw new Error(`env claim HTTP ${r.status}`);
    return ((await r.json()) as any).claimed === true;
  }
  async reportEnvTask(id: string, status: 'done' | 'error', result: string): Promise<void> {
    const r = await fetch(this.base + `/api/env/task/${id}/report`, { method: 'POST', headers: this.memberH(), body: JSON.stringify({ status, result }) });
    if (!r.ok) throw new Error(`env report HTTP ${r.status}`);
  }

  async health(): Promise<boolean> {
    try { const r = await fetch(this.base + '/api/health'); return r.ok; } catch { return false; }
  }
}
