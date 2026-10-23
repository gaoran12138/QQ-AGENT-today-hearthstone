// 今日炉石 · 卡片渲染
//
// 管线与 weather-card / mc-status 同一条（已验证过，别自创写法）：
//   离屏 BrowserWindow → loadFile(临时 HTML) → 等 paint → 量内容高度 → setContentSize → capturePage → toPNG
//
// 踩过的坑（照抄，别改）：
//  1) 初始高度必须给小（220）。BrowserWindow 默认 800×600，而 scrollHeight 在内容比视口矮时
//     返回的是视口高度、不是内容高度 —— 矮卡会按 600 截图，下面一大截空白。
//  2) 必须设窗口 backgroundColor：scrollHeight 是整数，实际渲染常带亚像素（比如 667.4），
//     窗口按 667 设就差一点点，右/下会露出 1~2px 白线。底色一致就看不出来。
//  3) 窗口宽度直接等于卡片宽度（不要 ×2）：截图取的是视口，宽度翻倍会在右侧留一条同色空白，
//     白占体积、QQ 里还显得图被压小。
//  4) 并发锁：渲染过程重，多个工具同时调用会抢 GPU，用一个布尔锁挡住。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CARD_W = 720;

let rendering = false;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pctColor(wr) {
  if (wr >= 53) return '#4ade80';
  if (wr >= 47) return '#e2e8f0';
  return '#f87171';
}

