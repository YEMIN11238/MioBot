/** Only the user's actual text/button can authorize optional media generation. */
export function requestedMediaIntent(text,kind,{button=false}={}){
  if(typeof text!=='string')return false;
  const noun=kind==='voice'?'语音':'表情(?:包)?';
  const negative=new RegExp('(?:不要|不想|不用|不需要|别|停止|关闭|关掉|禁止|取消)[^，,。！？!?；;\\n]{0,18}'+noun);
  const positive=kind==='voice'?/(?:发(?:个|条|段)?|用|说(?:个|条|段)?|给我).{0,6}语音|(?:念|读)给我听/:/(?:发(?:个|张|些)?|用|给我).{0,6}表情/;
  let result=button;
  for(const clause of text.split(/[，,。！？!?；;\n]/u)){
    if(negative.test(clause))result=false;
    else if(positive.test(clause))result=true;
  }
  return result;
}
