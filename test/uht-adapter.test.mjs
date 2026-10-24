import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const adapterPath = new URL('../src/browser/uht-adapter.js', import.meta.url);
const source = await readFile(adapterPath, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return '';
  throw error;
});

// Contract fixtures model the APIs observed in the supplied HAR. The engine
// bundle is absent from that recording; these are not copies of vendor code.
function runtimeFixture() {
  const roots = [];
  const state = { dispatched: 0, coveringElement: null };
  const canvas = {
    width: 2000, height: 1200,
    getBoundingClientRect: () => ({ left: 40, top: 70, width: 500, height: 300 }),
    contains: () => false,
  };
  const style = { display: 'block', visibility: 'visible', opacity: '1', transform: 'none' };

  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  }
  class UIButton {
    enabled = true;
    OnPress() { state.dispatched++; }
    OnClick() { state.dispatched++; }
  }
  class SoundPlayer {
    enabled = true;
    OnClick() { state.dispatched++; }
  }
  class UIPanel {
    enabled = true;
    constructor(alpha) { this.alpha = alpha; }
  }
  class UISprite {
    enabled = true;
    color = { a: 1 };
    spriteName = 'generic-icon';
    width = 80;
    height = 40;
    constructor(go) { this.gameObject = go; }
  }
  class Collider {
    enabled = true;
    isSphere = false;
    constructor(go, { x = 0, y = 0, width = 80, height = 40, depth = 0 } = {}) {
      this.gameObject = go;
      this.transform = go.transform;
      this.center = new Vector3(x, y, depth);
      this.size = new Vector3(width, height, 1);
    }
    GetTransformedCenterAndSize() { return { center: this.center, size: this.size }; }
  }
  class GameObject {
    activeSelf = true;
    layer = 0;
    components = [];
    constructor(name, parent) {
      this.name = name;
      this.transform = { gameObject: this, children: [], parent: parent?.transform ?? null };
      if (parent) parent.transform.children.push(this.transform);
      else roots.push(this);
    }
    get activeInHierarchy() {
      return this.activeSelf && (!this.transform.parent || this.transform.parent.gameObject.activeInHierarchy);
    }
    GetComponentsInChildren(Type, includeInactive) {
      const found = [];
      function visit(go) {
        if (!includeInactive && !go.activeInHierarchy) return;
        found.push(...go.components.filter((component) => component instanceof Type));
        for (const child of go.transform.children) visit(child.gameObject);
      }
      visit(this);
      return found;
    }
  }

  const camera = {
    enabled: true,
    ignoreInputBlocked: false,
    WorldToScreenPoint: ({ x, y, z = 0 }) => new Vector3(500 + x, 300 - y, z),
    ScreenToWorldPoint: ({ x, y, z = 0 }) => new Vector3(x - 500, 300 - y, z),
    IsClippingInput: () => false,
  };
  const uiCamera = { cachedCamera: camera, eventReceiverMask: { mask: 1 }, enabled: true };
  const globals = {
    globalRuntime: { sceneRoots: roots }, Collider, UIButton, SoundPlayer, UIPanel, UISprite,
    UHTMath: { Vector3 }, UHTScreen: { width: 1000, height: 600 },
    globalRenderer: { renderer: { view: canvas, resolution: 2 } },
    UICamera: { allUICameras: [uiCamera] },
    Globals: { GetCameraForObject: () => camera, InputBlocked: false },
    innerWidth: 1000, innerHeight: 800, devicePixelRatio: 2,
    getComputedStyle: () => style,
    document: { elementFromPoint: () => state.coveringElement ?? canvas },
    globalColliderInputManager: {
      getHoveredCollider(world, mask) {
        return roots.flatMap((root) => root.GetComponentsInChildren(Collider, true))
          .filter((col) => col.enabled && col.gameObject.activeInHierarchy)
          .filter((col) => (mask.mask & (1 << col.gameObject.layer)) !== 0)
          .filter((col) => {
            const dx = world.x - col.center.x;
            const dy = world.y - col.center.y;
            return col.isSphere ? dx * dx + dy * dy <= col.size.x ** 2
              : Math.abs(dx) <= col.size.x / 2 && Math.abs(dy) <= col.size.y / 2;
          })
          .sort((a, b) => a.center.z - b.center.z)[0] ?? null;
      },
    },
  };
  function button(name, parent, geometry) {
    const go = new GameObject(name, parent);
    const col = new Collider(go, geometry);
    go.components.push(col, new UIButton());
    return { go, col };
  }
  return { globals, state, roots, canvas, style, GameObject, Collider, UIButton,
    SoundPlayer, UIPanel, UISprite, button, camera, uiCamera };
}

