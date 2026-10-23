// 卡牌数据：只用到「dbfId → 中文名 + 费用 + 稀有度」，所以缓存成精简 JSON。
// 稀有度是给「合成所需尘数」用的 —— HSReplay 卡组页的 Dust cost 就是这个口径（按普通卡计价）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const DB_FILE = path.join(DATA_DIR, 'today-hearthstone-cards-zhcn-v2.json');
const SRC_URL = 'https://api.hearthstonejson.com/v1/latest/zhCN/cards.collectible.json';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 天；新版本上线后过期重下

/** 单张合成成本（普通卡，非金卡） */
export const DUST_BY_RARITY = { FREE: 0, COMMON: 40, RARE: 100, EPIC: 400, LEGENDARY: 1600 };

let cache = null;

/** 载入中文卡牌库（dbfId → [name, cost, rarity]）。首次下载约 2.6 MB / 2~3 秒，之后读本地缓存。 */
export async function loadCardDb() {
  if (cache) return cache;

  try {
    const st = fs.statSync(DB_FILE);
    if (Date.now() - st.mtimeMs < TTL_MS) {
      const j = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      const first = j && typeof j === 'object' ? Object.values(j)[0] : null;
      if (j && Object.keys(j).length > 1000 && Array.isArray(first) && first.length === 3) {
        cache = j;
        return cache;
      }
    }
  } catch {
    // 没有缓存文件 / 被手改坏 / 磁盘只读，都走下载
  }

  const res = await fetch(SRC_URL, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
      accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`卡牌数据下载失败：HTTP ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list) || list.length < 1000) throw new Error('卡牌数据格式不对');

  const m = {};
  for (const c of list) {
    if (!c || c.dbfId == null || !c.name) continue;
    m[c.dbfId] = [c.name, Number.isFinite(c.cost) ? c.cost : 99, String(c.rarity || '').toUpperCase()];
  }

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(m), 'utf8');
  } catch {
    // 写不进磁盘也不影响本次使用
  }

  cache = m;
  return cache;
}

/** dbfId → { name, cost, rarity }；查不到返回 null（衍生物、异画卡等可能缺） */
export function cardInfo(db, dbfId) {
  const hit = db?.[dbfId];
  return Array.isArray(hit) ? { name: hit[0], cost: hit[1], rarity: hit[2] || '' } : null;
}

/** 合成整套牌要多少尘：每张按稀有度计价（传说 1600 / 史诗 400 / 稀有 100 / 普通 40） */
export function dustOf(deckList, db) {
  if (!Array.isArray(deckList) || !db) return 0;
  let total = 0;
  for (const item of deckList) {
    if (!Array.isArray(item)) continue;
    const hit = db[item[0]];
    const rarity = Array.isArray(hit) ? hit[2] : '';
    const unit = DUST_BY_RARITY[rarity] ?? 0;
    total += unit * (Number(item[1]) || 1);
  }
  return total;
}
