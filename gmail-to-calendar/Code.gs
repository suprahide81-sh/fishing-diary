/**
 * Gmail予約完了メール → Googleカレンダー自動登録
 *
 * Gmailに届いた「予約完了・予約確認」メールを定期的にチェックし、
 * 本文から日時・内容を読み取ってGoogleカレンダーに予定を作成します。
 *
 * 対応フォーマット:
 *  1. サロン系(ホットペッパー等):「【予約日時】 9/5(土) 12:30」+「【所要時間】 120分」
 *  2. フェリー・交通系(津軽海峡フェリー等):「2026/09/19(土)」+「17:15発 20:50着」+「青森→函館」
 *  3. 汎用: 本文中の「予約日時」付近にある日付+時刻
 *
 * 使い方は同フォルダの README.md を参照。
 */

const CONFIG = {
  // 予定を入れるカレンダー。'primary' ならデフォルトカレンダー。
  // 別カレンダーを使う場合はカレンダーID(例: xxxx@group.calendar.google.com)を指定。
  calendarId: 'primary',

  // 予約メールを探すGmail検索クエリ(直近30日分)
  // ※処理済みのメールはラベルで除外されるので、期間が広くても二重登録はされない
  searchQuery:
    '{予約完了 予約確定 予約変更 予約キャンセル 予約取消 キャンセル完了 "ご予約ありがとうございます" "予約のお知らせ" "ご予約内容"} newer_than:30d',

  // 処理済みスレッドに付けるラベル(二重登録防止)
  processedLabel: 'カレンダー登録済',

  // 所要時間が読み取れなかった場合の予定の長さ(分)
  defaultDurationMinutes: 60,
};

// このスクリプトが作成した予定の目印(説明欄に埋め込む)。
// キャンセル時はこの目印がある予定だけを削除対象にする。
const AUTO_MARKER = '--- 自動登録 (Gmail予約メール連携) ---';

/** 初回に一度だけ実行: 30分おきの自動実行トリガーを設定する */
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncBookingMailsToCalendar') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('syncBookingMailsToCalendar')
    .timeBased()
    .everyMinutes(30)
    .create();
  Logger.log('30分おきの自動実行トリガーを設定しました。');
}

/** メイン処理: 予約メールを探してカレンダーに登録する */
function syncBookingMailsToCalendar() {
  const calendar =
    CONFIG.calendarId === 'primary'
      ? CalendarApp.getDefaultCalendar()
      : CalendarApp.getCalendarById(CONFIG.calendarId);
  if (!calendar) {
    throw new Error('カレンダーが見つかりません: ' + CONFIG.calendarId);
  }

  const label =
    GmailApp.getUserLabelByName(CONFIG.processedLabel) ||
    GmailApp.createLabel(CONFIG.processedLabel);

  const query = CONFIG.searchQuery + ' -label:' + CONFIG.processedLabel;
  const threads = GmailApp.search(query, 0, 50);

  // 検索結果は新しい順に返るので、古い順に並べ替えて時系列どおりに処理する。
  // (予約→変更→キャンセルの順に適用され、最後のメールの内容が最終状態になる)
  threads.reverse();

  threads.forEach(function (thread) {
    // ラベル検索の取りこぼし対策で二重チェック
    const already = thread.getLabels().some(function (l) {
      return l.getName() === CONFIG.processedLabel;
    });
    if (already) return;

    const message = thread.getMessages()[thread.getMessageCount() - 1];
    const subject = message.getSubject() || '';
    const body = message.getPlainBody() || '';
    const received = message.getDate();

    // キャンセルメールなら、対応する自動登録済みの予定を削除して終了
    if (isCancellationMail(subject, body)) {
      const deleted = handleCancellationMail(calendar, subject, body, received);
      Logger.log('キャンセルメールを処理: %s (削除した予定: %s件)', subject, deleted);
      thread.addLabel(label);
      return;
    }

    const bookings = parseBookingMail(subject, body, received);
    if (bookings.length === 0) {
      // 予約情報が読み取れないメール(お知らせ・広告等)はラベルだけ付けてスキップ
      thread.addLabel(label);
      return;
    }

    // 申込番号付きの予約(フェリー等)は、変更メールに備えて旧予定を削除してから登録し直す
    const bookingNumber = bookings[0].bookingNumber;
    if (bookingNumber) {
      deleteEventsByBookingNumber(calendar, bookingNumber);
    }

    bookings.forEach(function (b) {
      if (eventExists(calendar, b.title, b.start)) return;
      calendar.createEvent(b.title, b.start, b.end, {
        description: b.description,
        location: b.location || '',
      });
      Logger.log('予定を作成: %s (%s)', b.title, b.start);
    });

    thread.addLabel(label);
  });
}