function install(globals = {}) {
  const context = vm.createContext(globals);
  vm.runInContext(source, context, { filename: 'uht-adapter.js' });
  const adapter = context.__identificadorAdapters?.find((item) => item.name === 'uht');
  assert.ok(adapter, 'the UHT adapter must register without running game actions');
  return { adapter, context };
}

function scan(adapter) {
  // Normalize VM prototypes; results must be JSON-serializable metadata only.
  return JSON.parse(JSON.stringify(adapter.scan()));
}

test('reports unavailable when the UHT runtime is absent', () => {
  const { adapter } = install();
  assert.equal(scan(adapter).available, false);
  assert.deepEqual(scan(adapter).buttons, []);
});

test('projects world bounds through UHT screen units into scaled canvas CSS pixels', () => {
  const f = runtimeFixture();
  f.button('Control-17', new f.GameObject('GameRoot'), { x: 100, y: 100 });
  const { adapter } = install(f.globals);
  const result = scan(adapter);
  assert.equal(result.available, true);
  assert.equal(result.buttons.length, 1);
  assert.deepEqual(result.buttons[0].box, { x: 320, y: 160, width: 40, height: 20 });
  assert.equal(f.state.dispatched, 0);
});

test('uses the sphere radius convention exposed by UHT colliders', () => {
  const f = runtimeFixture();
  const { col } = f.button('Control', new f.GameObject('GameRoot'));
  col.isSphere = true;
  col.size.x = 30;
  assert.deepEqual(scan(install(f.globals).adapter).buttons[0].box,
    { x: 275, y: 205, width: 30, height: 30 });
});

test('keeps purchase and antebet menu entries separate outside the GUI root', () => {
  const f = runtimeFixture();
  const root = new f.GameObject('GameRoot');
  f.button('Compra', root, { x: -150 });
  f.button('Antebet', root, { x: 150 });
  const result = scan(install(f.globals).adapter);
  assert.equal(result.buttons.length, 2);
  assert.notEqual(result.buttons[0].key, result.buttons[1].key);
  assert.equal('action' in result.buttons[0], false);
  assert.equal('label' in result.buttons[0], false);
  assert.equal(f.state.dispatched, 0);
});

test('excludes disabled, inactive, transparent-panel and invalid-geometry controls', () => {
  const f = runtimeFixture();
  const root = new f.GameObject('GameRoot');
  f.button('Visible', root, { x: -300 });
  f.button('Disabled', root, { x: -150 }).col.enabled = false;
  const inactive = new f.GameObject('InactiveGroup', root);
  inactive.activeSelf = false;
  f.button('InactiveChild', inactive);
  const transparent = new f.GameObject('TransparentGroup', root);
  transparent.components.push(new f.UIPanel(0));
  f.button('TransparentChild', transparent, { x: 150 });
  f.button('Zero', root, { x: 300, width: 0 });
  f.button('Invalid', root, { x: NaN });
  const result = scan(install(f.globals).adapter);
  assert.equal(result.buttons.length, 1);
  assert.match(result.buttons[0].key, /Visible/);
});

test('does not mistake a sound-only collider for an actionable control', () => {
  const f = runtimeFixture();
  const go = new f.GameObject('Decorative');
  go.components.push(new f.Collider(go), new f.SoundPlayer());
  assert.deepEqual(scan(install(f.globals).adapter).buttons, []);
});

