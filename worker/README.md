# best-cf-ip Cloudflare Worker

请求进来即时抓取源地址、重新编号后以纯文本返回，与仓库 `scripts/update_best_cf_ip.py` 的输出格式一致。

```
# 100 best cf ips scanned at 2026-10-23 04:18
172.64.229.147:443#JP-102304-0001 🇯🇵
172.64.152.29:443#SG-102304-0002 🇸🇬
```

- `MMddHH` 批次号取源文件头 `scanned at` 的时间，取不到则用当前 UTC 时间
- 序号跨国家全局连续，不按国家重置
- 源里已有 `#JP-0001` / `#JP-102306-0001` 之类的旧序号会先剥掉再重排，因此重复处理结果不变

## 结构

```
worker/
├── src/index.js     # Worker 主体（含 transform / resolveBatch）
├── wrangler.toml    # 部署配置与环境变量
└── README.md
```

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SOURCE_URL` | `https://raw.githubusercontent.com/LancelotRar/best-cf-ips/main/best-cf-ip-scanned-top100.txt` | 源地址 |
| `CACHE_TTL` | `300` | 边缘缓存秒数，`0` 关闭 |
| `CORS_ORIGIN` | `*` | 允许的跨域来源 |

`wrangler.toml` 的 `[vars]` 里是明文默认值；需要按环境区分时用 secret 覆盖：

```bash
npx wrangler secret put SOURCE_URL
```

## 开发与部署

```bash
cd worker
npx wrangler dev                      # 本地跑在 http://127.0.0.1:8787
npx wrangler deploy                   # 部署到 <name>.<subdomain>.workers.dev
npx wrangler deploy --name best-cf-ip # 指定 Worker 名
```

## 响应

- `Content-Type: text/plain; charset=utf-8`，CORS 已放开
- `Cache-Control: public, max-age=<CACHE_TTL>`
- 调试头：`X-Batch`（批次号）、`X-Count`（有效行数）、`X-Skipped`（跳过行数）、`X-Source`（实际源地址）
- 源站失败且重试 3 次仍失败、或一行都解析不出时返回 `502`，不会输出空列表
- 只允许 `GET` / `HEAD` / `OPTIONS`