/**
 * キャンセル完了メールかどうかを判定する。
 * 予約確認メールの注意書き(「変更・キャンセルはお電話にて」「期日を過ぎると
 * 自動的に取消されます」等)に反応しないよう、件名の「予約キャンセル/予約取消」
 * または本文の完了表現(過去形)のみを対象にする。
 */
function isCancellationMail(subject, body) {
  if (/(予約|ご予約)の?(キャンセル|取消|取り消し)/.test(subject)) return true;
  if (/(キャンセル|取消|取り消し).{0,6}(完了|承りました)/.test(subject)) return true;
  return /(キャンセル|取消|取り消し)(を|が|は|手続きが)?.{0,10}(完了|承りました|受け付けました|受付けました|いたしました|致しました)/.test(
    body
  );
}

/**
 * キャンセルメールに対応する予定を削除する。削除した件数を返す。
 *  1. 申込番号・予約番号があれば、その番号で登録した予定を削除
 *  2. 本文に日時があれば、その開始時刻に自動登録した予定を削除
 * いずれも AUTO_MARKER 付き(=このスクリプトが作った)予定のみが対象。
 */
function handleCancellationMail(calendar, subject, body, received) {
  let deleted = 0;

  // 1) 申込番号・予約番号での特定(いちばん確実)
  const bookingNumber = findBookingNumber(body);
  if (bookingNumber) {
    deleted += deleteEventsByBookingNumber(calendar, bookingNumber);
  }

  // 2) 本文に日付+時刻があれば、その開始時刻の予定を削除
  if (deleted === 0) {
    const bookings = parseBookingMail(subject, body, received) || [];
    bookings.forEach(function (b) {
      deleted += deleteAutoEventsAt(calendar, b.start);
    });
  }

  // 3) 時刻がなくても【出発日】等の日付が書かれていれば、その日から特定する
  if (deleted === 0) {
    findCancelledDates(body, received).forEach(function (d) {
      deleted += deleteSingleAutoEventOnDate(calendar, d);
    });
  }

  return deleted;
}

/**
 * キャンセルメールから「取り消された予定の日付」を拾う。
 * 【出発日】2026/07/25(土) のようなラベル付き日付に対応(時刻はなくてよい)。
 */
function findCancelledDates(body, received) {
  const labelRe =
    /(?:出発日|乗車日|搭乗日|利用日|来店日|予約日|チェックイン|開始日)[^\n\d]{0,8}(?:(\d{4})[/年])?(\d{1,2})[/月](\d{1,2})日?/g;

  const dates = [];
  const seen = {};
  let m;
  while ((m = labelRe.exec(body)) !== null) {
    const d = buildDate(
      m[1] ? Number(m[1]) : null,
      Number(m[2]),
      Number(m[3]),
      0,
      0,
      received
    );
    if (!seen[d.getTime()]) {
      seen[d.getTime()] = true;
      dates.push(d);
    }
  }
  return dates;
}

/**
 * 指定日に自動登録された予定が「ちょうど1件」のときだけ削除する。
 * 同じ日に複数あるとどれを消すべきか判断できないため、その場合は削除しない
 * (誤って別の予定を消さないための安全策)。
 */
function deleteSingleAutoEventOnDate(calendar, date) {
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const autoEvents = calendar.getEvents(dayStart, dayEnd).filter(function (e) {
    return (e.getDescription() || '').indexOf(AUTO_MARKER) !== -1;
  });

  if (autoEvents.length !== 1) {
    if (autoEvents.length > 1) {
      Logger.log(
        '同日に自動登録の予定が%s件あるため自動削除を見送り: %s',
        autoEvents.length,
        dayStart
      );
    }
    return 0;
  }

  Logger.log(
    'キャンセルにより予定を削除: %s (%s)',
    autoEvents[0].getTitle(),
    autoEvents[0].getStartTime()
  );
  autoEvents[0].deleteEvent();
  return 1;
}

