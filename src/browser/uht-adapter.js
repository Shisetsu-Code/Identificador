/* Read-only adapter for the UHT scene graph used by some Pragmatic Play games.
 * API contracts were observed in a user-supplied HAR; no vendor source/assets
 * are bundled here. World coordinates are projected by the game's camera.
 */
(() => {
  'use strict';
  const global = globalThis;
  const nonControls = ['SoundPlayer', 'ScrollableList', 'ScrollableListThumb', 'UIScrollContent_HB'];

  function isType(component, name) {
    return typeof global[name] === 'function' && component instanceof global[name];
  }

  function active(go) {
    return go && go.activeInHierarchy === true && go.activeSelf !== false;
  }

  function visibleHierarchy(go) {
    const seen = new Set();
    for (let transform = go.transform; transform; transform = transform.parent) {
      if (seen.has(transform)) return false;
      seen.add(transform);
      const owner = transform.gameObject;
      if (!active(owner)) return false;
      for (const component of owner.components || []) {
        if (isType(component, 'UIPanel') &&
            (component.enabled === false || Number(component.alpha) <= 0.01)) return false;
      }
    }
    return true;
  }

  function hasResponder(go) {
    return (go.components || []).some((component) => component.enabled !== false &&
      !nonControls.some((name) => isType(component, name)) &&
      (typeof component.OnClick === 'function' || typeof component.OnPress === 'function'));
  }

  function visualState(go) {
    const state = { found: false, visible: false };
    const seen = new Set();
    function visit(transform) {
      if (!transform || seen.has(transform)) return;
      seen.add(transform);
      const owner = transform.gameObject;
      const components = owner?.components || [];
      // A nested control's artwork is not evidence for its parent's hit area.
      if (owner !== go && components.some((item) => isType(item, 'Collider'))) return;
      for (const widget of components) {
        const sprite = isType(widget, 'UISprite');
        if (!sprite && !isType(widget, 'UILabel')) continue;
        state.found = true;
        const content = sprite ? widget.spriteName : (widget._text ?? widget.text);
        const rendered = widget.pixiObjectContent;
        if (widget.enabled !== false && active(owner) && visibleHierarchy(owner) && content &&
            !(widget.width <= 0 || widget.height <= 0 || widget.color?.a <= 0.01 ||
              widget.panel?.alpha <= 0.01 || rendered?.worldAlpha <= 0.01 || rendered?.worldVisible === false)) {
          state.visible = true;
        }
      }
      for (const child of transform.children || []) visit(child);
    }
    visit(go.transform);
    return state;
  }

  function sceneKey(go, collider, roots) {
    const parts = [];
    const seen = new Set();
    for (let transform = go.transform; transform && !seen.has(transform); transform = transform.parent) {
      seen.add(transform);
      const name = String(transform.gameObject?.name ?? 'node');
      const siblings = transform.parent?.children || roots.map((item) => item.transform);
      const sameName = siblings.filter((item) => String(item.gameObject?.name ?? 'node') === name);
      parts.push(`${encodeURIComponent(name)}[${Math.max(0, sameName.indexOf(transform))}]`);
    }
    const index = (go.components || []).indexOf(collider);
    return `${parts.reverse().join('/')}:Collider[${index}]`;
  }

  function vector(x, y, z = 0) {
    return new global.UHTMath.Vector3(x, y, z);
  }

  function intersection(box, left, top, right, bottom) {
    const x = Math.max(box.x, left);
    const y = Math.max(box.y, top);
    const width = Math.min(box.x + box.width, right) - x;
    const height = Math.min(box.y + box.height, bottom) - y;
    return width > 0 && height > 0 ? { x, y, width, height } : null;
  }

  function projectedBounds(collider, camera) {
    const { center, size } = collider.GetTransformedCenterAndSize();
    const halfWidth = Math.abs(size.x) * (collider.isSphere ? 1 : 0.5);
    const halfHeight = Math.abs(collider.isSphere ? size.x : size.y) * (collider.isSphere ? 1 : 0.5);
    if (![center.x, center.y, halfWidth, halfHeight].every(Number.isFinite) ||
        halfWidth <= 0 || halfHeight <= 0) return null;
    const corners = [-1, 1].flatMap((dx) => [-1, 1].map((dy) =>
      camera.WorldToScreenPoint(vector(center.x + dx * halfWidth, center.y + dy * halfHeight, center.z || 0))));
    if (!corners.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) return null;
    const xs = corners.map((point) => point.x);
    const ys = corners.map((point) => point.y);
    return { x: Math.min(...xs), y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }

  function cameraAcceptsPoint(uiCamera, point) {
    const camera = uiCamera.cachedCamera;
    if (uiCamera.enabled === false || camera.enabled === false ||
        (uiCamera.gameObject && !active(uiCamera.gameObject))) return false;
    if (global.Globals?.InputBlocked && !camera.ignoreInputBlocked) return false;
    if (typeof camera.IsClippingInput === 'function' && camera.IsClippingInput()) {
      const settings = camera.extraCameraSettings;
      const transform = uiCamera.gameObject?.transform;
      if (!settings || !transform?.transformPoint) return false;
      const a = camera.WorldToScreenPoint(transform.transformPoint(vector(-settings.clipLeft, settings.clipUp)));
      const b = camera.WorldToScreenPoint(transform.transformPoint(vector(settings.clipRight, -settings.clipDown)));
      if (point.x < Math.min(a.x, b.x) || point.x > Math.max(a.x, b.x) ||
          point.y < Math.min(a.y, b.y) || point.y > Math.max(a.y, b.y)) return false;
    }
    return true;
  }

  // This invokes the engine's point query only. It never queues input, calls
  // OnClick/OnPress, changes Input.mousePosition or sends GameObject messages.
  function topColliderAt(point, uiCameras, manager) {
    for (let index = uiCameras.length - 1; index >= 0; index--) {
      const uiCamera = uiCameras[index];
      const camera = uiCamera.cachedCamera;
      if (!camera || !cameraAcceptsPoint(uiCamera, point)) continue;
      const collider = manager.getHoveredCollider(camera.ScreenToWorldPoint(vector(point.x, point.y)),
        uiCamera.eventReceiverMask);
      if (collider) return collider;
    }
    return null;
  }

  function scan() {
    const warnings = new Set();
    const buttons = [];
    const roots = global.globalRuntime?.sceneRoots;
    if (!Array.isArray(roots) || typeof global.Collider !== 'function') {
      return { available: false, buttons, warnings: [] };
    }
    const result = () => ({ available: true, buttons, warnings: [...warnings] });
    const canvas = global.globalRenderer?.renderer?.view;
    const width = global.UHTScreen?.width;
    const height = global.UHTScreen?.height;
    if (!canvas?.getBoundingClientRect || !Number.isFinite(width) || !Number.isFinite(height) ||
        width <= 0 || height <= 0 || typeof global.UHTMath?.Vector3 !== 'function') {
      warnings.add('UHT: faltan el canvas o las dimensiones de proyección; no se estiman coordenadas.');
      return result();
    }
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return result();
    for (let node = canvas; node; node = node.parentElement || node.getRootNode?.()?.host) {
      if (node.matches?.('[inert], [hidden], [aria-hidden="true"]')) return result();
      const style = typeof global.getComputedStyle === 'function' ? global.getComputedStyle(node) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' ||
          style.visibility === 'collapse' || Number(style.opacity) === 0)) return result();
    }

    const uiCameras = global.UICamera?.allUICameras;
    const manager = global.globalColliderInputManager;
    const canHitTest = Array.isArray(uiCameras) && uiCameras.length > 0 &&
      typeof manager?.getHoveredCollider === 'function' &&
      uiCameras.every((item) => !item.cachedCamera || typeof item.cachedCamera.ScreenToWorldPoint === 'function');
    if (!canHitTest) warnings.add('UHT: no está disponible la consulta de colisión; la oclusión del motor no se verifica.');
    const toCSS = (point) => ({ x: rect.left + point.x * rect.width / width,
      y: rect.top + point.y * rect.height / height });
    const seen = new Set();

    for (const root of roots) {
      let colliders;
      try {
        colliders = root.GetComponentsInChildren(global.Collider, true) || [];
      } catch {
        warnings.add('UHT: una raíz no permite enumerar sus colliders.');
        continue;
      }
      for (const collider of colliders) {
        if (seen.has(collider)) continue;
        seen.add(collider);
        try {
          const go = collider.gameObject;
          if (collider.enabled !== true || !active(go) || !visibleHierarchy(go) || !hasResponder(go)) continue;
          const camera = global.Globals?.GetCameraForObject?.(go);
          if (!camera || typeof camera.WorldToScreenPoint !== 'function' ||
              typeof collider.GetTransformedCenterAndSize !== 'function') {
            warnings.add('UHT: un control no expone cámara o límites proyectables.');
            continue;
          }
          if (camera.enabled === false || (global.Globals?.InputBlocked && !camera.ignoreInputBlocked)) continue;
          const bounds = projectedBounds(collider, camera);
          const screenBox = bounds && intersection(bounds, 0, 0, width, height);
          if (!screenBox) continue;
          const visuals = visualState(go);
          if (visuals.found && !visuals.visible) continue;
          // UHT also uses huge colliders with handlers to dismiss windows.
          // Small hit areas may have their art in siblings (including game
          // feature entries), so absence of a descendant widget alone is not
          // a reason to discard them.
          if (!visuals.visible && screenBox.width >= width * 0.8 && screenBox.height >= height * 0.8) continue;
          const css = toCSS(screenBox);
          const cssBox = intersection({ x: css.x, y: css.y,
            width: screenBox.width * rect.width / width, height: screenBox.height * rect.height / height },
          0, 0, global.innerWidth || Infinity, global.innerHeight || Infinity);
          if (!cssBox) continue;

          let exposed = false;
          let hitVerified = false;
          const samples = [[0.5, 0.5], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]];
          for (const [fx, fy] of samples) {
            const cssPoint = { x: cssBox.x + cssBox.width * fx, y: cssBox.y + cssBox.height * fy };
            if (typeof global.document?.elementFromPoint === 'function') {
              const element = global.document.elementFromPoint(cssPoint.x, cssPoint.y);
              if (element !== canvas && !canvas.contains?.(element)) continue;
            }
            const point = { x: (cssPoint.x - rect.left) * width / rect.width,
              y: (cssPoint.y - rect.top) * height / rect.height };
            if (canHitTest) {
              if (topColliderAt(point, uiCameras, manager) !== collider) continue;
              hitVerified = true;
            }
            exposed = true;
            break;
          }
          if (!exposed) continue;
          buttons.push({ key: sceneKey(go, collider, roots), box: cssBox,
            confidence: hitVerified ? 0.98 : 0.8,
            evidence: ['uht:enabled-collider', 'uht:active-hierarchy', 'uht:input-handler',
              'uht:camera-projection', ...(visuals.visible ? ['uht:visible-widget'] : []),
              ...(hitVerified ? ['uht:point-hit-test'] : [])] });
        } catch {
          // Do not expose exception text: a page may embed private data in it.
          warnings.add('UHT: un control cambió o no cumple el contrato esperado durante la lectura.');
        }
      }
    }
    return result();
  }

  const registry = global.__identificadorAdapters || (global.__identificadorAdapters = []);
  const existing = registry.findIndex((adapter) => adapter.name === 'uht');
  const adapter = { name: 'uht', scan };
  if (existing < 0) registry.push(adapter);
  else registry[existing] = adapter;
})();
