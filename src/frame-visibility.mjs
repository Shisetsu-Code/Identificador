/** Filter frame-local controls through every ancestor iframe without changing
 * their exported geometry. A child document cannot see its parent's occlusion. */
export async function visibleFrameButtons(frame, buttons, viewport) {
  if (!frame.parentFrame() || !buttons.length) return buttons;
  let current = frame;
  let size = viewport;
  let groups = buttons.map((button, index) => ({ index, points:
    [[.5,.5],[.15,.15],[.85,.15],[.15,.85],[.85,.85]].map(([fx,fy]) => ({
      x: button.box.x + button.box.width * fx,
      y: button.box.y + button.box.height * fy,
    })) }));
  while (current.parentFrame() && groups.length) {
    const element = await current.frameElement();
    let result;
    try {
      result = await element.evaluate((el, { groups, viewport }) => {
        const empty = { groups: [], viewport: { width: innerWidth, height: innerHeight } };
        for (let n = el; n; n = n.parentElement || n.getRootNode()?.host) {
          const style = getComputedStyle(n);
          if (n.matches('[inert], [hidden], [aria-hidden="true"]') || style.display === 'none' ||
              style.visibility !== 'visible' || Number(style.opacity) === 0) return empty;
        }
        const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
        if (!(rect.width > 0 && rect.height > 0 && viewport?.width > 0 && viewport?.height > 0)) return empty;
        const sx = rect.width / el.offsetWidth, sy = rect.height / el.offsetHeight;
        const pl = parseFloat(style.paddingLeft) || 0, pr = parseFloat(style.paddingRight) || 0;
        const pt = parseFloat(style.paddingTop) || 0, pb = parseFloat(style.paddingBottom) || 0;
        const left = rect.left + (el.clientLeft + pl) * sx;
        const top = rect.top + (el.clientTop + pt) * sy;
        const scaleX = (el.clientWidth - pl - pr) * sx / viewport.width;
        const scaleY = (el.clientHeight - pt - pb) * sy / viewport.height;
        function hit(x, y) {
          let node = document.elementFromPoint(x, y);
          const seen = new Set();
          while (node?.shadowRoot && !seen.has(node)) {
            seen.add(node);
            const inner = node.shadowRoot.elementFromPoint(x, y);
            if (!inner || inner === node) break;
            node = inner;
          }
          return node === el;
        }
        return {
          viewport: empty.viewport,
          groups: groups.map(group => ({ index: group.index,
            points: group.points.map(point => ({ x: left + point.x * scaleX, y: top + point.y * scaleY }))
              .filter(point => hit(point.x, point.y)),
          })).filter(group => group.points.length),
        };
      }, { groups, viewport: size });
    } finally { await element.dispose(); }
    groups = result.groups;
    size = result.viewport;
    current = current.parentFrame();
  }
  const visible = new Set(groups.map(group => group.index));
  return buttons.filter((_, index) => visible.has(index));
}
