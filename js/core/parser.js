/* ============================================================
   話した言葉から釣りデータを取り出す（画面に依存しない純粋関数）
   FD.parser.parse(text) → { kind:'catch'|'memo'|'data', ... }
============================================================ */
FD.parser = (() => {
  const SPECIES = ['ブラックバス', 'スモールマウス', 'スモール', 'ラージマウス', 'ラージ', 'バス', 'ブルーギル', 'ギル', 'ナマズ', 'ライギョ', '雷魚', 'コイ', '鯉', 'シーバス', 'スズキ', 'チヌ', 'クロダイ', 'キビレ', 'メバル', 'カサゴ', 'ガシラ', 'アジ', 'サバ', 'イワシ', 'タチウオ', 'ヒラメ', 'マゴチ', 'ハゼ', 'キス', 'イカ', 'アオリイカ', 'ブリ', 'ハマチ', 'ワラサ', 'サワラ', 'トラウト', 'ニジマス', 'ヤマメ', 'アマゴ', 'イワナ', 'サクラマス', 'ブラウン', 'ワカサギ', 'ヘラブナ', 'フナ'];
  const WEATHER = [['快晴', '☀️ 快晴'], ['曇り時々晴れ', '⛅ 曇り時々晴れ'], ['晴れ時々曇り', '🌤 晴れ時々曇り'], ['晴れ', '☀️ 晴れ'], ['晴', '☀️ 晴れ'], ['曇り', '☁️ 曇り'], ['曇', '☁️ 曇り'], ['くもり', '☁️ 曇り'], ['小雨', '🌦 小雨'], ['大雨', '🌧 大雨'], ['雨', '🌧 雨'], ['霧', '🌫 霧'], ['雪', '❄️ 雪']];
  const WATER = ['コーヒー色', 'マッディ', '笹濁り', 'ステイン', 'スーパークリア', 'クリア', '濁り', '透明', 'エメラルド', '増水', '減水', '満潮', '干潮', '大潮', '中潮', '小潮', '長潮', '若潮'];
  const MEMO_HEAD = /^(メモ|memo|移動|ポイント移動|ポイント変え|確認|さっき|今から|到着|ここ|状況|バラ|ばら)/i;
  const KANJI = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

  // 「三匹」「十匹」など簡単な漢数字を数字にする
  function kanjiNum(text) {
    return text.replace(/([一二三四五六七八九十]{1,3})(?=\s*(?:匹|本|尾|杯))/g, s => {
      let n = 0, cur = 0;
      for (const ch of s) { const v = KANJI[ch]; if (v === 10) { n += (cur || 1) * 10; cur = 0; } else cur = v; }
      return String(n + cur);
    });
  }

  function findLure(text) {
    const pats = [
      /(?:ルアーは|リグは|仕掛けは|エサは|餌は)([^\s、。！？]{2,16})/,
      /([^\s、。！？0-9のがはをにで]{2,16})(?:で釣れた|でヒット|がヒット|でバイト|で食った|で来た|でゲット)/,
      /(?:使った|投げた|試した|に変えた|にした|入れた)(?:のは|のが)?([^\s、。！？]{2,16})/,
      /([^\s、。！？0-9のがはをにで]{2,16})(?:を使って|を投げて|に変えて)/
    ];
    for (const p of pats) {
      const m = text.match(p);
      if (m) {
        const v = m[1].replace(/^(?:で|を|に|は|が)/, '').replace(/(?:で|を|に)$/, '').trim();
        if (v.length >= 2 && !SPECIES.includes(v)) return v.slice(0, 20);
      }
    }
    return '';
  }

  function extractFields(text) {
    const out = {};
    const add = (k, v) => { (out[k] ||= []).push(v); };

    const sp1 = text.match(/(?:フィールド|釣り場|場所|ポイント)(?:は|が|に|で)?「?([^\s、。！？」]{2,14})/);
    const sp2 = text.match(/([^\s、。！？]{1,8}(?:ダム湖|川|湖|池|ダム|海|港|沼|浦|湾|磯|浜|橋|公園|堤防|漁港|河口|水路|野池|リザーバー))/);
    const sp = [sp1?.[1], sp2?.[0]].find(v => v && !/^\d|匹|センチ|cm/.test(v));
    if (sp) add('spot', sp);

    for (const [k, v] of WEATHER) if (text.includes(k)) { add('weather', v); break; }

    for (const m of text.matchAll(/(?:(気温|水温)(?:は|が)?)?(-?\d+(?:\.\d+)?)\s*(?:度|℃)/g)) add('temp', `${m[1] || '気温'} ${m[2]}℃`);

    let wind = '';
    for (const d of ['北北東', '北北西', '南南東', '南南西', '北東', '北西', '南東', '南西', '北', '南', '東', '西']) if (text.includes(d + 'の風') || text.includes(d + '風')) { wind = d + '風'; break; }
    if (!wind) for (const s of ['強風', '暴風', '弱風', '微風', '無風', '爆風']) if (text.includes(s)) { wind = s; break; }
    const ws = text.match(/風速\s*(\d+(?:\.\d+)?)\s*(?:m|メートル)/);
    if (ws) wind = (wind ? wind + ' ' : '') + `風速${ws[1]}m`;
    if (wind) add('wind', wind);

    for (const s of WATER) if (text.includes(s)) add('water', s);

    const lure = findLure(text);
    if (lure) add('lure', lure);
    return out;
  }

  function parse(raw) {
    const text = kanjiNum(FD.util.toHalf(raw));
    if (!text) return null;
    const size = text.match(/(\d+(?:\.\d+)?)\s*(?:cm|センチ|せんち|㎝)/i);
    const count = text.match(/(\d+)\s*(?:匹|本|尾|杯)/);
    const fields = extractFields(text);

    // 「バス釣れた」のように数がなくても釣れた報告なら1匹として記録
    const caught = /(釣れた|釣れました|釣った|ゲット|キャッチ|フィッシュ|捕った|獲った)/.test(text) && !/(釣れない|釣れなかった|釣れず|バラ)/.test(text);
    if (size || count || caught) {
      return {
        kind: 'catch', text, fields,
        catch: {
          size: size ? parseFloat(size[1]) : null,
          count: count ? parseInt(count[1], 10) : 1,
          species: SPECIES.find(s => text.includes(s)) || '',
          lure: fields.lure?.[0] || '',
          text
        }
      };
    }
    if (MEMO_HEAD.test(text) || text.includes('メモ')) {
      return { kind: 'memo', text: text.replace(/^(メモ|memo)[\s、:：]*/i, '') || text, fields };
    }
    if (!Object.keys(fields).length && text.length > 2) fields.cond = [text.slice(0, 60)];
    return { kind: 'data', text, fields };
  }

  return { parse, extractFields, SPECIES };
})();
