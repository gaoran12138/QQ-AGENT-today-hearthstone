// 今日炉石（today-hearthstone）
//
// 一次调用产出两块内容，都由工具自己发出去：
//   1) 三张中文职业胜率榜卡片图：标准 / 狂野 / 竞技场
//   2) 全职业范围胜率 Top N 套牌：套牌名、职业、胜率、场数、**可直接导入的卡组代码**
//
// 数据源见 hsreplay.js 顶部注释（全部是 HSReplay 公开接口，无需取 token）。
//
// ── 设计要点（踩过的坑，别改）─────────────────────────────────────
// 1) 触发闸门：只在私聊或被 @ / 拍一拍时给（ctx.session.contextTier 1=被点名、4=私聊）。
//    拿不到档位时不硬拦，交给提示词约束 —— 否则某些通道会永远发不出来。
// 2) 图片/文字全部走 ctx.sender.sendMedia / sendTextBatch，绝不能绕过（会跳过限频与留档）。
// 3) 图片是锦上添花：渲染失败必须退化成纯文字照发，不能因为截不出图整条消息失败。
// 4) 三张图要串行渲染（render.js 里有全局锁），并发会抢 GPU 且第二张起直接返回 null。
// 5) 卡组代码后面不能紧贴中文标点 —— QQ 里长按复制会把标点一起选中，导入就失败。
//    所以代码永远单独成行，行尾不加任何字符。

// ⚠️ 依赖必须走「动态 import + 时间戳」，不能写成静态 import。
//     宿主 plugin-loader.js:305 重载时只给入口加 ?t= 破缓存，入口里
//     `import './hsreplay.js'` 这样的静态说明符解析出的 URL 不带 query，
//     Node 会命中首次加载的模块缓存 —— 改了依赖文件、点 reload 也不生效。
//     （2026-10-23 实测踩坑：改完职业短称和套牌中文名，日志与消息里仍是旧版英文。）
let depPromise = null;
function deps() {
  if (!depPromise) {
    const t = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    depPromise = Promise.all([
      import(`./hsreplay.js?t=${t}`),
      import(`./render.js?t=${t}`),
      import(`./cards.js?t=${t}`),
    ]).then(([hs, rd, cd]) => ({ hs, rd, cd }));
  }
  return depPromise;
}
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const SKILL_ID = 'today-hearthstone';

let cfgOf = () => ({});
let log = () => {};

/* ── 触发闸门 ────────────────────────────────────────────────────── */
function gate(ctx, cfg) {
  if (ctx?.kind === 'private') return '';
  if (cfg?.mentionOnly === false) return '';
  const tier = Number(ctx?.session?.contextTier);
  if (tier === 1) return '';
  if (!Number.isFinite(tier)) return '';
  return `这次在群里没被点名（档位 ${tier}，不是被 @ 也不是拍一拍），今日炉石只在对它点名或私聊时给。`
    + '把这条当作没发生：不要跟群里解释、不要提胜率这事，正常聊天就行。';
}

/* ── 小工具 ──────────────────────────────────────────────────────── */
function nowInShanghai() {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric', day: 'numeric', weekday: 'short',
  });
  return fmt.format(d).replace(/\//g, '月').replace(/周/, ' 周');
}

function stamp() {
  const d = new Date();
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

function nfmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

const FORMAT_CN = { standard: '标准模式', wild: '狂野模式' };

/* ── 套牌清单文本 ────────────────────────────────────────────────── */
function buildDeckText(decks, { format, minGames, totalCandidates }) {
  const label = FORMAT_CN[format] || format;
  const lines = [];
  lines.push(`🃏 今日炉石 · ${label}最强 ${decks.length} 套`);
  lines.push(`钻石到传说 · 候选 ${totalCandidates} 套 · 只留 ${nfmt(minGames)} 场以上`);
  lines.push('');
  decks.forEach((d, i) => {
    const wr = Number(d.winrate).toFixed(1);
    // 有国服叫法就用中文，没有就留英文原名 —— 宁可不翻，也不瞎翻
    const name = d.cnName || d.name;
    lines.push(`${i + 1}. ${d.cn} · ${name} · 胜率 ${wr}% · ${nfmt(d.games)} 场`);
  });
  lines.push('');
  lines.push('要哪一套的卡组代码，回我「第 3 套」或套牌名就行。');
  lines.push('数据来源 HSReplay.net · 实时抓取');
  return lines.join('\n');
}

/* ── 最近一次清单的缓存 ──────────────────────────────────────────────
 * 用户看到清单后可能过一会儿才问「第 3 套代码」。这时不能重新抓：慢，而且
 * HSReplay 数据一动，第 3 套就换人了，用户会觉得「这不是我刚才看的那个」。
 * 所以按会话缓存最近一次清单，2 小时内有效。
 */
const CACHE_FILE = path.join(DATA_DIR, 'today-hearthstone-last.json');
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const CACHE_MAX_CHATS = 40;

function readCacheMap() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    // 文件不存在、被手改坏、磁盘只读都走这里：缓存丢了不致命，重新发一次清单即可
    return {};
  }
}

