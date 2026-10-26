# -*- coding: utf-8 -*-
"""宏脉BI 报表取数:重放浏览器真实接口 → 写 site/data/*.json。

与老方案(fetch_data_dom.py:无头浏览器登录 → 等渲染 → 滚虚拟滚动条 → 读 DOM)的区别:
  - 取数改成直接重放 BI 自己的 action=req 接口(模板在 scripts/bi_session.json),
    不用开浏览器、不等渲染、不滚滚动条 → 单次 CI 从 145 秒降到几秒;
  - 服务端返回完整结果集,不再受「只渲染可视区」限制 → 不再漏行
    (每日业绩表:DOM 抓 284 行,接口抓 307 行,DOM 少的那 23 行是漏的);
  - 只有模板失效/缺失时才会临时开一次浏览器重新抓模板(--capture 可手动触发)。

运行模式(环境变量 FETCH_MODE):
  - main(默认):抓主页面 7 张表,不碰 daily.json。给每小时一跑的定时任务用。
  - daily:     只抓每日业绩页 1 张表,只写 daily.json。给每天一次的定时任务用。
  - both:      两个页面都抓(手动补跑)。

注意:两种模式都会先开一次浏览器重抓模板(约 20~30 秒)。这不是为了渲染,而是因为
BI 把结果集缓存在「抓模板那一刻创建的报表实例」上 —— 重放旧模板只会拿到旧快照
(2026-10-13 实测:早上抓的模板到下午重放,数字比 BI 页面落后好几小时)。

凭据走环境变量 BI_USER / BI_PASS,绝不写进代码、也不写进 bi_session.json。
"""
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bi_api  # noqa: E402

TABLE_NAMES = ["门店数据", "咨询数据", "医生数据", "网电数据", "市场数据",
               "市场各小组数据", "老带新数据",
               # 2026-10-26 新增：激励排名弹窗用的三张「周排名」表
               "门店数据-完成率排名(周)", "咨询数据-完成率排名(周)",
               "咨询数据-平均单体排名(周)"]
DAILY_TABLE = "门店每日数据"
# 可选表：抓不到不算失败（不让整次运行判死）。三张周排名表只服务「激励排名」弹窗，
# BI 侧改版/换页时最多是弹窗显示「暂无数据」，绝不能因此拖垮主看板的取数。
OPTIONAL_TABLES = {"门店数据-完成率排名(周)", "咨询数据-完成率排名(周)",
                   "咨询数据-平均单体排名(周)"}
FILE_KEYS = {
    "门店数据": "stores",
    "咨询数据": "consults",
    "医生数据": "doctors",
    "网电数据": "web",
    "市场数据": "market",
    "市场各小组数据": "market_groups",
    "老带新数据": "referral",
    "门店每日数据": "daily",
    "门店数据-完成率排名(周)": "store_rank_week",
    "咨询数据-完成率排名(周)": "consult_rank_week",
    "咨询数据-平均单体排名(周)": "consult_ticket_week",
}
OUT_DIR = Path(__file__).resolve().parent.parent / "site" / "data"
CN_TZ = timezone(timedelta(hours=8))  # CI 服务器是 UTC,固定成北京时间

# 每张表的表头必须包含的关键词(取数后自检,防 BI 改列名导致张冠李戴)
HEADER_CHECK = {
    "门店数据": ["门店", "业绩目标", "实收金额"],
    "咨询数据": ["咨询"],
    "医生数据": ["医生"],
    "网电数据": ["总目标"],
    "市场数据": ["总目标"],
    "市场各小组数据": ["所属部门", "平均单体"],
    "老带新数据": ["总目标"],
    "门店每日数据": ["时间", "门店", "实收金额"],
    # 三张周排名表（2026-10-26）：只要表头还有「年周」+ 关键人/店列就认
    "门店数据-完成率排名(周)": ["年周", "门店"],
    "咨询数据-完成率排名(周)": ["年周", "咨询人员"],
    "咨询数据-平均单体排名(周)": ["年周", "平均单体"],
}


