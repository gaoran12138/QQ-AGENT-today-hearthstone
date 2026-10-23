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
export async function fetchTopDecks({ format = 'standard', count = 10, minGames = 800 } = {}) {
  const gameType = format === 'wild' ? 'RANKED_WILD' : 'RANKED_STANDARD';
  const qs = `GameType=${gameType}&LeagueRankRange=DIAMOND_THROUGH_LEGEND&Region=ALL`;
  const j = await getJson(`/analytics/query/trending_decks_by_popularity/?${qs}`);
  const data = j?.series?.data || {};

  const pool = [];
  for (const [cls, decks] of Object.entries(data)) {
    if (!Array.isArray(decks)) continue;
    for (const d of decks) {
      if (!d?.shortid) continue;
      const games = Number(d.total_games) || 0;
      const winrate = Number(d.win_rate);
      if (!Number.isFinite(winrate)) continue;
      if (minGames > 0 && games < minGames) continue;
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
    throw new Error(`没有拿到符合条件的套牌（场数门槛 ${minGames} 场，可调低）`);
  }

  // 同一套牌（shortid）只留一次；不同代码的同类套牌都保留，让用户自己挑
  const seen = new Set();
  const uniq = pool.filter((d) => (seen.has(d.shortid) ? false : (seen.add(d.shortid), true)));
  uniq.sort((a, b) => b.winrate - a.winrate || b.games - a.games);
  // 候选池要比目标数量大：同名套牌（比如 3 套 C'Thun Demon Hunter）后面还要去重，
  // 池子刚好等于 count 的话，去完就不够数了。
  const poolSize = Math.max(1, Math.min(20, Math.max(count * 2, count + 4)));
  const picked = uniq.slice(0, poolSize);

  // 逐个补套牌名 + 卡组代码（并发 4，失败不影响其它套）
  const detailed = await mapLimit(picked, 4, async (deck) => {
    const fallbackName = `套牌 ${deck.shortid.slice(0, 6)}`;
    try {
      const page = await getText(`/decks/${deck.shortid}/`, { timeoutMs: 15000 });
      const title = decodeEntities((page.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '')
        .replace(/\s*[-|]\s*HSReplay\.net\s*$/i, '');
      const code = (page.match(/AAE[A-Za-z0-9+/]{20,}={0,2}/) || [])[0] || '';
      return { ...deck, name: title || fallbackName, cnName: deckCn(title || ''), code };
    } catch {
      // 失败项给个带 shortid 的唯一名字：不进同名去重，否则所有失败项会被合并成一套
      return { ...deck, name: fallbackName, cnName: '', code: '' };
    }
  });

  // 同名归并：每个名字只留场数最多的一套当代表，不够数再按胜率补同名落选套牌。
  // 目的：避免 Top10 里塞进 3 套 C'Thun Demon Hunter 这种纯重复，信息密度太低。
  const groups = new Map();
  for (const d of detailed) {
    if (!groups.has(d.name)) groups.set(d.name, []);
    groups.get(d.name).push(d);
  }
  const byWr = (a, b) => b.winrate - a.winrate || b.games - a.games;
  // 同一个套牌名（同一个 archetype）在 HSReplay 上常有多套不同构筑，胜率最高那套
  // 往往是样本很小的小众改法。这里留「场数最多」的那套当代表：场数多 = 更主流，
  // 用户去 HSReplay 点开同名套牌时看到的就是这一套，不会对不上。
  const reps = [...groups.values()].map((g) => g.slice().sort((a, b) => b.games - a.games)[0]);
  reps.sort(byWr);
  // 不同名字的套数不够时，再把落选的同名套牌按胜率补进来
  const extra = [...groups.values()]
    .flatMap((g) => g.slice().filter((d) => !reps.includes(d)))
    .sort(byWr);
  const decks = [...reps, ...extra].slice(0, Math.max(1, Math.min(20, count)));

  return { decks, format, gameType, totalCandidates: uniq.length, minGames };
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
  'Handbuff Death Knight': '手牌buff DK',
  'Herald Shaman': '死亡萨',
  'Mug Shaman': '穆格萨',
  'Cannon Warrior': '海盗战',
};

/** 查国服译名。查不到返回空串，调用方用英文原名兜底。 */
export function deckCn(name) {
  const key = String(name || '').replace(/[\u2018\u2019\u02bc]/g, "'").trim();
  return DECK_CN[key] || '';
}