function saveLastDecks(chatKey, payload) {
  try {
    const map = readCacheMap();
    map[chatKey] = { at: Date.now(), ...payload };
    const keys = Object.keys(map);
    if (keys.length > CACHE_MAX_CHATS) {
      keys.sort((a, b) => Number(map[a]?.at || 0) - Number(map[b]?.at || 0));
      for (const k of keys.slice(0, keys.length - CACHE_MAX_CHATS)) delete map[k];
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(map), 'utf8');
  } catch (e) {
    log(`写清单缓存失败：${e?.message ?? e}`);
  }
}

function loadLastDecks(chatKey) {
  const hit = readCacheMap()[chatKey];
  if (!hit || !Array.isArray(hit.decks) || !hit.decks.length) return null;
  if (Date.now() - Number(hit.at || 0) > CACHE_TTL_MS) return null;
  return hit;
}

/** 把用户的「第 3 套」「硬币贼」「术士」对到清单里的一行 */
function matchDeck(decks, query) {
  const raw = String(query || '').trim();
  if (!raw) return null;
  const num = raw.match(/^(?:第)?\s*(\d{1,2})\s*(?:套|个|号)?$/);
  if (num) return decks[Number(num[1]) - 1] || null;
  const q = raw.toLowerCase();
  return (
    decks.find((d) => (d.cnName && d.cnName.includes(raw)) || d.name.toLowerCase().includes(q))
    || decks.find((d) => d.cls && d.cls.toLowerCase() === q)
    || decks.find((d) => d.cn === raw)
    || null
  );
}

/** 单套牌导出成「仿游戏内导出」的文本 —— 自编格式，照抄炉石客户端导出的卡组文本，
 *  只把套牌名换成中文。代码必须独占一行，QQ 长按复制才不会带上中文标点。
 *
 *  ### 动物园术
 *  # 职业：术士
 *  # 模式：标准模式
 *  #
 *  # 2x (0) 咒怨之墓
 *  ...
 *  #
 *  AAECAf0G...
 *  # 想要使用这副套牌，请先复制到剪贴板，再在游戏中创建新套牌。
 *  # 套牌详情请查看https://hsreplay.net/decks/<shortid>/#gameType=RANKED_STANDARD
 */
export async function buildDeckExport({ hs, cd }, deck, format) {
  const fmt = format === 'wild' ? 'wild' : 'standard';
  const gameType = fmt === 'wild' ? 'RANKED_WILD' : 'RANKED_STANDARD';
  const lines = [];

  lines.push(`### ${deck.cnName || deck.name}`);
  lines.push(`# 职业：${hs.CLASS_CN?.[deck.cls] || deck.cn || '未知'}`);
  lines.push(`# 模式：${FORMAT_CN[fmt] || fmt}`);
  lines.push('#');

  const list = Array.isArray(deck.deckList) ? deck.deckList : [];
  if (list.length) {
    let db = null;
    try {
      db = await cd.loadCardDb();
    } catch (e) {
      log(`卡牌库加载失败，牌表用 dbfId 占位：${e?.message ?? e}`);
    }
    const rows = list.map(([dbfId, count]) => {
      const info = db ? cd.cardInfo(db, dbfId) : null;
      return { name: info?.name || `未知卡 ${dbfId}`, cost: info?.cost ?? 99, count: Number(count) || 1 };
    });
    // 官方导出顺序：费用升序，同费用按卡名（中文按码点）升序
    rows.sort((a, b) => a.cost - b.cost || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const r of rows) lines.push(`# ${r.count}x (${r.cost}) ${r.name}`);
    lines.push('#');
  }

  if (deck.code) {
    lines.push(deck.code);
  } else {
    lines.push('');
    lines.push('（这套没抓到卡组代码，可以去 HSReplay 按套牌名搜）');
  }
  lines.push('# 想要使用这副套牌，请先复制到剪贴板，再在游戏中创建新套牌。');
  lines.push(`# 套牌详情请查看https://hsreplay.net/decks/${deck.shortid || ''}/#gameType=${gameType}`);
  return lines.join('\n');
}

