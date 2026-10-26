# -*- coding: utf-8 -*-
"""宏脉BI 取数核心库:抓浏览器真实接口 → 之后直接重放。

背景
----
老方案是「无头浏览器登录 → 等帆软表格渲染 → 滚虚拟滚动条 → 读 DOM」,
一次要 145 秒左右,而且虚拟滚动只渲染可视区,实测一直在漏行(每日业绩表
DOM 只抓到 284 行,接口实际 307 行)。

新方案(本文件)
--------------
BI(永洪内核)渲染表格时,会向 /bi/viewer?...&action=req 发一串 zlib 压缩的
KV 请求。先用浏览器抓一次这些请求当「模板」(capture_page),之后日常取数
只要带上登录 Cookie 把模板原样重放(fetch_page)即可:
    - 不用开浏览器、不等渲染、不滚滚动条 → 6 张表约 1.5 秒
    - 服务端返回的是完整结果集,不再受可视区限制 → 不漏行
模板存在 scripts/bi_session.json(不含密码、不含 Cookie,可入库)。

登录用 BI 的 RSA 接口(login_api),只有模板需要刷新时才开浏览器。
"""
import base64
import json
import os
import re
import struct
import time
import zlib
from concurrent.futures import ThreadPoolExecutor

import requests
import urllib3

urllib3.disable_warnings()

# ---------------------------------------------------------------- 常量

BASE = "https://bi.hmccloud.com"
VIEWER_PATH = BASE + "/bi/viewer"

# 两个报表页:主报表页(6 张表)与每日业绩页(1 张表,按 start_date/end_date 过滤)
MAIN_URL = (
    VIEWER_PATH + "?proc=1&action=viewer&hback=true"
    "&db=__MY_DB__!2f!2026!5468!!5e74!!5e86!!2f!!6570!!636e!!96c6!!8868!!683c!.db"
)
DAILY_URL = (
    VIEWER_PATH + "?proc=1&action=viewer&hback=true"
    "&db=__MY_DB__!2f!2026!5468!!5e74!!5e86!!2f!!6bcf!!65e5!!4e1a!!7ee9!.db"
)
# 每日业绩报表带 start_date/end_date 参数:不传会弹参数对话框、表格不渲染。
# 用 URL 查询参数即可绕过对话框(实测有效)。
DAILY_START = "2026-08-15"          # 与看板曲线起点一致
DAILY_URL_WITH_DATES = "%s&start_date=%s&end_date={end}" % (DAILY_URL, DAILY_START)

DATA_URL = (VIEWER_PATH + "?isAjax=true&proc=1&platform=PC&deviceType=16"
            "&action=req&__level1__=viewer")

HEADERS = {
    "Content-Type": "application/octet-stream",
    "Accept": "*/*",
    "Origin": BASE,
    "Referer": (VIEWER_PATH + "?proc=2&locale=zh_CN&resource=/g5/h5/dist/js/pc/"
                "Common.worker.017f335a1460f94e63c7_prod.worker.js"),
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"),
}

HERE = os.path.dirname(os.path.abspath(__file__))
SESSION_FILE = os.path.join(HERE, "bi_session.json")

# 登录表单模板(宏脉 BI v10.1.5b 实测)。只有 adminv / passv / loginTime 是动态的,
# loginType 故意重复两次,所以必须拼原始字符串而不能用 dict。
LOGIN_FORM_DEFAULT = (
    "adminv={user}&passv={passv}&isAdmin=false&au_act=login&autoLogin=false"
    "&fromLogin=true&loginMode=user&phoneNumber=&verifyCode=&areaCode=+86"
    "&codeType=login&loginTime={logintime}&verifyCode1=&phoneVerifyCode1="
    "&loginType=user&loginType=phone&"
)

