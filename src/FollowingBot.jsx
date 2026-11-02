import React, {useEffect, useRef, useState} from 'react';
import Tilt from 'react-parallax-tilt';
import './following-bot.css';

/** A small, window-local mascot. The surrounding button keeps its own hit area. */
export default function FollowingBot() {
  const anchor=useRef(null);
  const [angles,setAngles]=useState({x:0,y:0});
  const [reduced,setReduced]=useState(()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(()=>{
    const preference=window.matchMedia('(prefers-reduced-motion: reduce)');
    const change=()=>setReduced(preference.matches);
    preference.addEventListener('change',change);
    return ()=>preference.removeEventListener('change',change);
  },[]);

  useEffect(()=>{
    const node=anchor.current;
    let frame=0,last=0,current={x:0,y:0},target={x:0,y:0};
    const paint=()=>{
      node.style.setProperty('--gaze-x',`${(current.x*4.5).toFixed(3)}px`);
      node.style.setProperty('--gaze-y',`${(current.y*3.8).toFixed(3)}px`);
      node.style.setProperty('--gaze-roll',`${(current.x*5).toFixed(3)}deg`);
      setAngles({x:Number((-current.y*13).toFixed(3)),y:Number((current.x*17).toFixed(3))});
    };
    const animate=now=>{
      frame=0;
      const blend=1-Math.exp(-Math.min(last?now-last:16,64)/80);last=now;
      current.x+=(target.x-current.x)*blend;current.y+=(target.y-current.y)*blend;
      const settled=Math.abs(target.x-current.x)+Math.abs(target.y-current.y)<0.001;
      if(settled)current={...target};
      paint();node.dataset.motion=settled?'idle':'following';
      if(!settled)frame=requestAnimationFrame(animate);else last=0;
    };
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(animate);};
    const neutral=immediate=>{
      target={x:0,y:0};
      if(immediate){cancelAnimationFrame(frame);frame=0;last=0;current={...target};paint();node.dataset.motion='idle';}
      else schedule();
    };
    neutral(true);
    if(reduced){node.dataset.motion='disabled';return;}
    const move=event=>{
      if(document.hidden||!['mouse','pen'].includes(event.pointerType))return;
      const box=node.getBoundingClientRect();
      const dx=event.clientX-box.left-box.width/2,dy=event.clientY-box.top-box.height/2;
      // A soft distance limit keeps the eyes inside the face, even at window edges.
      const distance=Math.hypot(dx,dy,180);
      target={x:dx/distance,y:dy/distance};schedule();
    };
    const out=event=>{if(!event.relatedTarget)neutral(false);};
    const blur=()=>neutral(true);
    const visibility=()=>{if(document.hidden)neutral(true);};
    window.addEventListener('pointermove',move,{passive:true});
    window.addEventListener('pointerout',out,{passive:true});
    window.addEventListener('blur',blur);
    document.addEventListener('visibilitychange',visibility);
    return ()=>{
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove',move);
      window.removeEventListener('pointerout',out);
      window.removeEventListener('blur',blur);
      document.removeEventListener('visibilitychange',visibility);
    };
  },[reduced]);

  return <span className="mio-tracker" ref={anchor} aria-hidden="true">
    <Tilt className="mio-head" tiltEnable={!reduced} tiltAngleXManual={angles.x} tiltAngleYManual={angles.y} perspective={220} transitionSpeed={0} glareEnable={false} scale={1} gyroscope={false}>
      <span className="orb"><span className="mio-eye-pair"><i/><i/></span></span>
    </Tilt>
  </span>;
}