/* ── 技能契约 ────────────────────────────────────────────────────── */
export function setup(api) {
  cfgOf = () => (typeof api.config === 'function' ? (api.config() || {}) : {});
  log = (...a) => { try { api.log?.(...a); } catch { /* 日志失败不影响主流程 */ } };

  api.registerTool({
    id: 'today',
    name: '发今日炉石情报',
    description:
      '抓 HSReplay 今日统计并**自己发出去**：三张中文职业胜率榜卡片图（标准 / 狂野 / 竞技场），'
      + '以及全职业范围胜率 Top N 套牌清单（套牌名、胜率、场数，**不含代码**）。'
      + '被问「今天炉石什么卡组强 / 职业胜率 / 炉石环境」时调用 today；用户随后问某一套的卡组代码时改调 today-hearthstone__deck_code。'
      + '⚠️ 调完不要再调 send_message，不要复述内容，直接结束这一轮。'
      + '返回第一行是 status：ok=已发出 / no-target=群里没被点名，不用回应 / error=失败。',
    category: 'utility',
    icon: '🃏',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '要发几套牌，3~20，默认按用户设置（一般 10）。' },
        format: {
          type: 'string',
          description: 'standard 或 wild。只有用户明确说「狂野」时才传 wild；不传就用用户设置里的默认模式。',
        },
      },
      required: [],
    },

    async execute(ctx, args) {
      const cfg = cfgOf();

      const deny = gate(ctx, cfg);
      if (deny) {
        log(`拒绝一次未点名的调用（档位 ${ctx?.session?.contextTier ?? '?'}）`);
        return { content: `status: no-target\n${deny}`, isError: true };
      }

      const sender = ctx?.sender;
      const chatKey = String(ctx?.chatKey || '');
      if (!sender || !chatKey) {
        return { content: 'status: error\n拿不到发送通道（ctx.sender / chatKey），这条没发出去。', isError: true };
      }

      const { hs, rd } = await deps();

      const format = String(args?.format || cfg.format || 'standard').toLowerCase() === 'wild' ? 'wild' : 'standard';
      const requested = Number(args?.count);
      const count = Number.isFinite(requested) && requested >= 3 ? Math.min(20, Math.round(requested))
        : Math.max(3, Math.min(20, Number(cfg.deckCount) || 10));
      const minGames = Math.max(0, Number(cfg.minGames) || 0);
      const wantDecks = cfg.sendDecks !== false;
      const wantCharts = cfg.sendCharts !== false;

      const canMedia = typeof sender.sendMedia === 'function';
      const canText = typeof sender.sendTextBatch === 'function';
      if (!canMedia && !canText) {
        return { content: 'status: error\n发送通道不支持发送，这条没发出去。', isError: true };
      }

      /* 1) 抓数据：三块并行，任何一块挂了都不影响其它块 */
      const [constructed, arena, deckRes, siteStats] = await Promise.all([
        wantCharts ? hs.fetchConstructedWinrates().catch((e) => ({ error: e?.message || String(e) })) : null,
        wantCharts ? hs.fetchArenaWinrates().catch((e) => ({ error: e?.message || String(e) })) : null,
        wantDecks
          ? hs.fetchTopDecks({ format, count, minGames }).catch((e) => ({ error: e?.message || String(e) }))
          : null,
        hs.fetchSiteStats(),
      ]);

      const errs = [];
      if (wantCharts && constructed?.error) errs.push(`职业胜率抓取失败：${constructed.error}`);
      if (wantCharts && Array.isArray(arena) === false && arena?.error) errs.push(`竞技场胜率抓取失败：${arena.error}`);
      if (wantDecks && deckRes?.error) errs.push(`套牌抓取失败：${deckRes.error}`);

      const hasCharts = wantCharts && (
        (Array.isArray(constructed?.standard) && constructed.standard.length > 0)
        || (Array.isArray(constructed?.wild) && constructed.wild.length > 0)
        || (Array.isArray(arena) && arena.length > 0)
      );
      const hasDecks = wantDecks && Array.isArray(deckRes?.decks) && deckRes.decks.length > 0;

      if (!hasCharts && !hasDecks) {
        const why = errs.length ? errs.join('；') : '既没有拿到胜率也没有拿到套牌';
        log(`全部数据源失败：${why}`);
        return { content: `status: error\n今日炉石抓取失败：${why}。稍后再试。`, isError: true };
      }

      const gameLabel = siteStats?.games_today ? `今日 ${nfmt(siteStats.games_today)} 场` : '';
      let sent = 0;
      const sentNotes = [];

      /* 2) 三张胜率图 */
      if (hasCharts) {
        const cards = [];
        if (Array.isArray(constructed?.standard) && constructed.standard.length) {
          cards.push({
            tag: 'standard',
            html: rd.buildRateCardHtml({
              kicker: 'STANDARD',
              title: '标准模式 · 职业胜率',
              subtitle: `钻石到传说 · 近一日${gameLabel ? ` · ${gameLabel}` : ''}`,
              rows: constructed.standard,
              note: '按胜率降序',
              footer: `今日炉石 · ${nowInShanghai()}`,
            }),
          });
        }
        if (Array.isArray(constructed?.wild) && constructed.wild.length) {
          cards.push({
            tag: 'wild',
            html: rd.buildRateCardHtml({
              kicker: 'WILD',
              title: '狂野模式 · 职业胜率',
              subtitle: '钻石到传说 · 近一日',
              rows: constructed.wild,
              note: '按胜率降序',
              footer: `今日炉石 · ${nowInShanghai()}`,
            }),
          });
        }
        if (Array.isArray(arena) && arena.length) {
          cards.push({
            tag: 'arena',
            html: rd.buildRateCardHtml({
              kicker: 'ARENA',
              title: '竞技场 · 职业胜率',
              subtitle: '全部对局 · 每职业样本为抓取轮数',
              rows: arena,
              note: '按胜率降序',
              footer: `今日炉石 · ${nowInShanghai()}`,
            }),
          });
        }

        // 串行渲染：render.js 有全局锁，并发第二张就返回 null
        const images = [];
        for (const c of cards) {
          const png = await rd.renderCardPng(c.html);
          if (png) {
            try {
              images.push({ path: rd.writePngFile(png, c.tag), tag: c.tag });
            } catch (e) {
              log(`图 ${c.tag} 落盘失败：${e?.message ?? e}`);
            }
          } else {
            log(`图 ${c.tag} 渲染失败`);
          }
        }

        if (images.length && canMedia) {
          const segs = [
            { type: 'text', data: { text: `🃏 今日炉石 · ${nowInShanghai()}\n今日胜率榜（职业 · 钻石到传说）` } },
            ...images.map((im) => ({ type: 'image', data: { file: im.path } })),
          ];
          try {
            await sender.sendMedia(chatKey, segs, { label: '今日炉石·胜率图' });
            sent += 1;
            sentNotes.push(`${images.length} 张胜率图`);
          } catch (e) {
            log(`发图失败：${e?.message ?? e}`);
            errs.push(`图片发送失败：${String(e?.message ?? e).slice(0, 80)}`);
          }
        } else if (images.length) {
          log('发送通道不支持媒体，跳过三张图');
        }
      }

      /* 3) 套牌清单 */
      if (hasDecks) {
        // 存一份清单，供「发某套代码」按序号 / 名字取用
        saveLastDecks(chatKey, { format: deckRes.format, decks: deckRes.decks });
        const text = buildDeckText(deckRes.decks, {
          format: deckRes.format,
          minGames,
          totalCandidates: deckRes.totalCandidates,
        });
        try {
          if (canMedia) {
            await sender.sendMedia(chatKey, [{ type: 'text', data: { text } }], { label: '今日炉石·套牌' });
          } else {
            await sender.sendTextBatch(chatKey, [text], {});
          }
          sent += 1;
          sentNotes.push(`${deckRes.decks.length} 套牌`);
        } catch (e) {
          const msg = String(e?.message ?? e).slice(0, 120);
          log(`发套牌失败：${msg}`);
          // 媒体配额用尽时退化成纯文字，尽量别让用户什么都收不到
          if (canText) {
            try {
              await sender.sendTextBatch(chatKey, [text], {});
              sent += 1;
              sentNotes.push(`${deckRes.decks.length} 套牌（文字兜底）`);
            } catch (e2) {
              errs.push(`套牌发送失败：${String(e2?.message ?? e2).slice(0, 80)}`);
            }
          } else {
            errs.push(`套牌发送失败：${msg}`);
          }
        }
      }

      if (!sent) {
        return { content: `status: error\n一条都没发出去：${errs.join('；') || '未知原因'}`, isError: true };
      }

      const tail = errs.length ? `\n（部分内容失败：${errs.join('；')}）` : '';
      log(`已发送 ${sent} 条：${sentNotes.join(' + ')}`);
      return {
        content: `status: ok\n已发出 ${sent} 条消息：${sentNotes.join('、')}。`
          + `（${FORMAT_CN[format] || format}）${tail}\n`
          + '不要再用 send_message 复述内容、也不要自己另做总结，直接结束这一轮。',
      };
    },
  });
  api.registerTool({
    id: 'deck_code',
    name: '发某套牌的卡组代码（游戏内导出格式）',
    description:
      '用户已经看过「今日炉石」的套牌清单，现在要其中某一套的卡组代码时调用。'
      + 'query 只填序号数字（如 "3"）或套牌名（如 "硬币贼"），不要填整句。'
      + '清单缓存 2 小时内有效；没缓存或对不上会返回说明文字，按说明处理。'
      + '⚠️ 发完不要再调 send_message 复述，直接结束这一轮。'
      + '返回第一行 status：ok=已发出 / no-target=群里没被点名 / no-list=还没发过清单 / not-found=对不上 / error=失败。',
    category: 'utility',
    icon: '📋',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '第几套（填数字，如 "3"）或套牌名（如 "硬币贼"）。' },
      },
      required: ['query'],
    },

    async execute(ctx, args) {
      const cfg = cfgOf();
      const deny = gate(ctx, cfg);
      if (deny) return { content: `status: no-target\n${deny}`, isError: true };

      const sender = ctx?.sender;
      const chatKey = String(ctx?.chatKey || '');
      if (!sender || !chatKey) {
        return { content: 'status: error\n拿不到发送通道（ctx.sender / chatKey），这条没发出去。', isError: true };
      }

      const last = loadLastDecks(chatKey);
      if (!last) {
        return {
          content: 'status: no-list\n这个会话最近 2 小时没发过「今日炉石」清单。'
            + '先调 today-hearthstone__today 发一次清单，再问用户要哪套。',
          isError: true,
        };
      }

      const deck = matchDeck(last.decks, args?.query);
      if (!deck) {
        const brief = last.decks.map((d, i) => `${i + 1}.${d.cnName || d.name}`).join('、');
        return {
          content: `status: not-found\n对不上「${String(args?.query || '').slice(0, 20)}」。`
            + `当前清单：${brief}。问用户要第几套。`,
          isError: true,
        };
      }

      const { hs, cd } = await deps();
      const text = await buildDeckExport({ hs, cd }, deck, last.format);
      try {
        if (typeof sender.sendMedia === 'function') {
          await sender.sendMedia(chatKey, [{ type: 'text', data: { text } }], { label: '今日炉石·卡组代码' });
        } else {
          await sender.sendTextBatch(chatKey, [text], {});
        }
        log(`已发出「${deck.cnName || deck.name}」的卡组代码`);
        return {
          content: `status: ok\n「${deck.cnName || deck.name}」的卡组代码已发出。`
            + '不要再用 send_message 复述，直接结束这一轮。',
        };
      } catch (e) {
        const msg = String(e?.message ?? e).slice(0, 100);
        log(`发代码失败：${msg}`);
        return { content: `status: error\n代码没发出去：${msg}`, isError: true };
      }
    },
  });
}