# 表名识别规则:按顺序匹配「表头必须同时包含的关键词」
# 网电/市场 两表列结构完全一致(门店/总目标/总到诊/...),只能靠出现顺序区分,
# 顺序已用 DOM 标题核对过:#05=网电 #06=市场 #07=老带新。
# 2026-10-13 起市场数据下面新增「市场各小组数据情况」表(列:所属部门/到诊人数/
# 总业绩/初诊业绩/复诊业绩/其他业绩/平均单体/今日到诊),列结构独特,靠
# 「所属部门+平均单体」唯一识别,不影响网电/市场的顺序配对。
NAME_RULES = [
    # 2026-10-26 新增的三张「周排名」表（看板「激励排名」弹窗用）。
    # 必须排在通用规则前面：它们都带「年周」列，而真正的「门店数据 / 咨询数据」明细表
    # 没有这一列 —— 靠「年周」区分，否则「咨询数据-完成率排名(周)」会被下面的
    # ["咨询"] 规则抢走，直接导致主看板取错表（这是最容易踩的坑）。
    ("门店数据-完成率排名(周)", ["年周", "门店", "业绩完成率"]),
    ("咨询数据-完成率排名(周)", ["年周", "咨询人员", "业绩完成率"]),
    ("咨询数据-平均单体排名(周)", ["年周", "咨询人员", "平均单体"]),
    ("医生数据", ["医生"]),
    ("咨询数据", ["咨询"]),
    ("门店每日数据", ["时间", "门店", "实收金额"]),
    ("门店数据", ["门店", "业绩目标", "实收金额"]),
    ("市场各小组数据", ["所属部门", "平均单体"]),
    ("老带新数据", ["总目标", "今日到诊", "再消费业绩"]),
    ("网电数据", ["总目标"]),      # 与 市场数据 同构,按出现顺序取第一个
    ("市场数据", ["总目标"]),      # 同构,取第二个
]
# 排除规则:命中即不可能是该表(用于区分 老带新 与 网电/市场)
NAME_EXCLUDE = {
    "老带新数据": ["再消费业绩(一年内)"],
}


# ---------------------------------------------------------------- 会话模板存取

