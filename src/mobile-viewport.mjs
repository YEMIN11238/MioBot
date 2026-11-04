const properties=['--mio-mobile-height','--mio-mobile-top'];

function isEditing(document){
  const element=document.activeElement;
  if(!element||element.disabled||element.readOnly)return false;
  if(element.isContentEditable)return true;
  if(element.tagName==='TEXTAREA')return true;
  return element.tagName==='INPUT'&&!['button','submit','reset','checkbox','radio','range','color','file','hidden'].includes(element.type);
}

/** Keep the mobile shell inside the visible area, including Safari's focus pan.
 * The keyboard can change height and offset independently of the layout viewport.
 * Pinch zoom deliberately keeps the last layout so the user can pan enlarged text.
 */
export function mountMobileViewport({window:win=globalThis.window,document:doc=globalThis.document}={}){
  const root=doc.documentElement,viewport=win.visualViewport;
  const previous=properties.map(name=>[name,root.style.getPropertyValue(name),root.style.getPropertyPriority(name)]);
  const hadMobile=root.classList.contains('miobot-mobile-active'),hadKeyboard=root.classList.contains('miobot-mobile-keyboard');
  let frame=null,active=true,baselineHeight=win.innerHeight,baselineWidth=win.innerWidth;
  const timers=new Set();
  root.classList.add('miobot-mobile-active');

  function update(){
    frame=null;if(!active)return;
    const scale=viewport?.scale||1;
    // Do not resize the layout, recenter it or fight visual-viewport panning while zoomed.
    if(Math.abs(scale-1)>.02)return;
    const height=viewport?.height||win.innerHeight;
    if(!Number.isFinite(height)||height<=0)return;
    const width=doc.documentElement.clientWidth||win.innerWidth;
    if(Math.abs(width-baselineWidth)>1){baselineWidth=width;baselineHeight=win.innerHeight;}
    baselineHeight=Math.max(baselineHeight,win.innerHeight,height);
    const editing=isEditing(doc),keyboard=editing&&baselineHeight-height>Math.max(100,baselineHeight*.18);
    const top=Math.max(0,Number(viewport?.offsetTop)||0);
    const chat=doc.querySelector?.('.mm-page-chat');
    const wasAtBottom=chat&&chat.scrollHeight-chat.clientHeight-chat.scrollTop<=48;
    root.style.setProperty('--mio-mobile-height',height+'px');
    root.style.setProperty('--mio-mobile-top',top+'px');
    root.classList.toggle('miobot-mobile-keyboard',keyboard);
    // Keep the latest reply visible when typing, but do not pull a reader out of history.
    if(wasAtBottom)chat.scrollTop=chat.scrollHeight;
    // Safari can leave a document scroll behind after the keyboard closes.
    // Scrollable chat/form panels keep their own position; only the outer page resets.
    if(!editing&&(win.scrollX||win.scrollY))win.scrollTo(0,0);
  }
  function schedule(){if(active&&frame===null)frame=win.requestAnimationFrame(update);}
  function settle(){
    schedule();
    for(const timer of timers)win.clearTimeout(timer);timers.clear();
    // Focus and orientation events can precede Safari's keyboard animation metrics.
    for(const delay of [80,350]){const timer=win.setTimeout(()=>{timers.delete(timer);schedule();},delay);timers.add(timer);}
  }
  const listeners=[
    [viewport,'resize',schedule],[viewport,'scroll',schedule],
    [win,'resize',schedule],[win,'scroll',schedule],[win,'orientationchange',settle],[win,'pageshow',settle],
    [doc,'focusin',settle],[doc,'focusout',settle],
  ];
  for(const [target,event,handler] of listeners)target?.addEventListener(event,handler);
  update();
  return()=>{
    active=false;
    for(const [target,event,handler] of listeners)target?.removeEventListener(event,handler);
    if(frame!==null)win.cancelAnimationFrame(frame);
    for(const timer of timers)win.clearTimeout(timer);
    for(const [name,value,priority] of previous){if(value)root.style.setProperty(name,value,priority);else root.style.removeProperty(name);}
    root.classList.toggle('miobot-mobile-active',hadMobile);
    root.classList.toggle('miobot-mobile-keyboard',hadKeyboard);
  };
}
