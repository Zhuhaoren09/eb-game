/* ==========================================================
   api-core.js —— 后端核心逻辑（EdgeOne / Cloudflare 共用）

   运行时约束（两边一致）：
     - V8，没有 Node 内置模块，不能用 npm 包
     - 没有 Response.json()，一律 new Response(JSON.stringify(...))
     - Web Crypto 可用

   对外只暴露 handle(request, { kv, env })

   数据键位：
     ue:{邮箱}        -> uid           邮箱索引
     u:{uid}         -> 用户记录
     b:{uid}         -> 个人最高分
     lb:all          -> 总榜数组
     lb:week:{key}   -> 周榜数组
     lb:day:{date}   -> 日榜数组
     meta:first      -> 是否已有第一个用户（用于初始化管理员）
   ========================================================== */

const enc = new TextEncoder();
const TOKEN_TTL = 60 * 60 * 24 * 7;      // 7 天
const PBKDF2_ROUNDS = 60000;             // 边缘函数 CPU 只有 200ms，不要调太高
const MAX_LB = 200;                      // 榜单最多保留条目

/* ---------------- 基础工具 ---------------- */

function b64uEncode(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });

const fail = (msg, status = 400) => json({ error: msg }, status);

async function pbkdf2(password, saltBytes, rounds) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: rounds, hash: "SHA-256" },
    key,
    256
  );
  return b64uEncode(bits);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signToken(payload, secret) {
  const head = b64uEncode(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64uEncode(enc.encode(JSON.stringify(payload)));
  const data = head + "." + body;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data));
  return data + "." + b64uEncode(sig);
}

async function verifyToken(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const data = parts[0] + "." + parts[1];
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), b64uDecode(parts[2]), enc.encode(data));
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64uDecode(parts[1])));
  } catch (e) {
    return null;
  }
  if (!payload || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function randHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

const normEmail = e => String(e || "").trim().toLowerCase();

function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

function cleanUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    nickname: u.nickname,
    role: u.role,
    banned: !!u.banned,
    banned_reason: u.banned_reason || null,
    created_at: u.created_at
  };
}

function weekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
}

const dayKey = d => d.toISOString().slice(0, 10);

/* ---------------- 榜单读写 ---------------- */

