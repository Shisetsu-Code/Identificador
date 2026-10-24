import { readFile } from 'node:fs/promises';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDocument(entry) {
  const type = entry._resourceType;
  const mime = entry.response.content?.mimeType;
  return (typeof type === 'string' && type.toLowerCase() === 'document')
    || (typeof mime === 'string' && /^(text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(mime));
}

function documentPriority(url, status) {
  const path = url.pathname;
  let priority = status >= 200 && status < 300 ? 1000 : 0;
  if (/\/gs2c\/html5Game(?:\.do)?(?:\/|$)/i.test(path)) priority += 500;
  else if (/\/gs2c\/openGame(?:\.do)?(?:\/|$)/i.test(path)) priority += 400;
  else if (/\/gs2c(?:\/|$)/i.test(path)) priority += 300;
  else if (/(?:^|\/)(?:launcher|launch|openGame|play)(?:[./]|$)/i.test(path)) priority += 200;
  return priority;
}

/**
 * Read replay metadata without returning headers, bodies or URL query parameters in summary.
 * entryUrl intentionally retains the exact captured URL for local routeFromHAR navigation.
 */
export async function readHar(path) {
  const source = await readFile(path, 'utf8');
  let har;
  try {
    har = JSON.parse(source);
  } catch {
    throw new Error('Invalid HAR JSON. The input file has not been changed.');
  }
  if (!isRecord(har) || !isRecord(har.log) || !Array.isArray(har.log.entries)) {
    throw new Error('Invalid HAR: log.entries must be an array.');
  }

  const hosts = new Map();
  const paths = new Map();
  let documents = 0;
  let selected = null;

  for (const [index, entry] of har.log.entries.entries()) {
    if (!isRecord(entry) || !isRecord(entry.request) || !isRecord(entry.response)) {
      throw new Error(`Invalid HAR entry ${index}: request and response objects are required.`);
    }
    const { request, response } = entry;
    if (typeof request.url !== 'string' || typeof request.method !== 'string' || !request.method.trim()) {
      throw new Error(`Invalid HAR entry ${index}: request URL and method are required.`);
    }
    if (!Number.isInteger(response.status) || response.status < 0 || response.status > 599) {
      throw new Error(`Invalid HAR entry ${index}: response status must be an HTTP status or zero.`);
    }
    if (response.content !== undefined && !isRecord(response.content)) {
      throw new Error(`Invalid HAR entry ${index}: response content must be an object.`);
    }
    let url;
    try {
      url = new URL(request.url);
    } catch {
      throw new Error(`Invalid HAR entry ${index}: request URL is invalid.`);
    }
    // Opaque URL paths can contain bodies. Only network URLs belong in the safe summary.
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) continue;

    hosts.set(url.host, (hosts.get(url.host) ?? 0) + 1);
    let hostPaths = paths.get(url.host);
    if (!hostPaths) {
      hostPaths = new Map();
      paths.set(url.host, hostPaths);
    }
    hostPaths.set(url.pathname, (hostPaths.get(url.pathname) ?? 0) + 1);

    if (!isDocument(entry) || !['http:', 'https:'].includes(url.protocol)) continue;
    documents += 1;
    if (request.method.toUpperCase() !== 'GET' || response.status < 200 || response.status >= 400) continue;
    const priority = documentPriority(url, response.status);
    if (!selected || priority > selected.priority) {
      selected = { entryUrl: request.url, host: url.host, path: url.pathname, priority };
    }
  }

  if (!selected) throw new Error('HAR does not contain a usable HTTP(S) document to replay.');

  const hostSummary = [];
  const pathSummary = [];
  for (const host of [...hosts.keys()].sort()) {
    hostSummary.push({ host, requests: hosts.get(host) });
    for (const path of [...paths.get(host).keys()].sort()) {
      pathSummary.push({ host, path, requests: paths.get(host).get(path) });
    }
  }
  return {
    entryUrl: selected.entryUrl,
    summary: {
      entries: har.log.entries.length,
      documents,
      entry: { host: selected.host, path: selected.path },
      hosts: hostSummary,
      paths: pathSummary,
    },
  };
}
