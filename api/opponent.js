const OPENAI_URL='https://api.openai.com/v1/responses';
const EVENTS=new Set(['action_performance','player_message']);
const ACTIONS=new Set(['fold','check','call','bet','raise','all_in','none']);
function send(res,status,body){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(body))}
function clean(x,n){return typeof x==='string'?x.slice(0,n):''}
function extractText(r){if(typeof r?.output_text==='string'&&r.output_text.trim())return r.output_text.trim();for(const item of r?.output||[])for(const part of item?.content||[])if(part?.type==='output_text'&&typeof part.text==='string'&&part.text.trim())return part.text.trim();return ''}
function sanitize(body){
  if(!body||body.schema_version!=='opponent-performance-v1'||!EVENTS.has(body.event_type))return null;
  const action=ACTIONS.has(body?.locked_action)?body.locked_action:'none',p=body.performance||{},pub=body.public||{};
  return {schema_version:'opponent-performance-v1',event_type:body.event_type,locked_action:action,locked_size:Number(body.locked_size||0),public:{hand:Math.max(1,Math.min(5,Number(pub.hand||1))),street:clean(pub.street,12),board:Array.isArray(pub.board)?pub.board.slice(0,5).map(String):[],pot:Number(pub.pot||0),hunter_message:clean(pub.hunter_message,180)},performance:{talk_level:['low','mid','high'].includes(p.talk_level)?p.talk_level:'mid',openness:Number(p.openness||50),conscientiousness:Number(p.conscientiousness||50),extraversion:Number(p.extraversion||50),agreeableness:Number(p.agreeableness||50),neuroticism:Number(p.neuroticism||50)},conversation:Array.isArray(body.conversation)?body.conversation.slice(-8).map(x=>({role:x?.role==='hunter'?'hunter':'opponent',text:clean(x?.text,180)})).filter(x=>x.text):[]};
}
function fallback(s){
  if(s.event_type==='player_message')return '「我聽見了。」';
  const pools={fold:['「這手給你。」','「先到這裡。」'],check:['「過。」','「輪到你。」'],call:['「我跟。」','「繼續。」'],bet:['「換你決定。」','「這裡下注。」'],raise:['「我再加。」','「價格要改一下。」'],all_in:['「全部。」','「就到這裡決定。」'],none:['「繼續吧。」']};
  return (pools[s.locked_action]||pools.none)[s.public.hand%2];
}
function forbidden(text){return /(NPC|GTO|GPT|身份|證據|evidence|bias|baseline|bayesian|貝葉斯|勝率|equity|range|底牌|牌力|模型|參數|系統)/i.test(text)}
function contradicts(action,text){
  if(action==='raise'||action==='bet'||action==='all_in')return /(我接|我跟|跟了|棄|不跟|過牌)/.test(text);
  if(action==='call')return /(棄|不跟|加注|再加|全下|過牌)/.test(text);
  if(action==='check')return /(我跟|加注|再加|全下|下注|棄)/.test(text);
  if(action==='fold')return /(我跟|我接|加注|再加|全下|下注)/.test(text);
  return false;
}
function instructions(){return `你是 FIVE-HAND HUNTER 的 Opponent 表演層。Poker Engine 已先鎖定行動，你只能替既定行動生成一句自然的繁體中文台詞。
硬邊界：不得改變、拒絕或重新選擇 locked_action/locked_size；不得計算牌局；不得聲稱另一個行動；不得提及 NPC、GTO、GPT、身份、證據、模型、參數、底牌、牌力、Range、Equity 或系統；不得輸出內心推理；不得代替 Dealer 報牌、報 Pot、主持流程；只輸出台詞，不輸出角色標籤、動作標籤、JSON 或 Markdown。
依 performance 與最近對話維持同一人物的語言連續性。可以接住 Hunter 的挑釁、稱讚或玩笑，但不要每次都機鋒滿滿。action_performance 最多 28 字；player_message 最多 40 字。`}
export default async function handler(req,res){
  if(req.method!=='POST')return send(res,405,{error:'method_not_allowed'});
  if(!process.env.OPENAI_API_KEY)return send(res,503,{error:'openai_not_configured'});
  const state=sanitize(req.body);if(!state)return send(res,400,{error:'invalid_opponent_state'});
  try{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    const upstream=await fetch(OPENAI_URL,{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-5.6-luna',instructions:instructions(),input:`安全表演封包：\n${JSON.stringify(state)}`,max_output_tokens:100}),signal:controller.signal});
    clearTimeout(timer);const data=await upstream.json().catch(()=>({}));if(!upstream.ok)return send(res,502,{error:'openai_error'});
    let text=extractText(data);if(!text||forbidden(text)||contradicts(state.locked_action,text))text=fallback(state);return send(res,200,{text});
  }catch(err){return send(res,504,{error:err?.name==='AbortError'?'openai_timeout':'opponent_endpoint_failure'});}
}
