import test from 'node:test';
import assert from 'node:assert/strict';
import {mountMobileViewport} from '../src/mobile-viewport.mjs';

class TrackedTarget extends EventTarget{
  listeners=new Map();
  addEventListener(type,handler,...options){
    const handlers=this.listeners.get(type)||new Set();handlers.add(handler);this.listeners.set(type,handlers);
    return super.addEventListener(type,handler,...options);
  }
  removeEventListener(type,handler,...options){this.listeners.get(type)?.delete(handler);return super.removeEventListener(type,handler,...options);}
  listenerCount(){return [...this.listeners.values()].reduce((total,handlers)=>total+handlers.size,0);}
  fire(type){this.dispatchEvent(new Event(type));}
}

function fixture({visual=true,classes=[],styles={}}={}){
  const values=new Map(Object.entries(styles)),names=new Set(classes),frames=new Map(),timers=new Map(),scrolls=[];
  let time=0,sequence=0;
  const style={
    getPropertyValue:name=>values.get(name)?.value||'',
    getPropertyPriority:name=>values.get(name)?.priority||'',
    setProperty:(name,value,priority='')=>values.set(name,{value,priority}),
    removeProperty:name=>values.delete(name),
  };
  const classList={contains:name=>names.has(name),add:name=>names.add(name),toggle:(name,force)=>force?names.add(name):names.delete(name)};
  const window=new TrackedTarget(),document=new TrackedTarget(),viewport=visual?new TrackedTarget():null;
  Object.assign(window,{innerWidth:390,innerHeight:844,scrollX:0,scrollY:0,visualViewport:viewport,
    requestAnimationFrame:fn=>{const id=++sequence;frames.set(id,fn);return id;},
    cancelAnimationFrame:id=>frames.delete(id),
    setTimeout:(fn,delay)=>{const id=++sequence;timers.set(id,{fn,at:time+delay});return id;},
    clearTimeout:id=>timers.delete(id),
    scrollTo:(x,y)=>{scrolls.push([x,y]);window.scrollX=x;window.scrollY=y;},
  });
  if(viewport)Object.assign(viewport,{width:390,height:844,offsetTop:0,scale:1});
  document.documentElement={clientWidth:390,style,classList};document.activeElement=null;
  const frame=()=>{const jobs=[...frames.values()];frames.clear();for(const job of jobs)job(time);};
  const tick=ms=>{const end=time+ms;let limit=100;while(limit--){const next=[...timers].filter(([,job])=>job.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;time=next[1].at;timers.delete(next[0]);next[1].fn();frame();}if(limit<0)throw Error('Unexpected repeating viewport timer');time=end;};
  const focus=(element={tagName:'TEXTAREA',disabled:false,readOnly:false})=>{document.activeElement=element;document.fire(element?'focusin':'focusout');};
  const mount=()=>mountMobileViewport({window,document});
  return {window,document,viewport,style,classList,frames,timers,scrolls,frame,tick,focus,mount};
}

test('Safari keyboard resize and independent focus pan keep the shell in the visual viewport, then restore on dismissal',()=>{
  const f=fixture(),unmount=f.mount();
  assert.equal(f.style.getPropertyValue('--mio-mobile-height'),'844px');
  assert.equal(f.style.getPropertyValue('--mio-mobile-top'),'0px');
  f.focus();Object.assign(f.viewport,{height:400,offsetTop:250});f.viewport.fire('resize');f.frame();
  assert.equal(f.style.getPropertyValue('--mio-mobile-height'),'400px');
  assert.equal(f.style.getPropertyValue('--mio-mobile-top'),'250px');
  assert.equal(f.classList.contains('miobot-mobile-keyboard'),true);
  f.viewport.offsetTop=110;f.viewport.fire('scroll');f.frame();
  assert.equal(f.style.getPropertyValue('--mio-mobile-top'),'110px','pan changes must work without a resize event');
  assert.equal(f.style.getPropertyValue('--mio-mobile-height'),'400px');
  f.window.scrollY=180;f.focus(null);Object.assign(f.viewport,{height:844,offsetTop:0});f.viewport.fire('resize');f.frame();
  assert.equal(f.style.getPropertyValue('--mio-mobile-height'),'844px');
  assert.equal(f.style.getPropertyValue('--mio-mobile-top'),'0px');
  assert.equal(f.classList.contains('miobot-mobile-keyboard'),false);
  assert.deepEqual(f.scrolls,[[0,0]],'only the outer document is reset after editing ends');
  unmount();
});

test('focusing with a hardware keyboard or changing browser chrome does not hide navigation as a software keyboard',()=>{
  const f=fixture(),unmount=f.mount();f.focus();f.frame();
  assert.equal(f.classList.contains('miobot-mobile-keyboard'),false);
  f.viewport.height=780;f.viewport.fire('resize');f.frame();
  assert.equal(f.style.getPropertyValue('--mio-mobile-height'),'780px');
  assert.equal(f.classList.contains('miobot-mobile-keyboard'),false);
  f.viewport.height=400;f.focus({tagName:'INPUT',type:'checkbox'});f.frame();
  assert.equal(f.classList.contains('miobot-mobile-keyboard'),false,'non-text controls do not imply a software keyboard');
  f.focus({tagName:'TEXTAREA',readOnly:true});f.frame();assert.equal(f.classList.contains('miobot-mobile-keyboard'),false);
  unmount();
});

test('pinch zoom keeps the current layout and permits panning until scale returns to one',()=>{
  const f=fixture(),unmount=f.mount();
  Object.assign(f.viewport,{height:422,offsetTop:130,scale:2});f.window.scrollY=260;
  f.viewport.fire('resize');f.viewport.fire('scroll');f.window.fire('scroll');f.frame();
  assert.equal(f.style.getPropertyValue('--mio-mobile-height'),'844px');
  assert.equal(f.style.getPropertyValue('--mio-mobile-top'),'0px');
  assert.equal(f.window.scrollY,260);assert.deepEqual(f.scrolls,[]);
  Object.assign(f.viewport,{height:760,offsetTop:0,scale:1});f.viewport.fire('resize');f.frame();
  assert.equal(f.style.getPropertyValue('--mio-mobile-height'),'760px');assert.deepEqual(f.scrolls,[[0,0]]);
  unmount();
});

test('orientation changes reset the height baseline before classifying a keyboard',()=>{
  const f=fixture(),unmount=f.mount();f.focus();
  f.window.innerWidth=844;f.document.documentElement.clientWidth=844;f.window.innerHeight=390;
  Object.assign(f.viewport,{width:844,height:300,offsetTop:0});f.window.fire('orientationchange');f.frame();
  assert.equal(f.style.getPropertyValue('--mio-mobile-height'),'300px');
  assert.equal(f.classList.contains('miobot-mobile-keyboard'),false,'portrait height is not used as the landscape baseline');
  f.viewport.height=170;f.viewport.fire('resize');f.frame();
  assert.equal(f.classList.contains('miobot-mobile-keyboard'),true);
  unmount();
});

test('browsers without VisualViewport follow innerHeight and use zero viewport offset',()=>{
  const f=fixture({visual:false}),unmount=f.mount();
  assert.equal(f.style.getPropertyValue('--mio-mobile-height'),'844px');
  f.window.innerHeight=560;f.window.fire('resize');f.frame();
  assert.equal(f.style.getPropertyValue('--mio-mobile-height'),'560px');
  assert.equal(f.style.getPropertyValue('--mio-mobile-top'),'0px');
  assert.equal(f.classList.contains('miobot-mobile-keyboard'),false);
  unmount();
});

test('tiny keyboard viewports are honored and delayed metrics after focus settle correctly',()=>{
  const f=fixture(),unmount=f.mount();f.focus();f.frame();
  assert.equal(f.classList.contains('miobot-mobile-keyboard'),false);
  Object.assign(f.viewport,{height:120,offsetTop:80});
  f.tick(80);
  assert.equal(f.style.getPropertyValue('--mio-mobile-height'),'120px','no artificial 320px minimum is introduced');
  assert.equal(f.style.getPropertyValue('--mio-mobile-top'),'80px');
  assert.equal(f.classList.contains('miobot-mobile-keyboard'),true);
  unmount();
});

test('unmount removes pending work and listeners and restores prior styles and classes for desktop',()=>{
  for(const classes of [[],['miobot-mobile-active','miobot-mobile-keyboard']]){
    const f=fixture({classes,styles:{'--mio-mobile-height':{value:'77vh',priority:'important'}}}),unmount=f.mount();
    f.focus();f.viewport.fire('resize');f.viewport.fire('scroll');
    assert.equal(f.frames.size,1,'one frame handles overlapping viewport events');assert.equal(f.timers.size,2);
    assert.ok(f.window.listenerCount()+f.document.listenerCount()+f.viewport.listenerCount()>0);
    unmount();
    assert.equal(f.frames.size,0);assert.equal(f.timers.size,0);
    assert.equal(f.window.listenerCount()+f.document.listenerCount()+f.viewport.listenerCount(),0);
    assert.equal(f.style.getPropertyValue('--mio-mobile-height'),'77vh');
    assert.equal(f.style.getPropertyPriority('--mio-mobile-height'),'important');
    assert.equal(f.style.getPropertyValue('--mio-mobile-top'),'');
    assert.equal(f.classList.contains('miobot-mobile-active'),classes.includes('miobot-mobile-active'));
    assert.equal(f.classList.contains('miobot-mobile-keyboard'),classes.includes('miobot-mobile-keyboard'));
    f.window.fire('resize');f.document.fire('focusout');f.viewport.fire('scroll');f.tick(1000);f.frame();
    assert.equal(f.style.getPropertyValue('--mio-mobile-height'),'77vh');assert.equal(f.frames.size,0);assert.equal(f.timers.size,0);
  }
});

test('keyboard resizing follows the latest reply only when the reader was already near the bottom',()=>{
  for(const readingHistory of [false,true]){
    const f=fixture(),unmount=f.mount(),writes=[];
    let position=readingHistory?1000:1290;
    const chat={
      scrollHeight:2000,
      get clientHeight(){return Math.max(0,Number.parseFloat(f.style.getPropertyValue('--mio-mobile-height'))-144);},
      get scrollTop(){return Math.min(position,this.scrollHeight-this.clientHeight);},
      set scrollTop(value){position=Math.max(0,Math.min(value,this.scrollHeight-this.clientHeight));writes.push(position);},
    };
    f.document.querySelector=selector=>selector==='.mm-page-chat'?chat:null;
    assert.equal(chat.clientHeight,700);
    f.focus();Object.assign(f.viewport,{height:400,offsetTop:110});f.viewport.fire('resize');f.frame();
    assert.equal(chat.clientHeight,256,'the fake panel measures the newly applied viewport height');
    if(readingHistory){
      assert.equal(chat.scrollTop,1000);assert.deepEqual(writes,[],'reading older messages must not jump to the latest reply');
    }else{
      assert.equal(chat.scrollTop,1744);assert.equal(chat.scrollHeight-chat.clientHeight-chat.scrollTop,0,'the latest reply remains visible after the keyboard shrinks the panel');
    }
    unmount();
  }
});
