# 今日炉石 · today-hearthstone

给 **QQ Agent** 用的炉石传说天梯情报技能。群里 @ 它说一句「今日炉石」，就把当天的天梯环境连图带表发出来，不用再翻 HSReplay。

- 📊 **三张职业胜率卡片图**：标准 / 狂野 / 竞技场，中文职业短称 + 职业配色 + 按胜率降序排列
- 🃏 **全职业范围胜率 Top10 套牌清单**：套牌名、职业、胜率、样本场数，一行一套不刷屏
- 📋 **按需发单套卡组代码**：看到想玩的回一句「第 3 套」或「海盗战」，只回那一套的代码，方便长按复制
- 🇨🇳 **套牌中文名**：`Zoo Warlock` → 动物园术，`C'Thun Warlock` → 克苏恩控制术，新套牌自动回落英文原名
- ⏱️ **清单缓存 2 小时**：同一会话追问代码不重复抓取

数据全部来自 HSReplay.net 的公开统计接口，无需登录、无需 Premium、无需代理。

## 用法

```
你：今日炉石
它：[标准胜率图] [狂野胜率图] [竞技场胜率图]
    🃏 今日炉石 · 标准模式最强 10 套
    钻石到传说 · 候选 23 套 · 只留 800 场以上

    1. 术 · 动物园术 · 胜率 63.5% · 6,399 场
    2. 萨 · 克苏恩萨 · 胜率 62.6% · 6,697 场
    3. 瞎 · 克苏恩瞎 · 胜率 61.6% · 2,741 场
    ...
    要哪一套的卡组代码，回我「第 3 套」或套牌名就行。

你：第 3 套
它：🃏 克苏恩瞎 · C'Thun Demon Hunter
    瞎 · 胜率 61.6% · 2,741 场

    AAECAea5AwTk7wOo7wPn8APQ+QMN2cYD...
```

只说「今日炉石」时默认标准模式。说「狂野炉石」「看看狂野」会切到狂野；说「竞技场」只发竞技场那张图。

## 安装

目录名必须是 `today-hearthstone`，放进 QQ Agent 的 `resources/app/skills/` 下：

```
<QQ Agent>/resources/app/skills/today-hearthstone/
├── skill.json
├── index.js
├── hsreplay.js
├── render.js
└── README.md
```

然后让它重新扫一遍技能，任选其一：

- `curl -X POST http://127.0.0.1:3210/api/skills/reload`
- 或直接重启 QQ Agent

技能默认开启（`enabledByDefault: true`），加载后模型能看到两个工具：`today-hearthstone__today`、`today-hearthstone__deck_code`。

从 Release 下载 zip 的话，解压出的文件同样放进这个目录即可。

## 设置

在 QQ Agent 的技能设置面板里改，或改 `data/config.json` 的 `skills.today-hearthstone`。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关，关掉后模型连工具都看不到 |
| `mentionOnly` | `true` | 群里只在被 @ / 拍一拍时回复，私聊不受影响 |
| `deckCount` | `10` | 清单发几套（3~20） |
| `minGames` | `800` | 样本场数下限，低于它的套牌胜率是噪声 |
| `format` | `standard` | 默认模式；用户明确说「狂野」时才切 |
| `sendCharts` | `true` | 是否发三张胜率图 |
| `sendDecks` | `true` | 是否发套牌清单 |

## 数据源

| 用途 | 接口 |
| --- | --- |
| 套牌列表 | `GET /analytics/query/trending_decks_by_popularity/?GameType=RANKED_STANDARD&LeagueRankRange=DIAMOND_THROUGH_LEGEND&Region=ALL` |
| 职业胜率 | `GET /analytics/query/player_class_performance_summary_v2/?LeagueRankRange=DIAMOND_THROUGH_LEGEND` |
| 竞技场 | `GET /api/v1/arena/classes_stats/` |
| 卡组代码 | `GET /decks/{shortid}/` 页面 SSR 里内嵌的 `AAE…` 串 |

口径：钻石到传说、全部区服、实时抓取不落库。

## 网络与文件访问

本技能只做两件事：抓公开统计数据、写一份临时清单缓存。

**网络** —— 唯一出口是 `hsreplay.net`（HTTPS GET），即上表四个接口加套牌详情页。不带 cookie、不需要 API key、不需要代理，不向任何第三方上报数据。

**文件** —— 只写 `data/today-hearthstone-last.json`（当前会话的清单缓存，2 小时过期，供「第 N 套代码」追问）；渲染卡片时会往系统临时目录写一个 HTML 和一张 PNG，用完立即删除。不读聊天记录、不读配置、不访问用户目录。

**权限声明** —— `skill.json` 里的 `permissions: ["web_fetch"]` 与代码的实际行为一致。

## 实现

| 文件 | 职责 |
| --- | --- |
| `skill.json` | 清单：设置项、设置面板 schema、给模型的提示词、触发示例 |
| `index.js` | 两个工具的实现、权限门（mentionOnly）、清单缓存、消息发送 |
| `hsreplay.js` | 数据层：四个接口抓取、职业/套牌中文名、卡组代码提取 |
| `render.js` | 卡片渲染：拼 HTML + Electron 离屏截图成 PNG |

卡片图走 QQ Agent 既有的渲染管线：`BrowserWindow({ offscreen: true })` 加载临时 HTML → 量内容高度 → `capturePage().toPNG()`。渲染失败会自动退化成纯文字，消息不会整条失败。

发送只用 `sender.sendMedia` / `sender.sendTextBatch` 这一条合法通道，限频与聊天记录都走宿主逻辑。

## 已知限制

- **hsguru.com 连不上**：该站在本机 DNS 被解析成假地址，用 DoH 拿到的真实 Cloudflare IP 直连也会被 reset，浏览器只能看到安全验证页。所以套牌数据改用 hsreplay 的同源统计，两站数据同源、口径略有差异。
- `/analytics/query/list_decks_by_win_rate_v2/` 的任何 TimeRange 都需要 Premium（403），因此排序只能基于 trending 的候选池（约 33 套），不是全站全量套牌。
- 套牌中文名是人工维护的对照表（`hsreplay.js` 的 `DECK_CN`），新扩展包上线出现新套牌时会先显示英文原名，补一条映射即可。
- 图片由 Electron 离屏截图渲染，极端环境下若渲染失败会自动退化成纯文字。

## 维护注意

- 改完 `hsreplay.js` / `render.js` 后必须 `POST /api/skills/reload`。这两个文件由 `index.js` 里的 `deps()` 用**动态 import + 时间戳**加载，不要改回静态 `import`：宿主 reload 时只给入口 `index.js` 加破缓存参数，静态 import 的依赖会命中 Node 的 ESM 模块缓存，改了也不生效（2026-10-23 踩过：改完中文名 reload 后消息里仍是旧英文）。
- 套牌中文名在 `hsreplay.js` 的 `DECK_CN`，职业短称在 `CLASS_SHORT`。新扩展包上线出现新套牌时先显示英文原名，按 `'英文名': '中文名'` 加一行即可。
- 译名按国服习惯人工判定，不以字面直译为准：例如 `Cannon Warrior` 字面是「火炮」，实际核心是火炮手衍生物反复开火 + 海盗协同，国服叫「海盗战」。

## 许可

[MIT](LICENSE)
