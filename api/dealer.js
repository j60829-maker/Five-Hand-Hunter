
const OPENAI_URL = 'https://api.openai.com/v1/responses';

const ALLOWED_EVENTS = new Set([
  'player_message',
  'invalid_action',
  'system_block',
  'showdown_reaction',
  'hand_reaction',
  'identity_analysis',
  'action_reaction',
  'phase_transition',
  'opponent_performance'
]);

// ==================================================
// 1. 荷官人格設定
// ==================================================

const PERSONA_RULES = {
  student:
    '活潑大學生：自然、親切、反應快；少量語助詞、低頻 emoji，不幼稚。',

  executive:
    '外商公司 CEO：俐落、專業、穩定，有管理者節奏；極少量自然英文。',

  moon:
    '月之精靈：冷冽、疏離、淡淡上對下；短句、克制、留白。'
};


// ==================================================
// 2. 回應與文字處理
// ==================================================

function send(res, status, body) {
  res.statusCode = status;

  res.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  res.setHeader('Cache-Control', 'no-store');

  res.end(JSON.stringify(body));
}


function extractText(response) {
  if (
    typeof response?.output_text === 'string' &&
    response.output_text.trim()
  ) {
    return response.output_text.trim();
  }

  for (const item of response?.output || []) {
    for (const part of item?.content || []) {
      if (
        part?.type === 'output_text' &&
        typeof part.text === 'string' &&
        part.text.trim()
      ) {
        return part.text.trim();
      }
    }
  }

  return '';
}


function cleanText(x, n) {
  return typeof x === 'string'
    ? x.slice(0, n)
    : '';
}


// ==================================================
// 3. 接收與整理遊戲資料
// ==================================================

function sanitizeState(body) {
  if (
    !body ||
    body.schema_version !== 'dealer-state-v1' ||
    !ALLOWED_EVENTS.has(body.event_type)
  ) {
    return null;
  }

  const persona = body?.dealer?.persona;

  if (!PERSONA_RULES[persona]) {
    return null;
  }

  const extra = body.extra || {};

  const identity =
    body.event_type === 'identity_analysis';

  return {
    schema_version: 'dealer-state-v1',

    event_type: body.event_type,

    match: {
      hand: Number(body?.match?.hand ?? 0),
      total_hands: 5,

      hero_stack: Number(
        body?.match?.hero_stack ?? 0
      ),

      opponent_stack: Number(
        body?.match?.opponent_stack ?? 0
      ),

      pot: Number(body?.match?.pot ?? 0),

      hand_ended: !!body?.match?.hand_ended,

      match_ended: !!body?.match?.match_ended
    },

    table: {
      street: cleanText(
        body?.table?.street,
        16
      ),

      board: Array.isArray(body?.table?.board)
        ? body.table.board.slice(0, 5).map(String)
        : [],

      hero_hole: Array.isArray(body?.table?.hero_hole)
        ? body.table.hero_hole.slice(0, 2).map(String)
        : [],

      opponent_hole_visible:
        Array.isArray(body?.table?.opponent_hole_visible)
          ? body.table.opponent_hole_visible
              .slice(0, 2)
              .map(String)
          : null,

      hero_position: cleanText(
        body?.table?.hero_position,
        16
      ),

      actor: ['hero', 'opp'].includes(
        body?.table?.actor
      )
        ? body.table.actor
        : null,

      hero_to_call:
        body?.table?.hero_to_call == null
          ? null
          : Number(body.table.hero_to_call),

      current_bet: Number(
        body?.table?.current_bet ?? 0
      )
    },

    dealer: {
      persona,

      conversation:
        Array.isArray(body?.dealer?.conversation)
          ? body.dealer.conversation
              .slice(-10)
              .map(t => ({
                role:
                  t?.role === 'hunter'
                    ? 'hunter'
                    : 'dealer',

                text: cleanText(t?.text, 220)
              }))
              .filter(t => t.text)
          : []
    },

    extra: {
      message: cleanText(extra.message, 240),

      winner: cleanText(extra.winner, 12),

      amount: Number(extra.amount ?? 0),

      heroHand: cleanText(extra.heroHand, 40),

      oppHand: cleanText(extra.oppHand, 40),

      matchEnded: !!extra.matchEnded,

      guess: identity
        ? cleanText(extra.guess, 8)
        : '',

      actual: identity
        ? cleanText(extra.actual, 8)
        : '',

      correct:
        identity && !!extra.correct,

      reason: identity
        ? cleanText(extra.reason, 700)
        : '',

      history: identity
        ? cleanText(extra.history, 7000)
        : ''
    }
  };
}


