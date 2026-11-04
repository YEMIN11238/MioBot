/** A deterministic AstrBot HTTP fixture. It never opens a network connection. */
export function nativeFixture() {
  const calls = [], sources = new Map(), providers = new Map(), personas = new Map(), profiles = new Map(), bots = new Map(), routes = new Map();
  let session = 0;
  const controls = {failChat: false, syncFails:false, delay: 0, testStatus: 'available', testError:'fixture provider rejected its key',sendFails: false, aborted: 0};
  const templates = {
    'OpenAI Compatible': {id:'openai',provider:'openai',type:'openai_chat_completion',provider_type:'chat_completion',enable:true,key:[],api_base:'https://api.openai.com/v1',custom_headers:{}},
    'Google Gemini': {id:'google_gemini',provider:'google',type:'googlegenai_chat_completion',provider_type:'chat_completion',enable:true,key:[],api_base:'https://generativelanguage.googleapis.com',gm_native_search:false},
    'Anthropic': {id:'anthropic',provider:'anthropic',type:'anthropic_chat_completion',provider_type:'chat_completion',enable:true,key:[],api_base:'https://api.anthropic.com'},
  };
  const botTypes = [
    {id:'telegram',type:'telegram',display_name:'Telegram',description:'Fixture Telegram',default_config:{id:'',type:'telegram',enable:false,token:''},schema:{token:{type:'string',obvious_hint:'access token'}},support_proactive_message:true,support_streaming_message:false},
    {id:'fixture-passive',type:'fixture-passive',display_name:'Passive fixture',default_config:{id:'',type:'fixture-passive',enable:false,password:''},schema:{password:{type:'string'}},support_proactive_message:false,support_streaming_message:false},
  ];
  const ok = data => Response.json({status:'ok',data});
  const fetcher = async (url, options = {}) => {
    const u = new URL(url), path = u.pathname.replace(/^\/api\/v1/,''), method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({path,method,body,query:Object.fromEntries(u.searchParams)});
    if(controls.syncFails&&path==='/personas')return Response.json({status:'error',message:'fixture runtime unavailable'},{status:503});
    if (path === '/personas') {
      if(method === 'POST') personas.set(body.persona_id,body);
      return ok(method === 'GET' ? [...personas.values()] : {});
    }
    if(path === '/personas/by-id'){personas.set(body.persona_id,body);return ok({});}
    if(path === '/plugins')return ok(['astrbot_plugin_wanna_be_human','astrbot_plugin_dafeiyu_clean'].map(name=>({name,version:'fixture',activated:true})));
    if(path === '/providers/schema') return ok({config_schema:{provider:{config_template:templates}},providers:[...providers.values()],provider_sources:[...sources.values()]});
    if(path === '/provider-sources' && method === 'POST'){sources.set(body.id,body);return ok({});}
    if(path === '/provider-sources' && method === 'GET') return ok({provider_sources:[...sources.values()]});
    if(path === '/provider-sources/providers' && method === 'POST'){providers.set(body.id,{...body,provider_source_id:body.source_id});return ok({});}
    if(path === '/provider-sources/models')return ok({models:['fixture-a','fixture-b']});
    if(path === '/providers')return ok({providers:[...providers.values()]});
    if(path === '/providers/by-id' && method === 'PUT'){const config=body.config || body.provider_config || body;providers.set(body.provider_id,{...config,id:body.provider_id});return ok({});}
    if(path === '/providers/test')return ok({status:controls.testStatus,error:controls.testStatus==='available'?null:controls.testError});
    if(path === '/config-profiles/schema')return ok({config:{provider_settings:{},platform:[]}});
    if(path === '/config-profiles'){
      if(method==='GET')return ok({info_list:[...profiles.values()]});
      const id='profile-'+(profiles.size+1);profiles.set(id,{conf_id:id,name:body.name,config:body.config});return ok({conf_id:id});
    }
    if(path.startsWith('/config-profiles/')){const id=decodeURIComponent(path.slice('/config-profiles/'.length));if(method==='GET')return ok({config:profiles.get(id)?.config});profiles.set(id,{...profiles.get(id),config:body});return ok({});}
    if(path==='/config-routes'){if(method==='PUT'){routes.clear();for(const [umo,id] of Object.entries(body.routing||{}))routes.set(umo,id);}return ok({routing:Object.fromEntries(routes)});}
    if(path.startsWith('/config-routes/')){const umo=decodeURIComponent(path.slice('/config-routes/'.length));if(method==='DELETE')routes.delete(umo);else if(method==='PUT')routes.set(umo,body.config_id);return ok({});}
    if(path === '/chat/sessions/new')return ok({session_id:'fixture-session-'+(++session)});
    if(/^\/chat\/sessions\/[^/]+\/stop$/.test(path))return ok({status:'stopping'});
    if(path === '/bot-types')return ok({bot_types:botTypes});
    if(path === '/bots'){
      if(method==='POST'){const config=body.config||body;bots.set(config.id,config);}
      return ok(method==='GET'?{bots:[...bots.values()]}:{});
    }
    if(path === '/bots/by-id'){
      if(method==='PUT')bots.set(body.bot_id,{...(body.config||body),id:body.bot_id});
      if(method==='DELETE')bots.delete(u.searchParams.get('bot_id'));
      return ok({bot:bots.get(u.searchParams.get('bot_id'))||{}});
    }
    if(path === '/bots/enabled'){const b=bots.get(body.bot_id);if(b)b.enable=body.enabled;return ok({});}
    if(path === '/bots/stats')return ok(Object.fromEntries([...bots.keys()].map(id=>[id,{status:'running',message_count:0}])));
    if(path === '/im/messages'){
      if(controls.sendFails)return Response.json({status:'error',message:'fixture adapter send failed'},{status:502});
      return ok({});
    }
    if(path === '/chat'){
      const signal=options.signal;
      const stream = new ReadableStream({
        async start(controller){
          const emit=e=>controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(e)+'\n\n'));
          if(controls.delay)await new Promise(r=>setTimeout(r,controls.delay));
          if(signal?.aborted){controls.aborted++;controller.error(new DOMException('Aborted','AbortError'));return;}
          if(controls.failChat){emit({type:'error',data:'fixture model failed'});controller.close();return;}
          if(controls.responseText){emit({type:'plain',data:controls.responseText,chain_type:'normal'});controller.close();return;}
          emit({type:'plain',data:'你好',chain_type:'normal'});
          if(controls.delay)await new Promise(r=>setTimeout(r,controls.delay));
          if(signal?.aborted){controls.aborted++;controller.error(new DOMException('Aborted','AbortError'));return;}
          emit({type:'plain',data:'，这是模拟回答。',chain_type:'normal'});controller.close();
        },
      });
      return new Response(stream,{headers:{'Content-Type':'text/event-stream'}});
    }
    throw new Error('Unexpected fixture request: '+method+' '+path);
  };
  return {fetcher,calls,controls,sources,providers,personas,profiles,bots,routes};
}
