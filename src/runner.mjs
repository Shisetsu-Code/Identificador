import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { KnowledgeStore, scopeForUrl } from './knowledge.mjs';
import { readHar } from './har.mjs';
import { visibleFrameButtons } from './frame-visibility.mjs';

const version = 1;
const detectorFiles = ['browser/uht-adapter.js', 'browser/inspector.js'];
const pageIdentities = new WeakMap();

async function detectorSource() {
  const parts = await Promise.all(detectorFiles.map(file => readFile(new URL(file, import.meta.url), 'utf8')));
  return parts.join('\n;\n');
}

function emptySnapshot() {
  return { version, capturedAt: new Date().toISOString(), frames: [], totals: { frames: 0, buttons: 0, known: 0, unknown: 0 } };
}

function summarize(frames) {
  return frames.reduce((total, frame) => ({
    frames: total.frames + 1,
    buttons: total.buttons + frame.buttons.length,
    known: total.known + frame.known.length,
    unknown: total.unknown + frame.unknown.length,
  }), { frames: 0, buttons: 0, known: 0, unknown: 0 });
}

function frameIdentities(page) {
  if (pageIdentities.has(page)) return pageIdentities.get(page);
  const identities = new WeakMap([[page.mainFrame(), '0']]);
  const nextChild = new WeakMap();
  function id(frame) {
    if (identities.has(frame)) return identities.get(frame);
    const parent = frame.parentFrame();
    if (!parent) return '0';
    const parentId = id(parent);
    const childIndex = nextChild.get(parent) || 0;
    nextChild.set(parent, childIndex + 1);
    const value = `${parentId}.${childIndex}`;
    identities.set(frame, value);
    return value;
  }
  pageIdentities.set(page, id);
  return id;
}

function safeUrl(value) {
  try { return scopeForUrl(value || 'about:blank'); }
  catch { return 'unavailable:'; }
}

async function gameForFrame(frame) {
  // Read only a constrained game identifier, never a config object or request payload.
  const fromRuntime = await frame.evaluate(() => {
    try {
      const configured = globalThis.UHT_CONFIG?.GAME_URL;
      if (typeof configured !== 'string' || !configured) return null;
      const path = new URL(configured, location.href).pathname;
      return path.match(/\/games\/([A-Za-z][A-Za-z0-9_-]{0,63})(?:\/|$)/)?.[1] || null;
    } catch { return null; }
  }).catch(() => null);
  if (fromRuntime) return fromRuntime;
  try {
    const query = new URL(frame.url()).searchParams;
    for (const key of ['symbol', 'gameSymbol']) {
      const value = query.get(key);
      if (value && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) return value;
    }
  } catch { /* Opaque or transient frame URLs carry no safe game identity. */ }
  return null;
}

function scopeOf(frame, id, explicitScope, games) {
  const game = games.get(frame);
  const url = `${safeUrl(frame.url())}${game ? `::game=${game}` : ''}`;
  const parent = frame.parentFrame();
  if (!parent) return explicitScope || url;
  return `${scopeOf(parent, id, explicitScope, games)}::frame=${id(frame)}::url=${url}`;
}