/** 指定の開始時刻に自動登録された予定を削除する。削除した件数を返す。 */
function deleteAutoEventsAt(calendar, start) {
  let count = 0;
  const windowEnd = new Date(start.getTime() + 60 * 1000);
  calendar.getEvents(start, windowEnd).forEach(function (e) {
    if (
      e.getStartTime().getTime() === start.getTime() &&
      (e.getDescription() || '').indexOf(AUTO_MARKER) !== -1
    ) {
      Logger.log('キャンセルにより予定を削除: %s (%s)', e.getTitle(), start);
      e.deleteEvent();
      count++;
    }
  });
  return count;
}

/**
 * 本文から申込番号・予約番号を探す。見つからなければ null。
 * 「【予約番号：43258944】」「申込番号 26345785」のような表記に対応。
 */
function findBookingNumber(body) {
  const m = body.match(/(?:申込番号|予約番号|受付番号|予約No\.?)\s*[:：]?\s*(\d{4,})/i);
  return m ? m[1] : null;
}

/** 予定の説明欄に入れる文章を組み立てる(申込番号があれば先頭に入れる) */
function buildDescription(subject, bookingNumber) {
  return (
    (bookingNumber ? '申込番号: ' + bookingNumber + '\n' : '') +
    'メール件名: ' + subject + '\n\n' + AUTO_MARKER
  );
}

/**
 * メール本文を解析して予約情報の配列を返す。
 * 各要素: { title, start, end, description, location, bookingNumber }
 */
function parseBookingMail(subject, body, received) {
  return (
    parseFerryMail(subject, body) ||
    parseSalonMail(subject, body, received) ||
    parseGenericMail(subject, body, received) ||
    []
  );
}

/**
 * フェリー・交通系:
 *   2026/09/19(土)
 *   17:15発 20:50着
 *   青　森→函　館 17便
 * 往路・復路など複数区間があれば区間ごとに予定を作る。
 */
function parseFerryMail(subject, body) {
  const legRe =
    /(\d{4})\/(\d{1,2})\/(\d{1,2})\([^)]+\)\s*\n\s*(\d{1,2}):(\d{2})発\s*(\d{1,2}):(\d{2})着\s*\n\s*([^\n→]+)→([^\n]+)/g;

  const bookingNumber = findBookingNumber(body);

  const bookings = [];
  let m;
  while ((m = legRe.exec(body)) !== null) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const start = new Date(year, month - 1, day, Number(m[4]), Number(m[5]));
    // 「24:00着」のような表記もDateがそのまま翌日に繰り上げてくれる
    let end = new Date(year, month - 1, day, Number(m[6]), Number(m[7]));
    if (end <= start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);

    const from = m[8].replace(/[\s　]/g, '').replace(/\d+便.*$/, '');
    const to = m[9].replace(/[\s　]/g, '').replace(/\d+便.*$/, '');

    bookings.push({
      title: '🚢 ' + from + '→' + to,
      start: start,
      end: end,
      location: from,
      bookingNumber: bookingNumber,
      description: buildDescription(subject, bookingNumber),
    });
  }
  return bookings.length > 0 ? bookings : null;
}

/**
 * サロン系(ホットペッパー等):
 *   【予約日時】 9/5(土) 12:30   ← 年なし表記あり
 *   【メニュー】 カラーエステ＋カット
 *   【所要時間】 120分
 */