def load_session():
    """读 scripts/bi_session.json;不存在返回 None(调用方需先抓模板)。"""
    if not os.path.exists(SESSION_FILE):
        return None
    try:
        with open(SESSION_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print("[session] 读取失败:%s(将重新抓模板)" % str(e)[:80])
        return None


def save_session(sess):
    tmp = SESSION_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(sess, f, ensure_ascii=False, indent=1)
    os.replace(tmp, SESSION_FILE)


# ---------------------------------------------------------------- 解析

def parse_cells(data):
    """永洪 BI 扁平记录流 -> [(行fIdx, 列val, 文本)]"""
    recs, i = [], 0
    while True:
        j = data.find(b"\x00\x03val\xff\xf8", i)
        if j < 0:
            break
        k = data.rfind(b"\xff\xf4\x00", i, j if i < j else 0)
        if k < 0:
            i = j + 4
            continue
        length = data[k + 3]
        value = data[k + 4:k + 4 + length]
        val = int.from_bytes(data[j + 7:j + 11], "big")
        m = data.find(b"\x00\x04fIdx\xff\xf8", j)
        if m < 0:
            break
        f_idx = int.from_bytes(data[m + 8:m + 12], "big")
        recs.append((f_idx, val, value.decode("utf-8", "replace")))
        i = m + 12
    return recs


def cells_to_rows(recs):
    """[(行,列,文本)] -> {行号: {列号: 文本}}(便于跨分块合并,fIdx 是全局行号)"""
    grid = {}
    for f_idx, val, txt in recs:
        grid.setdefault(f_idx, {})[val] = txt
    return grid


def grid_to_table(grid):
    """合并后的行字典 -> 二维表(第 0 行为表头)"""
    if not grid:
        return []
    ncol = max(max(d) for d in grid.values()) + 1
    return [[grid[f].get(v, "") for v in range(ncol)] for f in sorted(grid)]


def table_of(resp_bytes):
    """服务端响应字节 -> (grid, 二维表);响应是 zlib 压缩的 KV 流"""
    try:
        data = zlib.decompress(resp_bytes)
    except Exception:
        data = resp_bytes
    recs = parse_cells(data)
    grid = cells_to_rows(recs)
    return grid, grid_to_table(grid)


# ---------------------------------------------------------------- 请求体改写

def decomp_item(item):
    return zlib.decompress(base64.b64decode(item["body_b64"]))


def _find_int(body, key):
    """定位 KV 中 key 对应的 4 字节大端整数位置"""
    k = key.encode()
    j = body.find(b"\x00" + bytes([len(k)]) + k)
    if j < 0:
        return -1
    p = j + 2 + len(k)
    if body[p:p + 2] != b"\xff\xf8":
        return -1
    return p + 2


def patch_int(body, key, value):
    """把 KV 里 key 后的 4 字节整数改成 value(等长替换,不破坏长度前缀)"""
    p = _find_int(body, key)
    if p < 0:
        raise RuntimeError("请求体里没找到整数参数:%s" % key)
    return body[:p] + struct.pack(">i", value) + body[p + 4:]


def patch_date(body, key, new_date):
    """把 KV 里的 key=YYYY-MM-DD 换成新日期(日期定长 10 字符,可安全替换)"""
    pat = re.compile((key + r"=\d{4}-\d{2}-\d{2}").encode())
    if not pat.search(body):
        return body, False
    return pat.sub((key + "=" + new_date).encode(), body), True


def page_url_for_today(url, today=None):
    """把报表页 URL 里的 end_date 换成今天(抓模板时用,决定取数区间)"""
    today = today or _today()
    if "end_date=" in url:
        return re.sub(r"end_date=\d{4}-\d{2}-\d{2}", "end_date=" + today, url)
    return url


# ---------------------------------------------------------------- 纯 API 登录

def fetch_rsa_key():
    """从页面壳里取 RSA 公钥(服务端可能轮换,每次重新取)"""
    r = requests.get(MAIN_URL, headers={"User-Agent": HEADERS["User-Agent"]},
                     verify=False, timeout=25)
    m = re.search(r'rsaPublicKey:\s*"([A-Za-z0-9+/=]+)"', r.text)
    if not m:
        raise RuntimeError("未能从页面获取 rsaPublicKey")
    return m.group(1)


def esc(b64):
    """+ -> !2b! , / -> !2f!(宏脉 BI 自定义转义)"""
    return b64.replace("+", "!2b!").replace("/", "!2f!")


def login_api(user, pwd, sess=None):
    """纯 API 登录:不启动浏览器,返回 {name: value} 形式的 Cookie。

    实测加密方式:RSA-OAEP(SHA-1, MGF1-SHA1) 加密原始密码 -> base64 -> 自定义转义。
    """
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding

    if not user or not pwd:
        raise RuntimeError("缺少账号密码")

    s = requests.Session()
    s.headers.update({"User-Agent": HEADERS["User-Agent"], "Origin": BASE})
    s.get(MAIN_URL, verify=False, timeout=25)

    pub = (sess or {}).get("rsa_public_key") or ""
    if not pub.startswith("MII"):
        pub = fetch_rsa_key()
    if sess is not None:
        sess["rsa_public_key"] = pub

    key = serialization.load_der_public_key(base64.b64decode(pub))
    ct = key.encrypt(pwd.encode(), padding.OAEP(
        mgf=padding.MGF1(hashes.SHA1()), algorithm=hashes.SHA1(), label=None))
    passv = esc(base64.b64encode(ct).decode())

    tpl = (sess or {}).get("login_form") or LOGIN_FORM_DEFAULT
    form = (tpl.replace("{user}", user)
               .replace("{passv}", passv)
               .replace("{logintime}", str(int(time.time() * 1000))))

    r = s.post(MAIN_URL + "&isAjax=true", data=form,
               headers={"Content-Type": "application/x-www-form-urlencoded",
                        "Referer": MAIN_URL},
               verify=False, timeout=30)
    if r.status_code != 200:
        raise RuntimeError("登录 HTTP %s" % r.status_code)
    ck = requests.utils.dict_from_cookiejar(s.cookies)
    if "YHBISESSIONID" not in ck:
        raise RuntimeError("登录未返回 YHBISESSIONID(账号密码可能不对)")
    return ck


# ---------------------------------------------------------------- 浏览器抓模板

# 在页面内重放:把捕获到的请求体逐个 fetch 出去,返回响应(base64)。
# 之所以在浏览器里重放而不是 playwright 关闭后用 requests:实测某些环境下
# playwright 关闭后同进程再发网络请求会卡死;而且浏览器内重放自带同域 Cookie。
REPLAY_JS = """
async (b64s) => {
  const out = [];
  const url = '/bi/viewer?isAjax=true&proc=1&platform=PC&deviceType=16&action=req&__level1__=viewer';
  for (const b64 of b64s) {
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    try {
      const r = await fetch(url, { method: 'POST', body: bin,
        headers: { 'Content-Type': 'application/octet-stream' },
        credentials: 'same-origin' });
      const buf = new Uint8Array(await r.arrayBuffer());
      let s = '';
      const CH = 32768;
      for (let i = 0; i < buf.length; i += CH) {
        s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
      }
      out.push(btoa(s));
    } catch (e) { out.push('ERR:' + e); }
  }
  return out;
}
"""


def capture_page(user, pwd, url, log=print):
    """用浏览器打开报表页,抓下所有 action=req 请求当模板。

    会顺带在页面内重放一遍,据此判断哪些请求是「开报表」(preamble)、
    哪些是取数(data)、哪个是翻页模板(chunk)。返回 page 字典。
    """
    import tempfile
    from playwright.sync_api import sync_playwright

    profile = tempfile.mkdtemp(prefix="bi_capture_")
    reqs = []

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            profile, headless=True, ignore_https_errors=True, locale="zh-CN",
            viewport={"width": 1920, "height": 4000},   # 超高视口,让表格一次进视野
            args=["--ignore-certificate-errors", "--disable-gpu"])
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        def on_req(r):
            if "action=req" not in r.url:
                return
            try:
                body = r.post_data_buffer or b""
            except Exception:
                body = b""
            reqs.append({"url": r.url, "body_b64": base64.b64encode(body).decode()})

        page.on("request", on_req)
        page.goto(url, wait_until="domcontentloaded", timeout=90000)
        page.wait_for_timeout(3000)
        if page.query_selector('input[type="password"]'):
            page.fill('input[placeholder="用户名"]', user)
            page.fill('input[type="password"]', pwd)
            page.press('input[type="password"]', "Enter")
            log("  [capture] 已提交登录")
        try:
            page.wait_for_selector(".simpleGrid", timeout=60000)
        except Exception:
            log("  [capture] 警告:60s 内没等到表格渲染")
        page.wait_for_timeout(8000)

        # 登录会让页面重载,请求会重复抓一轮,按请求体去重(保留首次顺序)
        seen, uniq = set(), []
        for r in reqs:
            if r["body_b64"] in seen:
                continue
            seen.add(r["body_b64"])
            uniq.append(r)
        log("  [capture] 捕获请求 %d 个(去重后)" % len(uniq))

        resp_b64 = page.evaluate(REPLAY_JS, [r["body_b64"] for r in uniq])
        ctx.close()

    # 分类:能解析出表格的 = 取数请求
    data_idx, tables = [], {}
    for i, b64 in enumerate(resp_b64):
        if not b64 or b64.startswith("ERR:"):
            continue
        tbl = table_of(base64.b64decode(b64))[1]
        if len(tbl) >= 2 and len(tbl[0]) >= 3:
            data_idx.append(i)
            tables[i] = tbl
    if not data_idx:
        raise RuntimeError("抓到的请求里没有能解析出表格的,模板抓取失败")
    log("  [capture] 其中 %d 个是取数请求" % len(data_idx))

    first_data = min(data_idx)
    items = []
    for i, r in enumerate(uniq):
        if i in data_idx:
            body = decomp_item(r)
            # 带 topOffset 的是翻页模板(大表分块返回,每块约 100 行)
            role = "chunk" if b"topOffset" in body else "data"
            it = {"role": role, "url": r["url"], "body_b64": r["body_b64"],
                  "_idx": i}
            if role == "data":
                it["name"] = None   # 由调用方按表头命名
            items.append(it)
        elif i < first_data:
            items.append({"role": "preamble", "url": r["url"], "body_b64": r["body_b64"]})
    return {"url": url, "items": items,
            "tables_at_capture": {str(i): tables[i] for i in data_idx}}


