import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../src/browser/inspector.js', import.meta.url));
const fixtureUrl = new URL('./fixtures/controls.html', import.meta.url).href;
const launch = () => chromium.launch({headless:true, executablePath:process.env.IDENTIFICADOR_BROWSER_PATH || undefined});
async function setup(t, options={}) {
  const browser=await launch();t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:1000,height:700},...options});
  await context.addInitScript({content:await readFile(scriptPath,'utf8')});
  const page=await context.newPage(); await page.goto(fixtureUrl);
  return {browser,context,page};
}

test('detects two independent menu buttons without semantic labels or clicking',async t=>{
  const {page}=await setup(t);
  const result=await page.evaluate(()=>window.__identificador.scan());
  const expected=await page.locator('#buy, #ante').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}));
  const found=expected.map(r=>result.buttons.find(b=>Math.abs(b.box.x-r.x)<1&&Math.abs(b.box.y-r.y)<1&&Math.abs(b.box.width-r.width)<1));
  assert.ok(found.every(Boolean));assert.notEqual(found[0].signature,found[1].signature);
  assert.ok(found.every(b=>b.kind==='button'&&!('label' in b)&&!('action' in b)));
  assert.equal(await page.evaluate(()=>window.clicks),0);
});

test('rejects hidden disabled occluded offscreen and decorative nodes; captures pointer listeners',async t=>{
  const {page}=await setup(t);
  const r=await page.evaluate(()=>window.__identificador.scan());
  assert.equal(r.buttons.length,4); // buy, ante, custom, outer nested button
  assert.equal(new Set(r.buttons.map(b=>b.signature)).size,4);
});

test('updates dynamic controls and dimensions without swallowing actual clicks',async t=>{
  const {page}=await setup(t);
  await page.evaluate(()=>window.__identificador.scan());
  assert.equal(await page.locator('[data-identificador-overlay]').count(),1);
  assert.equal(await page.locator('[data-identificador-overlay]').evaluate(e=>getComputedStyle(e).pointerEvents),'none');
  await page.locator('#buy').click();assert.equal(await page.evaluate(()=>window.clicks),1);
  const before=await page.evaluate(()=>window.__identificador.scan().buttons);
  await page.evaluate(()=>{document.querySelector('#ante').hidden=true;const b=document.createElement('button');b.id='fresh';b.textContent='Nuevo';b.style.cssText='position:absolute;left:700px;top:300px;width:140px;height:50px';document.body.append(b)});
  const after=await page.evaluate(()=>window.__identificador.scan().buttons);
  assert.equal(after.length,before.length);assert.ok(after.some(b=>b.box.x===700&&b.box.width===140));
  assert.equal(after.filter(b=>before.some(x=>x.signature===b.signature)).length,3);
});

test('scopes inspector to each frame and reports unsupported canvas instead of guessing boxes',async t=>{
  const {page}=await setup(t);
  await page.evaluate(()=>{const f=document.createElement('iframe');f.srcdoc='<button>Child</button><canvas width="100" height="50"></canvas>';document.body.append(f)});
  await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.__identificador);
  const child=page.frames()[1];const r=await child.evaluate(()=>window.__identificador.scan());
  assert.equal(r.buttons.length,1);assert.equal(r.coverage.canvases,1);assert.ok(r.coverage.warnings.length>0);
});

test('draws adapter geometry in CSS pixels with stable IDs and known-only coloring',async t=>{
  const {page}=await setup(t,{deviceScaleFactor:2});
  await page.evaluate(()=>window.__identificadorAdapters.push({name:'fixture',scan:()=>({available:true,buttons:[{key:'a',box:{x:600,y:500,width:100,height:40},confidence:.98,evidence:['click-handler']}]})}));
  const a=await page.evaluate(()=>window.__identificador.scan().buttons.find(b=>b.source==='fixture'));
  assert.deepEqual(a.box,{x:600,y:500,width:100,height:40});
  assert.deepEqual(a.normalized,{x:.6,y:500/700,width:.1,height:40/700});
  await page.evaluate(sig=>window.__identificador.setKnown([sig]),a.signature);
  const box=page.locator(`[data-identificador-id="${a.id}"]`);assert.equal(await box.getAttribute('data-known'),'true');
  const b=await page.evaluate(()=>window.__identificador.scan().buttons.find(b=>b.source==='fixture'));assert.equal(b.id,a.id);
  await page.evaluate(()=>window.__identificador.destroy());assert.equal(await page.locator('[data-identificador-overlay]').count(),0);
});

test('finds property handlers and keeps removal semantics after inspector cleanup',async t=>{
 const {page}=await setup(t);
 const outcome=await page.evaluate(()=>{
  const property=document.createElement('div');property.id='property-handler';property.style.cssText='position:absolute;left:750px;top:450px;width:100px;height:40px;background:red';property.onclick=()=>{};document.body.append(property);
  const found=window.__identificador.scan().buttons.some(b=>b.box.x===750&&b.box.y===450);
  let called=0;const fn=()=>called++;const button=document.querySelector('#custom');button.addEventListener('click',fn,{once:true});
  window.__identificador.destroy();button.removeEventListener('click',fn);button.click();
  return {found,called};
 });
 assert.deepEqual(outcome,{found:true,called:0});
});

test('does not expose controls inside a transparent shadow host',async t=>{
 const {page}=await setup(t);
 const result=await page.evaluate(()=>{
  document.body.replaceChildren();const host=document.createElement('div');host.style.opacity='0';host.attachShadow({mode:'open'}).innerHTML='<button>Hidden shadow button</button>';document.body.append(host);
  return window.__identificador.scan();
 });
 assert.equal(result.buttons.length,0);
});

test('does not duplicate a once handler re-registered after detector cleanup',async t=>{
 const {page}=await setup(t);
 const count=await page.evaluate(()=>{
  const button=document.querySelector('#custom');let n=0;const callback=()=>n++;
  button.addEventListener('click',callback,{once:true});window.__identificador.destroy();button.addEventListener('click',callback,{once:true});button.click();return n;
 });
 assert.equal(count,1);
});
