#!/usr/bin/env node
/* 由簡譜原稿 .txt 直接出 A4 PDF，唔使開瀏覽器撳列印。
 *
 *   node topdf.js songs/my-song.txt out.pdf
 *   node topdf.js songs/my-song.txt out.pdf --space 18 --note 22 --align justify --rule dashed
 *
 * 需要 playwright（npm i -D playwright）。
 * 版面計算同瀏覽器入面一模一樣 —— 同一份 index.html、同一段 fit 程式碼。
 */
'use strict';

const path = require('path');
const fs = require('fs');

function loadPlaywright() {
  for (const id of ['playwright', 'playwright-core',
                    '/opt/node22/lib/node_modules/playwright']) {
    try { return require(id); } catch (e) { /* 試下一個 */ }
  }
  console.error('搵唔到 playwright。請執行：npm i -D playwright');
  process.exit(1);
}

function parseArgs(argv) {
  const opt = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) opt[a.slice(2)] = argv[++i];
    else opt._.push(a);
  }
  return opt;
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const src = opt._[0];
  if (!src) {
    console.error('用法：node topdf.js <原稿.txt> [輸出.pdf] [--space mm] [--note px]');
    console.error('              [--lyric %] [--gap %] [--linegap mm] [--margin mm]');
    console.error('              [--align left|justify] [--rule none|dashed|dotted|solid]');
    console.error('              [--paper a4|a4-landscape|letter] [--no-anno]');
    process.exit(1);
  }
  const out = opt._[1] || src.replace(/\.txt$/i, '') + '.pdf';
  const text = fs.readFileSync(src, 'utf8');

  const PAPER = {
    'a4': '210mm|A4 portrait',
    'a4-landscape': '297mm|A4 landscape',
    'letter': '216mm|Letter portrait'
  };

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto('file://' + path.resolve(__dirname, 'index.html'));

  const warnings = await page.evaluate(async (cfg) => {
    localStorage.clear();
    const $ = id => document.getElementById(id);
    const set = (id, v) => {
      if (v == null) return;
      $(id).value = v;
      $(id).dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('space', cfg.space); set('noteSize', cfg.note); set('lyricSize', cfg.lyric);
    set('gap', cfg.gap); set('lineGap', cfg.linegap); set('margin', cfg.margin);
    set('rule', cfg.rule); set('paper', cfg.paper);
    if (cfg.align) set('align', cfg.align);
    if (cfg.noAnno) { $('showAnno').checked = false; $('showAnno').dispatchEvent(new Event('input', { bubbles: true })); }

    const s = $('src');
    s.value = cfg.text;
    s.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    window.Jianpu.fitAll($('sheet'));
    // 有冇句子塞爆咗，或者詞同音對唔上
    return {
      overflow: [...document.querySelectorAll('.line .staff')]
        .filter(st => st.getBoundingClientRect().width > st.closest('.wrap').clientWidth + 2).length,
      mismatch: [...document.querySelectorAll('.warn')].map(w => w.textContent.trim())
    };
  }, {
    text,
    space: opt.space, note: opt.note, lyric: opt.lyric, gap: opt.gap,
    linegap: opt.linegap, margin: opt.margin, rule: opt.rule,
    align: opt.align === 'justify' ? 'justify' : (opt.align ? 'left' : null),
    paper: PAPER[(opt.paper || 'a4').toLowerCase()],
    noAnno: 'no-anno' in opt
  });

  await page.emulateMedia({ media: 'print' });
  await page.pdf({ path: out, printBackground: true, preferCSSPageSize: true });
  await browser.close();

  if (errors.length) { console.error('頁面錯誤：', errors); process.exit(1); }
  if (warnings.overflow) console.warn(`⚠ 有 ${warnings.overflow} 句塞爆咗一行`);
  warnings.mismatch.forEach(m => console.warn('⚠ ' + m));
  console.log('已出：' + out);
}

main().catch(e => { console.error(e); process.exit(1); });
