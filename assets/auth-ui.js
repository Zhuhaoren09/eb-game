/* ==========================================================
   登录 / 注册 界面
   在任意页面放一个 <div id="authNav"></div>，引入本文件即可。
   未登录显示「登录 / 注册」，登录过则自动保持登录态。
   ========================================================== */
(function () {
  const A = window.Auth;
  if (!A) return;

  let state = { session: null, profile: null };

  /* ---------------- 弹窗 ---------------- */
  let mask = null;

  function buildModal() {
    if (mask) return mask;

    mask = document.createElement("div");
    mask.className = "auth-mask";
    mask.innerHTML = `
      <div class="auth-box" role="dialog" aria-modal="true">
        <button class="modal-close" data-close aria-label="关闭">×</button>
        <div class="auth-tabs">
          <button data-mode="login" class="on">登录</button>
          <button data-mode="register">注册</button>
        </div>
        <form id="authForm" autocomplete="on">
          <label class="field">
            <span>邮箱</span>
            <input type="email" name="email" required placeholder="you@example.com" autocomplete="email">
          </label>
          <label class="field reg-only">
            <span>昵称</span>
            <input name="nickname" maxlength="16" placeholder="榜上显示的名字" autocomplete="nickname">
          </label>
          <label class="field">
            <span>密码</span>
            <input type="password" name="password" required minlength="6" placeholder="至少 6 位" autocomplete="current-password">
          </label>
          <button class="btn btn-primary auth-submit" type="submit">登录</button>
        </form>
        <p class="auth-msg" id="authMsg"></p>
        <p class="auth-hint" id="authHint"></p>
      </div>`;
    document.body.appendChild(mask);

    let mode = "login";

    const form = mask.querySelector("#authForm");
    const msg = mask.querySelector("#authMsg");
    const hint = mask.querySelector("#authHint");
    const submit = mask.querySelector(".auth-submit");

    function setMode(next) {
      mode = next;
      mask.querySelectorAll(".auth-tabs button").forEach(b =>
        b.classList.toggle("on", b.dataset.mode === next));
      mask.classList.toggle("register", next === "register");
      submit.textContent = next === "login" ? "登录" : "注册并登录";
      form.password.autocomplete = next === "login" ? "current-password" : "new-password";
      msg.textContent = "";
      msg.className = "auth-msg";
      hint.textContent = "";
    }

    mask.querySelectorAll(".auth-tabs button").forEach(btn => {
      btn.addEventListener("click", () => setMode(btn.dataset.mode));
    });

    mask.querySelector("[data-close]").addEventListener("click", close);
    mask.addEventListener("click", e => { if (e.target === mask) close(); });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && mask.classList.contains("open")) close();
    });

    form.addEventListener("submit", async e => {
      e.preventDefault();
      msg.textContent = "";
      msg.className = "auth-msg";

      const email = form.email.value.trim();
      const password = form.password.value;
      const nickname = (form.nickname.value || "").trim();

      if (!email || !password) return;
      if (password.length < 6) {
        msg.className = "auth-msg bad";
        msg.textContent = "密码至少 6 位。";
        return;
      }

      submit.disabled = true;
      const label = submit.textContent;
      submit.textContent = "请稍候…";

      try {
        if (mode === "login") {
          await A.signIn(email, password);
          location.reload();
        } else {
          const r = await A.signUp(email, password, nickname);
          if (r.signedIn) {
            location.reload();
          } else {
            msg.className = "auth-msg ok";
            msg.textContent = "注册成功，需要去邮箱点确认链接后才能登录。";
            setMode("login");
          }
        }
      } catch (err) {
        const t = String(err.message || "");
        msg.className = "auth-msg bad";
        if (/already|registered|exists/i.test(t)) {
          msg.textContent = "这个邮箱已经注册过了，直接登录即可。";
          setMode("login");
        } else if (/invalid|credentials|grant/i.test(t)) {
          msg.textContent = "邮箱或密码不对。";
        } else if (/confirm/i.test(t)) {
          msg.textContent = "邮箱还没验证，去收件箱点一下确认链接。";
        } else {
          msg.textContent = t || "出错了，稍后再试。";
        }
      } finally {
        submit.disabled = false;
        submit.textContent = label;
      }
    });

    return mask;
  }

  function open(mode) {
    buildModal();
    mask.classList.add("open");
    mask.classList.remove("register");
    const btn = mask.querySelector('.auth-tabs button[data-mode="' + (mode || "login") + '"]');
    if (btn) btn.click();
  }

  function close() {
    if (mask) mask.classList.remove("open");
  }

  /* ---------------- 封禁提示 ---------------- */
  function showBanned(reason) {
    const el = document.createElement("div");
    el.className = "banned-mask";
    el.innerHTML = `
      <div class="banned-box">
        <div class="banned-glyph">⛔</div>
        <h2>这个账号已被封禁</h2>
        <p>${reason ? "原因：" + reason : "你暂时无法参与对局记录与讨论。"}</p>
        <button class="btn btn-ghost" id="bannedOut">退出登录</button>
      </div>`;
    document.body.appendChild(el);
    el.querySelector("#bannedOut").addEventListener("click", async () => {
      await A.signOut();
      location.reload();
    });
  }

  /* ---------------- 顶栏 ---------------- */
  function mount() {
    const slot = document.getElementById("authNav");
    if (!slot) return;

    if (!state.session) {
      slot.innerHTML = `<button class="auth-btn" id="authOpen">登录 / 注册</button>`;
      slot.querySelector("#authOpen").addEventListener("click", () => open("login"));
      return;
    }

    const p = state.profile || {};
    const name = p.nickname || (state.session.user.email || "").split("@")[0];
    const isAdmin = p.role === "admin";

    slot.innerHTML = `
      <div class="user-menu">
        <button class="user-chip" id="userChip">
          <span class="avatar sm">${(name || "?").slice(-1)}</span>
          <span class="user-name">${name}</span>
          ${isAdmin ? '<span class="badge-admin">管理</span>' : ""}
          <span class="caret">▾</span>
        </button>
        <div class="user-drop" id="userDrop">
          ${isAdmin ? '<a href="admin.html">管理台</a>' : ""}
          <a href="forum.html">讨论区</a>
          <button id="btnSignOut">退出登录</button>
        </div>
      </div>`;

    const chip = slot.querySelector("#userChip");
    const drop = slot.querySelector("#userDrop");
    chip.addEventListener("click", e => {
      e.stopPropagation();
      drop.classList.toggle("open");
    });
    document.addEventListener("click", () => drop.classList.remove("open"));
    slot.querySelector("#btnSignOut").addEventListener("click", async () => {
      await A.signOut();
      location.reload();
    });
  }

  async function boot() {
    try {
      state.session = await A.session();
      if (state.session) {
        state.profile = await A.profile();
        if (state.profile && state.profile.banned) {
          document.body.style.overflow = "hidden";
          showBanned(state.profile.banned_reason);
        }
      }
    } catch (e) {
      state.session = null;
    }
    mount();
  }

  window.AuthUI = { boot: boot, open: open, state: () => state };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
