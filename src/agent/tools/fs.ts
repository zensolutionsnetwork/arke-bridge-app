/**
 * Filesystem tools — read, write, edit, list. Cowork parity: real paths, one filesystem, no sandbox
 * translation (BRIDGE_APP_SPEC §2). Every path is governed by the permission gate's allowPaths.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from './types.js';

const MAX_READ = 200_000; // clip huge files so a read can't blow the context

export const readFile: Tool = {
  name: 'read_file',
  scope: 'read',
  description: 'Read a UTF-8 text file and return its contents (clipped if very large).',
  inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the file' } }, required: ['path'] },
  pathArg: (i) => i.path,
  async run(i) {
    const data = fs.readFileSync(i.path, 'utf8');
    const clipped = data.length > MAX_READ ? data.slice(0, MAX_READ) + `\n…[clipped ${data.length - MAX_READ} chars]` : data;
    return { content: clipped };
  },
};

export const writeFile: Tool = {
  name: 'write_file',
  scope: 'write',
  description: 'Create or overwrite a file with the given content. Creates parent directories.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  pathArg: (i) => i.path,
  async run(i) {
    fs.mkdirSync(path.dirname(i.path), { recursive: true });
    fs.writeFileSync(i.path, String(i.content ?? ''), 'utf8');
    return { content: `wrote ${Buffer.byteLength(String(i.content ?? ''), 'utf8')} bytes to ${i.path}` };
  },
};

export const editFile: Tool = {
  name: 'edit_file',
  scope: 'edit',
  description: 'Replace the first exact occurrence of old_string with new_string in a file. Fails if old_string is absent or not unique.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
    required: ['path', 'old_string', 'new_string'],
  },
  pathArg: (i) => i.path,
  async run(i) {
    const data = fs.readFileSync(i.path, 'utf8');
    const first = data.indexOf(i.old_string);
    if (first === -1) return { content: `old_string not found in ${i.path}`, isError: true };
    if (data.indexOf(i.old_string, first + 1) !== -1) return { content: `old_string is not unique in ${i.path}`, isError: true };
    fs.writeFileSync(i.path, data.slice(0, first) + i.new_string + data.slice(first + i.old_string.length), 'utf8');
    return { content: `edited ${i.path}` };
  },
};

export const listDir: Tool = {
  name: 'list_dir',
  scope: 'read',
  description: 'List the entries of a directory (names, with a trailing / for subdirectories).',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  pathArg: (i) => i.path,
  async run(i) {
    const entries = fs.readdirSync(i.path, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? e.name + '/' : e.name)).sort();
    return { content: entries.join('\n') || '(empty)' };
  },
};

export const fsTools: Tool[] = [readFile, writeFile, editFile, listDir];
