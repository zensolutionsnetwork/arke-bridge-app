/**
 * Brain sync (contract §2) — the bridge app's side of "full representation, incremental by design".
 *
 * walkProject collects every file under a project root (minus the usual machine noise). buildUpload
 * runs them through the consent gate, hashes the survivors into chunks, and stamps the manifest with
 * brainVersion + consentManifestVersion. diffAgainst compares to what the voice already holds so only
 * changed chunks travel — but brainVersion always covers the FULL set, so client and voice can verify
 * they converged on the identical tree (Logos: hash-chunk, sync diffs, verify manifest hash).
 */
import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex, computeBrainVersion, type Chunk, type ChunkWithBody, type BrainManifest } from './protocol.js';
import { gate, consentManifestVersion, type ConsentManifest, type GateInput } from './consent.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '.cache', 'coverage']);

/** Recursively list project-relative POSIX paths under `root`, skipping machine noise. */
export function walkProject(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return out.sort();
}

export interface Upload {
  manifest: BrainManifest;
  chunks: ChunkWithBody[];        // full gated set, bodies included (transfer payload)
  excludedByPolicy: string[];
}

/**
 * Build a full upload from a project root + its consent manifest. Throws ConsentViolation (from the
 * gate) if any shareable file carries a secret — the caller lets it propagate and aborts loudly.
 */
export function buildUpload(
  root: string,
  member: string,
  displayName: string,
  consent: ConsentManifest,
  createdAt: string,
): Upload {
  const files: GateInput[] = walkProject(root).map((p) => ({ path: p, content: fs.readFileSync(path.join(root, p), 'utf8') }));
  const { included, excludedByPolicy } = gate(files, consent);
  const chunks: ChunkWithBody[] = included.map((f) => ({
    path: f.path,
    sha256: sha256Hex(f.content),
    bytes: Buffer.byteLength(f.content, 'utf8'),
    content: f.content,
  }));
  const manifest: BrainManifest = {
    contractVersion: consent.contractVersion,
    member,
    displayName,
    brainVersion: computeBrainVersion(chunks),
    createdAt,
    consentManifestVersion: consentManifestVersion(consent),
    chunks: chunks.map(({ content, ...meta }) => meta), // manifest carries metadata, not bodies
  };
  return { manifest, chunks, excludedByPolicy };
}

/**
 * Incremental selection: given the full local chunk set and the chunk hashes the voice already
 * holds, return only the chunks to send and the paths to delete. brainVersion (computed over the
 * full local set) is what both sides verify against after the voice applies the diff.
 */
export interface Diff { send: ChunkWithBody[]; deletePaths: string[]; unchanged: number }
export function diffAgainst(local: ChunkWithBody[], remote: Pick<Chunk, 'path' | 'sha256'>[]): Diff {
  const remoteByPath = new Map(remote.map((c) => [c.path, c.sha256]));
  const localPaths = new Set(local.map((c) => c.path));
  const send = local.filter((c) => remoteByPath.get(c.path) !== c.sha256);
  const deletePaths = remote.filter((c) => !localPaths.has(c.path)).map((c) => c.path);
  return { send, deletePaths, unchanged: local.length - send.length };
}
