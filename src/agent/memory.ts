/**
 * Memory import (BRIDGE_APP_SPEC §1: "Projects + persistent memory: same model as today").
 *
 * Reads the memory dir Arke already uses — `MEMORY.md` (the index) plus each fact file — and folds
 * it into a single brain block the runtime injects as system context. Identity comes FROM the brain
 * (council v2 contract §2: the voice speaks from its uploaded "who you are", nobody authors it for it).
 */
import fs from 'node:fs';
import path from 'node:path';

export interface MemoryFile { name: string; content: string }
export interface Brain { index: string; files: MemoryFile[]; text: string }

export function loadMemory(memoryDir: string): Brain {
  const indexPath = path.join(memoryDir, 'MEMORY.md');
  const index = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
  const files: MemoryFile[] = [];
  if (fs.existsSync(memoryDir)) {
    for (const name of fs.readdirSync(memoryDir).sort()) {
      if (name === 'MEMORY.md' || !name.endsWith('.md')) continue;
      files.push({ name, content: fs.readFileSync(path.join(memoryDir, name), 'utf8') });
    }
  }
  const text = [
    '# Arke — persistent memory (loaded by the bridge-app agent core)',
    '',
    '## Index',
    index.trim(),
    '',
    '## Facts',
    ...files.map((f) => `### ${f.name}\n${f.content.trim()}`),
  ].join('\n');
  return { index, files, text };
}