test('excludes a transparent visual while retaining a detached visible control', () => {
  const f = runtimeFixture();
  const root = new f.GameObject('GameRoot');
  const invisible = f.button('Invisible', root, { x: -150 });
  const sprite = new f.UISprite(invisible.go);
  sprite.color.a = 0;
  invisible.go.components.push(sprite);
  f.button('DetachedArt', root, { x: 150 });
  const result = scan(install(f.globals).adapter);
  assert.equal(result.buttons.length, 1);
  assert.match(result.buttons[0].key, /DetachedArt/);
});

test('does not label a view-sized invisible dismiss area as a visible button', () => {
  const f = runtimeFixture();
  f.button('ArbitraryName', new f.GameObject('GameRoot'), { width: 5000, height: 7000 });
  assert.deepEqual(scan(install(f.globals).adapter).buttons, []);
});

test('rescans dynamic controls and retains identity when only geometry changes', () => {
  const f = runtimeFixture();
  const root = new f.GameObject('GameRoot');
  const first = f.button('Control', root, { x: -100 });
  const { adapter } = install(f.globals);
  const before = scan(adapter).buttons[0];
  first.col.center.x = -200;
  const second = f.button('Control', root, { x: 150 });
  const after = scan(adapter).buttons;
  assert.equal(after.length, 2);
  assert.equal(after[0].key, before.key);
  assert.notDeepEqual(after[0].box, before.box);
  assert.notEqual(after[0].key, after[1].key);
  second.go.activeSelf = false;
  assert.equal(scan(adapter).buttons.length, 1);
});

test('does not expose a button fully covered by a blocking collider', () => {
  const f = runtimeFixture();
  const root = new f.GameObject('GameRoot');
  f.button('Control', root);
  const blocker = new f.GameObject('ModalBlocker', root);
  const blockerCol = new f.Collider(blocker, { width: 200, height: 100, depth: -100 });
  blocker.components.push(blockerCol);
  const { adapter } = install(f.globals);
  assert.deepEqual(scan(adapter).buttons, []);
  blockerCol.enabled = false;
  assert.equal(scan(adapter).buttons.length, 1);
  assert.equal(f.state.dispatched, 0);
});

test('keeps a partially exposed control when its center alone is covered', () => {
  const f = runtimeFixture();
  const root = new f.GameObject('GameRoot');
  f.button('Control', root);
  const blocker = new f.GameObject('SmallBlocker', root);
  blocker.components.push(new f.Collider(blocker, { width: 10, height: 10, depth: -100 }));
  assert.equal(scan(install(f.globals).adapter).buttons.length, 1);
});

test('respects blocked input and the camera override', () => {
  const f = runtimeFixture();
  f.button('Control', new f.GameObject('GameRoot'));
  const { adapter } = install(f.globals);
  f.globals.Globals.InputBlocked = true;
  assert.deepEqual(scan(adapter).buttons, []);
  f.camera.ignoreInputBlocked = true;
  assert.equal(scan(adapter).buttons.length, 1);
});

test('excludes canvas controls hidden by CSS or a DOM overlay', () => {
  const f = runtimeFixture();
  f.button('Control', new f.GameObject('GameRoot'));
  const { adapter } = install(f.globals);
  f.style.visibility = 'hidden';
  assert.deepEqual(scan(adapter).buttons, []);
  f.style.visibility = 'visible';
  f.state.coveringElement = {};
  assert.deepEqual(scan(adapter).buttons, []);
});

test('warns when collider hit testing is unavailable and registers idempotently', () => {
  const f = runtimeFixture();
  f.button('Control', new f.GameObject('GameRoot'));
  delete f.globals.globalColliderInputManager;
  const { adapter, context } = install(f.globals);
  const result = scan(adapter);
  assert.equal(result.buttons.length, 1);
  assert.ok(result.warnings.length > 0);
  vm.runInContext(source, context);
  assert.equal(context.__identificadorAdapters.filter((item) => item.name === 'uht').length, 1);
});