def to_number(s):
    """'2,465,912.1' -> 2465912.1;'112.09%' -> 112.09;失败返回原字符串"""
    if not isinstance(s, str):
        return s
    t = s.replace(",", "").replace("%", "").strip()
    try:
        return float(t)
    except ValueError:
        return s


def build_payload(name, rows):
    if not rows or len(rows) < 2:
        return {"columns": [], "rows": [], "empty": True}
    header = rows[0]
    data = []
    for r in rows[1:]:
        if not any(r):
            continue
        item = {}
        for i, col in enumerate(header):
            item[col] = to_number(r[i] if i < len(r) else "")
        data.append(item)
    return {
        "updated_at": datetime.now(CN_TZ).strftime("%Y-%m-%d %H:%M"),
        "source": "宏脉BI报表平台",
        "table": name,
        "columns": header,
        "rows": data,
    }


def header_ok(name, header):
    need = HEADER_CHECK.get(name)
    if not need:
        return True
    return all(any(k in c for c in header) for k in need)


def write_tables(tables, want):
    """把抓到的表写成 JSON;抓到 0 行不落盘(保留上一份好数据)。返回已写表名"""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written = []
    for name in want:
        rows = tables.get(name)
        out = OUT_DIR / ("%s.json" % FILE_KEYS[name])
        if not rows or len(rows) < 2:
            print("警告: %s 未抓到,保留原有 %s,未覆盖" % (name, out.name))
            continue
        if not header_ok(name, rows[0]):
            print("警告: %s 表头对不上(%s),保留原有 %s,未覆盖"
                  % (name, "/".join(rows[0][:4]), out.name))
            continue
        payload = build_payload(name, rows)
        tmp = out.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, out)
        written.append(name)
        print("  写入 %-8s %3d 行 -> %s" % (name, len(payload["rows"]), out.name))
    return written


def rebuild_session(user, pwd, only=None):
    """重抓模板;浏览器没装(playwright 未安装)或抓失败返回 None。

    main 模式平时不开浏览器,CI 里为了省时间不装 Chromium —— 这时重抓必然失败,
    返回 None 让调用方直接退出码 1,由 workflow 的 fallback 步骤装好浏览器再重试。
    """
    try:
        return bi_api.build_session(user, pwd, only=only)
    except Exception as e:
        print("[模板] 重抓失败:%s" % str(e)[:140])
        return None


