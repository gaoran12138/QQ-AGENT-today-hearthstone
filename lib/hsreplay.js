// 今日炉石 · 数据层
//
// 数据全部来自 hsreplay.net 的公开统计接口（本机直连可达，无需登录 / 无需 Premium）：
//   套牌列表  /analytics/query/trending_decks_by_popularity/?GameType=…&LeagueRankRange=DIAMOND_THROUGH_LEGEND&Region=ALL
//   职业胜率  /analytics/query/player_class_performance_summary_v2/?LeagueRankRange=DIAMOND_THROUGH_LEGEND
//   竞技场    /api/v1/arena/classes_stats/
//   卡组代码  /decks/{shortid}/ 的 SSR HTML 内嵌 AAE… 代码，<title> 即套牌名
//
// 踩过的坑（别改）：
//  1) list_decks_by_win_rate_v2 任何 TimeRange 都要 Premium（403），不能用来排序，只能用 trending。
//     trending 的 GameType 参数是有效的：RANKED_WILD 会返回狂野套牌（换个 shortid），不是忽略参数。
//  2) trending 里 archetype_id 可能为 null（狂野冷门套牌），所以套牌名必须以 /decks/{shortid}/ 的 <title> 为准。
//  3) 卡组代码自己实现 deckstring 编码器风险大（hero/class 编号错一位就导入失败），
//     直接用详情页里 Blizzard 官方生成的那串，保证可导入。
//  4) 胜率排序必须带场数门槛：trending 里有 61 场的套牌，胜率再高也是噪声。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../src/config.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const BASE = 'https://hsreplay.net';

export const CLASS_CN = {
  DEATHKNIGHT: '死亡骑士',
  DEMONHUNTER: '恶魔猎手',
  DRUID: '德鲁伊',
  HUNTER: '猎人',
  MAGE: '法师',
  PALADIN: '圣骑士',
  PRIEST: '牧师',
  ROGUE: '潜行者',
  SHAMAN: '萨满祭司',
  WARLOCK: '术士',
  WARRIOR: '战士',
};

/** 官方职业色，用于卡片配色 */
export const CLASS_COLOR = {
  DEATHKNIGHT: '#C41E3A',
  DEMONHUNTER: '#A330C9',
  DRUID: '#FF7C0A',
  HUNTER: '#AAD372',
  MAGE: '#3FC7EB',
  PALADIN: '#F48CBA',
  PRIEST: '#E8E8E8',
  ROGUE: '#FFF468',
  SHAMAN: '#0070DD',
  WARLOCK: '#8788EE',
  WARRIOR: '#C69B6D',
};

/** hsreplay 的 deck_class 数字编号（1-10 + 14，14=恶魔猎手，实测与首页竞技场榜一致） */
export const CLASS_BY_ID = {
  1: 'DEATHKNIGHT',
  2: 'DRUID',
  3: 'HUNTER',
  4: 'MAGE',
  5: 'PALADIN',
  6: 'PRIEST',
  7: 'ROGUE',
  8: 'SHAMAN',
  9: 'WARLOCK',
  10: 'WARRIOR',
  14: 'DEMONHUNTER',
};

/** 排行榜展示顺序：胜率高到低由调用方排，这里只兜底未知职业 */
export function classCn(code) {
  return CLASS_CN[code] || code || '未知职业';
}

