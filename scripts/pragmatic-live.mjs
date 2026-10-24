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
  // The operator explicitly confirms being an adult. Use the site's normal
  // affirmation control, never alter age/session cookies or bypass geo blocks.
  const pageContexts = () => context.pages().flatMap(p => p.frames());
  const clickFirst = async (pattern, label) => {
    for (const frame of pageContexts()) {
      for (const role of ['button', 'link']) {
        const item = frame.getByRole(role, { name: pattern }).first();
        try {
          if (await item.isVisible({ timeout: 1000 })) {
            await item.click({timeout: 5000});
            diagnostics.errors.push('Resolved visible ' + label + ' dialog');
            return true;
          }
        } catch {}
      }
    }
    return false;
  };
  await clickFirst(/^(yes,? i am 18 years or older|yes,? i am (18|over 18)|i am (over )?(18|21)|i am of legal age|yes,? i am|enter site|over 18|i confirm.*18|sí,? soy mayor de edad)$/i, 'age');
  await landing.waitForTimeout(1800);
  await clickFirst(/^(reject all|reject optional|necessary only|only necessary|decline|accept all|accept cookies|agree|got it|ok|aceptar|rechazar|solo necesarias)$/i, 'cookie');
  await landing.waitForTimeout(1800);
  // Only launch an official demo. Never initiate a spin, stake or bonus purchase.
  let launch=landing.getByRole('button',{name:/^(play now|play demo|demo)$/i}).first();
  if(await launch.count()===0) launch=landing.getByRole('link',{name:/^(play now|play demo|demo)$/i}).first();
  if(await launch.count()) {
    try {await launch.click({timeout:10000});diagnostics.launchedDemo=true;}
    catch(e){diagnostics.errors.push('demo-launch: '+String(e.message).slice(0,180));}
  } else diagnostics.errors.push('No official demo-launch button/link found on landing page');
  await landing.waitForTimeout(10000);
  // Canvas intro exposes a visible 'DON'T SHOW NEXT TIME' checkbox.
  // Coordinates are fractions of the embedded game rectangle, calibrated
  // against the actual screenshot; do not click the spin/replay symbol.
  const featureFrame = landing.frames().find(f => f.url().includes('demogamesfree.pragmaticplay.net/gs2c/html5Game'));
  if (featureFrame) {
    try {
      const embedding = await featureFrame.frameElement();
      const bounds = await embedding.boundingBox();
      if (bounds && bounds.width >= 600 && bounds.height >= 380) {
        const point = {x: bounds.x + bounds.width * 0.803, y: bounds.y + bounds.height * 0.928};
        diagnostics.introCheckboxPoint = point;
        await landing.mouse.click(point.x,point.y);
        diagnostics.introCheckboxClicked = true;
        await landing.waitForTimeout(800);
        await landing.screenshot({path:out+'/checkbox-after-click.png'});
        // Single entry control on the intro feature screen; never click a buy
        // or antebet option. Capture the state before any restart.
        const entryPoint = {x: bounds.x + bounds.width * 0.887, y: bounds.y + bounds.height * 0.715};
        diagnostics.introEntryPoint = entryPoint;
        await landing.mouse.click(entryPoint.x,entryPoint.y);
        await landing.waitForTimeout(4000);
        await landing.screenshot({path:out+'/after-intro-control.png'});
        // Keep the main game session after clicking the intro entry control.
        diagnostics.introFrameReloaded = false;
        await landing.waitForTimeout(12000);
        await landing.screenshot({path:out+'/gameplay-after-entry.png'});
      } else diagnostics.errors.push('Intro checkbox: unexpected frame rectangle');
    } catch(e) {diagnostics.errors.push('Intro checkbox: '+String(e.message).slice(0,180));}
  }
  // Intro is a carousel inside the game frame, not gameplay. Use only
  // explicit skip/continue controls, or its intro-only slide navigation.
  diagnostics.introActions = [];
  const gameFrame = () => landing.frames().find(f => f.url().includes('demogamesfree.pragmaticplay.net/gs2c/html5Game'));
  for (let attempt = 0; attempt < 8; attempt++) {
    const frame = gameFrame();
    if (!frame) { diagnostics.introActions.push('game frame unavailable'); break; }
    const candidates = [
      frame.getByRole('button', {name:/^(skip|skip intro|continue|start game|play game|close intro|close|next|got it)$/i}),
      frame.getByText(/^(skip|skip intro|continue|start game|play game|next)$/i),
    ];
    let clicked = false;
    for (const locator of candidates) {
      const target = locator.first();
      if (await target.isVisible().catch(()=>false)) {
        try { await target.click({timeout:2500});diagnostics.introActions.push('clicked named intro control');clicked=true;break; } catch {}
      }
    }
    if (!clicked) {
      // Main intro is a safe, non-wagering feature slide with a row of
      // progress dots and a replay graphic. Click a progress dot only
      // while this explicit intro-only banner is present.
      const introPresent = await frame.getByText(/DON.T SHOW NEXT TIME|WILDS WITH RANDOM MULTIPLIERS/i).count().catch(()=>0);
      if (introPresent) {
        await frame.locator('body').press('Escape').catch(()=>{});
        diagnostics.introActions.push('intro visible; Escape sent');
      } else {
        diagnostics.introActions.push('intro marker not found in DOM; retaining screenshot');
      }
    }
    await landing.waitForTimeout(1500);
    if (attempt===2 || attempt===7) {
      await landing.screenshot({path:out+'/intro-stage-'+attempt+'.png'}).catch(()=>{});
    }
  }
  await landing.waitForTimeout(15000);
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
