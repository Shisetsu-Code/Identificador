/* Original tiny scene used to exercise the public UHT adapter contract.
 * It is not vendor code and does not implement spins, wagers, or purchases. */
(() => {
  const canvas=document.querySelector('#stage'), ctx=canvas.getContext('2d');
  const width=1120,height=580,roots=[]; let menu=null,notice='';
  class Vector3 {constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}}
  class GameObject {
    components=[]; activeSelf=true; layer=0;
    constructor(name,parent){this.name=name;this.transform={gameObject:this,parent:parent?.transform||null,children:[]};if(parent)parent.transform.children.push(this.transform);else roots.push(this);}
    get activeInHierarchy(){return this.activeSelf&&(!this.transform.parent||this.transform.parent.gameObject.activeInHierarchy);}
    GetComponentsInChildren(Type,includeInactive){const out=[];const visit=go=>{if(!includeInactive&&!go.activeInHierarchy)return;out.push(...go.components.filter(c=>c instanceof Type));go.transform.children.forEach(c=>visit(c.gameObject));};visit(this);return out;}
  }
  class Collider {
    enabled=true; isSphere=false;
    constructor(go,rect){this.gameObject=go;this.rect=rect;this.center=new Vector3(rect.x+rect.width/2-width/2,height/2-rect.y-rect.height/2,0);this.size=new Vector3(rect.width,rect.height,1);}
    GetTransformedCenterAndSize(){return {center:this.center,size:this.size};}
  }
  class UIButton {enabled=true;constructor(go,click){this.gameObject=go;this.OnClick=click;}OnPress(){}}
  const camera={enabled:true,ignoreInputBlocked:false,WorldToScreenPoint:p=>new Vector3(width/2+p.x,height/2-p.y,p.z),ScreenToWorldPoint:p=>new Vector3(p.x-width/2,height/2-p.y,p.z),IsClippingInput:()=>false};
  const input={getHoveredCollider(p){return roots.flatMap(r=>r.GetComponentsInChildren(Collider,true)).find(c=>c.enabled&&c.gameObject.activeInHierarchy&&Math.abs(p.x-c.center.x)<=c.size.x/2&&Math.abs(p.y-c.center.y)<=c.size.y/2)||null;}};
  Object.assign(window,{Collider,UIButton,UHTMath:{Vector3},UHTScreen:{width,height},globalRuntime:{sceneRoots:roots},globalRenderer:{renderer:{view:canvas,resolution:1}},Globals:{GetCameraForObject:()=>camera,InputBlocked:false},UICamera:{allUICameras:[{cachedCamera:camera,eventReceiverMask:{mask:1},enabled:true}]},globalColliderInputManager:input});
  const root=new GameObject('Scene'),main=new GameObject('Main',root),purchase=new GameObject('PurchaseMenu',root),ante=new GameObject('AnteMenu',root);
  const controls=[];
  function button(name,parent,rect,label,detail,action){const go=new GameObject(name,parent);const collider=new Collider(go,rect);go.components.push(collider,new UIButton(go,action));controls.push({go,rect,label,detail});return go;}
  function open(value){menu=value;main.activeSelf=!value;purchase.activeSelf=value==='purchase';ante.activeSelf=value==='ante';notice='';document.querySelector('#state').textContent=value?'MENÚ ABIERTO':'VISTA PRINCIPAL';draw();}
  button('MenuEntryA',main,{x:54,y:228,width:214,height:86},'COMPRA','Abrir menú',()=>open('purchase'));
  button('MenuEntryB',main,{x:852,y:228,width:214,height:86},'ANTEBET','Abrir menú',()=>open('ante'));
  for(const [group,type] of [[purchase,'purchase'],[ante,'ante']]){
    button('Close',group,{x:895,y:100,width:44,height:40},'×','',()=>open(null));
    for(let i=0;i<3;i++)button('Option'+i,group,{x:222+i*232,y:224,width:212,height:130},`OPCIÓN ${i+1}`,'Seleccionar',()=>{notice=`Opción ${i+1} señalada · sin ejecutar ninguna apuesta`;draw();});
  }
  function round(x,y,w,h,r,fill,stroke){ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fillStyle=fill;ctx.fill();if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=1;ctx.stroke();}}
  function text(value,x,y,size,color='#e4edff',align='left',weight=500){ctx.font=`${weight} ${size}px system-ui,sans-serif`;ctx.fillStyle=color;ctx.textAlign=align;ctx.fillText(value,x,y);}
  function draw(){
    ctx.clearRect(0,0,width,height);
    const grad=ctx.createLinearGradient(0,0,width,height);grad.addColorStop(0,'#1d2942');grad.addColorStop(1,'#111a2d');ctx.fillStyle=grad;ctx.fillRect(0,0,width,height);
    text('CANVAS / DEMO',36,42,11,'#7a90b3','left',700);text('02 ACCESOS A MENÚ',width-36,42,11,'#7a90b3','right',700);
    round(316,84,488,360,20,'#10182a','#32415c');
    const colors=['#73dfcd','#8498ee','#c8ad6e'];
    for(let row=0;row<3;row++)for(let col=0;col<3;col++){
      const x=337+col*151,y=104+row*108;round(x,y,141,98,10,'#1c2941','#2b3b57');
      ctx.save();ctx.translate(x+70.5,y+49);ctx.strokeStyle=colors[(row+col)%3];ctx.lineWidth=4;
      if((row+col)%3===0){ctx.beginPath();ctx.arc(0,0,21,0,Math.PI*2);ctx.stroke();}
      else if((row+col)%3===1){ctx.rotate(Math.PI/4);ctx.strokeRect(-17,-17,34,34);}
      else{ctx.beginPath();ctx.moveTo(0,-23);ctx.lineTo(24,19);ctx.lineTo(-24,19);ctx.closePath();ctx.stroke();}ctx.restore();
    }
    text('Geometría y eventos, sin interpretar el texto.',560,486,15,'#8f9eb8','center');
    text('Los dos accesos son botones independientes.',560,511,12,'#647797','center');
    if(menu){ctx.fillStyle='#080e1bdc';ctx.fillRect(0,65,width,490);round(170,83,780,354,18,'#19243b','#41516d');text(menu==='purchase'?'Menú de compra':'Menú de antebet',216,143,25,'#e8effc','left',650);text('La misma detección encuentra las opciones del menú.',216,175,14,'#8d9db8');}
    for(const c of controls){if(!c.go.activeInHierarchy)continue;const r=c.rect;round(r.x,r.y,r.width,r.height,11,menu?'#243552':'#263d46',menu?'#466087':'#4d837f');text(c.label,r.x+r.width/2,r.y+r.height*.46,menu&&r.width<50?25:16,'#dceeea','center',650);if(c.detail)text(c.detail,r.x+r.width/2,r.y+r.height*.72,12,'#9cb8bb','center');}
    if(notice)text(notice,560,402,13,'#64ddc9','center');
    text('DETECCIÓN PASIVA',36,553,10,'#647b9e','left',700);text('SIN ACCIONES AUTOMÁTICAS',1084,553,10,'#647b9e','right',700);
  }
  canvas.addEventListener('click',e=>{const r=canvas.getBoundingClientRect();const p=new Vector3((e.clientX-r.left)*width/r.width,(e.clientY-r.top)*height/r.height);const c=input.getHoveredCollider(camera.ScreenToWorldPoint(p));if(c)c.gameObject.components.find(v=>v instanceof UIButton)?.OnClick();});
  open(null);
})();
