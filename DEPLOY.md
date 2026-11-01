# 部署说明

站点是纯静态页面 + 一份同源的后端接口。同一套代码可以跑在两个平台上：

| 平台 | 函数目录 | KV 绑定方式 |
|---|---|---|
| 腾讯云 EdgeOne Pages | `edge-functions/api/[[default]].js` | KV 是**全局变量** `EB_KV` |
| Cloudflare Pages | `functions/api/[[path]].js` | KV 挂在 **`context.env.EB_KV`** |

两边的业务逻辑都在根目录的 `api-core.js` 里，一份代码，两个入口只做适配。

---

## 一、部署到 EdgeOne Pages

### 1. 创建项目

1. 打开 https://console.tencentcloud.com/edgeone ，切到 **Makers** 标签
2. 创建项目，选 **直接上传**（后续也可以换成 Git 部署）
3. 加速区域选**中国大陆**（国内最快；绑自有域名时需要备案）或**全球**
4. 把 `site/` 目录**里面的内容**全部拖进去，`index.html` 要在最外层
5. 点开始部署

> 如果部署后 `/api/xxx` 返回 404，说明这个项目不支持直接上传函数，
> 把同一份 `site/` 推到 GitHub 仓库，改用**导入 Git 仓库**的方式创建项目即可。

### 2. 开通 KV 存储

1. 控制台 → **KV 存储** → 申请开通（免费额度 1GB）
2. **创建命名空间**，例如 `eb-kv`
3. 进入命名空间 → **关联项目** → 选中刚建的项目
4. 绑定时的**变量名必须填 `EB_KV`**（代码里就是按这个名字取的）

### 3. 配置密钥

项目 → 设置 → **环境变量** → 新增：

| 变量名 | 值 |
|---|---|
| `AUTH_SECRET` | 一串随机字符串，至少 32 位，自己生成，不要外传 |

生成办法：在任意命令行执行

```bash
openssl rand -hex 32
```

没有 openssl 就随便敲 40 多个字母数字，别用「123456」这种。

### 4. 验证

打开站点 → 右上角注册一个账号 → 回到首页看排行榜。
**第一个注册的账号自动成为管理员**，登录后用户菜单里会出现「管理台」。

---

## 二、部署到 Cloudflare Pages

### 1. 建 KV 命名空间

Workers & Pages → KV → Create namespace，名字随意，例如 `eb-kv`。

### 2. 建 Pages 项目

Workers & Pages → Create → Pages → Upload assets，把 `site/` 里的内容拖进去。

> 注意：拖拽上传的项目**不会执行 `functions/` 目录**。
> 要用 Cloudflare 的后端，必须用 **Git 连接**部署（`functions/` 只对 Git 部署生效）。

### 3. 绑定

- Settings → Functions → KV namespace bindings：变量名 `EB_KV`，选中刚建的命名空间
- Settings → Environment variables：`AUTH_SECRET` = 你的随机串，类型选 **Encrypt**

### 4. 重新部署

改完绑定要重新部署一次才生效。

---

## 三、接口一览

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | `/api/register` | 注册，返回令牌 | 公开 |
| POST | `/api/login` | 登录，返回令牌 | 公开 |
| GET | `/api/me` | 当前用户 | 登录 |
| PATCH | `/api/me` | 改自己的昵称 | 登录 |
| GET | `/api/leaderboard?range=all\|week\|day` | 榜单，最多 50 条 | 公开 |
| POST | `/api/score` | 提交一局成绩 `{score, win}` | 登录且未封禁 |
| GET | `/api/admin/users` | 玩家列表 | 管理员 |
| PATCH | `/api/admin/user` | 改名 / 封禁 `{id, nickname?, banned?, reason?}` | 管理员 |

认证方式：请求头 `Authorization: Bearer <token>`，令牌有效期 7 天。

---

## 四、数据存在哪

KV 里的键位：

| 键 | 内容 |
|---|---|
| `ue:{邮箱}` | 邮箱 → 用户 id |
| `u:{uid}` | 用户记录（含密码哈希、角色、封禁状态） |
| `b:{uid}` | 个人最高分与累计局数 |
| `lb:all` | 总榜数组 |
| `lb:week:{年-周}` | 周榜 |
| `lb:day:{日期}` | 日榜 |
| `meta:first` | 是否已有第一个用户（初始化管理员用） |

密码用 PBKDF2-SHA256 加盐哈希，**不存明文**。令牌用 HMAC-SHA256 签名。

---

## 五、已知限制

**1. 榜单是「读-改-写」。** KV 没有原子操作，两个人同时提交成绩时，后写的可能覆盖先写的。玩家数量少（几十人）基本不会撞，人多之后要把榜单换成真正的事务型数据库。

**2. KV 是最终一致。** EdgeOne 的 KV 全球同步最多 60 秒，刚提交的成绩可能不会立刻出现在别人那边。

**3. 封禁不是即时踢线。** 令牌在 7 天内仍然有效，被封的人做任何写操作会被拒绝，但要等令牌过期才会彻底登出。

**4. 密码哈希迭代次数压到 6 万次。** 因为边缘函数单次 CPU 只有 200ms，标准推荐值（几十万次）会超时。安全性够用，但不是最优。

**5. 日榜/周榜的键会一直累积。** 每天新增 1~2 个键，一年几百个，1GB 免费额度完全够，但不会自动清理。
