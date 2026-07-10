/**
 * LINE予定登録ボット → Googleカレンダー
 *
 * LINEのトークで届いた予定(「9/20 10時に港集合」等)をボットに転送すると、
 * 日時を読み取ってGoogleカレンダーに予定を登録し、確認の返事を返します。
 * グループトークに招待すれば、日時を含む発言を自動で拾うこともできます。
 *
 * 対応している日時表現:
 *  - 日付: 9/20、9月20日、2026/9/20、今日、明日、明後日、土曜、来週土曜、再来週金曜
 *  - 時刻: 10:00、10時、10時半、10時15分、午後7時、夜8時 (時刻なしなら終日予定)
 *
 * 使い方は同フォルダの README.md を参照。
 */

// LINE DevelopersのMessaging API設定で発行した
// 「チャネルアクセストークン(長期)」をここに貼り付ける
const LINE_CHANNEL_ACCESS_TOKEN = 'ここにチャネルアクセストークンを貼る';

// (任意) Google AI Studio (aistudio.google.com) で発行した無料のAPIキー。
// 貼ると、AIがメッセージを読んで「釣り」「飲み会」のような短いタイトルを
// 自動生成する。空のままでもキーワード辞書方式で動く。
const GEMINI_API_KEY = '';

const LINE_CONFIG = {
  // 予定を入れるカレンダー。'primary' ならデフォルトカレンダー
  calendarId: 'primary',
  // 時刻ありの予定の長さ(分)
  defaultDurationMinutes: 60,
};

// キーワード辞書方式で使う語(上にあるものほど優先)。自由に追加OK
const TITLE_KEYWORDS = [
  '釣り', '船釣り', '出港', 'ゴルフ', 'キャンプ', 'BBQ', 'バーベキュー',
  '飲み会', '忘年会', '新年会', '歓迎会', '送別会', '飲み',
  '焼肉', '寿司', 'ランチ', 'ディナー', 'ご飯', 'ごはん', '食事',
  '温泉', '旅行', '帰省', '映画', 'ライブ', '野球', 'サッカー', '麻雀',
  '買い物', '病院', '歯医者', '美容室', '美容院', '床屋',
  '打ち合わせ', '会議', 'ミーティング', '面談', '参観', '送迎', '集合',
];

// このボットが作成した予定の目印(説明欄に埋め込む)
const LINE_AUTO_MARKER = '--- 自動登録 (LINE予定登録ボット) ---';

/** LINEからのWebhookを受け取る入口(ウェブアプリとしてデプロイする) */
function doPost(e) {
  try {
    const json = JSON.parse(e.postData.contents);
    (json.events || []).forEach(handleLineEvent);
  } catch (err) {
    Logger.log('doPostエラー: ' + err);
  }
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }));
}

/** LINEのイベント1件を処理する */
function handleLineEvent(ev) {
  // 友だち追加されたら使い方を返す
  if (ev.type === 'follow') {
    replyToLine(
      ev.replyToken,
      '友だち追加ありがとうございます！\n' +
        '予定にしたいメッセージをこのトークに転送(または入力)してください。\n\n' +
        '例:「9/20 10時 釣り 港集合」\n' +
        '「明日19時に飲み会」\n\n' +
        '日時を読み取ってGoogleカレンダーに登録します。'
    );
    return;
  }

  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;

  const text = ev.message.text;
  const parsed = parseDateTimeJa(text, new Date());
  const isGroup = ev.source && ev.source.type !== 'user';

  if (!parsed) {
    // グループでは日時のない発言に反応しない(1対1のときだけ案内を返す)
    if (!isGroup) {
      replyToLine(
        ev.replyToken,
        '日時が読み取れませんでした🙏\n' +
          '「9/20 10:00 釣り」「明日19時 飲み会」のように、日付と時刻を含めて送ってください。'
      );
    }
    return;
  }

  const calendar =
    LINE_CONFIG.calendarId === 'primary'
      ? CalendarApp.getDefaultCalendar()
      : CalendarApp.getCalendarById(LINE_CONFIG.calendarId);

  const title = '📱 ' + makeEventTitle(text, parsed.title);
  const options = { description: '元のメッセージ:\n' + text + '\n\n' + LINE_AUTO_MARKER };

  let when;
  if (parsed.hasTime) {
    const end = new Date(
      parsed.start.getTime() + LINE_CONFIG.defaultDurationMinutes * 60 * 1000
    );
    calendar.createEvent(title, parsed.start, end, options);
    when = formatJa(parsed.start) + '〜';
  } else {
    calendar.createAllDayEvent(title, parsed.start, options);
    when = formatJa(parsed.start, true) + ' (終日)';
  }

  replyToLine(ev.replyToken, '📅 カレンダーに登録しました\n' + when + '\n' + title);
}

/**
 * メッセージから予定のタイトルを作る。
 *  1. Gemini APIキーが設定されていればAIに要約させる(無料枠で動作)
 *  2. AIが使えない/失敗した場合はキーワード辞書から抽出
 *  3. どちらもダメなら日時を除いた残りの文(fallback)を短くして使う
 */
function makeEventTitle(text, fallback) {
  if (GEMINI_API_KEY) {
    const aiTitle = generateTitleWithGemini(text);
    if (aiTitle) return aiTitle;
  }
  return extractTitleByRules(text, fallback);
}