/** Observe without dispatching any input. Coordinates remain local to each frame. */
export async function observePage(page, store, options = {}) {
  if (page.isClosed()) return emptySnapshot();
  const source = options.detectorSource || await detectorSource();
  try { await page.addInitScript({ content: source }); }
  catch (error) { if (page.isClosed()) return emptySnapshot(); throw error; }
  const id = frameIdentities(page);
  const intervalMs = options.intervalMs ?? 500;
  const durationMs = options.seconds === undefined ? Infinity : options.seconds * 1000;
  const deadline = Date.now() + durationMs;
  let snapshot = emptySnapshot();
  let stopped = page.isClosed() || options.signal?.aborted;
  let wake = () => {};
  const stop = () => { stopped = true; wake(); };
  page.on('close', stop);
  options.signal?.addEventListener('abort', stop, { once: true });

  try {
    while (!stopped) {
      const activeFrames = page.frames();
      // Assign paths before concurrent evaluations so sibling identity is deterministic.
      for (const frame of activeFrames) id(frame);
      const games = new Map(await Promise.all(activeFrames.map(async frame => [frame, await gameForFrame(frame)])));
      const frames = await Promise.all(activeFrames.map(async frame => {
        if (frame.isDetached()) return null;
        const metadata = {
          id: id(frame), url: safeUrl(frame.url()), scope: scopeOf(frame, id, options.scope, games),
        };
        try {
          let scan = await frame.evaluate(() => globalThis.__identificador?.scan() || null);
          if (!scan) {
            await frame.evaluate(source);
            scan = await frame.evaluate(() => globalThis.__identificador.scan());
          }
          const buttons = await visibleFrameButtons(frame, scan.buttons || [], scan.viewport);
          const partition = store.partition(buttons, metadata.scope);
          await frame.evaluate(({ known, overlay }) => {
            globalThis.__identificador.setKnown(known);
            globalThis.__identificador.setOverlay(overlay);
          }, { known: partition.known.map(button => button.signature), overlay: options.overlay !== false });
          const coverage = { ...scan.coverage, warnings: [...(scan.coverage?.warnings || [])] };
          if (!options.scope && !games.get(frame) && /\/(?:html5Game|openGame)\.do$/i.test(metadata.url)) {
            coverage.warnings.push('Este launcher comparte ruta entre juegos y no expone un identificador seguro; usa --scope para separar su memoria.');
          }
          return { ...metadata, viewport: scan.viewport, buttons, ...partition, coverage };
        } catch {
          if (frame.isDetached() || page.isClosed()) return null;
          return { ...metadata, viewport: null, buttons: [], known: [], unknown: [],
            coverage: { warnings: ['No se pudo inspeccionar este frame durante la captura; puede estar navegando.'] } };
        }
      }));
      // Closing the window while an evaluation is in flight must not erase the last result.
      if (page.isClosed()) break;
      const present = frames.filter(Boolean);
      snapshot = { version, capturedAt: new Date().toISOString(), frames: present, totals: summarize(present) };
      await options.onSnapshot?.(snapshot);
      if (stopped || Date.now() >= deadline) break;
      await new Promise(resolveWait => {
        const timer = setTimeout(finish, Math.min(intervalMs, Math.max(0, deadline - Date.now())));
        function finish() { clearTimeout(timer); wake = () => {}; resolveWait(); }
        wake = finish;
        if (stopped) finish();
      });
    }
    return snapshot;
  } finally {
    page.off('close', stop);
    options.signal?.removeEventListener('abort', stop);
  }
}

function unknownOnly(snapshot) {
  return {
    version: snapshot.version, capturedAt: snapshot.capturedAt,
    frames: snapshot.frames.filter(frame => frame.unknown.length).map(frame => ({
      id: frame.id, url: frame.url, scope: frame.scope, viewport: frame.viewport,
      buttons: frame.unknown, coverage: frame.coverage,
    })),
    totals: { buttons: snapshot.totals.unknown },
    ...(snapshot.warnings?.length ? { warnings: snapshot.warnings } : {}),
  };
}

async function importKnowledge(file, store, fallbackScope) {
  let value;
  try { value = JSON.parse(await readFile(resolve(file), 'utf8')); }
  catch { throw new Error('No se pudo leer --learn: usa una ruta a un archivo JSON válido.'); }

  const groups = [];
  if (Array.isArray(value?.frames)) {
    for (const frame of value.frames) groups.push({ scope: frame.scope, buttons: frame.buttons || frame.unknown });
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (Array.isArray(item?.buttons)) groups.push({ scope: item.scope || fallbackScope, buttons: item.buttons });
      else groups.push({ scope: item?.scope || fallbackScope, buttons: [typeof item === 'string' ? { signature: item, kind: 'button' } : item] });
    }
  } else if (value && Array.isArray(value.buttons)) {
    groups.push({ scope: value.scope || fallbackScope, buttons: value.buttons });
  } else {
    throw new Error('--learn requiere una exportación con frames o una lista de botones con scope.');
  }
  // Validate the complete import before modifying the store, including empty groups.
  for (const group of groups) {
    if (typeof group.scope !== 'string' || !group.scope.trim()) {
      throw new Error('Cada grupo de --learn necesita un scope explícito; conserva el contexto de la exportación o usa --scope para una lista.');
    }
    if (!Array.isArray(group.buttons) || group.buttons.some(button => !button || typeof button.signature !== 'string' || !button.signature.trim())) {
      throw new Error('--learn contiene botones sin una firma válida.');
    }
  }
  let learned = 0;
  for (const { scope, buttons } of groups) {
    learned += store.learn(buttons, scope);
  }
  await store.save();
  return learned;
}

