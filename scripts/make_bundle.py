#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 site/data/ 下的 8 张表合并成一个 bundle.json。

为什么需要（2026-10-15）
------------------------
GitHub Pages 对「单个来源 IP 的请求速率」限流：实测同一 IP 下约 18 req/s 正常，
约 171 req/s 就返回 HTTP 429（正文 `Rate limit exceeded ... IP address:xx Protected by
GitHub Pages`），且同负载打其它 CDN 正常 —— 所以不是站点容量问题，是单 IP 限流。

门店/办公室是同一个公网出口 IP（NAT），N 个人同时点开看板 = N × 12 个请求全部压在
同一个 IP 上，很容易整片白屏。把 8 张表合成 1 个文件，单次打开的请求数 12 → 5。

另外看板首次加载时用的是「不带时间戳的 URL」，能被 CDN 边缘缓存；只有数据心跳
才带 ?t= 强制刷新。所以合并后的 bundle 在绝大多数请求里是边缘命中，成本极低。

原 8 个 JSON 一个都不删
----------------------
Actions 有 main / daily 两种模式，各自只更新其中一部分文件（daily 模式只更 daily.json，
main 模式完全不碰 daily.json）。保留原文件才能保证每次合并出来的 bundle 始终完整。
"""

import json
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "site", "data")
OUT = os.path.join(DATA_DIR, "bundle.json")

# 顺序与 data.js 里的 TABLES 保持一致；键名 = 原文件名（不含 .json）
TABLES = ["stores", "consults", "doctors", "web", "market", "referral", "market_groups", "daily"]
# 可选表（2026-10-26）：激励排名弹窗用的三张「周排名」表。缺了照样出 bundle，
# 前端的弹窗显示「暂无数据」—— 绝不能因为这三张表没抓到就让整个数据包停产。
OPTIONAL = ["store_rank_week", "consult_rank_week", "consult_ticket_week"]


def main():
    bundle = {"generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    missing = []
    for t in TABLES:
        p = os.path.join(DATA_DIR, t + ".json")
        if not os.path.exists(p):
            missing.append(t)
            continue
        try:
            with open(p, encoding="utf-8") as f:
                bundle[t] = json.load(f)
        except Exception as e:  # 单个表坏了不要让整次运行失败
            print("读取 %s.json 失败: %s" % (t, e), file=sys.stderr)
            missing.append(t)

    if missing:
        # 缺表就不产出：宁可继续用旧的 bundle，也不要写一个残缺文件把看板搞空白
        print("缺少表 %s，保留旧 bundle.json 不动" % ", ".join(missing), file=sys.stderr)
        return 1

    for t in OPTIONAL:
        p = os.path.join(DATA_DIR, t + ".json")
        if not os.path.exists(p):
            print("可选表 %s.json 缺失，跳过（弹窗会显示暂无数据）" % t, file=sys.stderr)
            continue
        try:
            with open(p, encoding="utf-8") as f:
                bundle[t] = json.load(f)
        except Exception as e:
            print("读取 %s.json 失败: %s" % (t, e), file=sys.stderr)

    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        # 紧凑格式：体积比 indent=2 小一半多，而这些文件是每次打开都要全量下载的
        json.dump(bundle, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, OUT)  # 原子替换，避免 Pages 抓到写了一半的文件

    raw = os.path.getsize(OUT) / 1024
    print("bundle.json 已生成（含 %d 张表，%.1f KB）" % (len(TABLES), raw))
    return 0


if __name__ == "__main__":
    sys.exit(main())
