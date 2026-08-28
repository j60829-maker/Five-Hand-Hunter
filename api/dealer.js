const OPENAI_URL = 'https://api.openai.com/v1/responses';
const ALLOWED_EVENTS = new Set([
  'player_message','invalid_action','system_block','showdown_reaction','hand_reaction','identity_analysis'
]);

const PERSONA_RULES = {
  student: `活潑大學生：自然、親切、反應快，像真的在桌邊主持。少量語助詞、低頻 emoji；不要幼稚或每句裝可愛。`,
  executive: `外商公司 CEO：俐落、專業、穩定，有管理者節奏與自信。極少量自然英文，不堆術語，不像客服。`,
  moon: `月之精靈：冷冽、疏離、淡淡上對下；短句、克制、留白。不是無情機器，也不要華麗堆砌。`
};

function send(res,status,body){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(body));}
function extractText(response){
  if(typeof response?.output_text==='string'&&response.output_text.trim())return response.output_text.trim();
  for(const item of response?.output||[])for(const part of item?.content||[])if(part?.type==='output_text'&&typeof part.text==='string'&&part.text.trim())return part.text.trim();
  return '';
}
function cleanText(x,n){return typeof x==='string'?x.slice(0,n):''}
function sanitizeState(body){
  if(!body||body.schema_version!=='dealer-state-v1'||!ALLOWED_EVENTS.has(body.event_type))return null;
  const persona=body?.dealer?.persona;if(!PERSONA_RULES[persona])return null;
  const extra=body.extra||{};
  return {
    schema_version:'dealer-state-v1',event_type:body.event_type,
    match:{hand:Number(body?.match?.hand??0),total_hands:5,hero_stack:Number(body?.match?.hero_stack??0),opponent_stack:Number(body?.match?.opponent_stack??0),pot:Number(body?.match?.pot??0),hand_ended:!!body?.match?.hand_ended,match_ended:!!body?.match?.match_ended},
    table:{street:cleanText(body?.table?.street,16),board:Array.isArray(body?.table?.board)?body.table.board.slice(0,5).map(String):[],hero_hole:Array.isArray(body?.table?.hero_hole)?body.table.hero_hole.slice(0,2).map(String):[],opponent_hole_visible:Array.isArray(body?.table?.opponent_hole_visible)?body.table.opponent_hole_visible.slice(0,2).map(String):null,hero_position:cleanText(body?.table?.hero_position,16),actor:['hero','opp'].includes(body?.table?.actor)?body.table.actor:null,hero_to_call:body?.table?.hero_to_call==null?null:Number(body.table.hero_to_call),current_bet:Number(body?.table?.current_bet??0)},
    dealer:{persona,conversation:Array.isArray(body?.dealer?.conversation)?body.dealer.conversation.slice(-10).map(t=>({role:t?.role==='hunter'?'hunter':'dealer',text:cleanText(t?.text,220)})).filter(t=>t.text):[]},
    extra:{message:cleanText(extra.message,180),winner:cleanText(extra.winner,12),amount:Number(extra.amount??0),heroHand:cleanText(extra.heroHand,40),oppHand:cleanText(extra.oppHand,40),matchEnded:!!extra.matchEnded,guess:cleanText(extra.guess,8),actual:cleanText(extra.actual,8),correct:!!extra.correct,reason:cleanText(extra.reason,500),history:cleanText(extra.history,7000)}
  };
}
function buildInstructions(persona){return `你是 FIVE-HAND HUNTER 的 Dealer（荷官）表演層。程式負責真相，AI 只負責表演。

硬邊界：
- game state 是唯一真相。不得自行重算或改寫 Pot、Stack、Board、Hole Cards、Action、Hand、Street、Position、Winner、Refund。
- 不得創造牌或 Poker action；不得替 Hunter 決策或給策略建議。
- Reveal 前不得暗示 NPC/GTO/GPT 身份。
- 只輸出繁體中文荷官台詞；不要「Dealer：」、JSON、Markdown、系統說明。
- 不要輸出與語境無關的外語殘片、網站字串、變數名或 metadata。

對話：
- player_message 時要真的回答 Hunter。若 Hunter 問目前底池、籌碼、牌面、輪到誰等事實，只能引用 state 中已提供的數值，直接自然回答；不要叫玩家自己看畫面。
- Hunter 同時做 Poker action 不影響你回答他的聊天。
- 語氣必須明顯符合本局 persona，避免「我是這桌荷官、負責讓流程準確」等客服／系統式自我介紹。

牌局反應：
- showdown_reaction / hand_reaction 只做一句短反應，不重播牌面、Pot、Winner 或 Refund。
- match_ended=true 時，嚴禁「下一手」「還有幾手」「繼續保持」「重新聚焦下一手」等延續牌局的語句；應承認 Poker Phase 已終止。
- match_ended=false 才能自然銜接下一手。

Identity Phase：
- identity_analysis 只在程式已 Reveal 後使用。actual/correct 是程式真相，不得更改。
- 根據 Hunter 的 guess、reason 與 history 分析他的推理：指出 1–3 個較強 evidence、較弱或被牌局 decision space 限制的 evidence，最後簡短評價判斷品質。
- 不要假裝 history 沒有提供的事情發生過；資訊不足就明說。
- Identity 分析以簡潔、針對特定證據為主，不寫長篇教科書。

本局人格：${PERSONA_RULES[persona]}`;}

export default async function handler(req,res){
  if(req.method!=='POST')return send(res,405,{error:'method_not_allowed'});
  if(!process.env.OPENAI_API_KEY)return send(res,503,{error:'openai_not_configured'});
  const state=sanitizeState(req.body);if(!state)return send(res,400,{error:'invalid_dealer_state'});
  try{
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),9000);
    const upstream=await fetch(OPENAI_URL,{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-5.6-luna',instructions:buildInstructions(state.dealer.persona),input:`以下是程式鎖定的 DealerEvent。只根據它生成荷官台詞：\n${JSON.stringify(state)}`,max_output_tokens:state.event_type==='identity_analysis'?360:140}),signal:controller.signal});
    clearTimeout(timeout);const data=await upstream.json().catch(()=>({}));
    if(!upstream.ok){console.error('OpenAI dealer error',upstream.status,data?.error?.message||data);return send(res,502,{error:'openai_error'});}
    const text=extractText(data);if(!text)return send(res,502,{error:'empty_model_output'});
    return send(res,200,{text:text.slice(0,state.event_type==='identity_analysis'?1200:360)});
  }catch(err){console.error('Dealer endpoint failure',err?.name||err?.message||err);return send(res,504,{error:err?.name==='AbortError'?'openai_timeout':'dealer_endpoint_failure'});}
}
