/* ==========================================================
   EdgeOne Pages Functions 入口
   路由：/api/* 全部交给这里

   部署要求（在 EdgeOne Pages 控制台完成）：
     1. KV 存储 → 申请开通 → 新建命名空间 → 绑定到本项目
        绑定时的「变量名」必须填 EB_KV
     2. 项目设置 → 环境变量 → 新增
        AUTH_SECRET = 一串你自己生成的随机字符（至少 32 位）

   注意：EdgeOne 的 KV 是全局变量，不在 context.env 上。
   ========================================================== */

import { handle } from "../../api-core.js";

export async function onRequest(context) {
  const kv = (typeof EB_KV !== "undefined" && EB_KV) || (globalThis && globalThis.EB_KV);
  return handle(context.request, { kv, env: context.env || {} });
}
