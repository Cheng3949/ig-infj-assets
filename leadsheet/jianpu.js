/* 簡譜排版引擎 — 一句一行、跟歌詞闊度、自動壓縮
 *
 * 設計重點：
 *   1. 一個 phrase（一句歌詞）= 一個 .line，永遠唔會中途斷行。
 *   2. 每粒音符係一個 .col，闊度用 max-content 決定 —— CJK 歌詞字通常闊過數字，
 *      所以實際係「歌詞決定排版闊度」，唔係音符決定。
 *   3. 一句太長塞唔落一行時：先收窄音符間距，仲唔夠就 scaleX 壓窄字體。
 */
(function (global) {
  'use strict';

  /* ----------------------------------------------------------------- 解析 */

  var META_KEYS = {
    'title': 'title', '標題': 'title', '歌名': 'title', '曲名': 'title',
    'subtitle': 'subtitle', '副標題': 'subtitle', '副題': 'subtitle',
    'composer': 'composer', '曲': 'composer', '作曲': 'composer',
    'lyricist': 'lyricist', '詞': 'lyricist', '作詞': 'lyricist',
    'arranger': 'arranger', '編曲': 'arranger',
    'singer': 'singer', '唱': 'singer', '原唱': 'singer', '主唱': 'singer',
    'key': 'key', '調': 'key', '調號': 'key',
    'time': 'time', '拍': 'time', '拍號': 'time', '節拍': 'time',
    'tempo': 'tempo', '速度': 'tempo',
    'note': 'note', '備註': 'note', '註': 'note'
  };

  var BARS = {
    '|': 'single',
    '||': 'final',
    '|:': 'repeat-start',
    ':|': 'repeat-end',
    ':|:': 'repeat-both',
    ':||:': 'repeat-both'
  };

  // 標點會黐返上一個字，唔會自己霸一欄
  var PUNCT = '，。、！？；：·．,.!?;:’”」』）)…';

  function isNoteLine(t) {
    if (!/[0-7]/.test(t)) return false;
    return /^[0-7#b♯♭n=＝\^v_.\-|:()\s]+$/.test(t);
  }

  function parseNotes(text) {
    var cols = [];
    var toks = text.trim().split(/\s+/);
    for (var i = 0; i < toks.length; i++) {
      var tok = toks[i];
      if (!tok) continue;

      if (BARS[tok]) { cols.push({ kind: 'bar', style: BARS[tok] }); continue; }

      // 單獨嘅 - 係延音線，一個 - 佔一拍
      if (/^-+$/.test(tok)) {
        for (var d = 0; d < tok.length; d++) cols.push({ kind: 'dash' });
        continue;
      }

      var m = /^([#b♯♭n=＝]?)([\^v]*)([0-7])([\^v]*)([._\-]*)$/.exec(tok);
      if (!m) { cols.push({ kind: 'raw', text: tok }); continue; }

      var oct = 0, marks = m[2] + m[4];
      for (var k = 0; k < marks.length; k++) oct += marks[k] === '^' ? 1 : -1;

      var dots = 0, beams = 0, dashes = 0;
      for (var j = 0; j < m[5].length; j++) {
        var c = m[5][j];
        if (c === '.') dots++;
        else if (c === '_') beams++;
        else if (c === '-') dashes++;
      }

      cols.push({
        kind: 'note',
        acc: m[1],
        oct: oct,
        num: m[3],
        dots: dots,
        beams: beams,
        rest: m[3] === '0'
      });
      for (var e = 0; e < dashes; e++) cols.push({ kind: 'dash' });
    }
    return cols;
  }

  // 有空格 → 照空格斷；冇空格 → 逐個字斷（標點黐前字）
  function splitLyric(text) {
    var t = text.trim();
    if (/\s/.test(t)) return t.split(/\s+/);
    var out = [];
    var chars = Array.from(t);
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      if (PUNCT.indexOf(ch) >= 0 && out.length) out[out.length - 1] += ch;
      else out.push(ch);
    }
    return out;
  }

  function parse(src) {
    var meta = {}, items = [];
    var header = true, cur = null;
    var lines = String(src).replace(/\r/g, '').split('\n');

    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();

      if (!t) { cur = null; continue; }           // 空行 = 一句完
      if (t.slice(0, 2) === '//') continue;        // 註解

      if (header) {
        var m = /^([A-Za-z一-鿿]{1,4})\s*[:：]\s*(.*)$/.exec(t);
        if (m && META_KEYS[m[1].toLowerCase()]) {
          meta[META_KEYS[m[1].toLowerCase()]] = m[2].trim();
          continue;
        }
      }

      if (t[0] === '[' && t[t.length - 1] === ']') {
        header = false; cur = null;
        items.push({ type: 'section', text: t.slice(1, -1).trim() });
        continue;
      }

      if (t[0] === '>') {                          // 留白入面嘅字（例：英文歌詞）
        var txt = t.slice(1).trim();
        if (cur) cur.annos.push(txt);
        else items.push({ type: 'text', text: txt });
        continue;
      }

      if (isNoteLine(t)) {
        header = false;
        cur = { type: 'phrase', cols: parseNotes(t), lyrics: [], annos: [] };
        items.push(cur);
        continue;
      }

      if (cur) { cur.lyrics.push(splitLyric(t)); continue; }  // 歌詞（可以多過一段）

      header = false;
      items.push({ type: 'text', text: t });
    }

    return { meta: meta, items: items };
  }

  /* ----------------------------------------------------------------- 繪製 */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var ACC_GLYPH = { '#': '♯', '♯': '♯', 'b': '♭', '♭': '♭', 'n': '♮', '=': '♮', '＝': '♮' };

  function buildCol(col, lyricRows, rowCount) {
    var node = el('div', 'col ' + col.kind);

    var above = el('div', 'above');
    var mid = el('div', 'mid');
    var beams = el('div', 'beams');
    var below = el('div', 'below');
    node.appendChild(above);
    node.appendChild(mid);
    node.appendChild(beams);
    node.appendChild(below);

    if (col.kind === 'note') {
      if (col.acc) mid.appendChild(el('span', 'acc', ACC_GLYPH[col.acc] || col.acc));
      mid.appendChild(el('span', 'num', col.num));
      for (var d = 0; d < col.dots; d++) mid.appendChild(el('span', 'aug', '·'));

      // 高低八度點：休止符（0）唔畫
      if (!col.rest && col.oct !== 0) {
        var box = col.oct > 0 ? above : below;
        var n = Math.min(Math.abs(col.oct), 3);
        for (var o = 0; o < n; o++) box.appendChild(el('span', 'odot'));
      }
      // 減時線只會向「同樣有減時線」嗰邊伸出去，先至駁到一條連續嘅線
      for (var b = 0; b < Math.min(col.beams, 4); b++) {
        var bar = el('i');
        if (col.prevBeams > b) bar.classList.add('bl');
        if (col.nextBeams > b) bar.classList.add('br');
        beams.appendChild(bar);
      }

    } else if (col.kind === 'dash') {
      mid.appendChild(el('span', 'tie', '—'));

    } else if (col.kind === 'bar') {
      mid.appendChild(el('span', 'barline ' + col.style));

    } else {
      mid.appendChild(el('span', 'num', col.text || ''));
    }

    // 歌詞列（可以有多段）
    for (var r = 0; r < rowCount; r++) {
      var word = lyricRows[r];
      var ly = el('div', 'lyric');
      if (word === '~') { ly.classList.add('mel'); ly.innerHTML = '&nbsp;'; }
      else if (word && word !== '-' && word !== '_') { ly.textContent = word; }
      else { ly.innerHTML = '&nbsp;'; }
      node.appendChild(ly);
    }
    return node;
  }

  function beamsOf(col) {
    return col && col.kind === 'note' ? col.beams : 0;
  }

  function buildPhrase(ph) {
    var rowCount = Math.max(ph.lyrics.length, 1);

    for (var c = 0; c < ph.cols.length; c++) {
      ph.cols[c].prevBeams = beamsOf(ph.cols[c - 1]);
      ph.cols[c].nextBeams = beamsOf(ph.cols[c + 1]);
    }

    // 只有實音（1-7）先食一個歌詞字；休止符、延音線、小節線唔食
    var cursors = [];
    for (var r = 0; r < rowCount; r++) cursors.push(0);

    var line = el('div', 'line');
    var wrap = el('div', 'wrap');
    var staff = el('div', 'staff');

    for (var i = 0; i < ph.cols.length; i++) {
      var col = ph.cols[i];
      var words = [];
      for (var r2 = 0; r2 < rowCount; r2++) {
        if (col.kind === 'note' && !col.rest) {
          var src = ph.lyrics[r2] || [];
          words.push(src[cursors[r2]++]);
        } else {
          words.push(undefined);
        }
      }
      staff.appendChild(buildCol(col, words, rowCount));
    }

    wrap.appendChild(staff);
    line.appendChild(wrap);

    // 歌詞多過音符 → 尾嗰幾個字冇位擺。打譜嗰陣好易睇漏，所以喺螢幕度提一提。
    for (var v = 0; v < ph.lyrics.length; v++) {
      var total = ph.lyrics[v].length, used = cursors[v];
      if (total > used) {
        line.appendChild(el('div', 'warn',
          '⚠ ' + (ph.lyrics.length > 1 ? '第 ' + (v + 1) + ' 段：' : '') +
          '歌詞 ' + total + ' 個字，但淨係有 ' + used + ' 粒音 — 尾 ' +
          (total - used) + ' 個字（' + ph.lyrics[v].slice(used).join('') + '）擺唔落'));
      }
    }

    // 每行下面嘅留白（可寫筆記 / 放英文歌詞）
    var space = el('div', 'space');
    for (var a = 0; a < ph.annos.length; a++) space.appendChild(el('div', 'anno', ph.annos[a]));
    line.appendChild(space);

    return line;
  }

  function buildHeader(meta) {
    var head = el('header', 'sheet-head');
    if (meta.title) head.appendChild(el('h1', null, meta.title));
    if (meta.subtitle) head.appendChild(el('div', 'subtitle', meta.subtitle));

    var left = [], right = [];
    if (meta.key) left.push(meta.key);
    if (meta.time) left.push(meta.time);
    if (meta.tempo) left.push(meta.tempo);
    if (meta.lyricist) right.push('詞：' + meta.lyricist);
    if (meta.composer) right.push('曲：' + meta.composer);
    if (meta.arranger) right.push('編曲：' + meta.arranger);
    if (meta.singer) right.push('唱：' + meta.singer);

    if (left.length || right.length) {
      var bar = el('div', 'credits');
      var l = el('div', 'c-left');
      for (var i = 0; i < left.length; i++) l.appendChild(el('span', null, left[i]));
      var r = el('div', 'c-right');
      for (var j = 0; j < right.length; j++) r.appendChild(el('div', null, right[j]));
      bar.appendChild(l); bar.appendChild(r);
      head.appendChild(bar);
    }
    if (meta.note) head.appendChild(el('div', 'headnote', meta.note));
    return head;
  }

  function render(song, root) {
    root.innerHTML = '';
    if (song.meta && Object.keys(song.meta).length) root.appendChild(buildHeader(song.meta));

    var body = el('div', 'sheet-body');
    for (var i = 0; i < song.items.length; i++) {
      var it = song.items[i];
      if (it.type === 'section') body.appendChild(el('div', 'section', it.text));
      else if (it.type === 'text') body.appendChild(el('div', 'freetext', it.text));
      else body.appendChild(buildPhrase(it));
    }
    root.appendChild(body);
    return root;
  }

  /* ------------------------------------------------- 一句塞一行（自動壓縮） */

  var MIN_GAP_K = 0.18;     // 音符間距最多收到幾窄
  var MIN_SCALE_X = 0.78;   // 壓過呢個比例就連字體一齊縮細，唔好淨係扁
  var MIN_FONT_K = 0.45;
  // 「撐開」模式：一句最多只撐到自己自然闊度嘅呢個倍數。
  // 短句唔會被攤到成行咁散 —— 夠長嗰啲先至真係填滿一行。
  var MAX_STRETCH = 1.5;

  function widthOf(staff) { return staff.getBoundingClientRect().width; }

  function fitLine(line, justify) {
    var wrap = line.querySelector('.wrap');
    var staff = line.querySelector('.staff');
    if (!wrap || !staff) return;

    staff.style.transform = '';
    staff.style.fontSize = '';

    var avail = wrap.clientWidth;
    if (!avail) return;

    // 一行嘅闊度係間距倍數 k 嘅線性函數：w(k) = w0 + slope*k
    // 量兩次就可以直接解出「啱啱好塞滿」嗰個 k，唔使逐級試。
    line.style.setProperty('--gap-k', '0');
    var w0 = widthOf(staff);
    line.style.setProperty('--gap-k', '1');
    var natural = widthOf(staff);
    var slope = natural - w0;

    var k = slope > 0.5 ? (avail - w0) / slope : 1;

    if (justify) {
      // 撐得到邊度：塞滿一行同「自然闊度 × 上限」之間，邊個細取邊個
      var target = Math.min(avail, natural * MAX_STRETCH);
      var kJ = slope > 0.5 ? (target - w0) / slope : 1;
      k = Math.max(MIN_GAP_K, Math.min(k, Math.max(kJ, 1)));
      line.style.setProperty('--gap-k', k.toFixed(4));
    } else if (k >= 1) {
      line.style.setProperty('--gap-k', '1');     // 有位剩：保持原本間距，唔撐開
      return;
    } else if (k >= MIN_GAP_K) {
      line.style.setProperty('--gap-k', k.toFixed(4));   // 收窄間距就夠
      return;
    } else {
      line.style.setProperty('--gap-k', String(MIN_GAP_K));
    }

    // 仲係塞唔落 → 橫向壓窄；壓得太扁就連字體都縮細
    var placed = widthOf(staff);
    if (placed <= avail + 1.5) return;   // 差一兩個 subpixel 就唔好郁

    var s = avail / placed;
    if (s < MIN_SCALE_X) {
      var base = parseFloat(getComputedStyle(staff).fontSize);
      staff.style.fontSize = (base * Math.max(s / MIN_SCALE_X, MIN_FONT_K)) + 'px';
      s = Math.min(1, avail / widthOf(staff));
    }
    staff.style.transform = 'scaleX(' + s.toFixed(4) + ')';
  }

  function fitAll(root) {
    var justify = root.classList.contains('justify');
    var lines = root.querySelectorAll('.line');
    for (var i = 0; i < lines.length; i++) fitLine(lines[i], justify);
  }

  global.Jianpu = {
    parse: parse,
    render: render,
    fitAll: fitAll,
    fitLine: fitLine
  };
})(window);