async function readList(kv, key) {
  const raw = await kv.get(key);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

async function upsertBoard(kv, key, entry) {
  const arr = await readList(kv, key);
  const i = arr.findIndex(x => x.user_id === entry.user_id);
  if (i >= 0) {
    if (entry.score > arr[i].score) {
      arr[i].score = entry.score;
      arr[i].last = entry.last;
    }
    arr[i].nickname = entry.nickname;
  } else {
    arr.push(entry);
  }
  arr.sort((a, b) => b.score - a.score);
  await kv.put(key, JSON.stringify(arr.slice(0, MAX_LB)));
}

async function renameInBoards(kv, uid, nickname) {
  const today = dayKey(new Date());
  const keys = ["lb:all", "lb:week:" + weekKey(new Date()), "lb:day:" + today];
  for (const k of keys) {
    const arr = await readList(kv, k);
    let hit = false;
    for (const row of arr) {
      if (row.user_id === uid) { row.nickname = nickname; hit = true; }
    }
    if (hit) await kv.put(k, JSON.stringify(arr));
  }
}

/* ---------------- 主处理 ---------------- */

export async function handle(request, ctx) {
  const kv = ctx.kv;
  const env = ctx.env || {};
  const secret = env.AUTH_SECRET || "";

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS"
      }
    });
  }

  const withCors = res => {
    const h = new Headers(res.headers);
    h.set("Access-Control-Allow-Origin", "*");
    return new Response(res.body, { status: res.status, headers: h });
  };

  try {
    if (!kv) {
      return fail("KV 存储没有绑定。EdgeOne 需要在控制台创建命名空间并绑定为 EB_KV；Cloudflare 需要绑定 KV 命名空间到 EB_KV。", 500);
    }
    if (!secret) {
      return fail("缺少环境变量 AUTH_SECRET，请在项目设置里添加一个随机字符串。", 500);
    }

    const body = async () => {
      try { return await request.json(); } catch (e) { return {}; }
    };

    const currentUser = async () => {
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token) return null;
      const payload = await verifyToken(token, secret);
      if (!payload) return null;
      const raw = await kv.get("u:" + payload.uid);
      if (!raw) return null;
      return JSON.parse(raw);
    };

    const requireUser = async () => {
      const u = await currentUser();
      if (!u) return { error: fail("未登录或登录已过期", 401) };
      return { user: u };
    };

    const requireAdmin = async () => {
      const r = await requireUser();
      if (r.error) return r;
      if (r.user.role !== "admin") return { error: fail("需要管理员权限", 403) };
      return r;
    };

    /* ---- 注册 ---- */
    if (path === "/api/register" && method === "POST") {
      const b = await body();
      const email = normEmail(b.email);
      const password = String(b.password || "");
      const nickname = String(b.nickname || "").trim() || email.split("@")[0];

      if (!validEmail(email)) return fail("邮箱格式不对");
      if (password.length < 6) return fail("密码至少 6 位");
      if (nickname.length > 16) return fail("昵称最多 16 个字");

      if (await kv.get("ue:" + email)) return fail("这个邮箱已经注册过了", 409);

      const uid = crypto.randomUUID ? crypto.randomUUID() : randHex(16);
      const salt = new Uint8Array(16);
      crypto.getRandomValues(salt);
      const hash = await pbkdf2(password, salt, PBKDF2_ROUNDS);

      // 第一个注册的人自动成为管理员
      const bootstrapped = await kv.get("meta:first");
      const role = bootstrapped ? "player" : "admin";
      if (!bootstrapped) await kv.put("meta:first", uid);

      const user = {
        id: uid,
        email,
        nickname,
        salt: b64uEncode(salt),
        hash,
        role,
        banned: false,
        banned_reason: null,
        created_at: new Date().toISOString()
      };

      await kv.put("u:" + uid, JSON.stringify(user));
      await kv.put("ue:" + email, uid);

      const token = await signToken(
        { uid, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL },
        secret
      );
      return withCors(json({ token, user: cleanUser(user), firstAdmin: role === "admin" }));
    }

    /* ---- 登录 ---- */
    if (path === "/api/login" && method === "POST") {
      const b = await body();
      const email = normEmail(b.email);
      const password = String(b.password || "");

      const uid = await kv.get("ue:" + email);
      if (!uid) return fail("邮箱或密码不对", 401);

      const raw = await kv.get("u:" + uid);
      if (!raw) return fail("邮箱或密码不对", 401);
      const user = JSON.parse(raw);

      const hash = await pbkdf2(password, b64uDecode(user.salt), PBKDF2_ROUNDS);
      if (hash !== user.hash) return fail("邮箱或密码不对", 401);

      if (user.banned) {
        return json({
          error: "这个账号已被封禁",
          banned: true,
          reason: user.banned_reason || null
        }, 403);
      }

      const token = await signToken(
        { uid: user.id, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL },
        secret
      );
      return withCors(json({ token, user: cleanUser(user) }));
    }

    /* ---- 当前用户 ---- */
    if (path === "/api/me" && method === "GET") {
      const r = await requireUser();
      if (r.error) return withCors(r.error);
      return withCors(json({ user: cleanUser(r.user) }));
    }

    /* ---- 改自己的昵称 ---- */
    if (path === "/api/me" && method === "PATCH") {
      const r = await requireUser();
      if (r.error) return withCors(r.error);

      const b = await body();
      const nickname = String(b.nickname || "").trim();
      if (!nickname) return fail("昵称不能为空");
      if (nickname.length > 16) return fail("昵称最多 16 个字");

      const user = r.user;
      user.nickname = nickname;
      await kv.put("u:" + user.id, JSON.stringify(user));
      await renameInBoards(kv, user.id, nickname);

      return withCors(json({ user: cleanUser(user) }));
    }

    /* ---- 榜单 ---- */
    if (path === "/api/leaderboard" && method === "GET") {
      const range = url.searchParams.get("range") || "all";
      const now = new Date();
      const key =
        range === "week" ? "lb:week:" + weekKey(now) :
        range === "day" ? "lb:day:" + dayKey(now) :
        "lb:all";

      const arr = await readList(kv, key);
      return withCors(json({ range, rows: arr.slice(0, 50) }));
    }

    /* ---- 提交成绩 ---- */
    if (path === "/api/score" && method === "POST") {
      const r = await requireUser();
      if (r.error) return withCors(r.error);
      if (r.user.banned) return fail("账号已被封禁，无法提交成绩", 403);

      const b = await body();
      const score = Math.max(0, Math.min(1000000, parseInt(b.score, 10) || 0));
      const win = b.win ? 1 : 0;
      const now = new Date();
      const last = now.toISOString();

      const entry = { user_id: r.user.id, nickname: r.user.nickname, score, last };

      await upsertBoard(kv, "lb:all", entry);
      await upsertBoard(kv, "lb:week:" + weekKey(now), entry);
      await upsertBoard(kv, "lb:day:" + dayKey(now), entry);

      // 个人累计
      const rawBest = await kv.get("b:" + r.user.id);
      const best = rawBest ? JSON.parse(rawBest) : { best: 0, games: 0, wins: 0 };
      best.best = Math.max(best.best || 0, score);
      best.games = (best.games || 0) + 1;
      best.wins = (best.wins || 0) + win;
      best.last = last;
      await kv.put("b:" + r.user.id, JSON.stringify(best));

      return withCors(json({ ok: true, best }));
    }

    /* ---- 管理：用户列表 ---- */
    if (path === "/api/admin/users" && method === "GET") {
      const r = await requireAdmin();
      if (r.error) return withCors(r.error);

      const list = await kv.list({ prefix: "u:", limit: 200 });
      const users = [];
      for (const k of list.keys || []) {
        const raw = await kv.get(k.name);
        if (raw) users.push(cleanUser(JSON.parse(raw)));
      }
      users.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      return withCors(json({ users }));
    }

    /* ---- 管理：改名 / 封禁 ---- */
    if (path === "/api/admin/user" && method === "PATCH") {
      const r = await requireAdmin();
      if (r.error) return withCors(r.error);

      const b = await body();
      const id = String(b.id || "");
      if (!id) return fail("缺少用户 id");

      const raw = await kv.get("u:" + id);
      if (!raw) return fail("用户不存在", 404);
      const user = JSON.parse(raw);

      if (b.nickname !== undefined) {
        const nickname = String(b.nickname).trim();
        if (!nickname) return fail("昵称不能为空");
        if (nickname.length > 16) return fail("昵称最多 16 个字");
        user.nickname = nickname;
        await renameInBoards(kv, id, nickname);
      }

      if (b.banned !== undefined) {
        if (id === r.user.id && b.banned) return fail("不能封禁自己");
        user.banned = !!b.banned;
        user.banned_at = b.banned ? new Date().toISOString() : null;
        user.banned_reason = b.banned ? (String(b.reason || "").trim() || null) : null;
      }

      await kv.put("u:" + id, JSON.stringify(user));
      return withCors(json({ user: cleanUser(user) }));
    }

    return fail("接口不存在：" + method + " " + path, 404);
  } catch (e) {
    return withCors(fail("服务器错误：" + (e && e.message ? e.message : String(e)), 500));
  }
}
