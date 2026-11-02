import {setTimeout as delay} from 'node:timers/promises';
import {conversationalParts} from './assistant-profiles.mjs';

export const partPause=text=>Math.min(850,350+Math.min(text.length,50)*10);

/** Deliver only reviewed text. An abort never exposes the remaining parts. */
export async function deliverConversation(text,{signal,onPart,wait=ms=>delay(ms,undefined,{signal})}={}){
  const parts=conversationalParts(text,true);
  for(let index=0;index<parts.length;index++){
    signal?.throwIfAborted();
    if(index)await wait(partPause(parts[index-1]));
    signal?.throwIfAborted();
    await onPart(parts[index],index);
  }
  return parts;
}