// ==================================================
// 4. AI 荷官指示
// ==================================================

function buildInstructions(persona, eventType) {
  const base =
    `你是 FIVE-HAND HUNTER 的 Dealer 表演層。程式負責真相，AI 只負責表演。\n` +
    `硬邊界：不得重算或改寫 Pot、Stack、Board、Hole Cards、Action、Winner；不得替 Hunter 決策；只處理這一次事件，不重新回答對話歷史中的舊問題；只輸出繁體中文荷官台詞，不輸出標籤、JSON 或 Markdown。\n` +
    `目前事件：${eventType}。人格：${PERSONA_RULES[persona]}`;

  if (eventType !== 'identity_analysis') {
   
  
  return (
    `${base}\n` +

    `這是牌局結束後的身份辨識回顧，不是逐手 Poker 教學。\n` +

    `【核心任務】\n` +
    `評估 Hunter 的身份推理是否受到實際證據支持，` +
    `並解釋對手的外顯行為與真實身份之間可能存在的差異。` +
    `不得為了證明已知答案正確而事後編造理由。\n` +

    `【證據篩選】\n` +
    `先閱讀整場牌局，只選擇最具有身份辨識價值的行為。` +
    `最多討論兩項關鍵發現；沒有就不要硬找。` +
    `不必逐手回顧，不要重述所有底牌與行動。` +
    `單次普通 Raise、Call、Fold，通常不足以辨識身份。\n` +

    `【RNG 與行為偏移】\n` +
    `NPC、GTO、GPT 的實際行動可能受到隨機抽樣影響。` +
    `因此，對手的外顯行為可能接近其他身份，` +
    `即使核心身份沒有改變。` +
    `不能只因某幾次行動符合特定身份，就認定該身份的核心機制正在運作。` +
    `若沒有實際 RNG 紀錄，不得斷言某個行動就是隨機抽樣造成。\n` +

    `【XXX-like 的 XXX】\n` +
    `這是一套描述外顯行為與核心身份差異的分析框架。` +
    `前面的 XXX-like 代表本場實際表現較接近哪一種身份；` +
    `後面的 XXX 代表程式已鎖定的真實身份。` +
    `例如 NPC-like 的 GTO，代表真實身份是 GTO，` +
    `但這場呈現出某些較接近 NPC 的行為特徵。` +
    `XXX-like 只是對本場表現的描述，不代表核心身份改變。` +
    `只有在具體行動提供足夠支持時才使用。` +
    `如果缺乏可辨識的行為差異，就不要硬套標籤。` +
    `不得因為知道真實身份，就反向指定一個 XXX-like 分類。\n` +

    `【身份與推理】\n` +
    `actual/correct 是程式鎖定的真相，不是行為證據。` +
    `Hunter 猜對不代表推理充分；猜錯也不代表觀察沒有價值。` +
    `應針對 Hunter 提供的理由，判斷其觀察是否成立。` +
    `Hunter 未提供理由時，不得替他發明理由。\n` +

    `【資訊限制】\n` +
    `可以使用事後揭露的底牌與公牌理解對手決策，` +
    `但不得把未攤牌的底牌當作 Hunter 當時已知的資訊。` +
    `不得捏造未記錄的 RNG 結果、決策機率、` +
    `NPC 固定偏好、GTO 策略偏移或 GPT 內部學習狀態。` +
    `如果資料不足以判定行為特徵，必須承認不確定性。\n` +

    `【輸出方式】\n` +
    `先回應 Hunter 的身份判斷，再討論最重要的證據。` +
    `若有充分支持，可以使用 XXX-like 的 XXX 描述行為偏移。` +
    `若沒有強證據，直接說明本場證據不足，簡短結束。` +
    `不逐手流水帳，不重複免責聲明，不使用空泛結論。` +
    `通常控制在 100 至 200 個繁體中文字，必要時可以更短。` +
    `只輸出自然的荷官台詞，不要列出分析規則或內部術語說明。`
  );


  }

  return (
    `${base}\n` +
    `這是牌局結束後的正式檢討。actual/correct 是程式真相。Hunter 行動只能描述對手面對的刺激，不能當作 Opponent 身份證據。強證據排序：核心機制（NPC 穩定 Bias / GTO Baseline discipline / GPT Evidence→Adaptation）> sizing/frequency/sequence/cross-hand adjustment > 語言、情緒、沉默等表面風格。若 decision space 或 evidence 不足，明說不確定；Hunter 沒理由就不要替他發明理由。`
  );
}


