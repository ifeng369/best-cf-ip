#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抓取 best-cf-ips 扫描结果，为每个 IP 的国家标签追加按国家递增的序号。

    172.64.149.89:443#SG 🇸🇬   ->   172.64.149.89:443#SG-0001 🇸🇬
    172.64.146.122:443#SG 🇸🇬   ->   172.64.146.122:443#SG-0002 🇸🇬
    104.17.20.215:443#US 🇺🇸   ->   104.17.20.215:443#US-0001 🇺🇸

用法:
    python3 scripts/update_best_cf_ip.py [--url URL] [--output best-cf-ip.txt]
退出码:
    0 成功且文件内容已更新(或本来就没变化)
    1 抓取失败 / 没有解析出任何有效行
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter

DEFAULT_URL = (
    "https://raw.githubusercontent.com/LancelotRar/"
    "best-cf-ips/main/best-cf-ip-scanned-top50.txt"
)
DEFAULT_OUTPUT = "best-cf-ip.txt"

# 172.64.149.89:443#SG 🇸🇬  /  104.17.20.215:443#US-0001 🇺🇸  /  1.1.1.1:443#JP
ENTRY_RE = re.compile(
    r"^(?P<addr>\S+?:\d+)"      # ip:port
    r"#\s*"
    r"(?P<country>[A-Za-z]{2,3})"  # 国家码
    r"(?:-(?P<seq>\d+))?"         # 已存在的序号(重新处理时先剥掉)
    r"(?P<rest>\s.*)?$"           # 国旗等附加信息
)

HEAD_WIDTH = 4  # 0001
UA = "Mozilla/5.0 (compatible; best-cf-ip-updater/1.0)"


def fetch(url: str, retries: int = 3, timeout: int = 30) -> str:
    """带重试的 GET，返回 UTF-8 文本。"""
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if resp.status != 200:
                    raise urllib.error.HTTPError(url, resp.status, "bad status", resp.headers, None)
                raw = resp.read()
            text = raw.decode("utf-8-sig", errors="replace")
            if not text.strip():
                raise ValueError("远端返回内容为空")
            return text
        except Exception as exc:  # noqa: BLE001 - 网络异常统一重试
            last_err = exc
            if attempt < retries:
                wait = 2 ** attempt
                print(f"[warn] 第 {attempt}/{retries} 次抓取失败: {exc}，{wait}s 后重试", file=sys.stderr)
                time.sleep(wait)
    raise RuntimeError(f"抓取 {url} 失败: {last_err}")


def transform(text: str) -> tuple[str, Counter]:
    """给每行 IP 打上 国家码-序号；返回 (输出内容, 各国家计数)。"""
    counters: Counter = Counter()
    out: list[str] = []
    kept = skipped = 0

    for line in text.lstrip("\ufeff").splitlines():  # 防御 BOM 混入首行
        stripped = line.strip()
        if not stripped:
            continue
        # 保留源文件的 "# 50 best cf ips scanned at ..." 头部
        if stripped.startswith("#") and "scanned at" in stripped:
            out.append(stripped)
            continue

        m = ENTRY_RE.match(stripped)
        if not m:
            skipped += 1
            continue

        country = m.group("country").upper()
        rest = m.group("rest") or ""
        counters[country] += 1
        seq = f"{counters[country]:0{HEAD_WIDTH}d}"
        out.append(f"{m.group('addr')}#{country}-{seq}{rest}")
        kept += 1

    if skipped:
        print(f"[warn] 跳过 {skipped} 行无法解析的内容", file=sys.stderr)
    if not kept:
        raise RuntimeError("没有解析到任何有效 IP 行，已中止（不会覆盖现有文件）")

    stats = Counter(counters)
    print(f"[info] 有效 IP 行 {kept} 行, 跳过 {skipped} 行")
    print("[info] 各国家数量: " + ", ".join(f"{c}={n}" for c, n in sorted(stats.items())))
    return "\n".join(out) + "\n", stats


def write_if_changed(path: str, content: str) -> bool:
    """写入文件；内容未变化时不改动。返回是否发生变化。"""
    old = None
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as fh:
            old = fh.read()
    if old is not None and old.replace("\r\n", "\n") == content:
        print(f"[info] {path} 内容无变化，跳过写入")
        return False
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(content)
    print(f"[ok] 已写入 {path} ({len(content.encode('utf-8'))} bytes)")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="更新 best-cf-ip.txt（按国家追加序号）")
    ap.add_argument("--url", default=os.environ.get("SOURCE_URL", DEFAULT_URL))
    ap.add_argument("--output", default=os.environ.get("OUTPUT_FILE", DEFAULT_OUTPUT))
    args = ap.parse_args()

    print(f"[info] 源地址: {args.url}")
    print(f"[info] 输出文件: {args.output}")
    content, stats = transform(fetch(args.url))
    changed = write_if_changed(args.output, content)

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        rows = "\n".join(f"| {c} | {n} |" for c, n in sorted(stats.items()))
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(
                "## best-cf-ip.txt 更新结果\n\n"
                f"- 源: `{args.url}`\n"
                f"- 文件变化: {'是' if changed else '否（内容相同，未提交）'}\n"
                "- 各国家 IP 数量:\n\n"
                "| 国家码 | 数量 |\n| --- | --- |\n" + rows + "\n"
            )

    print("[done] 完成")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"[error] {exc}", file=sys.stderr)
        sys.exit(1)