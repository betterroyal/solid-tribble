/* 13周年庆数据看板 · 渲染层（js/main.js）
   版式与交互与 v2 单文件版完全一致；数据来自 js/data.js 装配的 BI 爬虫 JSON。
   以 <script type="module"> 引入：顶层 await 先取数，再按原流程一次性建板。 */
/* ══════════════════════════════════════════════════════════
       * ① 数据层：全部来自 BI 爬虫 JSON（js/data.js 装配，每 10 分钟更新）
       * ══════════════════════════════════════════════════════════ */
      const DATA = await loadDashboardData();
      const CAMPAIGN = DATA.campaign;
      const STORES = DATA.stores;
      const CHANNELS = DATA.channels;
      const STAFF = DATA.staff;
      /* ── 水球六段站位的门店顺序（2026-10-18 需求）─────────────────────────
         阅读顺序「从左到右、从上到下」= 医院 / 神华 / 九星 / 青东 / 包百 / 校园。
         六段槽位固定为：右上 → 右中 → 右下 → 左上 → 左中 → 左下，因此映射成
           神华(右上) 青东(右中) 校园(右下) | 医院(左上) 九星(左中) 包百(左下)。
         ⚠ 只作用于中央 Hero 的弧段与左右框；左栏两栏列表仍走 MODEL.stores 原始
           顺序（两栏逐行对齐是 10-16 的需求），所以不能改 CONFIG.order。
         HERO 只提供"站位 → 门店名"，取数一律按名字回查当拍模型，避免心跳重建
         后对象引用过期。 */
      const HERO_ORDER = ["神华店", "青东店", "校园店", "三级医院", "九星店", "包百店"];
      const HERO = (() => {
        const out = HERO_ORDER.map((n) => STORES.find((s) => s.name === n)).filter(Boolean);
        // 兜底：BI 改名/新增导致名字对不上时，未入列的门店补到末尾，不会整块消失
        STORES.forEach((s) => {
          if (!out.includes(s)) out.push(s);
        });
        return out;
      })();
      /* 站位 i 上的门店（按名字回查指定模型，取最新数值） */
      const heroEntry = (i, m) =>
        (m.stores.find((s) => s.name === HERO[i].name)) || HERO[i];
      /* 按站位顺序排好的门店数组（弧段 / 左右框的数据源） */
      const heroEntries = (m) => HERO.map((s, i) => heroEntry(i, m));

