/**
 * Mock receiving room — the hub's v2 behaviour, in memory (contract §3/§4).
 *
 * The hub is a broker: it polls every participant's brain-version BEFORE opening (an unreachable
 * voice is marked absent, never impersonated), relays turns round-robin with the v1 laws intact
 * (deep-copied history at each boundary, per-turn meta line, 15s budget, done honored once all have
 * spoken), then records the raw transcript with its hash and the brainVersion each voice spoke from.
 * It never authors or summarizes a word. Download is participants-only.
 */
import { CONTRACT_VERSION, transcriptHash, type Turn, type Participant, type TranscriptHeader, type Hash } from '../src/protocol.js';
import type { MockVoice } from './mock-voice.js';

export interface MeetingRecord {
  header: TranscriptHeader;
  turns: Turn[];
  participantSet: Set<string>;
}

export class MockHub {
  private voices = new Map<string, MockVoice>();
  private meetings = new Map<string, MeetingRecord>();

  /** A voice registers its reachable endpoint with the room. */
  connect(voice: MockVoice): void { this.voices.set(voice.member, voice); }

  /**
   * Open and run a meeting. `clock` supplies timestamps (the room has no wall clock of its own, so
   * the harness stays deterministic). Returns the meeting id.
   */
  runMeeting(opts: {
    meetingId: string;
    topic: string;
    members: string[];
    turnCap: number;
    clock: { openedAt: string; closedAt: string };
  }): string {
    const { meetingId, topic, members, turnCap, clock } = opts;

    // Poll brain-versions first; unreachable => absent, never defaulted (contract §3).
    const participants: Participant[] = [];
    const present: MockVoice[] = [];
    for (const name of members) {
      const v = this.voices.get(name);
      if (!v) continue; // absent
      participants.push({ member: v.member, displayName: v.displayName, brainVersion: v.brainVersion() });
      present.push(v);
    }

    const turns: Turn[] = [];
    const order = present.map((v) => v.displayName).join(' → ');
    let message = topic;
    const cap = Math.min(Math.max(1, turnCap), 150);
    let used = 0;
    for (let i = 0; i < cap; i++) {
      const v = present[i % present.length];
      const meta = `[council meta — turn ${i + 1}/${cap} | circle: ${order} | you are ${v.displayName} | norms: plain, technical, share code; close by self-assigning homework and set done:true]`;
      // Deep-copied history at the boundary so no voice can mutate the shared transcript (v1 law).
      const history: Turn[] = turns.slice(-30).map((t) => ({ speaker: t.speaker, text: t.text }));
      const r = v.ask(`${meta}\n\n${message}`, history);
      turns.push({ speaker: v.displayName, text: r.reply });
      used = i + 1;
      if (r.done && i >= present.length - 1) break; // let everyone speak once before honoring done
      message = r.reply;
    }

    const header: TranscriptHeader = {
      contractVersion: CONTRACT_VERSION,
      meetingId,
      openedAt: clock.openedAt,
      closedAt: clock.closedAt,
      turnsUsed: used,
      turnCap: cap,
      participants,
      transcriptSha256: transcriptHash(turns),
    };
    this.meetings.set(meetingId, { header, turns, participantSet: new Set(participants.map((p) => p.member)) });
    return meetingId;
  }

  /** GET /api/council/meeting/:id/transcript — participants only; an outsider gets nothing. */
  getTranscript(meetingId: string, asMember: string): { header: TranscriptHeader; turns: Turn[] } {
    const m = this.meetings.get(meetingId);
    if (!m) throw new Error(`meeting ${meetingId} not found`);
    if (!m.participantSet.has(asMember)) throw new Error(`403: ${asMember} did not sit in meeting ${meetingId}`);
    // Deep copy so the consumer verifies its own bytes, never the room's live object.
    return { header: { ...m.header, participants: m.header.participants.map((p) => ({ ...p })) }, turns: m.turns.map((t) => ({ ...t })) };
  }

  brainVersionOf(member: string): Hash | null { return this.voices.get(member)?.brainVersion() ?? null; }
}
