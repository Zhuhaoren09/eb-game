/* ==========================================================
   Cloudflare Workers 入口

   仓库用 Git 连接到 Cloudflare 并部署成 Worker 时，走的是这个文件。
   （走 Pages 的旧方式时用的是 functions/api/[[path]].js）

   规则很简单：
     /api/*  → 交给 api-core.js 处理
     其它    → 交给静态资源
   ========================================================== */

import { handle } from "./api-core.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handle(request, { kv: env.EB_KV, env: env });
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);

    return new Response("Not found", { status: 404 });
  }
};
