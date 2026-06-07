/**
 * Council v2 mock-agent test room (contract §9) — the gate every real member waits behind.
 *
 * Proves the full round-trip offline, with no live hub and no secret beyond the fixtures:
 *   1. upload brain → the voice's independently-recomputed brainVersion matches the client's
 *   2. incremental sync sends only changed chunks and re-verifies
 *   3. tampered transfer is caught (brainVersion diverges)
 *   4. meeting → download transcript → transcriptSha256 verifies locally
 *   5. transcript download is participants-only
 *   6. consent gate aborts loudly on a seeded fake secret; deny globs drop files quietly
 *
 * Run: npm run test-room   (exit 0 = the family may connect; nonzero = it may not)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildUpload, diffAgainst } from '../src/brain.js';
import { loadConsent, ConsentViolation } from '../src/consent.js';
import { transcriptHash } from '../src/protocol.js';
import { MockVoice } from './mock-voice.js';
import { MockHub } from './mock-hub.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = (name: string) => path.join(HERE, '..', 'fixtures', name);
const T0 = '2026-06-07T07:00:00Z'; // fixed clock keeps the run deterministic

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function section(title: string): void { console.log(`\n▸ ${title}`); }

// A bridge-app upload to a member's own voice, with the contract's verify step. Returns the upload.
function syncBrainToVoice(fixture: string, member: string, displayName: string, voice: MockVoice) {
  const consent = loadConsent(path.join(FIX(fixture), 'consent.json'));
  const up = buildUpload(FIX(fixture), member, displayName, consent, T0);
  const diff = diffAgainst(up.chunks, voice.remoteChunkHashes());
  voice.applyUpload(diff.send, diff.deletePaths);
  return { up, diff };
}

// ── 1 + 2 + 3: brain upload, incremental, tamper ───────────────────────────
section('Brain upload — hashes match by construction (contract §2)');
const nova = new MockVoice('zen-ai', 'Nova');
const logos = new MockVoice('biblevoice', 'Logos');

const a = syncBrainToVoice('mock-agent-a', 'zen-ai', 'Nova', nova);
check('Nova: voice brainVersion matches client', nova.brainVersion() === a.up.manifest.brainVersion,
  `${nova.brainVersion()} vs ${a.up.manifest.brainVersion}`);
check('Nova: first sync sent every gated chunk', a.diff.send.length === a.up.chunks.length && a.diff.unchanged === 0);
check('Nova: .env dropped quietly by deny glob (never scanned)', a.up.excludedByPolicy.includes('.env'));
check('Nova: consent.json itself not shared', a.up.excludedByPolicy.includes('consent.json'));

const b = syncBrainToVoice('mock-agent-b', 'biblevoice', 'Logos', logos);
check('Logos: voice brainVersion matches client', logos.brainVersion() === b.up.manifest.brainVersion);

section('Incremental sync — only changed chunks travel (Logos: diffs, not re-uploads)');
const aAgain = syncBrainToVoice('mock-agent-a', 'zen-ai', 'Nova', nova);
check('Nova: re-sync of unchanged tree sends 0 chunks', aAgain.diff.send.length === 0);
check('Nova: brainVersion stable across no-op re-sync', nova.brainVersion() === a.up.manifest.brainVersion);

section('Tamper detection — a corrupted chunk diverges the brainVersion');
const tampered = new MockVoice('zen-ai', 'Nova');
const corrupt = a.up.chunks.map((c, i) => (i === 0 ? { ...c, content: c.content + ' // injected' } : c));
tampered.applyUpload(corrupt, []);
check('Nova: tampered upload does NOT match client brainVersion', tampered.brainVersion() !== a.up.manifest.brainVersion);

// ── 4 + 5: meeting, transcript hash, participants-only ─────────────────────
section('Meeting → transcript download verifies locally (contract §3/§4)');
const hub = new MockHub();
hub.connect(nova);
hub.connect(logos);
const meetingId = hub.runMeeting({
  meetingId: 'mtg-0001',
  topic: 'Test-room shakedown: confirm the v2 round-trip end to end.',
  members: ['zen-ai', 'biblevoice'],
  turnCap: 6,
  clock: { openedAt: T0, closedAt: '2026-06-07T07:05:00Z' },
});

const dl = hub.getTranscript(meetingId, 'zen-ai'); // Nova is a participant
check('transcript downloads for a participant', dl.turns.length > 0);
check('transcriptSha256 verifies against re-hashed turns', transcriptHash(dl.turns) === dl.header.transcriptSha256,
  `${transcriptHash(dl.turns)} vs ${dl.header.transcriptSha256}`);
check('header records each voice\'s brainVersion', dl.header.participants.every((p) => p.brainVersion.startsWith('sha256:')));
check('participant brainVersion equals the live voice brainVersion',
  dl.header.participants.find((p) => p.member === 'zen-ai')!.brainVersion === nova.brainVersion());
check('turnsUsed within cap', dl.header.turnsUsed > 0 && dl.header.turnsUsed <= dl.header.turnCap);

let blocked403 = false;
try { hub.getTranscript(meetingId, 'architect-council'); } catch { blocked403 = true; }
check('non-participant download is refused (participants-only)', blocked403);

// A tampered transcript fails the local verify the bridge runs after download.
const tamperedTurns = dl.turns.map((t, i) => (i === 0 ? { ...t, text: t.text + ' [altered]' } : t));
check('altered transcript fails local hash verify', transcriptHash(tamperedTurns) !== dl.header.transcriptSha256);

// ── 6: consent gate blocks a seeded fake secret ────────────────────────────
section('Consent gate — seeded fake secret aborts the upload loudly (contract §9)');
let violation: ConsentViolation | null = null;
try {
  const consent = loadConsent(path.join(FIX('mock-agent-leaky'), 'consent.json'));
  buildUpload(FIX('mock-agent-leaky'), 'leaky', 'Leaky', consent, T0);
} catch (e) { if (e instanceof ConsentViolation) violation = e; else throw e; }
check('leaky upload threw ConsentViolation', violation !== null);
check('violation names the shareable file', !!violation && violation.path === 'src/config.ts', violation?.path);
check('violation identifies the secret pattern (anthropic-key)', !!violation && violation.hits.some((h) => h.pattern === 'anthropic-key'));
check('violation message redacts the secret (no full key)', !!violation && !violation.message.includes('FAKEFAKEFAKEFAKEFAKE'));

// ── verdict ────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(fail === 0
  ? `TEST ROOM PASSED — ${pass} checks. The v2 round-trip holds; the family may connect (Arke first).`
  : `TEST ROOM FAILED — ${pass} passed, ${fail} failed. No real member connects until this is green.`);
process.exit(fail === 0 ? 0 : 1);