def name_of(header, pool):
    """按表头给表命名;pool 是可用的表名池(同构表按顺序消耗)"""
    for name, keys in NAME_RULES:
        if name not in pool:
            continue
        if not all(any(k in c for c in header) for k in keys):
            continue
        if any(any(x in c for c in header) for x in NAME_EXCLUDE.get(name, [])):
            continue
        return name
    return None


def build_session(user, pwd, log=print, only=None):
    """抓报表页模板并写成 bi_session.json(需要账号密码 + 浏览器)。

    only:只重抓指定页面(如 "daily"),其余沿用已有模板。每日业绩页必须每天重抓
    一次 —— 它的日期区间是抓模板时由页面 URL 上的 end_date 决定的。
    """
    sess = load_session() or {}
    try:
        sess["rsa_public_key"] = fetch_rsa_key()
    except Exception as e:
        log("  [capture] 取 RSA 公钥失败:%s" % str(e)[:60])

    old_pages = sess.get("pages") or {}
    pages = {}
    for key, url, pool in (("main", MAIN_URL, ["门店数据", "咨询数据", "医生数据",
                                               "网电数据", "市场数据", "市场各小组数据",
                                               "老带新数据",
                                               # 2026-10-26：激励排名弹窗用的三张周排名表
                                               "门店数据-完成率排名(周)",
                                               "咨询数据-完成率排名(周)",
                                               "咨询数据-平均单体排名(周)"]),
                           ("daily", DAILY_URL_WITH_DATES.format(end=_today()),
                            ["门店每日数据"])):
        if only and key != only:
            if key in old_pages:
                pages[key] = old_pages[key]
            continue
        log("[capture] 抓 %s 页面模板 …" % key)
        pg = capture_page(user, pwd, url, log=log)
        # 给取数请求按表头命名
        pool_left = list(pool)
        for it in pg["items"]:
            if it.get("role") != "data":
                continue
            header = pg["tables_at_capture"].get(str(it["_idx"]), [[]])[0]
            nm = name_of(header, pool_left)
            if nm:
                pool_left.remove(nm)
            it["name"] = nm
            log("  [capture] 命名 %s(表头 %s…)" % (nm, "/".join(header[:3])))

        # 清理:
        #  1) 页面重载会抓到重复的取数请求 —— 期望的表都认出来了,就丢掉没认出的重复项
        #  2) 翻页模板留一个就够(offset 是运行时改的),多了只是白白占空间
        named = [it for it in pg["items"] if it.get("role") == "data" and it.get("name")]
        if len(named) == len(pool):
            pg["items"] = [it for it in pg["items"]
                           if not (it.get("role") == "data" and not it.get("name"))]
        else:
            log("  [capture] 警告:只认出 %d/%d 张表,保留未命名请求备查"
                % (len(named), len(pool)))
        kept, seen_chunk = [], False
        for it in pg["items"]:
            it.pop("_idx", None)
            if it.get("role") == "chunk":
                if seen_chunk:
                    continue
                seen_chunk = True
            kept.append(it)
        pg["items"] = kept
        pg.pop("tables_at_capture", None)
        pages[key] = pg
    sess["version"] = 2
    sess["saved_at"] = time.time()
    sess["pages"] = pages
    save_session(sess)
    log("[capture] 模板已写入 %s" % os.path.basename(SESSION_FILE))
    return sess