/** Gemini APIで短いタイトルを生成する。失敗時は null */
function generateTitleWithGemini(text) {
  try {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' +
      GEMINI_API_KEY;
    const prompt =
      '次のLINEメッセージは、ある予定について話しています。' +
      'カレンダーに登録する短いタイトルを日本語で1つだけ出力してください。\n' +
      '- 2〜10文字程度の名詞句にする(例: 釣り、飲み会、田中さんとランチ)\n' +
      '- 日時・曜日は含めない\n' +
      '- タイトルの文字列だけを出力し、説明・引用符・記号は付けない\n\n' +
      'メッセージ:\n' + text;

    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 500, temperature: 0.2 },
      }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('Gemini APIエラー: ' + res.getContentText().slice(0, 300));
      return null;
    }
    const data = JSON.parse(res.getContentText());
    let title =
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0].text;
    if (!title) return null;

    title = title.replace(/[\n\r"'「」『』]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!title || title.length > 20) return null; // 変な出力は捨てて辞書方式へ
    return title;
  } catch (err) {
    Logger.log('Geminiタイトル生成に失敗: ' + err);
    return null;
  }
}

/** キーワード辞書からタイトルを抽出する。見つからなければfallbackを短くして返す */
function extractTitleByRules(text, fallback) {
  for (let i = 0; i < TITLE_KEYWORDS.length; i++) {
    if (text.indexOf(TITLE_KEYWORDS[i]) !== -1) return TITLE_KEYWORDS[i];
  }
  const t = (fallback || '').trim();
  if (!t) return 'LINEの予定';
  return t.length > 15 ? t.slice(0, 15) + '…' : t;
}

/**
 * 話し言葉の日時表現を解析する。
 * 戻り値: { start: Date, hasTime: boolean, title: string } / 読み取れなければ null
 */
function parseDateTimeJa(text, now) {
  let rest = text;
  let year = null;
  let month = null;
  let day = null;
  let base = null; // 相対表現(明日・来週土曜など)の基準日

  // 1) 明示的な日付: 9/20, 9月20日, 2026/9/20
  let m = rest.match(/(?:(\d{4})[/年])?(\d{1,2})[/月](\d{1,2})日?/);
  if (m) {
    year = m[1] ? Number(m[1]) : null;
    month = Number(m[2]);
    day = Number(m[3]);
    rest = rest.replace(m[0], ' ');
  } else if ((m = rest.match(/今日|本日|明日|あした|明後日|あさって/))) {
    // 2) 相対表現
    const add = /今日|本日/.test(m[0]) ? 0 : /明日|あした/.test(m[0]) ? 1 : 2;
    base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + add);
    rest = rest.replace(m[0], ' ');
  } else if ((m = rest.match(/(今週|来週|再来週)?の?([月火水木金土日])曜/))) {
    // 3) 曜日指定: 直近のその曜日。「来週」なら+7日、「再来週」なら+14日
    const wd = '日月火水木金土'.indexOf(m[2]);
    let diff = (wd - now.getDay() + 7) % 7;
    if (m[1] === '来週') diff += 7;
    else if (m[1] === '再来週') diff += 14;
    base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff);
    rest = rest.replace(m[0], ' ');
  } else {
    return null;
  }

  // 時刻: 10:00, 10時, 10時半, 10時15分, 午後7時, 夜8時 (「10時間」には反応しない)
  let hasTime = false;
  let hour = 0;
  let minute = 0;
  m = rest.match(/(午後|午前|夜|朝)?\s*(\d{1,2})(?::(\d{2})|時(?!間)(半)?(?:(\d{1,2})分)?)/);
  if (m) {
    hour = Number(m[2]);
    minute = m[3] ? Number(m[3]) : m[4] ? 30 : m[5] ? Number(m[5]) : 0;
    if ((m[1] === '午後' || m[1] === '夜') && hour < 12) hour += 12;
    hasTime = true;
    rest = rest.replace(m[0], ' ');
  }

  let start;
  if (base) {
    start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute);
  } else {
    // 年なし日付は今日以降で最初に来る年に解釈(年末に翌年の予定を送ってもOK)
    let y = year || now.getFullYear();
    start = new Date(y, month - 1, day, hour, minute);
    if (!year && start.getTime() < now.getTime() - 2 * 24 * 60 * 60 * 1000) {
      start = new Date(y + 1, month - 1, day, hour, minute);
    }
  }

  // 残りの文からタイトルを作る
  const title = rest
    .replace(/[\n\r]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s、。,．.にでからはがの~〜ー-]+/, '')
    .replace(/[\s、。,．.]+$/, '')
    .trim()
    .slice(0, 50);

  return { start: start, hasTime: hasTime, title: title || 'LINEの予定' };
}

/** 日本語の日時表示: 9/20(日) 10:00 */
function formatJa(d, dateOnly) {
  const wd = '日月火水木金土'[d.getDay()];
  const date = d.getMonth() + 1 + '/' + d.getDate() + '(' + wd + ')';
  if (dateOnly) return date;
  const mm = ('0' + d.getMinutes()).slice(-2);
  return date + ' ' + d.getHours() + ':' + mm;
}

/** LINEに返事を送る(応答メッセージは無料・無制限) */
function replyToLine(replyToken, text) {
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: [{ type: 'text', text: text }],
    }),
    muteHttpExceptions: true,
  });
}