/* ══════════════════════════════════════════════════════════
       * ② 工具（沿用「进度水球」的几何与缓动套路）
       * ══════════════════════════════════════════════════════════ */
      const SVGNS = "http://www.w3.org/2000/svg";
      const $ = (id) => document.getElementById(id);
      /* 防呆（2026-10-14）：曾经因根目录还留着一份旧版页面（没有新加的元素），
         JS 取到 null 直接赋值 → 抛错 → 整个看板渲染中断变成空白页。
         凡写字到 DOM 一律走 setTxt / .? 判空，缺元素只跳过该处，不再拖垮整页。 */
      const setTxt = (id, txt) => {
        const el = $(id);
        if (el) el.textContent = txt;
      };
      /* 写 HTML 片段的空值安全版（判空同上，避免缺元素时整页崩） */
      const setHTML = (id, html) => {
        const el = $(id);
        if (el) el.innerHTML = html;
      };
      const ANIM = !/[?&]static=1/.test(location.search);
      if (!ANIM) document.documentElement.classList.add("noanim");
      /* 数据心跳：间隔与初始拍（调试参数） */
      const HB_MS = (() => {
        const m = /[?&]hbms=(\d+)/.exec(location.search);
        return m ? Math.max(1000, +m[1]) : 498000;
      })();
      const norm = (a) => ((a % 360) + 360) % 360;
      const easeOut = (t) => 1 - Math.pow(1 - t, 3);
      const lerp = (a, b, t) => a + (b - a) * t;
      const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
      /* 金额一律 2 位小数（2026-10-13 需求：与 BI 报表取出来的数据一致）。
         fmt2 输出带千分位的两位小数（21.35 / 8,888.00），fmtW 用于「万」口径、
         fmtY 用于「元」口径，只差单位后缀。 */
      const fmt2 = (v) =>
        (Number(v) || 0).toLocaleString("zh-CN", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
      const fmtW = fmt2;
      const fmtY = fmt2;
      const fmtI = (v) => Math.round(v).toLocaleString("zh-CN");
      /* 金额自适应单位：≥1 万走「X.XX万」，不足 1 万直接显示「X,XXX元」
         （市场小组的「今日业绩」BI 里给的是元，小额时显示 0.00万 会看不出数） */
      const fmtMoney = (v) => (v >= 1e4 ? fmtW(v / 1e4) + "万" : fmtY(v) + "元");
      function polar(cx, cy, r, deg) {
        const a = (deg * Math.PI) / 180;
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      }
      function arcPath(cx, cy, r, a0, a1) {
        const [x0, y0] = polar(cx, cy, r, a0);
        const [x1, y1] = polar(cx, cy, r, a1);
        const large = norm(a1 - a0) > 180 ? 1 : 0;
        return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
      }
      /* 方向感知弧线（水球组件原版）：dir=-1 时必须走逆时针短弧，
         否则左侧三段会画成 320°+ 的大弧叠满整圈（v2 首版踩过的坑） */
      function arcPathDir(r, a0, a1, dir) {
        const [x0, y0] = polar(H.CX, H.CY, r, a0);
        const [x1, y1] = polar(H.CX, H.CY, r, a1);
        const delta = dir > 0 ? norm(a1 - a0) : norm(a0 - a1); // 沿绘制方向的角距
        const large = delta > 180 ? 1 : 0;
        const sweep = dir > 0 ? 1 : 0;
        return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
      }
      const p2 = (n) => String(n).padStart(2, "0");
      /* 心跳刷新用的补间：tween(dur, fn) 逐帧回调，tweenNum 数字滚动 */
      function tween(dur, fn, done) {
        const t0 = performance.now();
        (function f(now) {
          const k = easeOut(clamp((now - t0) / dur, 0, 1));
          fn(k);
          if (k < 1) requestAnimationFrame(f);
          else done && done();
        })(t0);
      }
      function tweenNum(el, from, to, fmt, dur = 900) {
        tween(dur, (k) => (el.textContent = fmt(lerp(from, to, k))));
      }

      /* ══════════════════════════════════════════════════════════
       * ③ 舞台等比缩放
       * ══════════════════════════════════════════════════════════ */
      const stage = $("stage");
      let SCALE = 1;
      function syncStage() {
        SCALE = Math.min(innerWidth / 1920, innerHeight / 1080);
        stage.style.setProperty("--s", SCALE);
      }
      syncStage();
      addEventListener("resize", syncStage);

            /* ══════════════════════════════════════════════════════════
       * ④ 数据派生（真实 BI 数据，不再随机模拟；心跳=重新抓取 JSON）
       * ══════════════════════════════════════════════════════════ */
      const T = CAMPAIGN.today,
        D = CAMPAIGN.monthDays;
      /* 活动窗口的真实日期（data.js 由 BI「天数」列 + 今天反推）：X 轴 / tooltip / 标题都用它，
         活动跨月时页面自动跟着走，不再写死月份。 */
      const DAYS = CAMPAIGN.days || [];
      const mdAt = (i) => DAYS[i] || { m: CAMPAIGN.month, d: i + 1 };
      const dayLabel = (i) => `${mdAt(i).m}/${mdAt(i).d}`;
      const dayFull = (i) => `${mdAt(i).m}月${mdAt(i).d}日`;
      const campMonth = `${CAMPAIGN.year}年${CAMPAIGN.month}月`;
      $("subTitle").textContent = `13周年庆数据看板 · ${campMonth}`;
      /* heroTitle 元素已于 2026-10-15 按需求删除（标题改为只留顶部副标题），
         这里必须走判空安全的 setTxt —— 直接 $("heroTitle").textContent 会在
         元素缺失时抛错，把整个 module 渲染打断成白屏（历史上踩过一次）。 */
      setTxt("heroTitle", `${campMonth} · 门店业绩达成`);
      /* 底部折线面板头的「X月1日 – X月31日 · 万元」tag 已于 2026-10-18 按需求删除，
         这里不再写它（元素已移除，硬写会抛错打断整个渲染）。 */
      const totalBase = DATA.totals.totalBase;
      const totalRev = DATA.totals.totalRev;
      const totalInitBase = DATA.totals.totalInitBase;
      const totalInit = DATA.totals.totalInit;
      /* SPRINT_K / sprintOf（冲刺目标 = 基础 × 1.18）已于 2026-10-16 停用：
         「业绩进度」面板的条形改为直接表示完成率，页面不再有冲刺目标口径。
         系数仍保留在 data.js 的 CONFIG.sprintK，需要时可恢复。 */
      const actualOf = (s) => s.actual;
      const initActualOf = (s) => s.initActual;
      const dailyByStore = DATA.daily.byId;
      const dailyAll = DATA.daily.all;
      /* 每天在 daily.json 里到底有没有数据（2026-10-20 新增）。
         没抓到的日子数组里也是 0，跟「当天确实 0 业绩」分不开 —— 10-19 就是这样
         被画成一条 0 的平线。这里留一份存在性，tooltip 显示「暂无数据」、
         缺失的那天在零线上画个空心点。心跳时随模型一起替换。 */
      let HAS = (DATA.daily.has || []).slice();

      const KPI = DATA.kpi;
      /* 当前生效的数据模型（首次 = 刚抓到的 JSON；5 分钟心跳后会整体替换） */
      let MODEL = DATA.model;
      /* 底部更新时间 = BI 爬虫写入 JSON 的 updated_at（7 张表里最新的一个）。
         2026-10-18 需求：文案改为「数据更新于 … · 每5分钟自动刷新」，
         位置从底部居中挪到原来「数据来源」所在的右下角。 */
      const setFoot = (t) =>
        ($("footUpdated").textContent =
          "数据更新于 " + (t || "--") + " · 每5分钟自动刷新");
      setFoot(DATA.updatedAt);

/* ══════════════════════════════════════════════════════════
       * ⑤ KPI 行：环形 + 数字滚动 + 渠道 chip
       * ══════════════════════════════════════════════════════════ */
      function buildRing(svg, pct, color) {
        if (!svg) return () => {};
        const CX = 38,
          CY = 38,
          R = 29,
          ST = 7;
        svg.innerHTML = "";
        const mk = (tag, attrs) => {
          const el = document.createElementNS(SVGNS, tag);
          for (const k in attrs) el.setAttribute(k, attrs[k]);
          svg.appendChild(el);
          return el;
        };
        mk("path", {
          d: arcPath(CX, CY, R, 135, 405),
          fill: "none",
          stroke: "rgba(255,255,255,0.12)",
          "stroke-width": ST,
          "stroke-linecap": "round",
        });
        const prog = mk("path", {
          fill: "none",
          stroke: color,
          "stroke-width": ST,
          "stroke-linecap": "round",
          filter: "url(#tGlow)",
        });
        const dot = mk("circle", { r: 3, fill: "#fff" });
        const txt = mk("text", {
          x: CX,
          y: CY + 5,
          "text-anchor": "middle",
          class: "ring-txt",
        });
        return (p) => {
          if (p < 0.5) {
            prog.setAttribute("d", "");
            dot.setAttribute("r", 0);
          } else {
            prog.setAttribute(
              "d",
              arcPath(CX, CY, R, 135, 135 + (270 * p) / 100),
            );
            const [x, y] = polar(CX, CY, R, 135 + (270 * p) / 100);
            dot.setAttribute("cx", x.toFixed(2));
            dot.setAttribute("cy", y.toFixed(2));
            dot.setAttribute("r", 3);
          }
          txt.textContent = p.toFixed(2) + "%";
        };
      }
      const drawRT = buildRing($("rTime"), KPI.timePct, "#e8c25f");
      /* 「累计初诊」卡的初诊完成率圆环（#rInit）：2026-10-16 拆卡时一度移除，
         同日需求要求加回 —— 卡宽已从 194 放到 252，76px 圆环放得下。 */
      const drawRI = buildRing($("rInit"), KPI.initPct, "#e8c25f");
      /* 时间进度卡：大字位显示「第 X 天」，下一行小字「共 31 天」（2026-10-14 需求）
         2026-10-15：第/天用小字号、天数数字用大字号并加强发光，突出数字本身。 */
      const daysHTML = (n) =>
        `<i class="kd-t">第</i><b class="kd-n">${Math.round(n)}</b><i class="kd-t">天</i>`;
      setTxt("vDaysTotal", `共 ${D} 天`);
      /* 累计初诊卡：2026-10-16 起小字行只留「基础 X 人」，
         「客单 xxx 元」搬去独立的「平均单体」卡（见下面的 vAvgTicket）。 */
      setTxt("subInit", `基础 ${fmtI(totalInitBase)} 人`);
      /* 平均单体（2026-10-16 新增卡）= 六个店业绩之和 ÷ 六个店初诊之和 = KPI.avgTicket（元），
         与「累计初诊」完全同源（data.js 汇总）。
         小字行 2026-10-19 改为「今日单体」= 今日业绩 ÷ 今日初诊（同样按元算），
         今日初诊为 0 时无法相除，显示「—」。 */
      const todayTicketHTML = (k) =>
        k.todayInit ? `今日单体：${fmtY((k.todayRev * 1e4) / k.todayInit)}` : "今日单体：—";
      setTxt("vAvgTicket", fmtY(KPI.avgTicket));
      setTxt("subAvgTicket", todayTicketHTML(KPI));

      /* ── 顶部 chip：两种口径
         channel：X人 · 目标 Y人 ／ 今日 N · 完成率 R%（条形 = 完成率）
         group  ：X人 · 总业绩 Y万 ／ 今日 N（条形恒为 0%，见下） */
      const chipLine1 = (c) =>
        c.kind === "group"
          ? `<b>${fmtI(c.cum)}</b>人 · <b>${fmtW(c.total)}</b>万`
          : `<b>${fmtI(c.cum)}</b>人 · 目标 <b>${fmtI(c.target)}</b>人`;
      /* 小组 chip 的小字行（2026-10-19 需求）：改为「今日初诊：N 人」。
         渠道 chip 保持「今日 N · 完成率 R%」不变。 */
      const chipLine2 = (c) =>
        c.kind === "group"
          ? `今日初诊：<b style="font-size:14px">${fmtI(c.today)}</b>人`
          : `今日 <b style="font-size:14px">${fmtI(c.today)}</b> · 完成率 ${c.rate.toFixed(2)}%`;
      /* 小组 chip 的条（2026-10-16 需求）：黄线填充改为 0%（原先恒为 100% 通长黄线）；
         渠道 chip 仍按完成率填充。小组本身没有可比的完成率口径，黄线会误导。 */
      const chipBarW = (c) =>
        c.kind === "group" ? 0 : Math.round(clamp(c.rate, 0, 100));
      const chipHTML = (c) => `<div class="chip chip-${c.kind}">
            <div class="chip-name"><span class="dot" style="background:${c.color}"></span>${c.name}</div>
            <div class="chip-val">${chipLine1(c)}</div>
            <div class="chip-bar"><i data-w="${chipBarW(c)}"></i></div>
            <div class="chip-val" style="line-height:18px">${chipLine2(c)}</div>
          </div>`;

      let chipRefs = [];
      function renderChips(m) {
        const cards = m.channelCards || [];
        chipRefs = cards.map((card) => {
          const box = $(card.target);
          if (!box) return [];
          box.innerHTML = card.items.map(chipHTML).join("");
          return [...box.children].map((el) => ({
            line1: el.querySelectorAll(".chip-val")[0],
            bar: el.querySelector(".chip-bar i"),
            line2: el.querySelectorAll(".chip-val")[1],
          }));
        });
      }
      renderChips(MODEL);

      /* ══ 「更多」明细弹窗（2026-10-14 需求）══
         网电卡 → 网电数据 + 老带新数据；市场卡 → 市场数据 + 市场各小组数据。
         表格渲染用 MODEL.tables（每次心跳随模型整体替换 → 打开时永远是最新值）。 */
      const fmtCell = (v) => {
        if (v === "" || v == null) return "—";
        const n = +v;
        return isNaN(n)
          ? String(v)
          : n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
      };
      /* ── 弹窗表格的显示加工（2026-10-15 用户要求）──
         ① 两字门店名（医院 / 合计）中间补一个全角空格「　」，与「神华店」等
            三字名等宽 —— 首字贴左、末字与三字名的末字对齐；
         ② 表头去掉 BI 的「_总和」后缀：今日到诊_总和 → 今日到诊；
         ③ 「完成率」列统一按百分比显示、保留 2 位小数。
            ⚠ 各表口径不统一：web / market 是 0.316 这种小数，而 referral 的
            门店行却是 51.32 这种百分数（合计行又回到 0.416），
            所以按数值大小自动判别，不能一律 ×100。 */
      const storeNameFix = (s) => (s.length === 2 ? `${s[0]}　${s[1]}` : s);
      /* ④ 表头改名（2026-10-23 用户要求）：BI 的「市场各小组数据」把这列叫「其他业绩」，
         但口径就是「市场数据」表的「再消费业绩(一年内)」——实测两张表该列合计都是
         109,953.07，完全相等。同一个弹窗上下两张表叫法不一致容易误读，统一显示。
         注：目前只有 groups 表有这个列名，其他表不受影响。 */
      const HEAD_RENAME = { "其他业绩": "再消费业绩(一年内)" };
      const headText = (c) => {
        const base = c.replace(/_总和/g, "");
        return HEAD_RENAME[base] || base;
      };
      const isRateCol = (c) => /完成率/.test(c);
      const fmtRate = (v) => {
        if (v === "" || v == null) return "—";
        const n = +v;
        return isNaN(n) ? String(v) : `${(n <= 1 ? n * 100 : n).toFixed(2)}%`;
      };
      const tableHTML = (raw) => {
        const cols = (raw && raw.columns) || [];
        const rows = (raw && raw.rows) || [];
        if (!cols.length || !rows.length) return `<p class="more-empty">暂无数据</p>`;
        const head = cols.map((c) => `<th>${headText(c)}</th>`).join("");
        const body = rows
          .map((r) => {
            const tds = cols
              .map((c, i) => {
                if (i === 0) {
                  const v0 = r[c];
                  const nm = v0 == null || v0 === "" ? "—" : String(v0).trim();
                  return `<td>${storeNameFix(nm)}</td>`;
                }
                return `<td class="num">${isRateCol(c) ? fmtRate(r[c]) : fmtCell(r[c])}</td>`;
              })
              .join("");
            return `<tr>${tds}</tr>`;
          })
          .join("");
        return `<table class="more-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
      };
      const moreMask = $("moreMask");
      /* html 优先：给了就直接当弹窗正文（「激励排名」这类自绘表格用），
         否则按 secs 拼成「小标题 + 原始表」的多段结构（网电/市场明细用）。
         boxClass（2026-10-27）：「激励排名」弹窗要左右两栏，得比默认 960px 更宽，
         这里给 .modal-box 挂一个类；其它弹窗不传 → 自动摘掉，互不影响。 */
      const openMore = (title, secs, html, boxClass) => {
        $("moreTitle").textContent = title;
        const box = document.querySelector("#moreMask .modal-box");
        if (box) box.classList.toggle("inc-box", boxClass === "inc-box");
        $("moreBody").innerHTML =
          html != null
            ? html
            : secs
                .map(
                  (s) =>
                    `<div class="more-sec-title">${s.title}</div>` +
                    tableHTML(MODEL.tables && MODEL.tables[s.key]),
                )
                .join("");
        moreMask.hidden = false;
      };
      const closeMore = () => {
        moreMask.hidden = true;
      };
      $("moreClose").addEventListener("click", closeMore);
      moreMask.addEventListener("click", (e) => {
        if (e.target === moreMask) closeMore(); // 点遮罩空白处关闭
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeMore();
      });
      $("moreWeb").addEventListener("click", () =>
        openMore("网电 / 老带新明细", [
          { title: "网电数据", key: "web" },
          { title: "老带新数据", key: "referral" },
        ]),
      );
      $("moreMkt").addEventListener("click", () =>
        openMore("市场 / 各小组明细", [
          { title: "市场数据", key: "market" },
          { title: "市场各小组数据", key: "groups" },
        ]),
      );
      /* ── 「激励排名」弹窗（2026-10-26 需求）──
         数据是 BI 三张周排名表并出来的（data.js 的 buildIncentive），
         一张表按周分组、周内固定三行：健康顾问完成率 / 健康顾问单体 / 机构周业绩。
         周次列用 rowspan 合并，与原型一致。 */
      /* 值的格式化：pct 在 data.js 里已经统一成百分数（小数口径 ×100），这里只补符号；
         money 是元，走全局的两位小数格式。 */
      const incValue = (v, kind) =>
        kind === "money" ? fmtY(v) : `${Number(v).toFixed(2)}%`;
      /* 右栏：每周激励榜（BI 三张周排名表并出来的，见 data.js 的 buildIncentive） */
      const incentiveWeeklyHTML = () => {
        const inc = (MODEL && MODEL.incentive) || {};
        const rows = inc.rows || [];
        if (!rows.length)
          return `<p class="more-empty">暂无数据 —— BI 的三张周排名表还没取到（门店数据-完成率排名 / 咨询数据-完成率排名 / 咨询数据-平均单体排名），等下一次数据刷新后再看。</p>`;
        const counts = {};
        rows.forEach((r) => (counts[r.week] = (counts[r.week] || 0) + 1));
        const shown = {};
        const body = rows
          .map((r) => {
            const first = !shown[r.week];
            shown[r.week] = true;
            const weekCell = first
              ? `<td class="wk" rowspan="${counts[r.week]}">${r.week}</td>`
              : "";
            return `<tr>${weekCell}<td class="item">${r.label}</td><td class="who">${r.who}</td><td class="num">${incValue(r.value, r.kind)}</td></tr>`;
          })
          .join("");
        return `<table class="more-table inc-table">
          <thead><tr><th>周次</th><th>激励项目</th><th>激励对象</th><th>详细数据</th></tr></thead>
          <tbody>${body}</tbody></table>`;
      };
      /* 左栏：每日业绩完成率 TOP2（2026-10-27 需求）
         BI「门店每日数据」新增「业绩目标 / 业绩完成率」两列后，把每天的完成率
         第一名、第二名做成表，按日期从今天往前排（降序）。历史日用每日表的原生值；
         今日行改用门店表的实时「今日业绩」并重算完成率 —— 口径见 data.js 的
         buildDailyTop2，与外面曲线图完全同源（总额、目标、完成率都对得上） */
      const dailyTop2HTML = () => {
        const dt = (MODEL && MODEL.dailyTop2) || {};
        const days = dt.rows || [];
        if (!days.length)
          return `<p class="more-empty">暂无数据 —— BI「门店每日数据」还没取到「业绩目标 / 业绩完成率」两列，等下一次数据刷新（每天 02:00 抓一次）后再看。</p>`;
        const body = days
          .map((d) =>
            d.items
              .map((it, i) => {
                /* 日期列 rowspan 合并（同一天的第 1、2 名共用一格），与原型一致 */
                const dayCell =
                  i === 0
                    ? `<td class="dt-day" rowspan="${d.items.length}">${d.date}${
                        d.today ? `<span class="dt-tag">今日 · 实时</span>` : ""
                      }</td>`
                    : "";
                return `<tr>${dayCell}<td class="dt-store">${it.name}</td><td class="dt-rank r${it.rank}">第${it.rank}名</td><td class="num">${fmtCell(it.target)}</td><td class="num">${fmtCell(it.actual)}</td><td class="num dt-pct">${Number(it.pct).toFixed(2)}%</td></tr>`;
              })
              .join(""),
          )
          .join("");
        return `<table class="more-table dt-table">
          <thead><tr><th>时间</th><th>门店</th><th>排名</th><th>业绩目标</th><th>实收金额</th><th>业绩完成率</th></tr></thead>
          <tbody>${body}</tbody></table>`;
      };
      /* 弹窗正文：左 = 每日 TOP2（新），右 = 每周激励榜（原有） */
      const incentiveHTML = () => `<div class="inc-wrap">
          <div class="inc-col">
            <div class="inc-hd">每日业绩完成率 TOP2</div>
            <div class="inc-scroll">${dailyTop2HTML()}</div>
          </div>
          <div class="inc-col">
            <div class="inc-hd">每周激励排名</div>
            <div class="inc-scroll">${incentiveWeeklyHTML()}</div>
          </div>
        </div>`;
      const incBtn = $("btnIncentive");
      if (incBtn)
        incBtn.addEventListener("click", () =>
          openMore("激励排名", null, incentiveHTML(), "inc-box"),
        );
      function updateChips(m) {
        (m.channelCards || []).forEach((card, ci) => {
          card.items.forEach((c, i) => {
            const ref = chipRefs[ci] && chipRefs[ci][i];
            if (!ref) return;
            ref.line1.innerHTML = chipLine1(c);
            ref.line2.innerHTML = chipLine2(c);
            if (ref.bar) ref.bar.style.width = chipBarW(c) + "%";
          });
        });
      }

      /* ══════════════════════════════════════════════════════════
       * ⑥ 中央 Hero：移植「门店业绩水球看板」
       * ══════════════════════════════════════════════════════════ */
      const H = {
        CX: 450,
        CY: 320,
        R_RING: 233,
        R_BALL: 178,
        R_LABEL: 280,
        SEG_SPAN: 60,
        SEG_GAP: 2,
        STROKE: 30,
        VB_Y: 24,
        VB_W: 900,
        VB_H: 580,
      };
      /* 6 段：右上/右中/右下/左上/左中/左下（与 STORES 一一对应）
         mirror 模式：右侧顺时针涨、左侧逆时针涨，以垂直中轴严格镜像 */
      const SEGMENTS = [
        { slot: "right-top", start: 270, dir: 1 },
        { slot: "right-mid", start: 330, dir: 1 },
        { slot: "right-bottom", start: 30, dir: 1 },
        { slot: "left-top", start: 210, dir: -1 },
        { slot: "left-mid", start: 150, dir: -1 },
        { slot: "left-bottom", start: 90, dir: -1 },
      ];
      const trackRange = (seg) => ({
        a0: seg.start + H.SEG_GAP,
        a1: seg.start + H.SEG_SPAN - H.SEG_GAP,
      });
      function progressRange(seg, pct) {
        const t = trackRange(seg);
        const len = ((H.SEG_SPAN - 2 * H.SEG_GAP) * clamp(pct, 0, 100)) / 100;
        const a0 = seg.dir > 0 ? t.a0 : t.a1;
        return { a0, a1: a0 + seg.dir * len, dir: seg.dir };
      }

      const heroMod = $("heroMod");
      const gTracks = $("hTracks"),
        gProgress = $("hProgress"),
        gDots = $("hDots"),
        gHits = $("hHits");
      const progPaths = [],
        endDots = [],
        hitPaths = [],
        labels = [];
      const U = () => heroMod.clientWidth / H.VB_W; // 800/900 = 0.8889
      function syncUnit() {
        heroMod.style.setProperty("--u", U() + "px");
      }
      syncUnit();
      addEventListener("resize", syncUnit);

      SEGMENTS.slice(0, HERO.length).forEach((seg, i) => {
        const t = trackRange(seg),
          s = HERO[i];
        const mkP = (parent, attrs) => {
          const el = document.createElementNS(SVGNS, "path");
          for (const k in attrs) el.setAttribute(k, attrs[k]);
          parent.appendChild(el);
          return el;
        };
        mkP(gTracks, {
          d: arcPath(H.CX, H.CY, H.R_RING, t.a0, t.a1),
          stroke: "rgba(255,255,255,0.12)",
        });
        progPaths[i] = mkP(gProgress, { stroke: s.color });
        const c = document.createElementNS(SVGNS, "circle");
        c.setAttribute("r", 0);
        c.setAttribute("fill", "#fff");
        c.setAttribute("filter", "url(#hGlow)");
        gDots.appendChild(c);
        endDots[i] = c;
        hitPaths[i] = mkP(gHits, {
          d: arcPath(H.CX, H.CY, H.R_RING, t.a0, t.a1),
        });
      });

      function drawProgress(i, pct) {
        if (pct < 0.5) {
          progPaths[i].setAttribute("d", "");
          endDots[i].setAttribute("r", 0);
          return;
        }
        const rg = progressRange(SEGMENTS[i], pct);
        progPaths[i].setAttribute(
          "d",
          arcPathDir(H.R_RING, rg.a0, rg.a1, rg.dir),
        );
        const [x, y] = polar(H.CX, H.CY, H.R_RING, rg.a1);
        endDots[i].setAttribute("cx", x.toFixed(2));
        endDots[i].setAttribute("cy", y.toFixed(2));
        endDots[i].setAttribute("r", (H.STROKE / 2) * 0.75);
      }

      /* 水球波浪：波形/幅度回到最初 v2 单文件版（2026-10-19 需求）
         WL=160、wave1 amp 10、wave2 amp 13 且低 9px —— 与 13周年庆数据看板-v2.html 一致，
         这样波纹密度和起伏幅度都与初始界面相同；只保留现在的配色。
         （之前为了做「宽水带」把波长拉到 330、振幅拉到 22，纹路变粗变平，
           用户要求改回最初那版的波纹。） */
      const WL = 160,
        WAVE_W = H.R_BALL * 2 + WL * 2 + 120;
      const wave1 = $("hWave1"),
        wave2 = $("hWave2");
      function wavePath(level, amp) {
        const x0 = H.CX - WAVE_W / 2;
        let d = `M ${x0} ${level.toFixed(2)}`,
          x = x0;
        while (x < x0 + WAVE_W) {
          d +=
            ` Q ${x + WL * 0.25} ${level - amp}, ${x + WL * 0.5} ${level}` +
            ` Q ${x + WL * 0.75} ${level + amp}, ${x + WL} ${level}`;
          x += WL;
        }
        return (
          d +
          ` L ${x0 + WAVE_W} ${H.CY + H.R_BALL + 60} L ${x0} ${H.CY + H.R_BALL + 60} Z`
        );
      }
      function drawWaves(pct) {
        const lv = H.CY + H.R_BALL - (2 * H.R_BALL * clamp(pct, 0, 100)) / 100;
        /* 浅色后层浪在水面上、深色主体浪压在它下方 13px（2026-10-19 三次调整）
           v2 原参数是 wave1=lv / wave2=lv+9，两者相位相同、振幅 10 与 13，
           算下来 wave1 永远压在 wave2 上面 6~12px（同相位差值恒为 -3f-9 < 0），
           后层被完全遮死 —— 所以线上只剩一条浪。
           改成 wave2=lv（浅金，波峰高）、wave1=lv+13（深金主体），
           两层真实错开 11.5~14.5px，露出一道连续的水带；
           液体顶仍由 wave2 决定（≈lv），水位不会被虚抬。 */
        wave1.setAttribute("d", wavePath(lv + 13, 10));
        if (wave2) wave2.setAttribute("d", wavePath(lv, 13));
      }

      /* 左右门店标签：y 由段中心角算出，与弧段严格对齐且左右镜像 */
      /* 今日数据行（2026-10-14 需求）：今日初诊/今日业绩，取 BI 门店表各店实时列。
         2026-10-18 改版：第一行只放「今日数据」，字号/字距/颜色与店名一致
         （2026-10-19：去掉了冒号，与店名对齐更干净）；
         第二行另起一行放「X人 / Y万元」，加粗，字号取完成率(24u)的 2/3 = 16u；
         2026-10-20：「/」两侧加不换行空格，把人数和钱分开（用 &nbsp; 避免被折叠/断行）。
         右列的三个框由 CSS `.store-label.right .today` 改成右对齐。 */
      const todayHTML = (s) =>
        s.todayRev == null
          ? `<div class="t-line"><span class="t-lab">今日数据</span></div>
             <div class="t-line"><span class="t-val">—</span></div>`
          : `<div class="t-line"><span class="t-lab">今日数据</span></div>
             <div class="t-line"><span class="t-val">${fmtI(s.todayInit)}人&nbsp;/&nbsp;${fmt2(s.todayRev)}万元</span></div>`;
      /* 「今日数据」宽度兜底（2026-10-20）：
         .today 的真实可用宽度只有 ~128px —— 同一行前面还有色点 .dot，
         所以能用的是 128 而不是 .store-label 的内容宽 147。
         三位数人数 + 三位数业绩（999人 / 999.99万元 实测 139.6px）会超出去，
         而 .t-line 是 overflow:hidden，超了直接裁字（「元」整个看不见）。
         这里按实测文本宽等比缩字号兜底，只在超宽时生效，常态字号不变。 */
      const BASE_VAL_U = 16; // 与 CSS 里 .t-val 的 font-size 保持一致
      function fitTodayVal(el) {
        const tv = el.querySelector(".t-val");
        const line = tv && tv.closest(".t-line");
        if (!tv || !line) return;
        tv.style.fontSize = "";
        const avail = line.clientWidth;
        if (!avail) return;
        const rg = document.createRange();
        rg.selectNodeContents(tv);
        const need = rg.getBoundingClientRect().width;
        if (need > avail) {
          const ratio = (avail - 3) / need; // 留 3px 呼吸位，别把「元」顶到框边
          tv.style.fontSize = `calc(var(--u) * ${(BASE_VAL_U * ratio).toFixed(2)})`;
        }
      }
      // 字体/布局稳定后再兜一次，避免首帧测量偏差
      window.addEventListener("load", () =>
        labels.forEach((el) => el && fitTodayVal(el)),
      );
      HERO.forEach((s, i) => {
        const seg = SEGMENTS[i];
        const center = seg.start + H.SEG_SPAN / 2;
        const y = H.CY + H.R_LABEL * Math.sin((center * Math.PI) / 180);
        const side = seg.slot.startsWith("right") ? "right" : "left";
        const el = document.createElement("div");
        el.className = `store-label ${side}`;
        el.style.top = (((y - H.VB_Y) / H.VB_H) * 100).toFixed(3) + "%";
        el.innerHTML = `
          <span class="dot" style="background:${s.color};color:${s.color}"></span>
          <div class="info">
            <div class="name">${s.name}</div>
            <div class="pct">0%</div>
            <div class="bar"><i style="background:${s.color}"></i></div>
            <div class="today">${todayHTML(s)}</div>
          </div>`;
        heroMod.appendChild(el);
        fitTodayVal(el);
        labels[i] = el;
      });

      /* 主数字：宽度自动适配到「水球直径 × 73%」 */
      const hPct = $("hPct");
      const hSubVal = $("hSubVal");
      /* 水球下方数值行（2026-10-13 需求）：实收 / 基础目标，单位万元、2 位小数 */
      const heroSubText = (rev, base) => `${fmtW(rev)} / ${fmtW(base)} 万元`;
      let heroRev = totalRev,
        heroBase = totalBase;
      const TARGET_W = 0.73 * 2 * H.R_BALL; // 259.9 用户单位
      function fitHeroNumber(text) {
        hPct.textContent = text;
        let fs = 84;
        for (let i = 0; i < 3; i++) {
          hPct.style.fontSize = fs + "px";
          const w = hPct.getComputedTextLength();
          if (!w) break;
          fs = clamp((fs * TARGET_W) / w, 40, 120);
        }
        hPct.style.fontSize = fs.toFixed(2) + "px";
      }
      fitHeroNumber(KPI.revPct.toFixed(2) + "%");

      /* 弧段 hover tooltip */
      const arcTip = $("arcTip");
      function labelTopPx(seg) {
        const center = seg.start + H.SEG_SPAN / 2;
        const y = H.CY + (H.R_RING + 34) * Math.sin((center * Math.PI) / 180);
        const x = H.CX + (H.R_RING + 34) * Math.cos((center * Math.PI) / 180);
        return [x * U(), (y - H.VB_Y) * U()];
      }
      function tipHTML(s) {
        /* 2026-10-12 需求：弹窗精简为「剩余业绩 / 剩余日均业绩 / 剩余初诊 /
           剩余日均初诊 / 平均单体」—— 前四项是 BI 门店表原生列（data.js 直取），
           原 实收·基础 / 冲刺目标·完成 / 累计初诊·初诊完成率 三行已删除。 */
        const avgRow =
          s.avgTicket != null && s.avgTicket > 0
            ? `<div><span class="col">平均单体</span><b>${fmtY(s.avgTicket)}</b> 元</div>`
            : `<div><span class="col">平均单体</span><b>—</b></div>`;
        const remRev =
          s.remainRev != null
            ? `<div><span class="col">剩余业绩</span><b>${s.remainRev.toFixed(2)}</b> 万
              <span class="col">· 剩余日均</span><b>${
                s.remainRevDaily != null ? s.remainRevDaily.toFixed(2) : "—"
              }</b> 万</div>`
            : `<div><span class="col">剩余业绩</span><b>—</b></div>`;
        const remInit =
          s.remainInit != null
            ? `<div><span class="col">剩余初诊</span><b>${fmtI(s.remainInit)}</b> 人
              <span class="col">· 剩余日均</span><b>${
                s.remainInitDaily != null ? fmtI(s.remainInitDaily) : "—"
              }</b> 人</div>`
            : `<div><span class="col">剩余初诊</span><b>—</b></div>`;
        return `<div class="hd"><span class="dot" style="background:${s.color}"></span>${s.name}</div>
          ${remRev}
          ${remInit}
          ${avgRow}`;
      }
      SEGMENTS.slice(0, HERO.length).forEach((seg, i) => {
        hitPaths[i].style.cursor = "pointer";
        hitPaths[i].addEventListener("mouseenter", () => {
          heroMod.classList.add("focus");
          heroMod.classList.add("dim-others");
          progPaths.forEach((p, j) =>
            p.setAttribute("opacity", j === i ? 1 : 0.28),
          );
          endDots.forEach((d, j) =>
            d.setAttribute("opacity", j === i ? 1 : 0.28),
          );
          labels.forEach((l, j) => l.classList.toggle("on", j === i));
          arcTip.innerHTML = tipHTML(heroEntry(i, MODEL));
          const [x, y] = labelTopPx(seg);
          arcTip.style.display = "block";
          arcTip.style.left = clamp(x, 130, 670) + "px";
          arcTip.style.top = y - 10 + "px";
        });
        hitPaths[i].addEventListener("mouseleave", () => {
          heroMod.classList.remove("focus", "dim-others");
          progPaths.forEach((p) => p.setAttribute("opacity", 1));
          endDots.forEach((d) => d.setAttribute("opacity", 1));
          labels.forEach((l) => l.classList.remove("on"));
          arcTip.style.display = "none";
        });
      });

      /* ?hover=N 调试：模拟悬停第 N 段弧（截图核对 tooltip 用） */
      const hoverIdx = /[?&]hover=(\d)/.exec(location.search);
      if (hoverIdx)
        hitPaths[+hoverIdx[1]].dispatchEvent(new Event("mouseenter"));

      /* Hero 入场：弧长 / 水位 / 巨数同一进度驱动 */
      (function heroEnter() {
        if (!ANIM) {
          heroEntries(MODEL).forEach((s, i) => {
            drawProgress(i, s.revPct);
            labels[i].querySelector(".pct").textContent =
              s.revPct.toFixed(2) + "%";
            labels[i].querySelector(".bar i").style.width =
              clamp(s.revPct, 0, 100) + "%";
          });
          drawWaves(KPI.revPct);
          hPct.textContent = KPI.revPct.toFixed(2) + "%";
          hSubVal.textContent = heroSubText(totalRev, totalBase);
          return;
        }
        const DUR = 1800,
          t0 = performance.now();
        (function frame(now) {
          const k = easeOut(clamp((now - t0) / DUR, 0, 1));
          heroEntries(MODEL).forEach((s, i) => {
            drawProgress(i, s.revPct * k);
            labels[i].querySelector(".pct").textContent =
              (s.revPct * k).toFixed(2) + "%";
            labels[i].querySelector(".bar i").style.width =
              clamp(s.revPct * k, 0, 100) + "%";
          });
          drawWaves(KPI.revPct * k);
          hPct.textContent = (KPI.revPct * k).toFixed(2) + "%";
          hSubVal.textContent = heroSubText(totalRev * k, totalBase);
          if (k < 1) requestAnimationFrame(frame);
        })(t0);
      })();

      /* ══════════════════════════════════════════════════════════
       * ⑦ 左栏：门店达成 + 初诊进度（32px 行，6 行闭合）
       *    数据全部来自 BI 门店表：初诊到诊 / 初诊目标 / 初诊完成率
       *    （2026-09-29 前这里是"复诊到店率"，用的是 CONFIG 里手填的 revisit，
       *      BI 没有这个指标；现在换成 BI 原生的初诊三件套，不再依赖手填值。）
       * ══════════════════════════════════════════════════════════ */
      /* ── 左栏两栏的排序（2026-10-26 需求）──
         业绩进度：业绩 / 完成率 / 平均单体（「目标」已按要求先隐藏，能力保留）；
         初诊进度：初诊 / 完成率（同上）。
         点按钮 = 按该指标降序重排 + 行内对应的那个数字变金色加粗
         （与默认的完成率同一套格式，其余数字保持小字灰色）。
         2026-10-26 追加需求：**打开页面就按完成率降序**（不再是门店固定顺序），
         所以 STORE_SORT_ON 初始为 true；两栏因此不再逐行对齐（旧的对齐需求作废）。 */
      const STORE_SORT = { rowsRev: "pct", rowsRevisit: "pct" };
      const STORE_SORT_ON = { rowsRev: true, rowsRevisit: true };
      /* 每个面板可选指标的取数口径 + 该指标在行内对应哪个数字（hl）：
         amount → 「实收 53.48」/「初诊 282」；target → 「/ 目标 65.00」；
         pct → 行尾百分比；avg → 行内末尾临时补一段「· 单体 3,080.10」并高亮它。 */
      const STORE_METRIC = {
        rowsRev: {
          target: { val: (s) => s.targetBase, hl: "target" },
          amount: { val: (s) => s.actual, hl: "amount" },
          pct: { val: (s) => s.revPct, hl: "pct" },
          avg: { val: (s) => s.avgTicket, hl: "avg" },
        },
        rowsRevisit: {
          target: { val: (s) => s.initBase, hl: "target" },
          amount: { val: (s) => initActualOf(s), hl: "amount" },
          pct: { val: (s) => s.initPct, hl: "pct" },
        },
      };
      const storeMetric = (id) =>
        (STORE_METRIC[id] || {})[STORE_SORT[id]] || STORE_METRIC[id].pct;
      /* 该面板当前应显示的门店顺序：按当前指标降序（STORE_SORT_ON 为 false 时保持原序，
         目前两个面板都是 true，留这个开关是为了以后想回到"门店固定顺序"能一键改回） */
      const storeOrder = (id, list) => {
        if (!STORE_SORT_ON[id]) return list;
        const mt = storeMetric(id);
        return [...list].sort((a, b) => mt.val(b) - mt.val(a));
      };
      /* 行内数字：命中当前指标就套 .sp-hl（金色加粗），其余原样输出 */
      const spNum = (id, key, text) =>
        storeMetric(id).hl === key ? `<b class="sp-hl">${text}</b>` : text;
      /* 行尾百分比：只有完成率是当前指标时才金色加粗 */
      const spPct = (id, pct) =>
        `<span class="sp-pct${storeMetric(id).hl === "pct" ? " on" : ""}">${pct.toFixed(2)}%</span>`;
      /* 「平均单体」是唯一没有行内位置的指标：选中时才在行尾追加「 · 单体 X」并高亮，
         其余模式下这段不出现 —— 行内文字保持原样（2026-10-26 需求）。 */
      const spAvg = (id, s) =>
        storeMetric(id).hl === "avg"
          ? ` · ${spNum(id, "avg", "单体 " + fmtY(s.avgTicket))}`
          : "";

      function renderRevRows(m, setW) {
        /* 2026-10-16 需求：
           ① 行内小字不再带「万」（面板头已写明「单位：万元」）；
           ② 条形改为直接表示正常完成率（实收 ÷ 基础 = s.revPct），
              并删掉白色的基础目标刻度 —— 原先条形是对「冲刺目标（基础×1.18）」画、
              刻度恒停在 84.7%，与右侧的完成率百分比是两个口径，容易误读，已废弃。
              副作用修正：基础为 0 的门店（如三级医院）原先 0÷0 被钳成满条，
              现在按完成率 0.00% 显示为空条，与右侧百分比一致。
           2026-10-26：行序/高亮走上面的 STORE_METRIC（点按钮排序用），
           行首加 data-name —— 心跳时据此判断行序有没有变，变了就整块重画。 */
        const id = "rowsRev";
        $("rowsRev").innerHTML = storeOrder(id, m.stores)
          .map(
            (s) => `<div class="sp-row" data-name="${s.name}">
              <div class="sp-l1">
                <span class="dot" style="background:${s.color}"></span>
                <span class="sp-name">${s.name}</span>
                <span class="sp-meta">实收 ${spNum(id, "amount", fmtW(s.actual))} / 目标 ${spNum(id, "target", fmtW(s.targetBase))}${spAvg(id, s)}</span>
              </div>
              <div class="sp-bar-wrap">
                <span class="sp-bar"><i data-w="${clamp(s.revPct, 0, 100).toFixed(1)}"></i></span>
              </div>
              ${spPct(id, s.revPct)}
            </div>`,
          )
          .join("");
        // setW=true：点排序按钮 / 心跳重画后直接落位（首次进入交给 entrance 统一铺开）
        if (setW)
          $("rowsRev")
            .querySelectorAll("i[data-w]")
            .forEach((el) => (el.style.width = el.dataset.w + "%"));
      }
      renderRevRows(MODEL);
      /* 心跳：行序没变 → 原地更新，条形走 CSS 过渡、百分比走数字滚动；
         行序变了（排序模式下某店被反超）→ 整块重画，否则按下标写会把数字写到别人身上。 */
      function updateRevRows(m, animate) {
        const id = "rowsRev";
        const list = storeOrder(id, m.stores);
        const box = $("rowsRev");
        const sameOrder =
          box.children.length === list.length &&
          list.every((s, i) => box.children[i] && box.children[i].dataset.name === s.name);
        if (!sameOrder) {
          renderRevRows(m, true);
          beatFade(box);
          return;
        }
        const rows = box.children;
        list.forEach((s, i) => {
          const row = rows[i];
          row.querySelector(".sp-meta").innerHTML =
            `实收 ${spNum(id, "amount", fmtW(s.actual))} / 目标 ${spNum(id, "target", fmtW(s.targetBase))}${spAvg(id, s)}`;
          row.querySelector(".sp-bar i").style.width =
            clamp(s.revPct, 0, 100).toFixed(1) + "%";
          const pctEl = row.querySelector(".sp-pct");
          if (animate)
            tweenNum(
              pctEl,
              parseFloat(pctEl.textContent) || 0,
              s.revPct,
              (v) => v.toFixed(2) + "%",
              1100,
            );
          else pctEl.textContent = s.revPct.toFixed(2) + "%";
        });
      }

      /* setW=true：心跳重建后直接落位（入场时交给 entrance 统一铺开）
         2026-10-16 需求：门店顺序不再按初诊完成率降序，改为与上方「业绩进度」
         面板完全一致的 MODEL.stores 原始顺序（神华/九星/青东/包百/校园/医院），
         两栏逐行一一对应，便于左右对照。
         2026-10-26 追加需求：打开页面就按完成率降序，两栏不再逐行对齐（对齐需求作废），
         排序口径见 storeOrder（点按钮可切到目标/初诊/完成率）。 */
      function renderRevisitRows(m, setW) {
        const id = "rowsRevisit";
        $("rowsRevisit").innerHTML = storeOrder(id, m.stores)
          .map((s) => {
            const done = fmtI(initActualOf(s)),
              goal = fmtI(s.initBase);
            return `<div class="sp-row" data-name="${s.name}">
              <div class="sp-l1">
                <span class="dot" style="background:${s.color}"></span>
                <span class="sp-name">${s.name}</span>
                <span class="sp-meta">初诊 ${spNum(id, "amount", done)} / 目标 ${spNum(id, "target", goal)}</span>
              </div>
              <div class="sp-bar-wrap">
                <span class="sp-bar"><i data-w="${clamp(s.initPct, 0, 100).toFixed(1)}"></i></span>
              </div>
              ${spPct(id, s.initPct)}
            </div>`;
          })
          .join("");
        if (setW)
          $("rowsRevisit")
            .querySelectorAll("i[data-w]")
            .forEach((el) => (el.style.width = el.dataset.w + "%"));
      }
      renderRevisitRows(MODEL, false);
      /* 左栏两栏的排序按钮（2026-10-26 需求）：点哪个指标，就按它降序重排该面板，
         行内对应数字变金色加粗；两块面板各自独立，互不影响。 */
      document.querySelectorAll(".seg[data-sort]").forEach((seg) => {
        seg.addEventListener("click", (e) => {
          const btn = e.target.closest(".seg-btn");
          if (!btn) return;
          const id = seg.dataset.sort;
          const by = btn.dataset.by;
          if (STORE_SORT_ON[id] && STORE_SORT[id] === by) return; // 已是该模式
          STORE_SORT[id] = by;
          STORE_SORT_ON[id] = true;
          seg
            .querySelectorAll(".seg-btn")
            .forEach((b) => b.classList.toggle("on", b === btn));
          if (id === "rowsRev") renderRevRows(MODEL, true);
          else renderRevisitRows(MODEL, true);
          beatFade($(id));
        });
      });

      /* ══════════════════════════════════════════════════════════
       * ⑧ 右栏：顾问 / 医生排行（28~30px 行，首屏 7 行，可滚轮下翻看全部）
       * ══════════════════════════════════════════════════════════ */
      /* 排行面板的排序模式（2026-10-16 需求）：两块面板各自独立，初始「完成率」。
         pct = 业绩完成率（%）；amount = 业绩（万）；target = 业绩目标（万）；
         avg = 平均单体（元）。后两个 2026-10-26 新增。
         排序状态放在模块级：心跳重渲染（renderRank 被再次调用）时不会丢，
         用户切到「业绩」后一直保持。 */
      const RANK_MODE = { rowsConsult: "pct", rowsDoctor: "pct" };
      const RANK_ITEMS = {}; // containerId → 最近一次的数据，供按钮切换时原地重排
      /* 每行的「条形 + 行尾数字」（2026-10-26 需求）：
         数字一律贴到行最右，条形从姓名右侧一直铺到数字前 —— 即原来「业绩」那一列
         的位置也让给条形了。四种模式的条形与行尾数字永远是同一个指标，
         不会出现「条形看完成率、数字看业绩」的口径分裂：
           pct    绝对百分比，100% 封顶（完成率超过 100% 的条不再溢出）
           amount 占本列表最大业绩的比例（排序榜=相对长度，第一名必满格）
           target 占本列表最大业绩目标的比例（同上）
           avg    占本列表最大平均单体的比例（同上） */
      const RANK_METRIC = {
        pct: {
          val: (p) => clamp(p.pct, 0, 100),
          max: () => 100,
          text: (p) => `${p.pct.toFixed(2)}%`,
          unit: "完成率",
        },
        amount: {
          val: (p) => p.amount,
          max: (list) => Math.max(...list.map((p) => p.amount), 1e-6),
          text: (p) => fmtW(p.amount),
          unit: "单位：万元",
        },
        target: {
          val: (p) => p.target,
          max: (list) => Math.max(...list.map((p) => p.target), 1e-6),
          text: (p) => fmtW(p.target),
          unit: "单位：万元",
        },
        avg: {
          val: (p) => p.avgTicket,
          max: (list) => Math.max(...list.map((p) => p.avgTicket), 1e-6),
          text: (p) => fmtY(p.avgTicket),
          unit: "单位：元",
        },
      };

      function renderRank(containerId, items, setW) {
        const box = $(containerId);
        if (!box) return; // 判空：缺元素不拖垮整板
        const src = items || [];
        RANK_ITEMS[containerId] = src;
        const by = RANK_MODE[containerId] || "pct";
        /* 按当前模式降序；主指标并列时用另一个指标兜底，
           避免一堆 0.00% 的人每次心跳顺序乱跳（B 端看板最忌行号漂移）。
           「目标」并列很常见（同店同档目标），故兜底用业绩，其次完成率。 */
        const list = [...src].sort((a, b) =>
          by === "amount"
            ? b.amount - a.amount || b.pct - a.pct
            : by === "target"
              ? b.target - a.target || b.amount - a.amount || b.pct - a.pct
              : by === "avg"
                ? b.avgTicket - a.avgTicket || b.pct - a.pct
                : b.pct - a.pct || b.amount - a.amount,
        );
        const colorOf = (p) =>
          (STORES.find((s) => s.name === p.store) || {}).color || "#d4af37";
        /* 当前指标的刻度：pct 固定 0~100，amount/avg 取本列表最大值（至少给个极小值防除零） */
        const metric = RANK_METRIC[by] || RANK_METRIC.pct;
        const maxV = Math.max(metric.max(list), 1e-6);
        const wOf = (p) =>
          clamp((metric.val(p) / maxV) * 100, 0, 100).toFixed(1);
        /* 心跳（约每 8 分钟）会整块重写 innerHTML，必须先把 scrollTop 存下再还原，
           否则用户正往下翻时会被无声弹回顶部。 */
        const keepTop = box.scrollTop;
        box.innerHTML = list
          .map(
            (p, i) => `<div class="rk-row has-store">
              <span class="rk-badge ${i < 3 ? "r" + (i + 1) : ""}">${i + 1}</span>
              <span class="rk-name">${p.name}</span>
              <span class="rk-bar"><i data-w="${wOf(p)}" style="--c:${colorOf(p)}"></i></span>
              <span class="rk-pct">${metric.text(p)}</span>
            </div>`,
          )
          .join("");
        box.scrollTop = keepTop;
        if (setW)
          box.querySelectorAll("i[data-w]").forEach((el) => (el.style.width = el.dataset.w + "%"));
      }
      /* 面板右上角标签：2026-10-16 由「累计万元」改为「单位：万元」
         （行内的「万」字同时去掉，单位只在这里声明一次）。
         2026-10-26：单位跟着当前指标走 —— 完成率模式没有金额单位，
         平均单体是「元」而不是「万元」，标签不能一直写死「单位：万元」。 */
      const rankTag = (m) => {
        const unitOf = (id) => (RANK_METRIC[RANK_MODE[id]] || RANK_METRIC.pct).unit;
        setTxt("tagConsult", `全部 ${m.staff.consultants.length} 人 · ${unitOf("rowsConsult")}`);
        setTxt("tagDoctor", `全部 ${m.staff.doctors.length} 人 · ${unitOf("rowsDoctor")}`);
      };
      renderRank("rowsConsult", MODEL.staff.consultants, false);
      renderRank("rowsDoctor", MODEL.staff.doctors, false);
      rankTag(MODEL);
      /* 排序按钮：业绩 / 完成率 / 平均单体（后者只有咨询面板有）。点击后原地重排该面板
         （另一块不受影响），按钮高亮跟随，右上角标签的单位同步切换；
         setW=true 让条形宽度直接落位，不重播 1.4s 过渡。 */
      document.querySelectorAll(".seg[data-rank]").forEach((seg) => {
        seg.addEventListener("click", (e) => {
          const btn = e.target.closest(".seg-btn");
          if (!btn) return;
          const id = seg.dataset.rank;
          const by = btn.dataset.by;
          if (RANK_MODE[id] === by) return; // 已是该模式，不必重排
          RANK_MODE[id] = by;
          seg.querySelectorAll(".seg-btn").forEach((b) =>
            b.classList.toggle("on", b === btn),
          );
          renderRank(id, RANK_ITEMS[id], true);
          rankTag(MODEL); // 单位跟着指标走（完成率 / 万元 / 元）
          beatFade($(id));
        });
      });

      /* ══════════════════════════════════════════════════════════
       * ⑨ 底部折线：尺寸由容器反算，杜绝溢出
       * ══════════════════════════════════════════════════════════ */
      const bodyBox = document.querySelector(".trend-body");
      const TW = bodyBox.clientWidth,
        TH = bodyBox.clientHeight;
      /* 左侧留白（2026-10-19 需求）：删掉纵轴顶部的「万」字后，刻度数字整体左移到
         与面板头那条金色小竖条同一条竖线上（panel-hd 的 padding-left = 16px，
         换算成 svg 坐标约 15）。PAD_L 相应收窄，把省下的宽度还给绘图区。 */
      const AXIS_X = 15; // 刻度文字左边缘（svg 坐标）
      const PAD_L = 46,
        PAD_R = 18,
        PAD_T = 8,
        PAD_B = 24;
      const PLOT_W = TW - PAD_L - PAD_R,
        PLOT_H = TH - PAD_T - PAD_B; // 128
      const trendSvg = $("trendSvg");
      trendSvg.setAttribute("viewBox", `0 0 ${TW} ${TH}`);
      /* X 轴长度跟随 BI 实际数据（2026-10-18 需求）：原来横轴固定画满整月 31 天，
         BI 只到 18 号时，前 18 天被压在全宽 58% 里、右边一大截空白。
         现在取「最后一个有数据的日期」为终点 —— BI 多一天，轴就多一格。 */
      const lastDataIdx = (arr) => {
        for (let i = arr.length - 1; i >= 0; i--) if (arr[i] > 0) return i;
        return -1;
      };
      /* 以「所有系列里最后一个有数据的日期」为终点（SERIES 在下面才建，故延后赋值） */
      const dataDays = () => {
        let last = -1;
        Object.values(SERIES).forEach((se) => {
          last = Math.max(last, lastDataIdx(se.data));
        });
        return clamp(last + 1, 2, D); // 至少 2 个点才画得成线
      };
      let NDAY = 2; // 折线实际跨度（天数），SERIES 建好后按真实数据重算
      const xAt = (i) => PAD_L + (i * PLOT_W) / (NDAY - 1);
      /* 纵轴量程（2026-10-18 需求）：每个系列按自身数据自动定标 —— 选中某门店时
         纵轴跟着该店的业绩缩放，不再沿用「全部门店」的固定量程（那样单店曲线会贴底）。
         刻度固定 4 等分，步长取 1/1.5/2/2.5/3/4/5/6/8/10 ×10^k，保证标签是整数。
         daily 全 0（活动刚开月、还没抓到数据）时兜底 0~4，避免除以 0 变 NaN。 */
      const niceScale = (arr) => {
        const peak = Math.max(0, ...arr.filter((v) => Number.isFinite(v)));
        if (!(peak > 0)) return { max: 4, step: 1 };
        const target = peak * 1.15; // 顶部留 15% 余量
        const mag = Math.pow(10, Math.floor(Math.log10(target / 4)));
        for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
          const step = m * mag;
          if (step * 4 >= target - 1e-9) return { max: +(step * 4).toFixed(6), step };
        }
        return { max: 40 * mag, step: 10 * mag };
      };
      const fmtTick = (v) => {
        const r = Math.round(v * 100) / 100;
        return Number.isInteger(r) ? String(r) : String(+r.toFixed(1));
      };
      const yAt = (v, max) => PAD_T + (1 - v / max) * PLOT_H;

      function drawGrid(sc) {
        let html = "";
        for (let i = 1; i <= 4; i++) {
          const val = sc.step * i;
          const y = yAt(val, sc.max).toFixed(1);
          html += `<line class="grid-ln" x1="${PAD_L}" y1="${y}" x2="${TW - PAD_R}" y2="${y}" />`;
          html += `<text class="axis-txt" x="${AXIS_X}" y="${+y + 5}" text-anchor="start">${fmtTick(val)}</text>`;
        }
        /* X 刻度：每 5 天一格（第 1/5/10/15… 天），只画到数据末尾；
           末尾那天与上一格相距 ≥2 天时补一个标签，让「最后一天」始终能看到 */
        const xt = [0, 4, 9, 14, 19, 24, 29].filter((i) => i < NDAY);
        if (NDAY - 1 - xt[xt.length - 1] >= 2) xt.push(NDAY - 1);
        xt.forEach((i) => {
          html += `<text class="axis-txt" x="${xAt(i).toFixed(1)}" y="${TH - 6}" text-anchor="middle">${dayLabel(i)}</text>`;
        });
        /* 单位「万」已按 2026-10-19 需求删除（面板上方不再有单位标，
           靠 tooltip 里的「万」字说明口径） */
        $("tGrid").innerHTML = html;
      }

      /* 缺失日标记（2026-10-20）：某天 daily.json 里没有行时，在零线上画一个空心点。
         这样「没抓到数据」和「当天业绩真的为 0」在图上能分辨开，
         不至于像之前那样只看到一条贴着底边的平线、以为业绩掉没了。 */
      function drawGapMarks() {
        const g = $("tGap");
        if (!g) return;
        const y0 = (PAD_T + PLOT_H).toFixed(1);
        let html = "";
        for (let i = 0; i < NDAY; i++) {
          if (HAS[i]) continue;
          html += `<circle class="gap-dot" cx="${xAt(i).toFixed(1)}" cy="${y0}" r="2.6" />`;
        }
        g.innerHTML = html;
      }

      const SERIES = {
        all: { name: "全部门店", color: "#f0cf7a", data: dailyAll },
      };
      STORES.forEach(
        (s) =>
          (SERIES[s.id] = {
            name: s.name,
            color: s.color,
            data: dailyByStore[s.id],
          }),
      );
      const rescaleSeries = (se) => {
        se.sc = niceScale(se.data);
        se.y = se.data.map((v) => yAt(v, se.sc.max));
        se.cum = se.data.reduce(
          (acc, v) => (acc.push((acc[acc.length - 1] || 0) + v), acc),
          [],
        );
      };
      Object.values(SERIES).forEach(rescaleSeries);
      NDAY = dataDays(); // BI 数据到第几天，横轴就画几天
      drawGrid(SERIES.all.sc);
      drawGapMarks();

      const lineEl = $("lgLine"),
        areaEl = $("lgArea"),
        pulseEl = $("lgPulse"),
        endDotEl = $("lgEndDot");
      let curKey = "all";
      let dispY = SERIES[curKey].y.slice(); // 折线当前显示的 y（用于插值起点）
      /* 平滑曲线（2026-10-19 需求：折线改曲线图）。
         用单调三次 Hermite（等价 d3.curveMonotoneX）：曲线严格经过每个数据点，
         且两个点之间不会冲出数据范围 —— 普通 Catmull-Rom 在 0 值附近会鼓出负值弧线。 */
      function smoothD(pts) {
        const n = pts.length;
        if (n < 2) return "";
        const f = (v) => v.toFixed(1);
        if (n === 2) return `M ${f(pts[0][0])},${f(pts[0][1])} L ${f(pts[1][0])},${f(pts[1][1])}`;
        const dx = [],
          slope = [];
        for (let i = 0; i < n - 1; i++) {
          dx[i] = pts[i + 1][0] - pts[i][0];
          slope[i] = (pts[i + 1][1] - pts[i][1]) / (dx[i] || 1);
        }
        const m = new Array(n);
        m[0] = slope[0];
        m[n - 1] = slope[n - 2];
        for (let i = 1; i < n - 1; i++) {
          if (slope[i - 1] * slope[i] <= 0) {
            m[i] = 0; // 拐点（峰/谷）：切线取水平，避免过冲
          } else {
            const w1 = 2 * dx[i] + dx[i - 1];
            const w2 = dx[i] + 2 * dx[i - 1];
            m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
          }
        }
        let d = `M ${f(pts[0][0])},${f(pts[0][1])}`;
        for (let i = 0; i < n - 1; i++) {
          const h = dx[i] / 3;
          d +=
            ` C ${f(pts[i][0] + h)},${f(pts[i][1] + m[i] * h)}` +
            ` ${f(pts[i + 1][0] - h)},${f(pts[i + 1][1] - m[i + 1] * h)}` +
            ` ${f(pts[i + 1][0])},${f(pts[i + 1][1])}`;
        }
        return d;
      }
      function pathsOf(y) {
        /* 只画到 NDAY（有数据的最后一天），避免末尾的补 0 点越出绘图区右边界 */
        const pts = y.slice(0, NDAY).map((yy, i) => [xAt(i), yy]);
        const dLine = smoothD(pts);
        const base = (PAD_T + PLOT_H).toFixed(1);
        const x0 = pts[0][0].toFixed(1),
          x1 = pts[pts.length - 1][0].toFixed(1);
        return {
          dLine,
          dArea: dLine + ` L ${x1},${base} L ${x0},${base} Z`,
        };
      }
      function paint(key, yOverride, colorOverride) {
        const se = SERIES[key],
          y = yOverride || se.y,
          color = colorOverride || se.color;
        const { dLine, dArea } = pathsOf(y);
        lineEl.setAttribute("d", dLine);
        areaEl.setAttribute("d", dArea);
        lineEl.setAttribute("stroke", color);
        $("tAreaA").setAttribute("stop-color", color);
        pulseEl.setAttribute("cx", xAt(NDAY - 1));
        pulseEl.setAttribute("cy", y[NDAY - 1]);
        pulseEl.setAttribute("stroke", color);
        endDotEl.setAttribute("cx", xAt(NDAY - 1));
        endDotEl.setAttribute("cy", y[NDAY - 1]);
      }
      function mixColor(h0, h1, t) {
        const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
        const a = p(h0),
          b = p(h1);
        return `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], t))).join(",")})`;
      }
      paint(curKey);

      /* 折线过渡：从 fromY（旧像素位置）动到 key 系列的目标位置。
         用「归一化高度」插值 —— 这样即便换系列时纵轴量程变了，
         起点仍精确落在旧曲线上，终点落在新量程上，不会跳。 */
      function tweenPaint(key, fromY, fromC, dur) {
        const to = SERIES[key];
        const ratio = (y) => 1 - (y - PAD_T) / PLOT_H;
        const fromR = fromY.map(ratio);
        const yOf = (r) => PAD_T + (1 - r) * PLOT_H;
        const t0 = performance.now();
        (function frame(now) {
          const k = clamp((now - t0) / dur, 0, 1),
            e = easeOut(k);
          paint(
            key,
            to.y.map((ty, i) => yOf(lerp(fromR[i], ratio(ty), e))),
            fromC === to.color ? fromC : mixColor(fromC, to.color, e),
          );
          if (k < 1) requestAnimationFrame(frame);
          else paint(key);
        })(t0);
      }

      function switchSeries(key) {
        if (key === curKey || !SERIES[key]) return;
        const fromY = SERIES[curKey].y.slice(),
          fromC = SERIES[curKey].color;
        curKey = key;
        $("selLabel").textContent = SERIES[key].name;
        document
          .querySelectorAll("#selMenu li")
          .forEach((li) => li.classList.toggle("cur", li.dataset.key === key));
        /* 纵轴随所选系列重定标（关卡需求：选门店后按该店业绩缩放） */
        drawGrid(SERIES[key].sc);
        tweenPaint(key, fromY, fromC, 300);
        dispY = SERIES[key].y.slice();
      }

      (function initSelect() {
        const sel = $("sel"),
          menu = $("selMenu");
        menu.innerHTML =
          `<li class="all cur" data-key="all"><span class="dot"></span>全部门店</li>` +
          STORES.map(
            (s) =>
              `<li data-key="${s.id}"><span class="dot" style="background:${s.color}"></span>${s.name}</li>`,
          ).join("");
        $("selBtn").addEventListener("click", (e) => {
          e.stopPropagation();
          sel.classList.toggle("open");
        });
        menu.addEventListener("click", (e) => {
          const li = e.target.closest("li");
          if (!li) return;
          switchSeries(li.dataset.key);
          sel.classList.remove("open");
        });
        document.addEventListener("click", () => sel.classList.remove("open"));
        document.addEventListener(
          "keydown",
          (e) => e.key === "Escape" && sel.classList.remove("open"),
        );
      })();

      (function initHover() {
        const pad = $("hoverPad"),
          tip = $("tip"),
          hLn = $("hoverLn"),
          hDot = $("hoverDot");
        pad.setAttribute("x", PAD_L);
        pad.setAttribute("y", PAD_T);
        pad.setAttribute("width", PLOT_W);
        pad.setAttribute("height", PLOT_H);
        trendSvg.addEventListener("mousemove", (e) => {
          const r = trendSvg.getBoundingClientRect();
          const mx = (e.clientX - r.left) / SCALE;
          const i = clamp(
            Math.round((mx - PAD_L) / (PLOT_W / (NDAY - 1))),
            0,
            NDAY - 1,
          );
          const se = SERIES[curKey],
            x = xAt(i),
            y = se.y[i];
          hLn.style.display = hDot.style.display = "";
          hLn.setAttribute("x1", x);
          hLn.setAttribute("x2", x);
          hLn.setAttribute("y1", PAD_T);
          hLn.setAttribute("y2", PAD_T + PLOT_H);
          hDot.setAttribute("cx", x);
          hDot.setAttribute("cy", y);
          hDot.setAttribute("stroke", se.color);
          tip.style.display = "block";
          tip.innerHTML = HAS[i]
            ? `${dayFull(i)} · <b>${se.data[i].toFixed(2)}</b> 万<br>累计 <b>${se.cum[i].toFixed(2)}</b> 万 · ${se.name}`
            : `${dayFull(i)} · <b class="na">暂无数据</b><br>累计 <b>${se.cum[i].toFixed(2)}</b> 万 · ${se.name}`;
          const tw = tip.offsetWidth / SCALE;
          tip.style.left = x + (i > (NDAY * 2) / 3 ? -tw - 16 : 16) + "px";
          tip.style.top = clamp(y - 30, 4, TH - 60) + "px";
        });
        trendSvg.addEventListener("mouseleave", () => {
          tip.style.display = "none";
          hLn.style.display = hDot.style.display = "none";
        });
      })();

      /* ══════════════════════════════════════════════════════════
       * ⑩ 入场编排 + KPI 数字滚动
       * ══════════════════════════════════════════════════════════ */
      (function entrance() {
        const setNumbers = (k) => {
          setHTML("vDays", daysHTML(T * k));
          setTxt("vInit", fmtI(totalInit * k));
          setTxt("vTodayInit", fmtI(DATA.kpi.todayInit * k));
          setTxt("vTodayRev", fmt2(DATA.kpi.todayRev * k));
          drawRT(KPI.timePct * k);
          drawRI(KPI.initPct * k);
        };
        document
          .querySelectorAll(".rv")
          .forEach((el) => el.classList.add("in"));
        if (!ANIM) {
          document
            .querySelectorAll("i[data-w]")
            .forEach((el) => (el.style.width = el.dataset.w + "%"));
          setNumbers(1);
          return;
        }
        const rvs = document.querySelectorAll(".rv");
        document
          .querySelectorAll(".rv")
          .forEach((el) => el.classList.remove("in"));
        rvs.forEach((el, i) =>
          setTimeout(() => el.classList.add("in"), 120 + i * 80),
        );
        setTimeout(
          () =>
            document
              .querySelectorAll("i[data-w]")
              .forEach((el) => (el.style.width = el.dataset.w + "%")),
          650,
        );
        const t0 = performance.now(),
          DUR = 1800;
        (function frame(now) {
          const k = easeOut(clamp((now - t0) / DUR, 0, 1));
          setNumbers(k);
          if (k < 1) requestAnimationFrame(frame);
        })(t0);
      })();

      /* ══════════════════════════════════════════════════════════
       * ⑪ 时钟
       * ══════════════════════════════════════════════════════════ */
      (function clock() {
        const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
        const p = (n) => String(n).padStart(2, "0");
        (function tick() {
          const d = new Date();
          $("clkTime").textContent =
            `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
          $("clkDate").textContent =
            `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${WD[d.getDay()]}`;
          setTimeout(tick, 1000);
        })();
      })();

      /* ══════════════════════════════════════════════════════════
       * ⑫ 数据心跳：每 5 分钟重新抓取 BI 数据并全量刷新（页面不重载）
       * ══════════════════════════════════════════════════════════ */
      const ENTRANCE_END = performance.now() + (ANIM ? 2600 : 0);
      let curArc = heroEntries(MODEL).map((s) => s.revPct); // 6 段弧当前完成率（按站位顺序）
      let heroCur = KPI.revPct; // 水球当前水位
      let ringCur = { time: KPI.timePct, init: KPI.initPct };
      const beatFade = (el) => {
        el.classList.remove("bfade");
        void el.offsetWidth;
        el.classList.add("bfade");
      };

      /* KPI 卡：天数/初诊数字 + 两只环同步补间（第 1 卡显示天数，无数字滚动） */
      function updateKPI(m, animate) {
        const setN = (id, to, fmt) => {
          const el = $(id);
          if (!el) return; // 页面里没这个元素就跳过，不拖垮整页
          if (!animate) {
            el.textContent = fmt(to);
            return;
          }
          const from =
            parseFloat((el.textContent + "").replace(/[^\d.-]/g, "")) || 0;
          tweenNum(el, from, to, fmt);
        };
        setHTML("vDays", daysHTML(T));
        setN("vInit", m.totalInit, fmtI);
        setN("vTodayInit", m.kpi.todayInit, fmtI);
        setN("vTodayRev", m.kpi.todayRev, fmt2);
        setN("vAvgTicket", m.kpi.avgTicket, fmtY); // 平均单体（2026-10-16 新增卡）
        setTxt("subAvgTicket", todayTicketHTML(m.kpi)); // 今日单体（2026-10-19）
        $("subInit").textContent = `基础 ${fmtI(m.totalInitBase)} 人`;
        const to = {
          time: m.kpi.timePct,
          init: m.kpi.initPct,
        };
        if (!animate) {
          drawRT(to.time);
          drawRI(to.init);
        } else {
          const from = ringCur,
            t0 = performance.now(),
            DUR = 900;
          (function f(now) {
            const k = easeOut(clamp((now - t0) / DUR, 0, 1));
            drawRT(lerp(from.time, to.time, k));
            drawRI(lerp(from.init, to.init, k));
            if (k < 1) requestAnimationFrame(f);
          })(t0);
        }
        ringCur = to;
      }

      /* 中央 Hero：弧段生长 / 水位升降 / 主数字滚动 / 左右标签同步 */
      function updateHero(m, animate) {
        const target = m.kpi.revPct;
        fitHeroNumber(target.toFixed(2) + "%"); // 字号按终态适配，滚动中宽度稳定
        const fromArc = curArc.slice(),
          fromHero = heroCur,
          toRev = m.totalRev,
          toBase = m.totalBase,
          fromRev = heroRev,
          fromBase = heroBase;
        const apply = (k) => {
          heroEntries(m).forEach((s, i) => {
            const p = lerp(fromArc[i], s.revPct, k);
            drawProgress(i, p);
            labels[i].querySelector(".pct").textContent = p.toFixed(2) + "%";
            labels[i].querySelector(".bar i").style.width =
              clamp(p, 0, 100) + "%";
            const tEl = labels[i].querySelector(".today");
            /* 心跳同步今日初诊/今日业绩；文本没变就不重写 innerHTML，
               否则每帧重建节点会丢掉 fitTodayVal 设的字号自适应 */
            if (tEl) {
              const html = todayHTML(s);
              if (tEl.dataset.html !== html) {
                tEl.innerHTML = html;
                tEl.dataset.html = html;
                fitTodayVal(labels[i]);
              }
            }
          });
          const hp = lerp(fromHero, target, k);
          drawWaves(hp);
          hPct.textContent = hp.toFixed(2) + "%";
          hSubVal.textContent = heroSubText(
            lerp(fromRev, toRev, k),
            lerp(fromBase, toBase, k),
          );
        };
        if (!animate) apply(1);
        else tween(950, apply);
        curArc = heroEntries(m).map((s) => s.revPct);
        heroCur = target;
        heroRev = toRev;
        heroBase = toBase;
      }

      /* 底部折线：序列整体替换 + 300~700ms 插值；当前系列量程变档时重建网格 */
      function updateTrend(m, animate) {
        SERIES.all.data = m.daily.all;
        m.stores.forEach((s) => (SERIES[s.id].data = m.daily.byId[s.id]));
        HAS = (m.daily.has || HAS).slice(); // 缺失日标记跟着心跳一起更新
        /* 横轴跨度跟着 BI 的数据走：BI 多了新的一天，轴自动延长一格 */
        NDAY = dataDays();
        /* 每个系列按自己新的数据重新定标（选门店时纵轴同样跟着走） */
        Object.values(SERIES).forEach(rescaleSeries);
        drawGrid(SERIES[curKey].sc);
        drawGapMarks();
        const fromY = dispY;
        dispY = SERIES[curKey].y.slice();
        if (!animate) {
          paint(curKey);
          return;
        }
        tweenPaint(curKey, fromY, SERIES[curKey].color, 700);
      }

      /* 一次心跳 = 全板原地刷新 */
      function applyModel(m, animate) {
        updateKPI(m, animate);
        updateChips(m);
        updateHero(m, animate);
        updateRevRows(m, animate);
        renderRevisitRows(m, true);
        beatFade($("rowsRevisit"));
        rankTag(m);
        renderRank("rowsConsult", m.staff.consultants, true);
        beatFade($("rowsConsult"));
        renderRank("rowsDoctor", m.staff.doctors, true);
        beatFade($("rowsDoctor"));
        updateTrend(m, animate);
      }


      /* 节拍器：每 HB_MS 拍一次，入场动画结束后才开拍 */
      const hbBox = $("hbBox"),
        hbText = $("hbText");
      let nextAt = Date.now() + HB_MS,
        flashUntil = 0,
        lastSync = "",
        hbT = 0;
      setInterval(() => {
        if (performance.now() < ENTRANCE_END) return;
        loadDashboardData() // 心跳：走 cache:"no-cache" 条件重验证，保证拿到 CI 刚更新的数据
          .then((fresh) => {
            if (fresh.campaign.today !== T) {
              location.reload(); // 跨天：整页重载，时间轴按新天数重排
              return;
            }
            MODEL = fresh.model;
            applyModel(MODEL, true);
            setFoot(fresh.updatedAt);
          })
          .catch((e) => console.warn("数据心跳取数失败,保留当前数据", e));
        nextAt = Date.now() + HB_MS;
        lastSync = new Date().toTimeString().slice(0, 8);
        flashUntil = Date.now() + 3200;
        hbBox.classList.remove("flash");
        void hbBox.offsetWidth;
        hbBox.classList.add("flash");
        clearTimeout(hbT);
        hbT = setTimeout(() => hbBox.classList.remove("flash"), 1200);
      }, HB_MS);

      /* 指示器文案：刷新后 3.2s 显示「已同步」，平时显示倒计时 */
      setInterval(() => {
        if (Date.now() < flashUntil) {
          hbText.textContent = `已同步数据 · ${lastSync}`;
          return;
        }
        const left = Math.max(0, nextAt - Date.now());
        hbText.textContent = ` 下次自动刷新时间 ${p2(Math.floor(left / 60000))}:${p2(Math.floor((left % 60000) / 1000))}`;
      }, 500);