export function classColor(code) {
  return CLASS_COLOR[code] || '#8b9bb4';
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

async function getText(path, { timeoutMs = 20000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'user-agent': UA, accept: '*/*', 'accept-language': 'en-US,en;q=0.9' },
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}（${path.split('?')[0]}）`);
    return text;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`请求超时（${path.split('?')[0]}）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(path, opts) {
  const text = await getText(path, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回不是 JSON（${path.split('?')[0]}）`);
  }
}

/** 今日站点级统计（总场数 / 贡献者），失败只是少一行脚注，不算错误 */
export async function fetchSiteStats() {
  try {
    const j = await getJson('/api/v1/live/games_count/weekly/', { timeoutMs: 10000 });
    return j?.data || null;
  } catch {
    return null;
  }
}

/** 标准 + 狂野职业胜率（同一接口返回两套，按 BGT_RANKED_* 分） */
export async function fetchConstructedWinrates() {
  const j = await getJson('/analytics/query/player_class_performance_summary_v2/?LeagueRankRange=DIAMOND_THROUGH_LEGEND');
  const data = j?.series?.data || {};
  const pick = (key) => {
    const group = data[key] || {};
    return Object.entries(group)
      .filter(([, v]) => v && Number.isFinite(Number(v.win_rate)))
      .map(([code, v]) => ({ code, cn: classShort(code), winrate: Number(v.win_rate), color: classColor(code) }))
      .sort((a, b) => b.winrate - a.winrate);
  };
  const standard = pick('BGT_RANKED_STANDARD');
  const wild = pick('BGT_RANKED_WILD');
  if (!standard.length) throw new Error('HSReplay 没有返回标准模式职业胜率');
  return { standard, wild };
}

/** 竞技场职业胜率 */
export async function fetchArenaWinrates() {
  const j = await getJson('/api/v1/arena/classes_stats/');
  const list = Array.isArray(j?.data) ? j.data : [];
  return list
    .filter((x) => Number.isFinite(Number(x?.win_rate)))
    .map((x) => {
      const code = CLASS_BY_ID[Number(x.deck_class)] || '';
      return {
        code,
        cn: classShort(code),
        winrate: Number(x.win_rate),
        drafts: Number(x.num_drafts) || 0,
        pickRate: Number(x.pick_rate) || 0,
        color: classColor(code),
      };
    })
    .sort((a, b) => b.winrate - a.winrate);
}

/**
 * 全职业范围按胜率取 TopN 套牌。
 *
 * trending 每个职业只给 3 套（狂野常常只有 1 套），所以候选池约 33 套；
 * 先按场数门槛过滤掉噪声，再按胜率排序。
 */
/** archetype id → 英文名。一次请求拿全部 776 条，常驻内存 1 小时。
 *  用它给套牌起名，就不用为每套牌单独抓一次页面（那是 33 次请求 / 13 秒）。 */
// archetypes 接口一次返回全部 776 条，但要 10 秒上下 —— 所以内存 + 磁盘两级缓存，
// 进程重启或技能 reload 之后都能直接用，不用再等。
const ARCH_FILE = path.join(DATA_DIR, 'today-hearthstone-archetypes.json');
const ARCH_TTL_MS = 24 * 60 * 60 * 1000;
let archetypeCache = null;
let archetypeAt = 0;
async function fetchArchetypeNames() {
  if (archetypeCache && Date.now() - archetypeAt < ARCH_TTL_MS) return archetypeCache;

  try {
    const st = fs.statSync(ARCH_FILE);
    const fresh = Date.now() - st.mtimeMs < ARCH_TTL_MS;
    if (fresh) {
      const j = JSON.parse(fs.readFileSync(ARCH_FILE, 'utf8'));
      if (j?.names && Object.keys(j.names).length > 100) {
        archetypeCache = new Map(Object.entries(j.names).map(([k, v]) => [Number(k), v]));
        archetypeAt = st.mtimeMs;
        return archetypeCache;
      }
    }
  } catch {
    // 没缓存 / 被改坏：走网络
  }

  const list = await getJson('/api/v1/archetypes/?hl=en');
  const m = new Map();
  for (const a of Array.isArray(list) ? list : []) {
    if (a?.id != null && a.name) m.set(Number(a.id), String(a.name));
  }
  if (m.size > 100) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(ARCH_FILE, JSON.stringify({ at: Date.now(), names: Object.fromEntries(m) }), 'utf8');
    } catch {
      // 落盘失败不影响本次使用
    }
  }
  archetypeCache = m;
  archetypeAt = Date.now();
  return m;
}

/** 按需抓某一套的卡组代码（约 2 秒）。清单里不存代码，用户真要时才调这个。 */
export async function fetchDeckCode(shortid) {
  const page = await getText(`/decks/${shortid}/`, { timeoutMs: 15000 });
  return (page.match(/AAE[A-Za-z0-9+/]{20,}={0,2}/) || [])[0] || '';
}

export async function fetchTopDecks({ format = 'standard', count = 10, minGames = 800, dustOf = null } = {}) {
  const gameType = format === 'wild' ? 'RANKED_WILD' : 'RANKED_STANDARD';
  const qs = `GameType=${gameType}&LeagueRankRange=DIAMOND_THROUGH_LEGEND&Region=ALL`;
  // archetypes 一次就能拿到全部套牌名；抓不到也不影响主流程，缺失的名字后面单独补
  const [j, archNames] = await Promise.all([
    getJson(`/analytics/query/trending_decks_by_popularity/?${qs}`),
    fetchArchetypeNames().catch(() => new Map()),
  ]);
  const data = j?.series?.data || {};

  const pool = [];
  for (const [cls, decks] of Object.entries(data)) {
    if (!Array.isArray(decks)) continue;
    for (const d of decks) {
      if (!d?.shortid) continue;
      const games = Number(d.total_games) || 0;
      const winrate = Number(d.win_rate);
      if (!Number.isFinite(winrate)) continue;
      // 这里不再按 minGames 过滤：全职业那套数据要留给「问某职业推荐什么」用
      pool.push({
        shortid: String(d.shortid),
        cls,
        cn: classShort(cls),
        color: classColor(cls),
        winrate,
        games,
        popularityDelta: Number(d.popularity_delta) || 0,
        archetypeId: d.archetype_id ?? null,
        // 原始牌表 [[dbfId, 张数], ...]：导出「# 2x (3) 卡名」那种格式要用
        deckList: parseDeckList(d.deck_list),
        avgMinutes: Math.round((Number(d.avg_game_length_seconds) || 0) / 6) / 10,
      });
    }
  }

  if (!pool.length) {
    throw new Error('没有拿到今日套牌数据，稍后再试');
  }

  // 同一套牌（shortid）只留一次
  const seen = new Set();
  const uniq = pool.filter((d) => (seen.has(d.shortid) ? false : (seen.add(d.shortid), true)));

  // 套牌名直接从 archetypes 映射拿 —— 11 个职业 × 3 套全都有名字，不用挨个抓页面。
  // 卡组代码也不抓：清单里本来就不显示代码，用户真要那套时再 fetchDeckCode 按需抓（约 2 秒）。
  let detailed = uniq.map((d) => ({
    ...d,
    name: (d.archetypeId != null && archNames.get(Number(d.archetypeId))) || '',
    code: '',
  }));

  // archetype_id 为空（新构筑还没来得及归类）的少数几套，抓页面补个名字
  const needName = detailed.filter((d) => !d.name);
  if (needName.length) {
    const fixed = await mapLimit(needName, 6, async (deck) => {
      const fallbackName = `套牌 ${deck.shortid.slice(0, 6)}`;
      try {
        const page = await getText(`/decks/${deck.shortid}/`, { timeoutMs: 12000 });
        const title = decodeEntities((page.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '')
          .replace(/\s*[-|]\s*HSReplay\.net\s*$/i, '');
        return { ...deck, name: title || fallbackName };
      } catch {
        return { ...deck, name: fallbackName };
      }
    });
    const byId = new Map(fixed.map((f) => [f.shortid, f]));
    detailed = detailed.map((d) => byId.get(d.shortid) || d);
  }
  for (const d of detailed) d.cnName = deckCn(d.name);

  // 合成成本：按普通卡计价，等价于 HSReplay 卡组页的「合成所需尘」
  for (const d of detailed) {
    if (typeof dustOf === 'function') {
      try { d.dust = Number(dustOf(d.deckList)) || 0; } catch { d.dust = 0; }
    } else {
      d.dust = 0;
    }
  }

  // 分职业：每职业内部同名去重（留场数最多的那套），按胜率排，最多 3 套。
  // 不过 minGames 门槛 —— 冷门职业本来场数就少，滤完就空了。
  const byClass = {};
  for (const d of detailed) {
    if (!byClass[d.cls]) byClass[d.cls] = [];
    byClass[d.cls].push(d);
  }
  for (const cls of Object.keys(byClass)) {
    const list = dedupeByName(byClass[cls]);
    // 场数太少的套牌胜率不可信（几十场的「最强」是噪声），优先给样本够的
    const solid = list.filter((d) => d.games >= 100);
    byClass[cls] = (solid.length >= 3 ? solid : [...solid, ...list.filter((d) => d.games < 100)]).slice(0, 3);
  }

  // Top N：跨职业，先按场数门槛筛，再同名去重
  const eligible = minGames > 0 ? detailed.filter((d) => d.games >= minGames) : detailed;
  const decks = dedupeByName(eligible).slice(0, Math.max(1, Math.min(20, count)));

  return { decks, byClass, format, gameType, totalCandidates: eligible.length, minGames };
}

/** 同名归并：每个名字留场数最多的那套当代表（场数多 = 更主流，用户去 HSReplay 点开看到的
 *  就是这一套，不会对不上）；不同名字的套数不够时，落选的同名套牌按胜率补在后面。 */
function dedupeByName(list) {
  const groups = new Map();
  for (const d of list) {
    if (!groups.has(d.name)) groups.set(d.name, []);
    groups.get(d.name).push(d);
  }
  const byWr = (a, b) => b.winrate - a.winrate || b.games - a.games;
  const reps = [...groups.values()].map((g) => g.slice().sort((a, b) => b.games - a.games)[0]);
  reps.sort(byWr);
  const extra = [...groups.values()]
    .flatMap((g) => g.slice().filter((d) => !reps.includes(d)))
    .sort(byWr);
  return [...reps, ...extra];
}

/** trending 接口把 deck_list 塞成了 JSON 字符串（"[[dbfId,count],...]"），这里统一解析成数组 */
function parseDeckList(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ── 国服叫法 ──────────────────────────────────────────────────────
 * 职业用短称：国服玩家只说「术 / 瞎 / DK」，不会念「术士 / 恶魔猎手」。
 * 套牌名只收录确认过的国服叫法，没把握的一律留英文原样 —— 翻错比不翻更糟；
 * HSReplay 每个版本都会冒出新 archetype，查不到的自动走英文兜底。
 */
export const CLASS_SHORT = {
  DEATHKNIGHT: 'DK',
  DEMONHUNTER: '瞎',
  DRUID: '德',
  HUNTER: '猎',
  MAGE: '法',
  PALADIN: '骑',
  PRIEST: '牧',
  ROGUE: '贼',
  SHAMAN: '萨',
  WARLOCK: '术',
  WARRIOR: '战',
};

export function classShort(code) {
  return CLASS_SHORT[code] || CLASS_CN[code] || code || '未知';
}

/** 英文 archetype 名 → 国服叫法。只放确认过的。 */
export const DECK_CN = {
  'Zoo Warlock': '动物园术',
  "C'Thun Warlock": '克苏恩控制术',
  "C'Thun Shaman": '克苏恩萨',
  "C'Thun Demon Hunter": '克苏恩瞎',
  'Coin Rogue': '硬币贼',
  'Dragon Warrior': '龙战',
  'Handbuff Death Knight': '污手DK',
  'Herald Shaman': '死亡萨',
  'Mug Shaman': '穆格萨',
  'Cannon Warrior': '海盗战',
};

/** 查国服译名。查不到返回空串，调用方用英文原名兜底。 */
export function deckCn(name) {
  const key = String(name || '').replace(/[\u2018\u2019\u02bc]/g, "'").trim();
  return DECK_CN[key] || '';
}
