import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const VERSION = 1;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
}

function signaturesFor(buttons) {
  if (!Array.isArray(buttons)) throw new TypeError('Buttons must be an array.');
  return buttons.map((button, index) => {
    if (!isRecord(button)) throw new TypeError(`Button ${index} must be an object.`);
    requireText(button.signature, `Button ${index} signature`);
    if (button.kind !== undefined && button.kind !== 'button') {
      throw new TypeError(`Button ${index} kind must be button.`);
    }
    return button.signature;
  });
}

function validateDocument(document) {
  if (!isRecord(document)) throw new Error('Invalid knowledge file: expected a JSON object.');
  if (document.version !== VERSION) throw new Error('Unsupported knowledge file version.');
  if (!Array.isArray(document.entries)) throw new Error('Invalid knowledge file: entries must be an array.');
  if (Object.keys(document).some((key) => !['version', 'entries'].includes(key))) {
    throw new Error('Invalid knowledge file: unexpected fields.');
  }
  for (const [index, entry] of document.entries.entries()) {
    if (!isRecord(entry)) throw new Error(`Invalid knowledge entry ${index}: expected an object.`);
    requireText(entry.scope, `Knowledge entry ${index} scope`);
    requireText(entry.signature, `Knowledge entry ${index} signature`);
    if (entry.kind !== 'button') throw new Error(`Invalid knowledge entry ${index}: kind must be button.`);
    if (Object.keys(entry).some((key) => !['scope', 'signature', 'kind'].includes(key))) {
      throw new Error(`Invalid knowledge entry ${index}: unexpected fields.`);
    }
  }
}

/** Stable URL identity without credentials, query parameters or fragment state. */
export function scopeForUrl(value) {
  requireText(value, 'URL');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Cannot create a scope from an invalid URL.');
  }
  if (url.protocol === 'file:') return `file://${url.host}${url.pathname}`;
  if (url.protocol === 'about:') return `about:${url.pathname}`;
  // Opaque URLs can contain full documents or code. Their caller supplies frame context.
  if (url.protocol === 'data:' || url.protocol === 'javascript:') return url.protocol;
  if (url.protocol === 'blob:') return `blob:${url.origin}`;
  return url.origin === 'null' ? url.protocol : `${url.origin}${url.pathname}`;
}

/** Confirmed button signatures. Calling learn is the explicit confirmation step. */
export class KnowledgeStore {
  #path;
  #scopes = new Map();
  #pendingSave = Promise.resolve();

  constructor(path) {
    requireText(path, 'Knowledge file path');
    this.#path = resolve(path);
  }

  static async open(path) {
    const store = new KnowledgeStore(path);
    let source;
    try {
      source = await readFile(store.#path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return store;
      throw error;
    }
    let document;
    try {
      document = JSON.parse(source);
    } catch {
      throw new Error('Invalid knowledge JSON. The existing file has not been changed.');
    }
    validateDocument(document);
    for (const entry of document.entries) store.learn([entry], entry.scope);
    return store;
  }

  partition(buttons, scope) {
    requireText(scope, 'Scope');
    const signatures = signaturesFor(buttons);
    const confirmed = this.#scopes.get(scope);
    const result = { known: [], unknown: [] };
    buttons.forEach((button, index) => {
      result[confirmed?.has(signatures[index]) ? 'known' : 'unknown'].push(button);
    });
    return result;
  }

  learn(buttons, scope) {
    requireText(scope, 'Scope');
    // Validate the entire batch before changing state, so malformed imports are all-or-nothing.
    const signatures = signaturesFor(buttons);
    if (!signatures.length) return 0;
    let confirmed = this.#scopes.get(scope);
    if (!confirmed) {
      confirmed = new Set();
      this.#scopes.set(scope, confirmed);
    }
    const previousSize = confirmed.size;
    for (const signature of signatures) confirmed.add(signature);
    return confirmed.size - previousSize;
  }

  async save() {
    const entries = [];
    for (const scope of [...this.#scopes.keys()].sort()) {
      for (const signature of [...this.#scopes.get(scope)].sort()) {
        entries.push({ scope, signature, kind: 'button' });
      }
    }
    const source = `${JSON.stringify({ version: VERSION, entries }, null, 2)}\n`;
    const operation = this.#pendingSave.then(async () => {
      const directory = dirname(this.#path);
      const temporaryPath = resolve(directory, `.${basename(this.#path)}.${randomUUID()}.tmp`);
      await mkdir(directory, { recursive: true });
      try {
        await writeFile(temporaryPath, source, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temporaryPath, this.#path);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => {});
      }
    });
    // Keep later saves usable after an I/O failure while returning this failure to its caller.
    this.#pendingSave = operation.catch(() => {});
    await operation;
  }
}
