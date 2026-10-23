/**
 * Cloudflare Worker：抓取 best-cf-ips 扫描结果，重新编号后以纯文本返回。
 *
 * 输出格式（与仓库里 scripts/update_best_cf_ip.py 保持一致）：
 *     172.64.229.238:443#JP-102306-0001 🇯🇵
 *     └── ip:port ──┘ └国家┘└MMddHH┘└全局序号(跨国家连续，不重置)┘
 *
 * 环境变量：
 *     SOURCE_URL  源地址，默认 LancelotRar/best-cf-ips top100
 *     CACHE_TTL   边缘缓存秒数，默认 300，设为 0 关闭缓存
 *     CORS_ORIGIN 允许的跨域来源，默认 "*"
 */

const DEFAULT_SOURCE = "https://raw.githubusercontent.com/LancelotRar/best-cf-ips/main/best-cf-ip-scanned-top100.txt";
const DEFAULT_TTL = 300;
const HEAD_WIDTH = 4; // 0001
const UA = "Mozilla/5.0 (compatible; best-cf-ip-worker/1.0)";

// 172.64.149.89:443#SG 🇸🇬
// 104.17.20.215:443#US-102306-0001 🇺🇸
// 1.1.1.1:443#JP
const ENTRY_RE = /^(?<addr>\S+?:\d+)#\s*(?<country>[A-Za-z]{2,3})(?:-(?<batch>\d{6}))?(?:-(?<seq>\d+))?(?<rest>\s.*)?$/;

// "# 100 best cf ips scanned at 2026-10-23 04:18"
const SCANNED_AT_RE = /scanned\s+at\s+(?<date>\d{4}-\d{2}-\d{2})(?:[ T](?<hh>\d{2}):\d{2})?/;

/**
 * MMddHH 批次号：优先取源文件头部 scanned at 的时间，取不到则用当前 UTC 时间。
 * @param {string} text
 * @param {Date} [now]
 * @returns {string}
 */
export function resolveBatch(text, now = new Date()) {
  const m = SCANNED_AT_RE.exec(text);
  if (m) {
    const [, mm, dd] = m.groups.date.split("-");
    return mm + dd + (m.groups.hh || "00");
  }
  const pad = (n) => String(n).padStart(2, "0");
  return pad(now.getUTCMonth() + 1) + pad(now.getUTCDate()) + pad(now.getUTCHours());
}

/**
 * 把源文本转换成 国家-MMddHH-全局序号 的列表。
 * @param {string} text 源文本
 * @param {Date} [now] 兜底批次用的当前时间
 * @returns {{body: string, batch: string, kept: number, skipped: number, stats: Record<string, number>}}
 */
export function transform(text, now = new Date()) {
  const batch = resolveBatch(text, now);
  const out = [];
  /** @type {Record<string, number>} */
  const stats = {};
  let kept = 0;
  let skipped = 0;
  let seq = 0;

  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // 保留源文件的 "# 100 best cf ips scanned at ..." 头部
    if (line.startsWith("#") && line.includes("scanned at")) {
      out.push(line);
      continue;
    }

    const m = ENTRY_RE.exec(line);
    if (!m) {
      skipped += 1;
      continue;
    }

    const country = m.groups.country.toUpperCase();
    const rest = m.groups.rest || "";
    seq += 1; // 全局连续递增，与国家前缀无关
    stats[country] = (stats[country] || 0) + 1;
    out.push(`${m.groups.addr}#${country}-${batch}-${String(seq).padStart(HEAD_WIDTH, "0")}${rest}`);
    kept += 1;
  }

  if (!kept) throw new Error("没有解析到任何有效 IP 行");

  return { body: out.join("\n") + "\n", batch, kept, skipped, stats };
}

/**
 * 带重试地抓取源地址。
 * @param {string} url
 * @param {number} [retries]
 * @returns {Promise<string>}
 */
async function fetchSource(url, retries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": UA },
        cf: { cacheTtl: 60, cacheEverything: true },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const text = await resp.text();
      if (!text.trim()) throw new Error("远端返回内容为空");
      return text;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
    }
  }
  throw new Error(`抓取 ${url} 失败: ${lastErr && lastErr.message ? lastErr.message : lastErr}`);
}

/** @param {string} value @returns {number} */
function parseTtl(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_TTL;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TTL;
  return n;
}

export default {
  /**
   * @param {Request} request
   * @param {{SOURCE_URL?: string, CACHE_TTL?: string, CORS_ORIGIN?: string}} env
   * @param {{waitUntil: (p: Promise<unknown>) => void}} ctx
   */
  async fetch(request, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": env.CORS_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed\n", { status: 405, headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } });
    }

    const source = (env.SOURCE_URL || DEFAULT_SOURCE).trim();
    const ttl = parseTtl(env.CACHE_TTL);

    // 边缘缓存：按源地址区分，避免换源后读到旧结果
    const cache = caches.default;
    const cacheKey = new Request(
      new URL(`/__best-cf-ip?src=${encodeURIComponent(source)}`, request.url).toString(),
      { method: "GET" },
    );
    if (ttl > 0) {
      const hit = await cache.match(cacheKey);
      if (hit) return stripOrHead(hit, request, cors);
    }

    let result;
    try {
      result = transform(await fetchSource(source));
    } catch (err) {
      return new Response(`[error] ${err && err.message ? err.message : err}\n`, {
        status: 502,
        headers: { ...cors, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }

    const resp = new Response(result.body, {
      headers: {
        ...cors,
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": ttl > 0 ? `public, max-age=${ttl}` : "no-store",
        "X-Batch": result.batch,
        "X-Count": String(result.kept),
        "X-Skipped": String(result.skipped),
        "X-Source": source,
      },
    });

    if (ttl > 0) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return stripOrHead(resp, request, cors);
  },
};

/**
 * 缓存命中时补上 CORS 头；HEAD 请求去掉 body。
 * @param {Response} resp
 * @param {Request} request
 * @param {Record<string, string>} cors
 */
function stripOrHead(resp, request, cors) {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(request.method === "HEAD" ? null : resp.body, {
    status: resp.status,
    headers,
  });
}