function rankColor(i) {
  if (i === 0) return '#fbbf24';
  if (i === 1) return '#cbd5e1';
  if (i === 2) return '#d9925f';
  return '#64748b';
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

/**
 * 一张职业胜率榜卡片。
 *
 * @param {object} o
 * @param {string} o.kicker   小标（如「标准模式」）
 * @param {string} o.title    主标题（如「职业胜率」）
 * @param {string} o.subtitle 副标题（分段 / 样本说明）
 * @param {Array<{cn:string,winrate:number,color:string,drafts?:number}>} o.rows
 * @param {string} o.note     榜单右上角补充（如「按胜率降序」）
 * @param {string} o.footer   页脚
 */
export function buildRateCardHtml({ kicker, title, subtitle, rows = [], note = '', footer = '' }) {
  const list = Array.isArray(rows) ? rows : [];
  const maxWr = Math.max(...list.map((r) => Number(r.winrate) || 0), 50);
  const minWr = Math.min(...list.map((r) => Number(r.winrate) || 0), 50);
  const span = Math.max(maxWr - minWr, 0.1);

  const rowHtml = list.map((r, i) => {
    const wr = Number(r.winrate) || 0;
    // 条形长度：榜单内相对归一（第一名 100%，最后一名 22%），比绝对映射更能看出差距
    const w = Math.round(22 + ((wr - minWr) / span) * 78);
    const extra = r.drafts ? `<b>${fmtNum(r.drafts)}</b> 轮` : '';
    return `<div class="row">
      <div class="rank" style="color:${rankColor(i)}">${i + 1}</div>
      <div class="dot" style="background:${esc(r.color)}"></div>
      <div class="name">${esc(r.cn)}</div>
      <div class="bar"><i style="width:${w}%;background:${esc(r.color)}"></i></div>
      <div class="pct" style="color:${pctColor(wr)}">${wr.toFixed(1)}%</div>
      <div class="extra">${extra}</div>
    </div>`;
  }).join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { background:#0c1220; }
  body { width:${CARD_W}px; font-family:"Microsoft YaHei","PingFang SC","Segoe UI",sans-serif; -webkit-font-smoothing:antialiased; }
  .card { width:${CARD_W}px; padding:26px 30px 20px; background:linear-gradient(180deg,#151f33 0%,#0f1726 100%); }
  .head { display:flex; align-items:flex-end; justify-content:space-between; padding-bottom:16px; border-bottom:1px solid rgba(148,163,184,.18); }
  .kicker { display:inline-block; font-size:13px; letter-spacing:.12em; color:#7dd3fc; background:rgba(56,189,248,.12);
            border:1px solid rgba(56,189,248,.32); border-radius:999px; padding:3px 10px; margin-bottom:9px; }
  .title { font-size:30px; font-weight:800; color:#f1f5f9; letter-spacing:.01em; line-height:1.15; }
  .subtitle { margin-top:7px; font-size:13px; color:#94a3b8; }
  .note { font-size:12px; color:#64748b; padding-bottom:4px; white-space:nowrap; }
  .rows { padding:12px 0 6px; }
  .row { display:grid; grid-template-columns:26px 10px 92px 1fr 64px 74px; align-items:center;
         gap:10px; height:42px; border-bottom:1px solid rgba(148,163,184,.08); }
  .row:last-child { border-bottom:none; }
  .rank { font-size:15px; font-weight:700; text-align:center; font-variant-numeric:tabular-nums; }
  .dot { width:10px; height:10px; border-radius:50%; box-shadow:0 0 8px currentColor; }
  .name { font-size:17px; font-weight:600; color:#e2e8f0; }
  .bar { height:9px; background:rgba(148,163,184,.13); border-radius:999px; overflow:hidden; }
  .bar i { display:block; height:100%; border-radius:999px; opacity:.92; }
  .pct { font-size:17px; font-weight:700; text-align:right; font-variant-numeric:tabular-nums; }
  .extra { font-size:12px; color:#64748b; text-align:right; white-space:nowrap; }
  .extra b { color:#94a3b8; font-weight:600; }
  .foot { display:flex; justify-content:space-between; align-items:center; margin-top:12px; padding-top:13px;
          border-top:1px solid rgba(148,163,184,.18); font-size:12px; color:#64748b; }
</style></head>
<body><div class="card">
  <div class="head">
    <div>
      <span class="kicker">${esc(kicker)}</span>
      <div class="title">${esc(title)}</div>
      <div class="subtitle">${esc(subtitle)}</div>
    </div>
    <div class="note">${esc(note)}</div>
  </div>
  <div class="rows">${rowHtml}</div>
  <div class="foot"><span>${esc(footer)}</span><span>HSReplay.net</span></div>
</div></body></html>`;
}

/** 渲染 HTML → PNG 字节。失败返回 null（调用方退回纯文字，不让整条消息失败）。 */
export async function renderCardPng(html, { timeoutMs = 15000 } = {}) {
  if (rendering) return null;
  rendering = true;
  let electron = null;
  try {
    const mod = await import('electron');
    electron = mod?.default ?? mod;
  } catch {
    rendering = false;
    return null;
  }
  if (!electron || typeof electron.BrowserWindow !== 'function') {
    rendering = false;
    return null;
  }

  let win = null;
  const tmpHtml = path.join(os.tmpdir(), `qq-agent-hs-card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`);
  try {
    fs.writeFileSync(tmpHtml, html, 'utf8');
    win = new electron.BrowserWindow({
      show: false,
      skipTaskbar: true,
      frame: false,
      useContentSize: true,
      width: CARD_W,
      height: 220,
      backgroundColor: '#0c1220',
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    await win.loadFile(tmpHtml);
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      win.webContents.once('paint', finish);
      setTimeout(finish, 400);
    });

    const h = await win.webContents.executeJavaScript(`(() => {
      const b = document.body;
      const card = document.querySelector('.card');
      return Math.ceil(Math.max(b.scrollHeight, b.offsetHeight, card ? card.getBoundingClientRect().bottom : 0));
    })()`);

    win.setContentSize(CARD_W, Math.max(160, (Number(h) || 600) + 1));
    await new Promise((r) => setTimeout(r, 80));
    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    if (!png || png.length < 1000) throw new Error('截图为空');
    return png;
  } catch {
    return null;
  } finally {
    try { win?.destroy?.(); } catch { /* 忽略 */ }
    try { fs.unlinkSync(tmpHtml); } catch { /* 忽略 */ }
    rendering = false;
  }
}

/** 把 PNG 写到临时文件，返回绝对路径。 */
export function writePngFile(png, tag = 'hs') {
  const file = path.join(os.tmpdir(), `qq-agent-hs-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.png`);
  fs.writeFileSync(file, png);
  return file;
}
