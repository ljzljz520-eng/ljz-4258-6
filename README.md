# 发酵乳记录平台（SolidJS PWA + Node/Fastify + PostgreSQL + IndexedDB）

该系统记录发酵乳生产事实并在服务端执行授权：罐卡与 pH 曲线用于追溯，不给出接种量建议，也不直接控制冷却设备。

## 1. 核心边界

### 离线只能形成“事实”，不能完成在线授权

IndexedDB 和设备端可离线保存：

- 温度/pH 读数：`sourceId + seq` 是来源内幂等键；
- 时钟校准锚点：同时保留 `deviceTime`、`referenceTime`、`driftMs`；
- 人工观察事实：例如“某账号在 observedAt 看到接种”，必须携带联网时领取的离线票券与 HMAC；
- 补录时间：记录事件发生的 `observedAt`，服务端另记 `receivedAt`，不覆盖设备原始 `observedAt`。

离线端不能自己决定：

- 两个签名是否来自不同账号；
- 两人是否分别具备 `operator` 与 `quality` 资格；
- 绑定的菌种、批次版本是否仍为当前版本；
- 证据水位是否足够；
- 冲突是否关闭；
- 是否允许接种状态机进入 `inoculated`。

同一账号连续点击只会产生一个有效确认；伪造第二人会生成冲突事实并进入“待协调”。本地 UI 还要求退出并登录另一账号，防止同一界面连点。

## 2. 状态机

- 菌种 `culture`：`received -> quarantined <-> released -> voided`；换签 `sign_version` 递增，状态事件不冒充换签版本。
- 奶基 `milk`：`received -> released -> consumed`；建批成功时追加 `milk.consumed` 谱系事件。
- 接种：`not_authorized -> one_person -> confirmed -> inoculated / aborted`。
- 冷却：`not_started -> started -> completed / aborted`。
- 灌装：`not_started -> completed / aborted`（开始事件只用于记录现场观察，最终仍由完成事件转移）。
- 批次：`created -> inoculated -> cooling -> cooled -> filled / aborted`。

冲突确认不静默丢弃，而追加 `reconciliation.opened`；主管处理前，服务端拒绝接种签发。

## 3. 证据水位

每个设备来源使用全局单调序号；批次用建批时绑定的起始序号计算连续证据窗口：

```text
批次窗口 startSeq=100：

收到 100,101 => 计数 2
先收到 101   => 计数 0，等待晚到的 100
之后收到 100 => 计数 2
重复收到 100 => 幂等忽略，不改变值或水位
```

建批时为每个来源配置 `startSeq + minCount` 证据窗口；温度和 pH 的来源序号全局单调，不同批次绑定不同起始序号。签发接口由后端重新计算该窗口内连续证据数。

## 4. 快速开始

```bash
npm install
cp .env.example .env

# 内存模式（无需 PostgreSQL；重启不保留数据）
npm start
# 另一个终端
npm run dev:web
npm run simulate
```

### PostgreSQL

```bash
docker compose up -d postgres
export DATABASE_URL=postgres://ferment:ferment@localhost:5432/ferment_records
npm run migrate
npm start
```

演示账号令牌：

| 角色 | 令牌 |
|---|---|
| operator | `demo-operator` |
| quality | `demo-quality` |
| supervisor | `demo-supervisor` |

演示设备令牌：`ingest-temp-001`、`ingest-ph-001`。

## 5. 常用脚本

```bash
npm run dev:server     # API 开发模式
npm run dev:web        # Solid/Vite PWA
npm run build          # 类型检查 + PWA 构建
npm test               # 内存存储与事件重放测试
npm run migrate         # 执行 PostgreSQL 迁移
npm run simulate        # happy path 设备/双人/晚到 pH 模拟
SCENARIO=culture-change npm run simulate
SCENARIO=double-click npm run simulate
```

设备模拟器会：注册/放行菌种和奶基、建批、发送时钟锚点、先发送本批次 pH 窗口的第二个序号后发送起始序号、重复发送起始序号、领取两张不同账号离线票券，并尝试签发及后续冷却/灌装。

## 6. API 摘要

- `POST /auth/login`：换发会话令牌；
- `POST /auth/offline-ticket`：在线签发离线事实票券；
- `GET /state`：状态、读数、锚点、设备、用户；
- `POST /commands`：在线授权命令；
- `POST /sync`：批量提交锚点、读数、在线/离线命令，逐项返回结果；
- `POST /device/clock-anchor`：设备时钟锚点；
- `POST /device/readings`：单条设备读数；
- `GET /batches/:id`：罐卡详情、读数、锚点与水位；
- `GET /batches/:id/issue-readiness`：解释后端阻断原因。

所有冲突返回机器可读 `error.code` 与中文说明，前端罐卡展示“后端阻断原因”和待协调项。

## 7. 测试覆盖

`npm test` 覆盖：

1. 完整菌种/奶基/接种/冷却/灌装状态机；
2. 同账号双点不能成为第二人；
3. 晚到 pH 与缺口水位；
4. 重复同步 anchor/reading/confirmation 的幂等性；
5. 菌种换签后旧版本确认进入待协调；
6. 时钟漂移锚点和原始采集时间保留；
7. 两个并发改批请求，一个成功、旧版本失败；
8. 事件日志重放恢复状态、冲突和阻断记录。

设置 `RUN_PG_INTEGRATION=1 DATABASE_URL=... npm run test:integration` 可在真实 PostgreSQL 上运行集成标记。

## 8. 目录

```text
server/            Fastify API、领域状态机、事件存储、设备模拟器
server/db/...      PostgreSQL 迁移
web/src/db.ts      IndexedDB 离线队列
web/src/api.ts     API/HMAC/离线票券
web/src/index.tsx  Solid PWA：罐卡、pH 曲线、阻断解释、离线采集
tests/             Node test 套件
scripts/migrate.ts SQL 迁移执行器
```

## 9. 安全与运维注意

演示令牌仅供本地开发。生产环境应换成：集中身份认证、短寿命访问令牌、设备证书、TLS、审计导出和票券撤销策略。即便设备被攻破，伪造离线事实最终仍必须通过服务端的账号、票券、版本、状态机、证据水位和冲突检查；但被攻破设备可产生无效垃圾事实，因此需要设备准入和监控。