// ==================================================
// 5. Poker 階段的身份資訊保護
// ==================================================

function violatesPokerSilence(text) {
  return /(NPC|GTO|GPT|身份|證據|evidence|bias|baseline|bayesian|貝葉斯|線索|暗示|推測)/i.test(text);
}


function safePokerLine(eventType) {
  if (eventType === 'hand_reaction') {
    return '本手結束，準備下一手。';
  }

  if (eventType === 'showdown_reaction') {
    return '牌面與結果已確認。';
  }

  if (eventType === 'action_reaction') {
    return '行動已確認。';
  }

  return '收到。牌桌繼續。';
}


// ==================================================
// 6. OpenAI API 請求與回應
// ==================================================

export default async function handler(req, res) {

  // 僅接受 POST 請求
  if (req.method !== 'POST') {
    return send(res, 405, {
      error: 'method_not_allowed'
    });
  }

  // 確認 API 金鑰存在
  if (!process.env.OPENAI_API_KEY) {
    return send(res, 503, {
      error: 'openai_not_configured'
    });
  }

  // 驗證並整理傳入的遊戲資料
  const state = sanitizeState(req.body);

  if (!state) {
    return send(res, 400, {
      error: 'invalid_dealer_state'
    });
  }

  try {

    // 建立請求控制器與 30 秒等待上限
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      30000
    );

    // 向 OpenAI 發送請求
    const upstream = await fetch(OPENAI_URL, {
      method: 'POST',

      headers: {
        Authorization:
          `Bearer ${process.env.OPENAI_API_KEY}`,

        'Content-Type': 'application/json'
      },

      body: JSON.stringify({
        model:
          process.env.OPENAI_MODEL ||
          'gpt-5.6-luna',

        instructions: buildInstructions(
          state.dealer.persona,
          state.event_type
        ),

        input:
          `以下是程式鎖定事件，只根據它生成完整、不截斷的台詞：\n${JSON.stringify(state)}`,

        max_output_tokens:
          state.event_type === 'identity_analysis'
            ? 2000
            : 180
      }),

      signal: controller.signal
    });

    // 停止逾時計時
    clearTimeout(timeout);

    // 讀取 OpenAI 回應
    const data = await upstream
      .json()
      .catch(() => ({}));

    // 處理 OpenAI 回傳的錯誤
    if (!upstream.ok) {
      console.error(
        'OpenAI dealer error',
        upstream.status,
        data?.error?.message || data
      );

      return send(res, 502, {
        error: 'openai_error'
      });
    }

    // 紀錄回應狀態，供除錯使用
    console.log('Dealer AI response:', {
      status: data.status,

      incompleteReason:
        data.incomplete_details?.reason,

      outputTokens:
        data.usage?.output_tokens,

      reasoningTokens:
        data.usage?.output_tokens_details?.reasoning_tokens,

      maxOutputTokens:
        data.max_output_tokens
    });

    // 偵測 AI 回應是否不完整
    if (data.status === 'incomplete') {
      return send(res, 502, {
        error:
          `openai_incomplete_${data.incomplete_details?.reason || 'unknown'}`
      });
    }

    // 提取 AI 文字
    let text = extractText(data);

    if (!text) {
      return send(res, 502, {
        error: 'empty_model_output'
      });
    }

    // Poker 階段不得洩漏身份資訊
    if (
      state.event_type !== 'identity_analysis' &&
      violatesPokerSilence(text)
    ) {
      text = safePokerLine(state.event_type);
    }

    // 將 AI 文字回傳給 App
    return send(res, 200, {
      text
    });

  } catch (err) {

    console.error(
      'Dealer endpoint failure',
      err?.name || err?.message || err
    );

    return send(res, 504, {
      error:
        err?.name === 'AbortError'
          ? 'openai_timeout'
          : 'dealer_endpoint_failure'
    });
  }
}
