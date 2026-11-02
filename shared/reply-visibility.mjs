const opening=/<(think|thinking|reasoning)>/iy;
const legacy=/^\s*🤔[ \t]*思考[:：]/u;
const candidates=['<think>','<thinking>','<reasoning>','🤔 思考:','🤔 思考：','🤔思考:','🤔思考：'];

/** Only provider/framework prefixes are removed; code and ordinary words stay. */
function presentation(value,final){
  if(typeof value!=='string')return {text:value,pending:false};
  let text=value;
  for(let pass=0;pass<32;pass++){
    const start=text.search(/\S/u);if(start<0)return {text:final?text:'',pending:!final};
    opening.lastIndex=start;const tag=opening.exec(text);
    if(tag){
      const close=new RegExp('</'+tag[1]+'>','ig');close.lastIndex=opening.lastIndex;const end=close.exec(text);
      if(!end)return {text:'',pending:!final};
      text=text.slice(close.lastIndex).replace(/^\s*\r?\n/u,'');continue;
    }
    if(legacy.test(text)){
      const divider=/\r?\n[ \t]*────[ \t]*\r?\n+/u.exec(text);
      if(!divider)return {text:final?text:'',pending:!final};
      text=text.slice(divider.index+divider[0].length);continue;
    }
    const trimmed=text.slice(start).toLowerCase();
    if(!final&&candidates.some(prefix=>prefix.toLowerCase().startsWith(trimmed)))return {text:'',pending:true};
    return {text,pending:false};
  }
  return {text:'',pending:!final};
}

export function visibleReply(text){return presentation(text,true).text;}

/** Hold an undecided prefix from its first character, never reveal then retract. */
export class ReplyVisibilityFilter{
  constructor(){this.raw='';this.emitted='';this.finished=false;}
  push(chunk){if(this.finished)return '';this.raw+=String(chunk??'');return this.delta(false);}
  delta(final){const {text}=presentation(this.raw,final);if(typeof text!=='string'||!text.startsWith(this.emitted))return '';const delta=text.slice(this.emitted.length);this.emitted=text;return delta;}
  finish(){if(this.finished)return '';this.finished=true;return this.delta(true);}
  get text(){return visibleReply(this.raw);}
}