# ---------------------------------------------------------------- 重放取数

def _today():
    """北京日期(与看板 updated_at 同一时区)"""
    from datetime import datetime, timedelta, timezone
    return datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d")


def _post(s, url, body, timeout=30):
    r = s.post(url, data=zlib.compress(body), headers=HEADERS, timeout=timeout)
    r.raise_for_status()
    return r.content


def fetch_page(page, cookies, today=None, timeout=30, log=print, max_chunks=40):
    """重放一个页面的模板,返回 {表名: 二维表}。

    流程:preamble 顺序发(建立服务端缓存实例)→ data 并发发 → 大表按
    topOffset 翻页补全(服务端每次只给约 100 行,fIdx 是全局行号,按行号合并)。

    注意:日期区间是「抓模板那一刻」由页面 URL 决定的,重放改不了
    (2026-10-12 起日期不再出现在请求体里)。所以每日业绩页要拿到今天的区间,
    就必须先用带当天日期的 URL 重抓一次模板 —— 见 build_session(only="daily")。
    """
    today = today or _today()
    items = page["items"]
    preamble = [it for it in items if it.get("role") == "preamble"]
    data_items = [it for it in items if it.get("role") == "data"]
    chunk = next((it for it in items if it.get("role") == "chunk"), None)

    s = requests.Session()
    s.cookies.update(cookies)
    s.headers.update({"User-Agent": HEADERS["User-Agent"]})

    def prep(it):
        """解出请求体并做必要的参数改写(日期是等长替换,改不动时原样返回)"""
        body, _ = patch_date(decomp_item(it), "end_date", today)
        return body

    t0 = time.time()
    for it in preamble:
        try:
            _post(s, it.get("url") or DATA_URL, prep(it), timeout)
        except Exception as e:
            log("  [warn] preamble 请求失败(继续):%s" % str(e)[:60])
    dt_pre = time.time() - t0

    def one(it):
        t = time.time()
        raw = _post(s, it.get("url") or DATA_URL, prep(it), timeout)
        grid, tbl = table_of(raw)
        return it, grid, tbl, time.time() - t

    t1 = time.time()
    with ThreadPoolExecutor(max_workers=max(1, min(8, len(data_items)))) as ex:
        outs = list(ex.map(one, data_items))
    dt_data = time.time() - t1

    result = {}
    for it, grid, tbl, dt in outs:
        name = it.get("name") or "未命名"
        if len(tbl) < 2:
            log("  [warn] %s 返回空表" % name)
            continue
        # 有翻页模板且首屏已满 100 行 → 说明还有后续块,继续翻
        n = len(grid)
        if chunk:
            base = prep(chunk)
            offset = max(grid) + 1
            for _ in range(max_chunks):
                try:
                    body = patch_int(base, "topOffset", offset)
                except RuntimeError as e:
                    log("  [warn] %s" % e)
                    break
                try:
                    raw = _post(s, chunk.get("url") or DATA_URL, body, timeout)
                except Exception as e:
                    log("  [warn] 翻页失败:%s" % str(e)[:60])
                    break
                g2, _ = table_of(raw)
                new = [f for f in g2 if f not in grid]
                if not new:
                    break
                for f in new:
                    grid[f] = g2[f]
                offset = max(grid) + 1
        tbl = grid_to_table(grid)
        result[name] = tbl
        log("  %-8s %3d 行 x %2d 列  %.2fs %s"
            % (name, len(tbl) - 1, len(tbl[0]), dt,
               "(含翻页)" if chunk else ""))

    log("  [计时] preamble %.2fs + 取数 %.2fs = %.2fs"
        % (dt_pre, dt_data, time.time() - t0))
    return result
