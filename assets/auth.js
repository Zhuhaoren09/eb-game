/* ==========================================================
   认证 / 接口 客户端
   所有请求打同源的 /api/*，由 EdgeOne 或 Cloudflare 的
   Functions 处理，前端不需要知道后端跑在哪个平台。

   令牌保存在 localStorage，打开页面自动恢复登录态。
   ========================================================== */
(function () {
  const STORE = "eb.token";

  const getToken = () => { try { return localStorage.getItem(STORE) || ""; } catch (e) { return ""; } };
  const setToken = t => { try { localStorage.setItem(STORE, t); } catch (e) {} };
  const clearToken = () => { try { localStorage.removeItem(STORE); } catch (e) {} };

  let cached = null;

  async function api(path, opts) {
    opts = opts || {};
    const headers = { "Content-Type": "application/json" };
    const t = getToken();
    if (t && opts.auth !== false) headers.Authorization = "Bearer " + t;

    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    });

    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = { error: text }; } }

    if (!res.ok) {
      const err = new Error((data && data.error) || ("请求失败 HTTP " + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function session() {
    if (cached) return cached;
    if (!getToken()) return null;
    try {
      const d = await api("/api/me");
      cached = { token: getToken(), user: d.user };
      return cached;
    } catch (e) {
      if (e.status === 401) { clearToken(); cached = null; }
      return null;
    }
  }

  async function signUp(email, password, nickname) {
    const d = await api("/api/register", {
      method: "POST",
      body: { email: email, password: password, nickname: nickname }
    });
    setToken(d.token);
    cached = { token: d.token, user: d.user };
    return { signedIn: true, user: d.user, firstAdmin: !!d.firstAdmin };
  }

  async function signIn(email, password) {
    const d = await api("/api/login", {
      method: "POST",
      body: { email: email, password: password }
    });
    setToken(d.token);
    cached = { token: d.token, user: d.user };
    return d.user;
  }

  async function signOut() {
    clearToken();
    cached = null;
  }

  async function profile() {
    const s = await session();
    return s ? s.user : null;
  }

  // 清掉本地缓存，重新拉一次（改名后用）
  async function refresh() {
    cached = null;
    return profile();
  }

  const getLeaderboard = (range) =>
    api("/api/leaderboard?range=" + (range || "all"), { auth: false });

  const submitScore = (score, win) =>
    api("/api/score", { method: "POST", body: { score: score, win: win } });

  const renameMe = (nickname) =>
    api("/api/me", { method: "PATCH", body: { nickname: nickname } });

  const adminUsers = () => api("/api/admin/users");

  const adminUpdate = (id, patch) =>
    api("/api/admin/user", { method: "PATCH", body: Object.assign({ id: id }, patch) });

  window.Auth = {
    unconfigured: false,
    api: api,
    session: session,
    signUp: signUp,
    signIn: signIn,
    signOut: signOut,
    profile: profile,
    refresh: refresh,
    getLeaderboard: getLeaderboard,
    submitScore: submitScore,
    renameMe: renameMe,
    adminUsers: adminUsers,
    adminUpdate: adminUpdate
  };
})();