function validateOptions(options) {
  if ([options.url, options.har, options.demo].filter(Boolean).length > 1) {
    throw new Error('Elige un solo origen: --url, --har o --demo.');
  }
  if (options.seconds !== undefined && (!Number.isFinite(options.seconds) || options.seconds <= 0)) {
    throw new Error('--seconds debe ser un número mayor que cero.');
  }
  if (options.scope !== undefined && (typeof options.scope !== 'string' || !options.scope.trim())) {
    throw new Error('--scope necesita un nombre de contexto no vacío.');
  }
  if (options.url) {
    let url;
    try { url = new URL(options.url); }
    catch { throw new Error('--url necesita una URL HTTP o HTTPS válida.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--url solo admite HTTP o HTTPS; usa --demo para el ejemplo local.');
    if (url.username || url.password) throw new Error('No incluyas credenciales en --url; abre una sesión desde el navegador.');
  }
}

async function navigate(page, url, signal) {
  if (signal?.aborted) return;
  let onAbort;
  const interrupted = new Promise(resolveAbort => {
    onAbort = resolveAbort;
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }), interrupted]);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Run a local observation or import confirmed signatures. No model calls or game clicks. */
export async function run(options = {}) {
  validateOptions(options);
  const output = resolve(options.output || 'output');
  try { await mkdir(output, { recursive: true }); }
  catch { throw new Error('No se pudo crear --output; revisa la ruta y sus permisos.'); }
  const knowledgePath = resolve(options.knowledgePath || join(output, 'knowledge.json'));
  let store;
  try { store = await KnowledgeStore.open(knowledgePath); }
  catch { throw new Error('No se pudo abrir la memoria de botones; revisa knowledge.json antes de continuar.'); }
  const learned = options.learn ? await importKnowledge(options.learn, store, options.scope) : 0;
  if (options.learn && !options.url && !options.har && !options.demo) return { learned, files: { knowledge: knowledgePath } };

  let targetUrl = options.url || new URL('../examples/demo.html', import.meta.url).href;
  let harInfo;
  if (options.har) {
    try { harInfo = await readHar(resolve(options.har)); targetUrl = harInfo.entryUrl; }
    catch { throw new Error('No se pudo abrir el HAR o encontrar su documento de entrada; revisa el archivo y sus respuestas HTML.'); }
  }
  let source;
  try { source = await detectorSource(); }
  catch { throw new Error('No se pudieron cargar los scripts del inspector; revisa la instalación de Identificador.'); }
  let browser;
  try {
    browser = await chromium.launch({
      headless: Boolean(options.headless),
      executablePath: options.executablePath || process.env.IDENTIFICADOR_BROWSER_PATH || undefined,
    });
  } catch {
    throw new Error('No se pudo iniciar Chromium. Instálalo con "npx playwright install chromium" o usa --executable-path; para un entorno sin pantalla, añade --headless.');
  }
  const warnings = [];
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
    let failedRequests = 0;
    if (options.har) context.on('requestfailed', () => { failedRequests++; });
    await context.addInitScript({ content: source });
    if (options.har) {
      try {
        await context.routeFromHAR(resolve(options.har), { notFound: 'abort' });
        await context.routeWebSocket('**/*', socket => socket.close({ code: 1000, reason: 'Offline HAR replay' }));
      } catch { throw new Error('El HAR no se pudo preparar para reproducción offline; no se habilitó acceso a la red.'); }
    }
    let page = await context.newPage();
    const entryPage = page;
    let change;
    context.on('page', opened => { page = opened; change?.abort(); });
    try { await navigate(entryPage, targetUrl, options.signal); }
    catch (error) {
      if (error.name === 'TimeoutError') {
        warnings.push('La carga inicial no terminó en 30 segundos; se observa el contenido disponible.');
      } else if (!entryPage.isClosed()) {
        const networkCode = String(error.message).match(/net::(ERR_[A-Z_]+)/)?.[1];
        throw new Error(options.har
          ? 'No se pudo cargar el documento del HAR offline; puede faltar contenido o una redirección capturada.'
          : `No se pudo abrir la página${networkCode ? ` (${networkCode})` : ''}; revisa la dirección y la conexión.`);
      }
    }
    let snapshot = emptySnapshot();
    let capturedPage = page;
    const duration = options.seconds ?? (options.headless ? 5 : undefined);
    const deadline = duration === undefined ? Infinity : Date.now() + duration * 1000;
    while (!options.signal?.aborted && Date.now() < deadline) {
      if (page.isClosed()) {
        const remaining = context.pages().filter(candidate => !candidate.isClosed());
        if (!remaining.length) break;
        page = remaining.at(-1);
      }
      const observed = page;
      change = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, change.signal]) : change.signal;
      const current = await observePage(observed, store, {
        ...options, signal, detectorSource: source,
        seconds: deadline === Infinity ? undefined : Math.max(0.001, (deadline - Date.now()) / 1000),
      });
      if (current.frames.length) { snapshot = current; capturedPage = observed; }
      if (page !== observed || observed.isClosed()) continue;
      break;
    }
    if (options.remember) {
      for (const frame of snapshot.frames) store.learn(frame.buttons, frame.scope);
      await store.save();
      const frames = snapshot.frames.map(frame => ({ ...frame, ...store.partition(frame.buttons, frame.scope) }));
      snapshot = { ...snapshot, frames, totals: summarize(frames) };
      if (!capturedPage.isClosed()) {
        const byId = frameIdentities(capturedPage);
        for (const frame of capturedPage.frames()) {
          const saved = snapshot.frames.find(item => item.id === byId(frame));
          if (saved) await frame.evaluate(signatures => globalThis.__identificador?.setKnown(signatures), saved.known.map(button => button.signature)).catch(() => {});
        }
      }
    }
    if (options.har && failedRequests) warnings.push(`HAR offline: ${failedRequests} solicitudes no pudieron reproducirse. Pueden faltar scripts o recursos necesarios del juego.`);
    if (!snapshot.totals.buttons) warnings.push('No se detectaron botones en la última captura; esto no confirma que la página carezca de controles. Revisa la cobertura y espera a que cargue el juego.');
    if (options.har && !snapshot.totals.buttons) warnings.push('El HAR puede estar incompleto: comprueba que incluya el motor y los recursos del juego, o usa --url para observarlo cargado.');
    for (const frame of snapshot.frames) {
      for (const warning of frame.coverage?.warnings || []) if (!warnings.includes(warning)) warnings.push(warning);
    }
    if (warnings.length) snapshot = { ...snapshot, warnings };
    const unknown = unknownOnly(snapshot);
    const files = { all: join(output, 'all.json'), unknown: join(output, 'unknown.json'), knowledge: knowledgePath };
    try {
      await Promise.all([
        writeFile(files.all, `${JSON.stringify(snapshot, null, 2)}\n`),
        writeFile(files.unknown, `${JSON.stringify(unknown)}\n`),
      ]);
    } catch { throw new Error('No se pudieron guardar las capturas JSON; revisa el espacio y los permisos de --output.'); }
    if (options.screenshot !== false && !capturedPage.isClosed()) {
      try {
        files.screenshot = join(output, 'overlay.png');
        await capturedPage.screenshot({ path: files.screenshot, timeout: 10_000 });
      } catch {
        delete files.screenshot;
        warnings.push('No se pudo guardar la captura de pantalla; se conservaron los JSON.');
      }
    }
    return { snapshot, unknown, files, learned, warnings, ...(harInfo ? { har: harInfo.summary } : {}) };
  } finally {
    await browser.close().catch(() => {});
  }
}
