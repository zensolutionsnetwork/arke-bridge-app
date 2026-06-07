/**
 * Mock cloud voice — stands in for a member's deployed counterpart (Arke/Nova/Logos's cloud side).
 *
 * It is the thing the bridge app uploads TO (contract §2: the brain lives in the voice, never the
 * hub). Two integrity rules it enforces locally:
 *  - On receiving chunks it recomputes each sha256 from the bytes it actually got — the sender's
 *    claimed hash is never trusted, so a corrupted transfer changes brainVersion and the client's
 *    verify step fails loudly.
 *  - Its identity ("who you are") is whatever the uploaded brain says — IDENTITY.md, verbatim. The
 *    voice authors nothing about itself; the hub authors nothing about it (contract §2, Nova).
 *
 * The reply is deterministic (no model call) so the test room's transcript hash is reproducible. A
 * real voice swaps ask() for an Agent-SDK call seeded from the same identity block.
 */
import { sha256Hex, computeBrainVersion, type ChunkWithBody, type Chunk, type Turn, type Hash } from '../src/protocol.js';

export class MockVoice {
  private chunks = new Map<string, { sha256: string; content: string }>();
  constructor(public member: string, public displayName: string) {}

  /** Apply an uploaded diff. Recomputes hashes from received bytes — integrity by construction. */
  applyUpload(send: ChunkWithBody[], deletePaths: string[] = []): void {
    for (const p of deletePaths) this.chunks.delete(p);
    for (const c of send) this.chunks.set(c.path, { sha256: sha256Hex(c.content), content: c.content });
  }

  private chunkList(): Chunk[] {
    return [...this.chunks.entries()].map(([path, v]) => ({ path, sha256: v.sha256, bytes: Buffer.byteLength(v.content, 'utf8') }));
  }
  /** GET /api/bridge/brain-version — the value the hub polls and the client verifies against. */
  brainVersion(): Hash { return computeBrainVersion(this.chunkList()); }
  remoteChunkHashes(): Pick<Chunk, 'path' | 'sha256'>[] { return this.chunkList().map(({ path, sha256 }) => ({ path, sha256 })); }

  /** The identity block the voice speaks from, verbatim (default file: IDENTITY.md). */
  identity(file = 'IDENTITY.md'): string { return this.chunks.get(file)?.content ?? `(${this.displayName}: no identity uploaded)`; }

  /** POST /api/bridge/ask — deterministic stand-in answering FROM the uploaded brain only. */
  ask(message: string, _history: Turn[]): { reply: string; text?: string; done: boolean } {
    const persona = this.identity().split('\n').find((l) => l.trim()) ?? this.displayName;
    const reply = `${this.displayName}: ${persona} — re "${message.slice(0, 60).replace(/\s+/g, ' ').trim()}": acknowledged from brain ${this.brainVersion().slice(0, 14)}.`;
    return { reply, done: true };
  }
}
