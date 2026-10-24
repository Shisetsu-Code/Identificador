import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readFile} from 'node:fs/promises';

test('canvas demo finds two menu entries then the four controls in an opened menu',async t=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.IDENTIFICADOR_BROWSER_PATH||undefined});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:2});
 const script=(await Promise.all(['uht-adapter.js','inspector.js'].map(n=>readFile(new URL('../src/browser/'+n,import.meta.url),'utf8')))).join('\n');
 await context.addInitScript({content:script});const page=await context.newPage();await page.goto(new URL('../examples/demo.html',import.meta.url).href);
 let result=await page.evaluate(()=>window.__identificador.scan());assert.equal(result.buttons.length,2);assert.deepEqual(result.coverage.engines,['uht']);assert.deepEqual(result.coverage.warnings,[]);
 const before=result.buttons.map(b=>b.signature);const rect=result.buttons[0].box;
 await page.mouse.click(rect.x+rect.width/2,rect.y+rect.height/2);
 result=await page.evaluate(()=>window.__identificador.scan());assert.equal(result.buttons.length,4);assert.ok(result.buttons.every(b=>!before.includes(b.signature)));
 const close=result.buttons.find(b=>b.box.width<60);assert.ok(close);await page.mouse.click(close.box.x+close.box.width/2,close.box.y+close.box.height/2);
 result=await page.evaluate(()=>window.__identificador.scan());assert.deepEqual(result.buttons.map(b=>b.signature),before);
});

test('UHT controls disappear when a DOM ancestor of the canvas is transparent',async t=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.IDENTIFICADOR_BROWSER_PATH||undefined});t.after(()=>browser.close());
 const context=await browser.newContext();await context.addInitScript({content:(await Promise.all(['uht-adapter.js','inspector.js'].map(n=>readFile(new URL('../src/browser/'+n,import.meta.url),'utf8')))).join('\n')});
 const page=await context.newPage();await page.goto(new URL('../examples/demo.html',import.meta.url).href);
 assert.equal(await page.evaluate(()=>__identificador.scan().buttons.length),2);
 await page.locator('main').evaluate(el=>el.style.opacity='0');
 assert.equal(await page.evaluate(()=>__identificador.scan().buttons.length),0);
});
