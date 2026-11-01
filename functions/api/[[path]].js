/* ==========================================================
   Cloudflare Pages Functions 入口
   路由：/api/* 全部交给这里

   部署要求（在 Cloudflare 控制台完成）：
     1. Workers & Pages → KV → 创建命名空间，例如 eb-kv
     2. 进入 Pages 项目 → Settings → Functions → KV namespace bindings
        变量名填 EB_KV，选中刚建的命名空间
     3. Settings → Environment variables → 新增
        AUTH_SECRET = 一串你自己生成的随机字符（至少 32 位）
        记得选加密（Encrypt）

   注意：Cloudflare 的 KV 挂在 context.env 上，和 EdgeOne 不一样，
   所以这里用一个入口做适配，核心逻辑还是同一份 api-core.js。
   ========================================================== */

import { handle } from "../../api-core.js";

export async function onRequest(context) {
  return handle(context.request, {
    kv: context.env ? context.env.EB_KV : null,
    env: context.env || {}
  });
}
