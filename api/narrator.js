const OPENAI_URL='https://api.openai.com/v1/responses';
const CUES=new Set(['table_waits','light_shifts','room_tightens','chair_empty','cards_rest','door_closes']);
function send(res,status,body){res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(body))}
function extractText(r){if(typeof r?.output_text==='string'&&r.output_text.trim())return r.output_text.trim();for(const item of r?.output||[])for(const part of item?.content||[])if(part?.type==='output_text'&&typeof part.text==='string'&&part.text.trim())return part.text.trim();return ''}
function sanitize(body){if(!body||body.schema_version!=='narrator-camera-v1'||!CUES.has(body.visual_cue))return null;return {schema_version:'narrator-camera-v1',visual_cue:body.visual_cue}}
function fallback(cue){return {table_waits:'桌燈落在深色絨布上，房間其餘地方安靜地退入陰影。',light_shifts:'桌面的光微微偏了一寸，牌室裡只剩空調低沉的聲音。',room_tightens:'遠處的玻璃映著桌燈，四周的聲音彷彿被厚重地毯吸收。',chair_empty:'對面的椅子空了，椅背仍停在離桌面不遠的位置。',cards_rest:'牌堆安靜地留在桌面中央，邊緣接住一線冷光。',door_closes:'門在遠處闔上，牌室重新只剩燈光與靜止的桌面。'}[cue]}
function forbidden(text){return /(Hunter|Opponent|Dealer|玩家|獵人|對手|荷官|NPC|GTO|GPT|身份|證據|線索|暗示|推測|心理|緊張|猶豫|憤怒|自信|牌力|底牌|下注|籌碼|勝率|Range|Equity|Bias|Baseline|Bayesian|貝葉斯|系統|參數)/i.test(text)}
function instructions(){return `你是中立的環境攝影機，不是全知敘事者。唯一目的，是替 FIVE-HAND HUNTER 製造沉浸氛圍。
你只能描述沒有分析價值的風景：空間、桌面材質、空椅、光線、陰影、遠處聲音、空調、門與靜止物件。不得描寫任何人物的動作、表情、語氣、身體反應或心理；不得提及玩家、對手、荷官；不得知道或推測牌局、籌碼、底牌、行動、身份、證據、系統設定或任何參數。只有氛圍，沒有答案。
根據 visual_cue 寫一句 18–42 字的繁體中文背景描述。不要解釋 cue，不輸出標籤、JSON、Markdown 或引號。`}
export default async function handler(req,res){
  if(req.method!=='POST')return send(res,405,{error:'method_not_allowed'});
  if(!process.env.OPENAI_API_KEY)return send(res,503,{error:'openai_not_configured'});
  const state=sanitize(req.body);if(!state)return send(res,400,{error:'invalid_narrator_state'});
  try{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    const upstream=await fetch(OPENAI_URL,{method:'POST',headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-5.6-luna',instructions:instructions(),input:JSON.stringify(state),max_output_tokens:90}),signal:controller.signal});
    clearTimeout(timer);const data=await upstream.json().catch(()=>({}));if(!upstream.ok)return send(res,502,{error:'openai_error'});
    let text=extractText(data);if(!text||forbidden(text))text=fallback(state.visual_cue);return send(res,200,{text});
  }catch(err){return send(res,504,{error:err?.name==='AbortError'?'openai_timeout':'narrator_endpoint_failure'});}
}
