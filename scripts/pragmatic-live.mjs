import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { observePage } from '../src/runner.mjs';
import { KnowledgeStore } from '../src/knowledge.mjs';

const out = 'output/pragmatic-live';
await mkdir(out, { recursive:true });
const url = 'https://www.pragmaticplay.com/en/games/rat-royale/?cur=USD&gamelang=en';
const source = (await Promise.all([
  'src/browser/uht-adapter.js','src/browser/inspector.js'
].map(f => readFile(f,'utf8')))).join('\n;\n');
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
const diagnostics = {page:url, launchedDemo:false, errors:[], frames:[], samples:[], captureTime:new Date().toISOString()};
const context=await browser.newContext({viewport:{width:1280,height:800},serviceWorkers:'block'});
context.on('page', p => {
  p.on('pageerror', e => { if(diagnostics.errors.length<15) diagnostics.errors.push(String(e.message).slice(0,180)); });
});
await context.addInitScript({content:source});
try {
  const landing=await context.newPage();
  await landing.goto(url,{waitUntil:'domcontentloaded',timeout:45000}).catch(e=>diagnostics.errors.push('landing: '+String(e.message).slice(0,180)));
  await landing.waitForTimeout(5000);
  // Only launch an official demo. Never initiate a spin, stake or bonus purchase.
  let launch=landing.getByRole('button',{name:/^(play now|play demo|demo)$/i}).first();
  if(await launch.count()===0) launch=landing.getByRole('link',{name:/^(play now|play demo|demo)$/i}).first();
  if(await launch.count()) {
    try {await launch.click({timeout:10000});diagnostics.launchedDemo=true;}
    catch(e){diagnostics.errors.push('demo-launch: '+String(e.message).slice(0,180));}
  } else diagnostics.errors.push('No official demo-launch button/link found on landing page');
  await landing.waitForTimeout(25000);
  const store=await KnowledgeStore.open(out+'/knowledge.json');
  for(const p of context.pages()) {
    const snap=await observePage(p,store,{scope:'rat-royale-live',seconds:2,intervalMs:500});
    const record={url:new URL(p.url()).origin+new URL(p.url()).pathname,totals:snap.totals,
      frames:snap.frames.map(f=>({id:f.id,url:f.url,coverage:f.coverage,buttons:f.buttons}))};
    diagnostics.samples.push(record);
    try {await p.screenshot({path:out+'/page-'+diagnostics.samples.length+'.png',timeout:10000});}
    catch(e){diagnostics.errors.push('screenshot: '+String(e.message).slice(0,140));}
  }
  diagnostics.frames=diagnostics.samples.flatMap(s=>s.frames);
  diagnostics.totalButtons=diagnostics.samples.reduce((sum,s)=>sum+s.totals.buttons,0);
  diagnostics.uhtFrames=diagnostics.frames.filter(f=>f.coverage?.engines?.includes('uht')).length;
} catch(e) {diagnostics.errors.push('fatal: '+String(e.stack||e).slice(0,1000));}
finally {
  await writeFile(out+'/report.json',JSON.stringify(diagnostics,null,2));
  console.log(JSON.stringify({launchedDemo:diagnostics.launchedDemo,totalButtons:diagnostics.totalButtons,uhtFrames:diagnostics.uhtFrames,errors:diagnostics.errors,frames:diagnostics.frames.map(f=>({url:f.url,buttons:f.buttons.length,coverage:f.coverage}))},null,2));
  await browser.close();
}