function parseSalonMail(subject, body, received) {
  const dtMatch = body.match(
    /【予約日時】\s*(?:(\d{4})[/年])?(\d{1,2})[/月](\d{1,2})日?(?:\([^)]+\))?\s*(\d{1,2}):(\d{2})/
  );
  if (!dtMatch) return null;

  const start = buildDate(
    dtMatch[1] ? Number(dtMatch[1]) : null,
    Number(dtMatch[2]),
    Number(dtMatch[3]),
    Number(dtMatch[4]),
    Number(dtMatch[5]),
    received
  );

  const durMatch = body.match(/【所要時間】\s*(\d+)\s*分/);
  const minutes = durMatch ? Number(durMatch[1]) : CONFIG.defaultDurationMinutes;
  const end = new Date(start.getTime() + minutes * 60 * 1000);

  const menuMatch = body.match(/【メニュー】\s*\n?\s*([^\n]+)/);
  // 冒頭の「◯◯です。」から店名を推定(例: STOKEDです。)
  const shopMatch = body
    .split('\n')
    .slice(0, 6)
    .join('\n')
    .match(/^\s*(.{1,30}?)です[。！!]/m);
  const shop = shopMatch ? shopMatch[1].trim() : '';

  const title =
    '💇 ' +
    (shop ? shop + ' ' : '') +
    (menuMatch ? menuMatch[1].trim() : '予約');

  // 署名部から住所らしき行を拾う(都道府県で始まる行)
  const locMatch = body.match(/^\s*((?:北海道|東京都|大阪府|京都府|.{2,3}県)[^\n]+)$/m);

  const bookingNumber = findBookingNumber(body);

  return [
    {
      title: title,
      start: start,
      end: end,
      location: locMatch ? locMatch[1].trim() : '',
      bookingNumber: bookingNumber,
      description: buildDescription(subject, bookingNumber),
    },
  ];
}

/**
 * 汎用フォールバック:
 * 「予約日時」「ご予約日」等のキーワードがある本文から最初の日付+時刻を拾う。
 */
function parseGenericMail(subject, body, received) {
  if (!/(予約日時|ご予約日|来店日時|ご利用日|チェックイン)/.test(body)) return null;

  const m = body.match(
    /(?:(\d{4})[/年])?(\d{1,2})[/月](\d{1,2})日?(?:\([^)]+\))?[^\d\n]{0,10}(\d{1,2}):(\d{2})/
  );
  if (!m) return null;

  const start = buildDate(
    m[1] ? Number(m[1]) : null,
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    received
  );
  const end = new Date(start.getTime() + CONFIG.defaultDurationMinutes * 60 * 1000);

  const bookingNumber = findBookingNumber(body);

  return [
    {
      title: '📅 ' + subject,
      start: start,
      end: end,
      location: '',
      bookingNumber: bookingNumber,
      description: buildDescription(subject, bookingNumber),
    },
  ];
}

/** 年なし日付(9/5等)は受信日以降で最初に来る年に解釈する */
function buildDate(year, month, day, hour, minute, received) {
  if (year) return new Date(year, month - 1, day, hour, minute);
  const ref = received || new Date();
  let y = ref.getFullYear();
  const candidate = new Date(y, month - 1, day, hour, minute);
  // 受信日より2日以上過去なら翌年の予約とみなす(当日・前日受信の揺れは許容)
  if (candidate.getTime() < ref.getTime() - 2 * 24 * 60 * 60 * 1000) y += 1;
  return new Date(y, month - 1, day, hour, minute);
}

/** 同タイトル・同開始時刻の予定が既にあるか(二重登録防止) */
function eventExists(calendar, title, start) {
  const windowEnd = new Date(start.getTime() + 60 * 1000);
  return calendar.getEvents(start, windowEnd).some(function (e) {
    return e.getTitle() === title;
  });
}

/**
 * 予約変更・キャンセルメール対応:
 * 同じ申込番号で自動登録した今後の予定を削除する。削除した件数を返す。
 */
function deleteEventsByBookingNumber(calendar, bookingNumber) {
  const now = new Date();
  const oneYearLater = new Date(now.getTime() + 366 * 24 * 60 * 60 * 1000);
  let count = 0;
  calendar
    .getEvents(now, oneYearLater, { search: '申込番号: ' + bookingNumber })
    .forEach(function (e) {
      const desc = e.getDescription() || '';
      if (
        desc.indexOf('申込番号: ' + bookingNumber) !== -1 &&
        desc.indexOf(AUTO_MARKER) !== -1
      ) {
        Logger.log('旧予定を削除: %s (%s)', e.getTitle(), e.getStartTime());
        e.deleteEvent();
        count++;
      }
    });
  return count;
}
