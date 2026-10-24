/* Inject before page scripts. Observes controls; never dispatches input. */
(() => {
  'use strict';
  if (globalThis.__identificador?.version === 1) return;
  const adapters = globalThis.__identificadorAdapters ||= [];
  const activationEvents = new Set(['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend']);
  const listeners = new WeakMap();
  const observed = new Set();
  const registered = new WeakSet();
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  let stopped = false, overlayEnabled = true, host, shadow;
  let last = { version: 1, viewport: {}, buttons: [], coverage: {} };
  let known = new Set();
  let pendingOnce = 0;
  const ids = new Map();

  function restoreListenersWhenSafe() {
    if (!stopped || pendingOnce > 0) return;
    if (EventTarget.prototype.addEventListener === trackedAdd) EventTarget.prototype.addEventListener = add;
    if (EventTarget.prototype.removeEventListener === trackedRemove) EventTarget.prototype.removeEventListener = remove;
  }
  function captureOption(options) { return typeof options === 'boolean' ? options : !!options?.capture; }
  function trackedAdd(type, callback, options) {
    if (!activationEvents.has(type) || this.nodeType !== 1 || !callback || !['function','object'].includes(typeof callback)) return add.call(this, type, callback, options);
    const records = listeners.get(this) || [];
    const capture = captureOption(options);
    const existing = records.find(r => r.type === type && r.callback === callback && r.capture === capture);
    if (existing) return add.call(this, type, existing.wrapped, options);
    if (stopped) return add.call(this, type, callback, options);
    const record = { type, callback, capture, signal: options?.signal, wrapped: callback, active: false, once: !!options?.once };
    record.cleanup = () => {
      if (!record.active) return;
      record.active = false;
      const i = records.indexOf(record); if (i >= 0) records.splice(i, 1);
      if (record.once) pendingOnce--;
      record.signal?.removeEventListener('abort', record.cleanup);
      restoreListenersWhenSafe();
    };
    if (options?.once) {
      record.wrapped = function (event) {
        record.cleanup();
        return typeof callback === 'function' ? callback.call(this, event) : callback.handleEvent(event);
      };
    }
    // Call the native API first so invalid listeners/options retain native errors.
    const result = add.call(this, type, record.wrapped, options);
    if (!record.signal?.aborted) {
      record.active = true; if (record.once) pendingOnce++;
      records.push(record); listeners.set(this, records);
      if (record.signal) add.call(record.signal, 'abort', record.cleanup, { once: true });
      if (!registered.has(this)) { observed.add(new WeakRef(this)); registered.add(this); }
    }
    return result;
  }
  function trackedRemove(type, callback, options) {
    const records = listeners.get(this), capture = captureOption(options);
    const record = records?.find(r => r.type === type && r.callback === callback && r.capture === capture);
    const result = remove.call(this, type, record?.wrapped || callback, options);
    if (record) record.cleanup();
    return result;
  }
  EventTarget.prototype.addEventListener = trackedAdd;
  EventTarget.prototype.removeEventListener = trackedRemove;

  // Two independent 32-bit hashes keep DOM paths and displayed text out of exports.
  function fingerprint(value) {
    let a = 2166136261, b = 3335557771;
    for (let i = 0; i < value.length; i++) {
      a = Math.imul(a ^ value.charCodeAt(i), 16777619);
      b = Math.imul(b ^ value.charCodeAt(i), 2246822519);
    }
    return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
  }
  function pathFor(el) {
    const parts = [];
    for (let n = el, depth = 0; n?.nodeType === 1 && depth < 24; n = n.parentElement, depth++) {
      const siblings = n.parentElement ? Array.from(n.parentElement.children).filter(x => x.tagName === n.tagName && x !== host) : [n];
      parts.unshift(`${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}:${siblings.indexOf(n)}`);
      if (!n.parentElement && n.getRootNode()?.host) { parts.unshift(pathFor(n.getRootNode().host), 'shadow'); }
    }
    return parts.join('/');
  }
  function clipBox(input, width, height) {
    if (!input || !['x','y','width','height'].every(k => Number.isFinite(input[k])) || input.width <= 0 || input.height <= 0) return null;
    const x = Math.max(0, input.x), y = Math.max(0, input.y);
    const right = Math.min(width, input.x + input.width), bottom = Math.min(height, input.y + input.height);
    if (right - x < 3 || bottom - y < 3) return null;
    return { x, y, width: right - x, height: bottom - y };
  }
  function visible(el) {
    if (!el.isConnected || el.closest('[inert], [hidden], [aria-hidden="true"], [aria-disabled="true"]') || el.matches(':disabled')) return false;
    for (let n = el; n; n = n.parentElement || n.getRootNode()?.host) {
      if (n.matches('[inert], [hidden], [aria-hidden="true"], [aria-disabled="true"]')) return false;
      const style = getComputedStyle(n);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
    }
    return getComputedStyle(el).pointerEvents !== 'none';
  }
  function exposed(el, r) {
    // Walk into open shadow roots after hit-testing the outer document, so an
    // unrelated DOM overlay above a shadow host still hides its controls.
    for (const [fx, fy] of [[.5,.5],[.15,.15],[.85,.15],[.15,.85],[.85,.85]]) {
      const x = r.x + r.width * fx, y = r.y + r.height * fy;
      let hit = document.elementFromPoint(x, y);
      const seen = new Set();
      while (hit?.shadowRoot && !seen.has(hit)) {
        seen.add(hit);
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      if (hit && (hit === el || el.contains(hit))) return true;
    }
    return false;
  }
  function domControls(width, height) {
    const candidates = new Map();
    const selector = 'button,input[type="button"],input[type="submit"],input[type="reset"],input[type="image"],a[href],summary,[role="button"],[role="menuitem"],[role="tab"],[onclick]';
    function collect(root) {
      for (const el of root.querySelectorAll(selector)) if (el !== host && !host?.contains(el)) candidates.set(el, ['dom-control']);
      // Open shadow roots have their own hit-testing and geometry.
      for (const el of root.querySelectorAll('*')) {
        if (el === host) continue;
        const properties = [...activationEvents].filter(event => typeof el['on'+event] === 'function');
        if (properties.length) candidates.set(el, properties.map(event => `handler:${event}`));
        if (el.shadowRoot) collect(el.shadowRoot);
      }
    }
    collect(document);
    for (const ref of observed) {
      const el = ref.deref();
      if (!el) { observed.delete(ref); continue; }
      const events = (listeners.get(el) || []).filter(r => !r.signal?.aborted).map(r => r.type);
      if (events.length && el !== host && !host?.contains(el)) candidates.set(el, [...new Set(events)].sort().map(e => `listener:${e}`));
    }
    const valid = [];
    for (const [el, evidence] of candidates) {
      if (!visible(el)) continue;
      const box = clipBox(el.getBoundingClientRect(), width, height);
      if (!box || !exposed(el, box)) continue;
      // Do not turn global delegated listeners into a whole-page button.
      if (['HTML','BODY','CANVAS'].includes(el.tagName)) continue;
      valid.push({ el, box, evidence });
    }
    return valid.filter(v => !valid.some(p => p !== v && p.el.contains(v.el) && p.el.matches('button,a[href],[role="button"]')))
      .filter(v => !valid.some(c => c !== v && v.el.contains(c.el) && !v.el.matches('button,a[href],[role="button"]')))
      .map(({el,box,evidence}) => ({
        key: pathFor(el) + '|' + [el.getAttribute('role'),el.getAttribute('type'),el.getAttribute('aria-label'),el.textContent?.replace(/\s+/g,' ').trim().slice(0,160)].join('|'),
        source: 'dom', box, confidence: .98, evidence
      }));
  }
  function ensureOverlay() {
    if (host?.isConnected) return;
    if (!document.documentElement) return;
    host = document.createElement('div'); host.setAttribute('data-identificador-overlay','');
    host.style.cssText = 'position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;overflow:hidden!important;contain:strict!important;';
    shadow = host.attachShadow({mode:'open'});
    document.documentElement.appendChild(host);
  }
  function draw() {
    if (!overlayEnabled || stopped) { host?.remove(); return; }
    ensureOverlay(); if (!shadow) return;
    shadow.replaceChildren();
    for (const button of last.buttons) {
      const el = document.createElement('div'), isKnown = known.has(button.signature);
      el.setAttribute('data-identificador-id',button.id); el.setAttribute('data-known',String(isKnown));
      const {x,y,width,height} = button.box;
      const color = isKnown ? '#3bffc2' : '#ffc957';
      el.style.cssText = `box-sizing:border-box;position:absolute;left:${x}px;top:${y}px;width:${width}px;height:${height}px;border:2px solid ${color};border-radius:5px;background:${isKnown ? '#3bffc20b' : '#ffc9570b'};pointer-events:none;`;
      const badge = document.createElement('span'); badge.textContent=button.id;
      badge.style.cssText = `position:absolute;left:0;top:0;transform:translateY(-100%);font:700 11px/17px ui-monospace,monospace;letter-spacing:0.3px;background:${color};color:#09131e;border-radius:3px 3px 0 0;padding:0 4px;white-space:nowrap;pointer-events:none;`;
      if(y<20) badge.style.transform='none';
      el.appendChild(badge); shadow.appendChild(el);
    }
  }
  function scan() {
    if (stopped) return last;
    const width=innerWidth, height=innerHeight;
    const raw=domControls(width,height), warnings=[], engines=[];
    for (const adapter of adapters) {
      try {
        const result=adapter.scan();
        if (result?.available) engines.push(adapter.name);
        for (const b of result?.buttons || []) raw.push({...b,source:adapter.name});
        for (const warning of result?.warnings || []) warnings.push(`${adapter.name}: ${warning}`);
      } catch { warnings.push(`${adapter.name}: inspection failed`); }
    }
    const signatures=new Set(), buttons=[];
    for (const control of raw) {
      const box=clipBox(control.box,width,height);
      if (!box || typeof control.key!=='string') continue;
      const signature=`v1:${control.source}:${fingerprint(control.source+'|'+control.key)}`;
      if(signatures.has(signature)) continue; signatures.add(signature);
      if(!ids.has(signature)) ids.set(signature,`B${String(ids.size+1).padStart(3,'0')}`);
      buttons.push({id:ids.get(signature),signature,kind:'button',source:control.source,box,
        normalized:{x:box.x/width,y:box.y/height,width:box.width/width,height:box.height/height},
        confidence:Math.max(0,Math.min(1,Number(control.confidence)||0)),evidence:control.evidence||[]});
    }
    const canvases=document.querySelectorAll('canvas').length;
    if(canvases && !engines.length) warnings.push('Canvas sin adaptador accesible: no se pueden inferir sus botones internos.');
    last={version:1,viewport:{width,height},buttons,coverage:{dom:true,canvases,engines,warnings}};
    draw(); return last;
  }
  globalThis.__identificador={version:1,scan,
    setOverlay(value){overlayEnabled=!!value;draw();},
    setKnown(signatures){known=new Set(signatures);draw();},
    destroy(){stopped=true;clearInterval(timer);host?.remove();restoreListenersWhenSafe();}
  };
  const timer=setInterval(scan,500);
  add.call(document,'DOMContentLoaded',()=>scan(),{once:true});
  if(document.readyState!=='loading') scan();
})();
