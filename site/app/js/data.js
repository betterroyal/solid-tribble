/* ═══════════════════════════════════════════════════════════════
 * 13周年庆数据看板 · 数据层（js/data.js）
 * 职责：拉取 BI 爬虫生成的 JSON（GitHub Pages /data/*.json，每 10 分钟更新），
 *       装配成渲染层（main.js）需要的模型。业务数字不再写死在页面里。
 *
 * BI 里没有、页面又需要的字段，全部集中在下方 CONFIG，改这里即可：
 *   - storeExtras：各店弧段颜色 + 复诊到店率%（BI 无此指标，手填）
 *   - extraStores：BI 里没有的弧段（如"三级医院"），不用可整段删空
 *   - channels：   渠道 chip 与 BI 表的对应关系（自动取"合计"行）
 * ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  const CONFIG = {
    /* 冲刺目标 = 基础目标 × SPRINT_K */
    sprintK: 1.18,
    /* 门店展示顺序（决定弧段从右上开始、左右镜像的排布；不存在的名字会被忽略）
       「三级医院」是周年庆页面上的叫法，BI 门店表里这家店叫「医院」（见 aliases）。 */
    order: ["神华店", "九星店", "青东店", "包百店", "校园店", "三级医院"],
    /* 页面叫法 → BI 门店表里的实际名字。找不到再按原名找，两边任一侧改名都不会断：
       - BI 里叫「医院」、页面叫「三级医院」 → 走别名
       - 哪天 BI 直接改名成「三级医院」     → 原名命中，别名自动失效，无需再改代码 */
    aliases: { 三级医院: "医院" },
    /* 各店颜色（决定弧段与列表圆点）。
       revisit（复诊到店率，BI 无此指标、手填）：2026-09-29 起「初诊进度」区块已改用
       BI 原生的初诊到诊/初诊目标/初诊完成率，此字段目前没有页面在用，先留着备用。 */
    storeExtras: {
      神华店: { color: "#d9b876", revisit: 74 },
      九星店: { color: "#c99572", revisit: 62 },
      青东店: { color: "#8fb5a4", revisit: 81 },
      包百店: { color: "#86a0b4", revisit: 66 },
      校园店: { color: "#cfc9ba", revisit: 59 },
      三级医院: { color: "#b98da0", revisit: 78 },
    },
    /* 尚未进 BI 的门店：用配置值先占位（实收=目标×完成率），保住版式。
       ★ 自动接管：一旦 BI 的门店表里出现同名（或别名）门店，占位会让位给真实数据，
         不会出现"同名算两遍"或"两版数字打架"。
       2026-09-29：「三级医院」在 BI 门店表里已上线（BI 里叫「医院」），
       占位置空，全部改用真实数据。留空即可 —— 一旦往里加，弧段就会多出一段。
       要临时恢复占位展示：把 { id:"sy", name:"三级医院", color:"#b98da0",
       targetBase:270, revPct:68.1, initBase:740, initPct:64.3, revisit:78 } 填回来。 */
    extraStores: [],
    /* 圆环版式最多几段（渲染层 SEGMENTS 写死 6 段）。BI 门店数超过它时，
       多出来的店会被丢掉并打印警告 —— 否则会取到 undefined 直接把看板打崩。
       真要多加一家店，得同步改 main.js 的 SEGMENTS 和这里的数字。 */
    maxSegments: 6,
    /* 渠道 chip ↔ BI 表：cum=累计到诊 target=总目标 today=今日到诊（取"合计"行） */
    channels: [
      { name: "网电", file: "web", color: "#d9b876" },
      { name: "市场", file: "market", color: "#c99572" },
      { name: "老带新", file: "referral", color: "#8fb5a4" },
    ],
    /* 顶部两枚 chip 卡的排布（2026-10-13 起）：
       第 3 张卡 = 网电 + 老带新；第 4 张卡 = 市场 + 市场一组 + 市场二组。
       group 项来自 market_groups.json（BI「市场各小组数据」表，业绩口径）：
         到诊人数 → 人数，总业绩 → 总业绩(万)，今日到诊 → 今日，今日业绩 → 今日业绩 */
    channelCards: [
      {
        target: "chChipsA",
        items: [{ channel: "网电" }, { channel: "老带新" }],
      },
      {
        target: "chChipsB",
        items: [
          { channel: "市场" },
          { group: "市场一组" },
          { group: "市场二组" },
        ],
      },
    ],
    /* 市场各小组的展示顺序与颜色（名字要和 BI「所属部门」列完全一致）。
       「市场一组」颜色 2026-10-16 由蓝色 #86a0b4 改成 #b98da0 ——
       与「三级医院」门店圆点同色（用户指定：一组用这个粉色）。 */
    groups: [
      { name: "市场一组", color: "#b98da0" },
      { name: "市场二组", color: "#cfc9ba" },
    ],
  };

  /* 数据地址（按顺序尝试，命中即用）：
     看板现在位于站点根目录（https://beiteruier.github.io/solid-tribble/），
     所以首选 "data/"；本地双击打开 / 任意静态服务器时用绝对地址兜底。 */
  const BASES = ["data/", "https://beiteruier.github.io/solid-tribble/data/"];
  const RETRY_MAX = 3; // 429 / 网络抖动时的重试次数
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* 取一个 JSON。
     ⚠ 关于缓存（2026-10-15 实测纠正）：GitHub Pages 的 CDN **不把查询串当缓存键**。
       实测 7 分钟内 `bundle.json` 与 `bundle.json?t=随机数` 返回的数据完全一致，
       Age 一路递增（0→45→90→…）说明两者命中同一个缓存对象 ——
       所以老写法 `?t=Date.now()` 对 Pages 是**无效的**，绕过不了缓存，
       页脚「更新于」因此会比 CI 落后 0~5 分钟（Pages 固定发 Cache-Control: max-age=600）。
     现在改用 `cache: 'no-cache'`：浏览器/CDN 会带 If-None-Match 做条件重验证，
       内容没变回 304（几乎不耗流量），变了就拿最新的 —— 这才是真正有效的绕过方式。
       代价是每次取数会回源一次，但合并成 bundle 后每次加载只有 1 个数据请求
       （合并前是 8 个），完全在可承受范围内。
     429 是 Pages 的限流响应，这里做指数退避（0.8s → 1.6s → 3.2s + 抖动）重试，
     避免偶发限流直接让整页空白。
     注意 4xx（除 429 外）不做重试 —— 尤其是 404：文件确实不存在，重试只是白等，
     会拖慢 bundle 缺失时的回退路径。只重试 429、5xx 和网络错误。 */
  async function fetchJSON(file) {
    let lastErr;
    for (const base of BASES) {
      for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
        const url = base + file + ".json";
        try {
          const res = await fetch(url, { cache: "no-cache" });
          if (res.status === 429) throw new Error("HTTP 429 限流"); // 可重试
          if (!res.ok) {
            // 4xx 是确定性失败，重试没有意义；标记 fatal 让下面的 catch 直接跳出
            const e = new Error("HTTP " + res.status);
            e.fatal = res.status >= 400 && res.status < 500;
            throw e;
          }
          return await res.json();
        } catch (e) {
          lastErr = e;
          if (e.fatal || attempt === RETRY_MAX) break; // fatal 直接换下一个 base
          await wait(800 * Math.pow(2, attempt) + Math.random() * 400);
        }
      }
    }
    throw new Error("取数失败: " + file + " (" + lastErr + ")");
  }

  const num = (v) => (v === "" || v == null || isNaN(+v) ? 0 : +v);

  /* 激励榜单的三类奖项：key = ranks 里的表键；label = 弹窗里显示的项目名；
     kind 决定值的格式化（pct 百分比 / money 元）。
     顺序即弹窗里的行序（用户给的原型就是这个顺序）。 */
  const INCENTIVE_ITEMS = [
    { key: "consult", label: "健康顾问完成率第一名", nameRe: /咨询人员|咨询|姓名/, valRe: /完成率/, kind: "pct" },
    { key: "ticket", label: "健康顾问单体第一名", nameRe: /咨询人员|咨询|姓名/, valRe: /平均单体/, kind: "money" },
    { key: "store", label: "机构周业绩第一名", nameRe: /门店/, valRe: /完成率/, kind: "pct" },
  ];

  /* 三张周排名表 → { weeks:[{week,date,count}], rows:[{week,label,who,value,kind}], empty }
     按周合并；周的排序优先用「年周_时间」，没有日期就按周序号。 */
  function buildIncentive(ranks) {
    const colOf = (raw, res) => {
      const cols = (raw && raw.columns) || [];
      for (const re of res) {
        const c = cols.find((x) => re.test(String(x)));
        if (c) return c;
      }
      return null;
    };
    const byWeek = new Map();
    INCENTIVE_ITEMS.forEach((item) => {
      const raw = ranks[item.key];
      if (!raw || !(raw.rows || []).length) return;
      /* ⚠ 周列不能简单用 /周/ 找：门店表的列是 [行号, 年周_时间, 门店, 业绩完成率]，
         /周/ 会先命中「年周_时间」，把日期当成周次，结果每周都被拆成单独一"周"。
         所以先排除日期列，再找 周数/行号。 */
      const weekCol =
        colOf(raw, [/^(?!.*(年周|时间|日期)).*周/]) || colOf(raw, [/行号/]);
      const dateCol = colOf(raw, [/年周/, /时间/, /日期/]);
      const nameCol = colOf(raw, [item.nameRe]);
      const valCol = colOf(raw, [item.valRe]);
      if (!nameCol || !valCol) return;
      /* 完成率口径：这几张周排名表 BI 给的都是 0~1 的小数（1.663 = 166.3%）。
         按整列最大值判断 —— 全列都 ≤10 一定是小数口径（百分数口径会出现 100+ 的值），
         比逐值判断安全：1.663 这种"看着像百分数"的小数不会再被当成 1.66%。 */
      const nums = (raw.rows || []).map((r) => num(r[valCol]));
      const pctK = item.kind === "pct" && Math.max(...nums, 0) <= 10 ? 100 : 1;
      (raw.rows || []).forEach((r, i) => {
        const who = r[nameCol] == null ? "" : String(r[nameCol]).trim();
        if (!who) return; // 空行跳过（BI 末尾常有合计/空白行）
        const wRaw = weekCol ? String(r[weekCol] == null ? "" : r[weekCol]).trim() : "";
        /* 周键：优先取「第N周」里的数字，两张表写法略有差异（第1周 / 第 1 周）也能并到同一周 */
        const digits = /(\d+)/.exec(wRaw);
        const wKey = digits ? "w" + digits[1] : wRaw || "w" + (i + 1);
        const dateStr = dateCol ? String(r[dateCol] == null ? "" : r[dateCol]).trim() : "";
        const d = /(\d{4})\D+(\d{1,2})\D+(\d{1,2})/.exec(dateStr);
        const order = d ? Date.UTC(+d[1], +d[2] - 1, +d[3]) : 0;
        if (!byWeek.has(wKey))
          byWeek.set(wKey, {
            week: wRaw || `第${i + 1}周`,
            date: dateStr,
            order,
            items: [],
          });
        byWeek.get(wKey).items.push({
          label: item.label,
          who,
          value: num(r[valCol]) * pctK,
          kind: item.kind,
        });
      });
    });
    /* 周升序；没有日期的周排在最后（order=0），再用周序号兜底 */
    const weeks = [...byWeek.entries()]
      .map(([key, w]) => ({ key, ...w }))
      .sort((a, b) => {
        const na = +(/(\d+)/.exec(a.week) || [])[1] || 0;
        const nb = +(/(\d+)/.exec(b.week) || [])[1] || 0;
        return a.order - b.order || na - nb;
      });
    const rank = (label) => INCENTIVE_ITEMS.findIndex((x) => x.label === label);
    const rows = [];
    weeks.forEach((w) => {
      w.items.sort((a, b) => rank(a.label) - rank(b.label));
      w.items.forEach((it) => rows.push({ week: w.week, ...it }));
      w.count = w.items.length;
    });
    return {
      weeks: weeks.map((w) => ({ week: w.week, date: w.date, count: w.count })),
      rows,
      empty: !rows.length,
    };
  }

  /* 当前北京时间：页面跑在浏览器里，用本机时间 + 时区偏移换算，避免看的人时区不同导致活动窗口算错 */
  function cnNow() {
    const now = new Date();
    return new Date(now.getTime() + (480 + now.getTimezoneOffset()) * 60000);
  }

  function buildModel(storesRaw, consultsRaw, doctorsRaw, chanRaws, dailyRaw, groupsRaw, rankRaws) {
    /* ── 活动进程：BI"天数/时间进度"列 = 第 N 天 / 共 31 天 ── */
    const D = 31;
    const T = Math.min(
      D,
      Math.max(1, Math.round(num(storesRaw.rows[0] && storesRaw.rows[0]["天数"])) || 28),
    );
    /* ── 活动窗口（动态，2026-10-13 起）──
       BI 门店表的「天数」列 = 活动第几天（第 1 天 = 活动首日）。用「今天(北京) − (T-1) 天」
       反推首日，于是：活动跨月/跨年时页面自动跟着走，不再写死 9 月。
       D（30 天）只用于坐标轴长度与「时间进度」环，与 BI「共 30 天」一致。 */
    const firstDate = cnNow();
    firstDate.setDate(firstDate.getDate() - (T - 1));
    const dayDates = [];
    for (let i = 0; i < D; i++) {
      const dt = new Date(firstDate.getTime());
      dt.setDate(firstDate.getDate() + i);
      dayDates.push({ y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() });
    }
    const CAMPAIGN_START = {
      year: firstDate.getFullYear(),
      month: firstDate.getMonth() + 1,
      day: firstDate.getDate(),
    };

    /* ── 门店：目标/实收/完成率/初诊 全部来自 stores.json（单位元 → 万） ── */
    /* 「今日业绩」列：门店表新增的实时列(10 分钟一刷)。BI 里同时有"今日初诊",
       这里必须认准"业绩/实收/金额"关键字,否则会把初诊人数当成金额。
       找不到该列时 todayKey=null → 曲线今日点回退用 daily 当日值。 */
    const cols = storesRaw.columns || [];
    const todayKey =
      cols.find((c) => /今日/.test(String(c)) && /业绩|实收|金额/.test(String(c))) ||
      cols.find((c) => /今日/.test(String(c)) && !/到诊|初诊/.test(String(c)));
    /* 「今日初诊」列（2026-10-14 新增，给顶部「今日数据」卡用）：
       与今日业绩同理按关键字找列，避免写死列名在 BI 端改列名时断掉。 */
    const todayInitKey = cols.find(
      (c) => /今日/.test(String(c)) && /初诊/.test(String(c)),
    );
    /* 页面叫法 → BI 行的映射：原名优先，原名找不到再看别名（如 三级医院→医院）。
       biName 记下来给下面的曲线按 BI 名字取每日数据用。 */
    const byName = {};
    storesRaw.rows.forEach((r) => (byName[r["门店"]] = r));
    const rowOf = (n) => byName[n] || byName[CONFIG.aliases[n]] || null;
    const biNameOf = (n) => (byName[n] ? n : CONFIG.aliases[n] || n);
    const names = CONFIG.order.filter((n) => rowOf(n));
    // 已被 order 占用的 BI 名字（含别名命中的，如「医院」已被「三级医院」占用），
    // 否则 BI 里的「医院」会被当成"order 里没有的新店"再追加一次，弧段直接多出一段。
    const usedBi = new Set(names.map(biNameOf));
    storesRaw.rows.forEach((r) => {
      const raw = r["门店"];
      if (!names.includes(raw) && !usedBi.has(raw)) names.push(raw);
    });
    const stores = names.map((n) => {
      const r = rowOf(n);
      const ex = CONFIG.storeExtras[n] || {};
      return {
        id: n,
        name: n,
        biName: biNameOf(n), // BI 门店表里这家店的实际名字（可能与页面叫法不同）
        color: ex.color || "#d4af37",
        targetBase: num(r["业绩目标"]) / 1e4, // 万
        actual: num(r["实收金额"]) / 1e4, // 万
        revPct: num(r["业绩完成率"]), // %
        initBase: num(r["初诊目标"]), // 人
        initActual: num(r["初诊到诊"]), // 人
        initPct: num(r["初诊完成率"]), // %
        avgTicket: num(r["平均单体"]), // 平均单体（元，BI 原生列）
        /* 剩余四项（2026-10-12 起 BI 门店表原生列，单位已算好，直接取）：
           剩余业绩/剩余日均业绩（万、万/天），剩余初诊/剩余日均初诊（人、人/天）。
           天数/日均的分母口径由 BI 端决定，前端不重复计算。 */
        remainRev: num(r["剩余业绩"]),
        remainRevDaily: num(r["剩余日均业绩"]),
        remainInit: num(r["剩余初诊"]),
        remainInitDaily: num(r["剩余日均初诊"]),
        /* 今日业绩（万）：门店表的实时列，10 分钟一刷。
           daily.json 每天只在凌晨抓一次，今日那格会是 0/陈旧值，
           所以曲线最后一个点用这里覆盖，历史点仍来自 daily。 */
        todayRev: todayKey ? num(r[todayKey]) / 1e4 : null,
        todayInit: todayInitKey ? num(r[todayInitKey]) : 0, // 今日初诊（人）
        revisit: ex.revisit != null ? ex.revisit : 0, // 复诊到店率%（BI 无，手填）
      };
    });
    /* BI 之外的弧段（占位值）：BI 门店表里还没出现时才启用；
       将来 BI 正式纳入该门店 → 上面的 stores 已按真实数据建好，这里直接跳过。
       占位门店 BI 没有"平均单体"，tooltip 里显示 — */
    CONFIG.extraStores.forEach((s) => {
      if (rowOf(s.name)) return; // 原名或别名在 BI 里已有数据 → 占位让位给真实值
      stores.push({
        ...s,
        biName: s.name,
        avgTicket: null,
        todayRev: null, // BI 无此店 → 今日点仍走 daily
        remainRev: null, // 占位店无剩余指标 → tooltip 显示 —
        remainRevDaily: null,
        remainInit: null,
        remainInitDaily: null,
        actual: (s.targetBase * s.revPct) / 100,
        initActual: (s.initBase * s.initPct) / 100,
      });
    });
    /* 超出版式的店直接丢弃（汇总指标要按剩下的算，否则大屏数字和弧段对不上账） */
    const MAX_SEG = CONFIG.maxSegments || 6;
    if (stores.length > MAX_SEG) {
      const dropped = stores.slice(MAX_SEG).map((s) => s.name).join("、");
      console.warn(
        `[看板] BI 门店有 ${stores.length} 家，超出 ${MAX_SEG} 段版式，已忽略：${dropped}`,
      );
      stores.length = MAX_SEG;
    }

    /* ── 渠道：优先取"合计"行，没有才逐行求和（排除合计防重复计数） ── */
    const todayOf = (r) =>
      num(r["今日到诊_总和"] != null ? r["今日到诊_总和"] : r["今日到诊"]);
    const channels = CONFIG.channels.map((c) => {
      const rows = (chanRaws[c.file] && chanRaws[c.file].rows) || [];
      const sumRow = rows.find((r) => /合计/.test(String(r["门店"])));
      let target, cum, today;
      if (sumRow) {
        target = num(sumRow["总目标"]);
        cum = num(sumRow["总到诊"]);
        today = todayOf(sumRow);
      } else {
        target = cum = today = 0;
        rows.forEach((r) => {
          if (/合计/.test(String(r["门店"]))) return;
          target += num(r["总目标"]);
          cum += num(r["总到诊"]);
          today += todayOf(r);
        });
      }
      return {
        ...c,
        target,
        cum,
        today,
        rate: target ? (cum / target) * 100 : 0, // 累计完成率
        share: 0,
      };
    });
    const cumSum = channels.reduce((a, c) => a + c.cum, 0) || 1;
    channels.forEach((c) => (c.share = c.cum / cumSum));

    /* ── 市场各小组（BI「市场各小组数据」表）：业绩口径
       列名在 BI 端可能微调，统一按关键字找列，找不到就退化为 0（不写死列名）。
       注意「今日到诊」是人数、「今日业绩」是金额，两者都含"今日"，必须分开匹配。 */
    const gCols = (groupsRaw && groupsRaw.columns) || [];
    const gRows = (groupsRaw && groupsRaw.rows) || [];
    const pickCol = (re) => gCols.find((c) => re.test(String(c))) || null;
    const cHead = pickCol(/到诊人数|到诊/);
    const cTotal = pickCol(/总业绩/);
    const cToday = pickCol(/今日到诊/);
    const cRevToday = pickCol(/今日.*(业绩|实收|金额)/);
    const groups = CONFIG.groups
      .map((g) => {
        const r = gRows.find((x) => String(x["所属部门"]).trim() === g.name);
        if (!r) return null;
        return {
          name: g.name,
          color: g.color,
          cum: cHead ? num(r[cHead]) : 0, // 到诊人数（人）
          total: (cTotal ? num(r[cTotal]) : 0) / 1e4, // 总业绩（元 → 万）
          today: cToday ? num(r[cToday]) : 0, // 今日到诊（人）
          revToday: cRevToday ? num(r[cRevToday]) : 0, // 今日业绩（元）
        };
      })
      .filter(Boolean);
    /* 条形宽度：该组总业绩占「参与展示的组」合计的比例 */
    const gRevSum = groups.reduce((a, g) => a + g.total, 0) || 1;
    groups.forEach((g) => (g.share = g.total / gRevSum));

    /* ── 顶部 chip 卡：按 CONFIG.channelCards 组装（渠道项 + 小组项）── */
    const chanByName = {};
    channels.forEach((c) => (chanByName[c.name] = c));
    const groupByName = {};
    groups.forEach((g) => (groupByName[g.name] = g));
    const channelCards = (CONFIG.channelCards || []).map((card) => ({
      target: card.target,
      items: card.items
        .map((it) => {
          if (it.channel && chanByName[it.channel]) {
            const c = chanByName[it.channel];
            return {
              kind: "channel",
              name: c.name,
              color: c.color,
              cum: c.cum, // 累计到诊（人）
              target: c.target, // 总目标（人）
              today: c.today, // 今日到诊（人）
              rate: c.rate, // 完成率 %
            };
          }
          if (it.group && groupByName[it.group]) {
            const g = groupByName[it.group];
            return {
              kind: "group",
              name: g.name,
              color: g.color,
              cum: g.cum,
              total: g.total,
              today: g.today,
              revToday: g.revToday,
              share: g.share,
            };
          }
          return null;
        })
        .filter(Boolean),
    }));

    /* ── 咨询/医生排行：按实收金额降序；BI 无门店列。
       2026-10-15：不再截断 TOP7 —— 输出全部人员，由面板内部滚动查看
       （咨询 16 人、医生 38 人；榜单满 7 行后仍在同一容器内继续滚动）。
       2026-10-16：BI 里这列「业绩完成率」是 0~1 的小数，这里 ×100 存成百分数 pct
       （同时供排序、条形宽度、行尾百分比三处使用；三处必须同源，否则口径会打架）。
       原 tag 字段（取整字符串「44%」）已无引用，随行尾改用两位小数一并删除。
       这里仍按金额降序排一份「出厂顺序」，实际展示顺序由 main.js 的 RANK_MODE 决定。
       2026-10-26：BI「咨询数据」新增「平均单体」列（元），一并带进排行模型，
       供「健康顾问业绩」面板的第三个排序按钮（平均单体）使用。
       医生表没有该列 → num(undefined) = 0，医生面板不出这个按钮，也不受影响。
       同日再加「业绩目标」（万）—— 两块面板都有的原生列，供「目标」按钮使用。 ── */
    const rankAll = (rows, nameKey, amtKey) =>
      rows
        .map((r) => ({
          name: r[nameKey],
          pct: num(r["业绩完成率"]) * 100, // 百分数，如 44.4
          amount: num(r[amtKey]) / 1e4, // 万
          target: num(r["业绩目标"]) / 1e4, // 业绩目标（元 → 万）
          avgTicket: num(r["平均单体"]), // 平均单体（元，BI 原生列；医生表没有 → 0）
        }))
        .sort((a, b) => b.amount - a.amount);
    const staff = {
      consultants: rankAll(consultsRaw.rows, "咨询人员", "实收金额"),
      doctors: rankAll(doctorsRaw.rows, "医生", "医生业绩"),
    };

    /* ── 激励排名（2026-10-26 新增）────────────────────────────────────────
       BI 新加了三张「周排名」表，每张一周一行、只放当周第一名：
         门店数据-完成率排名(周)   → 门店 + 业绩完成率
         咨询数据-完成率排名(周)   → 咨询人员 + 业绩完成率
         咨询数据-平均单体排名(周) → 咨询人员 + 平均单体
       这里按「周」把三张表并成一张激励榜，周内顺序固定为
         健康顾问完成率第一名 / 健康顾问单体第一名 / 机构周业绩第一名。
       三张表都是可选表（scripts/fetch_data.py 的 OPTIONAL_TABLES）：缺任一张或整张为空
       都不报错，只是对应那一行不出现；全缺时弹窗显示「暂无数据」。
       列名一律按关键字找（年周/周/行号、门店/咨询人员、完成率/平均单体），
       BI 端微调列名不会把这张表弄断。 */
    const incentive = buildIncentive(rankRaws || {});

    /* ── 每日实收（动态活动窗口）：daily.json 时间形如"2026年10月13日"，元 → 万。
       按下标 = 该日期距活动首日的天数入列；窗口外的日期（如 BI 里更早的历史）直接忽略。
       这样 10 月、11 月…只要 BI「天数」列更新，曲线自动跟着走，不用改代码。 */
    const per = {};
    const dayIdx = (y, m, d) =>
      Math.round(
        (Date.UTC(y, m - 1, d) -
          Date.UTC(CAMPAIGN_START.year, CAMPAIGN_START.month - 1, CAMPAIGN_START.day)) /
          86400000,
      );
    (dailyRaw.rows || []).forEach((r) => {
      const m = /(\d+)年(\d+)月(\d+)日/.exec(String(r["时间"]));
      if (!m) return;
      const i = dayIdx(+m[1], +m[2], +m[3]);
      if (i < 0 || i >= D) return;
      (per[r["门店"]] = per[r["门店"]] || {})[i] = num(r["实收金额"]) / 1e4;
    });
    const byId = {};
    const all = new Array(T).fill(0);
    /* has[i] = 第 i 天在 daily.json 里到底有没有行（2026-10-20 新增）。
       以前「没抓到」和「当天业绩为 0」在数组里都是一样的 0，趋势图看不出区别：
       10-19 daily 没抓到 → 曲线画成 0，看着像当天一分钱没收。
       记下每天的存在性，让 tooltip 能显示「暂无数据」、并在缺失点画空心标记。 */
    const has = new Array(T).fill(false);
    stores.forEach((s) => {
      // 按 BI 里的真实店名取每日数据（页面叫「三级医院」但 BI 叫「医院」时也能取到）
      const m = per[s.biName || s.name] || {};
      const arr = [];
      for (let i = 0; i < T; i++) {
        if (m[i] != null) has[i] = true;
        arr.push(m[i] || 0);
      }
      /* 今日点（下标 T-1）用门店表实时「今日业绩」覆盖：
         daily.json 已改为每天凌晨抓一次，白天它的今日格不刷新。
         找不到该列时 s.todayRev 为 null → 保持 daily 原值，不写 0。
         2026-10-18 修正：BI 门店表「今日业绩」经常整列为 0（当天还没结算/未刷新），
         直接覆盖会把 daily 里已经存在的今日实收抹成 0，曲线末尾凭空掉到 0。
         改为取两者较大值 —— 只有实时列确实更大（更及时）时才覆盖。 */
      if (s.todayRev != null && s.todayRev > arr[T - 1]) {
        arr[T - 1] = s.todayRev;
        has[T - 1] = true; // 今日点来自门店表实时列，也算「有数据」
      }
      byId[s.id] = arr;
      for (let i = 0; i < T; i++) all[i] += arr[i];
    });

    /* ── 汇总指标 ── */
    const totalBase = stores.reduce((a, s) => a + s.targetBase, 0);
    const totalRev = stores.reduce((a, s) => a + s.actual, 0);
    const totalInitBase = stores.reduce((a, s) => a + s.initBase, 0);
    const totalInit = stores.reduce((a, s) => a + s.initActual, 0);
    /* 「今日数据」卡（2026-10-14 新增）：今日初诊（人）/ 今日业绩（万）
       = 门店表各店求和；todayRev 为 null（找不到列）时按 0 计。 */
    const totalTodayInit = stores.reduce((a, s) => a + (s.todayInit || 0), 0);
    const totalTodayRev = stores.reduce((a, s) => a + (s.todayRev || 0), 0);
    const kpi = {
      timePct: (T / D) * 100,
      revPct: totalBase ? (totalRev / totalBase) * 100 : 0,
      initPct: totalInitBase ? (totalInit / totalInitBase) * 100 : 0,
      avgTicket: totalInit ? (totalRev * 1e4) / totalInit : 0,
      todayInit: totalTodayInit,
      todayRev: totalTodayRev,
    };
    const model = {
      stores,
      totalRev,
      totalInit,
      totalBase,
      totalInitBase,
      kpi,
      channels,
      channelCards,
      staff,
      daily: { byId, all, has },
      /* 激励排名（2026-10-26）：三张周排名表并出来的榜单，供「激励排名」弹窗渲染 */
      incentive,
      /* 原始表（2026-10-14 新增）：给「更多」弹窗渲染明细表格用，
         每次心跳随模型整体替换，弹窗打开时拿到的永远是最新值。 */
      tables: {
        web: chanRaws.web,
        referral: chanRaws.referral,
        market: chanRaws.market,
        groups: groupsRaw,
      },
    };
    return {
      campaign: {
        year: CAMPAIGN_START.year,
        month: CAMPAIGN_START.month,
        monthDays: D,
        today: T,
        days: dayDates, // 第 i 天对应的真实日期，页面据此画 X 轴与 tooltip
      },
      sprintK: CONFIG.sprintK,
      stores,
      channels,
      channelCards,
      groups,
      staff,
      daily: { byId, all, has },
      totals: { totalBase, totalRev, totalInitBase, totalInit, totalTodayInit, totalTodayRev },
      kpi,
      model,
      updatedAt: "",
    };
  }

  const TABLES = ["stores", "consults", "doctors", "web", "market", "referral", "market_groups", "daily"];
  /* 可选表（2026-10-26）：激励排名弹窗用的三张周排名表。
     ⚠ 千万不能混进上面的 TABLES —— TABLES 里任何一张取不到都会让整页取数失败（白屏），
     这三张只是弹窗的锦上添花，取不到就当空榜单处理（弹窗显示「暂无数据」）。 */
  const OPT_TABLES = ["store_rank_week", "consult_rank_week", "consult_ticket_week"];

  /* 可选表的安全取数：404 / 网络错误都返回 null，绝不抛错 */
  async function fetchOptional(file) {
    try {
      return await fetchJSON(file);
    } catch (e) {
      console.warn(`[看板] 可选表 ${file}.json 取不到（弹窗会显示暂无数据）`, e.message || e);
      return null;
    }
  }

  /* 取 8 张表（2026-10-15）：优先读 CI 合并好的 bundle.json —— 1 个请求而不是 8 个。
     这是给「同一办公室多人同时刷新」降限流风险用的。
     bundle 不存在 / 不完整时自动回退到逐个抓，老数据目录仍保留着，兼容没有 bundle 的部署。 */
  async function loadAllTables() {
    try {
      const b = await fetchJSON("bundle");
      if (b && TABLES.every((t) => b[t]))
        return [
          ...TABLES.map((t) => b[t]),
          ...OPT_TABLES.map((t) => b[t] || null), // bundle 里没有这三张 → null
        ];
      console.warn("bundle.json 不完整，回退逐个抓取");
    } catch (e) {
      console.warn("bundle.json 取数失败，回退逐个抓取", e);
    }
    const required = await Promise.all(TABLES.map((t) => fetchJSON(t)));
    const optional = await Promise.all(OPT_TABLES.map((t) => fetchOptional(t)));
    return [...required, ...optional];
  }

  async function loadDashboardData() {
    const [
      storesRaw,
      consultsRaw,
      doctorsRaw,
      webRaw,
      marketRaw,
      referralRaw,
      groupsRaw,
      dailyRaw,
      storeRankRaw,
      consultRankRaw,
      ticketRankRaw,
    ] = await loadAllTables();
    const out = buildModel(
      storesRaw,
      consultsRaw,
      doctorsRaw,
      { web: webRaw, market: marketRaw, referral: referralRaw },
      dailyRaw,
      groupsRaw,
      { store: storeRankRaw, consult: consultRankRaw, ticket: ticketRankRaw },
    );
    out.updatedAt = [
      storesRaw,
      consultsRaw,
      doctorsRaw,
      webRaw,
      marketRaw,
      referralRaw,
      groupsRaw,
      dailyRaw,
    ]
      .map((j) => (j && j.updated_at) || "")
      .sort()
      .pop();
    return out;
  }

  global.loadDashboardData = loadDashboardData;
})(window);