def main():
    user = os.environ.get("BI_USER")
    pwd = os.environ.get("BI_PASS")
    if not user or not pwd:
        sys.exit("缺少环境变量 BI_USER / BI_PASS")

    mode = (os.environ.get("FETCH_MODE") or "main").strip().lower()
    force_capture = "--capture" in sys.argv or os.environ.get("BI_CAPTURE") == "1"
    if mode == "daily":
        pages, want = [("daily", [DAILY_TABLE])], [DAILY_TABLE]
    elif mode == "both":
        pages, want = [("main", TABLE_NAMES), ("daily", [DAILY_TABLE])], TABLE_NAMES + [DAILY_TABLE]
    else:
        if mode != "main":
            print("未知 FETCH_MODE=%r,按 main 处理" % mode)
            mode = "main"
        pages, want = [("main", TABLE_NAMES)], TABLE_NAMES
    print("=== FETCH_MODE=%s  页面=%s ===" % (mode, [p for p, _ in pages]))

    t_all = time.time()
    sess = None if force_capture else bi_api.load_session()
    if sess is None or not sess.get("pages"):
        print("[模板] 没有可用模板 → 开浏览器抓一次(约 30~60s,之后就都不用了)")
        sess = rebuild_session(user, pwd)
        if sess is None:
            sys.exit(1)

    # ★ 主页面必须每次重抓模板（2026-10-13 起）：BI 把查询结果缓存在「抓模板那一刻创建的
    #   报表实例」上（实例 id 形如 数据集表格20261013113428-451，带创建时间戳）。原样重放旧
    #   模板 = 永远拿同一份旧快照 —— 实测 10:44 抓的模板，14:31 重放仍返回 10:44 的数字
    #   （改请求体里的 refresh 字段没用；只把 id 字符串换新，服务端直接返回空表）。
    #   重抓一次（= 服务端新建实例）后立刻就是最新值，所以这里每次都重抓。
    #   代价：CI 里多约 20~30 秒（浏览器已缓存），每小时一次可以接受。
    if not force_capture and any(k == "main" for k, _ in pages):
        t_cap = time.time()
        print("[模板] 重抓 main 页模板(新建实例,否则重放只拿到缓存快照)…")
        rebuilt = rebuild_session(user, pwd, only="main")
        if rebuilt is None:
            print("[模板] 重抓失败(多半是没装浏览器) → 退出码 1,交给 workflow 兜底重试")
            sys.exit(1)
        sess = rebuilt
        print("[模板] 完成 %.2fs" % (time.time() - t_cap))

    # 每日业绩报表(2026-10-12 起不再弹参数框)的日期区间,是抓模板时由页面 URL 上的
    # end_date 决定的,重放改不动(日期不在请求体里)。所以每次抓 daily 之前先用「今天」
    # 的 URL 重抓一次该页模板(约 30~40s,每天只跑一次)。
    if any(k == "daily" for k, _ in pages):
        t_cap = time.time()
        print("[模板] 重抓 daily 页模板(end_date=%s)…" % bi_api._today())
        rebuilt = rebuild_session(user, pwd, only="daily")
        if rebuilt is not None:
            sess = rebuilt
            print("[模板] 完成 %.2fs" % (time.time() - t_cap))
        else:
            print("[模板] 重抓失败,沿用旧模板")

    for attempt in (1, 2):
        t_login = time.time()
        try:
            cookies = bi_api.login_api(user, pwd, sess)
        except Exception as e:
            print("[登录] 失败:%s" % str(e)[:100])
            if attempt == 1:
                print("[模板] 登录失败,尝试重抓模板后重试")
                rebuilt = rebuild_session(user, pwd)
                if rebuilt is None:
                    sys.exit(1)
                sess = rebuilt
                continue
            sys.exit(1)
        print("[登录] 成功 %.2fs" % (time.time() - t_login))

        tables = {}
        for page_key, names in pages:
            pg = sess["pages"].get(page_key)
            if not pg:
                print("[取数] 缺少 %s 页模板" % page_key)
                continue
            print("[取数] %s 页面:" % page_key)
            try:
                tables.update(bi_api.fetch_page(pg, cookies))
            except Exception as e:
                print("[取数] %s 页面失败:%s" % (page_key, str(e)[:120]))
        written = write_tables(tables, want)
        # 可选表（三张周排名）缺了不算失败，只提示 —— 见 OPTIONAL_TABLES 注释
        missing = [n for n in want if n not in written and n not in OPTIONAL_TABLES]
        opt_missing = [n for n in want if n not in written and n in OPTIONAL_TABLES]
        if opt_missing:
            print("[提示] 可选表未抓到(不影响主看板):%s" % "、".join(opt_missing))
        if not missing:
            print("[完成] %d 张表,总耗时 %.2f 秒" % (len(written), time.time() - t_all))
            return 0
        print("[完成] 缺表 %s" % "、".join(missing))
        if attempt == 1:
            print("[模板] 模板可能已失效 → 重抓一次再试")
            rebuilt = rebuild_session(user, pwd)
            if rebuilt is None:
                sys.exit(1)
            sess = rebuilt
            continue
        # 两次都没成:退出码 1,由 workflow 退回 DOM 版抓取,保证看板不断数
        sys.exit(1)


if __name__ == "__main__":
    sys.exit(main() or 0)
