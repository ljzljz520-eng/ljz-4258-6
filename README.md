# 发酵乳记录平台（SolidJS PWA + Node.js + PostgreSQL）

面向发酵乳生产的记录与授权系统：前端以罐卡显示批次状态和 pH 曲线，支持 IndexedDB 离线采集；Node.js/Fastify API 管理批次、事件和双签；PostgreSQL 保存身份、事件谱系、来源水位、校准锚点与待协调项。无 PostgreSQL 时默认使用本地嵌入式 PGlite，便于演示与测试。

## 能力清单

- **SolidJS PWA**：罐卡总览、批次详情、SVG pH 曲线、离线队列、Service Worker、Web Manifest。
- **明确状态机**：
  - 菌种：`staged → released → consumed/quarantined`，`quarantined ↔ released`。
  - 奶基：`prepared → verified → consumed/rejected`。
  - 接种：`not_started → awaiting_signatures → issued/cancelled`。
  - 冷却：`warm → cooling → cooled`。
  - 灌装：`not_filled → filling → filled`。
  - 批次版本冲突或证据阻断时进入 `reconcile_required`。
- **双签接种**：两个不同账号、相同 `batch_version` 与 `culture_version_id`，后端在第二签时实时复查资格与证据。
- **离线边界**：温度/pH 和点击行为可离线记事实；接种签发及状态推进必须在线授权。离线两次点击不能冒充双签。
- **设备序号与时钟**：温度/pH 按 `source_id/source_seq` 同步与去重；校准锚点记录设备时钟与服务端时钟差；保留原始 `collected_at`，另存 `corrected_collected_at`。
- **谱系**：批次版本、菌种换签、事件、授权日志、协调处理和签名均入库。
- **冲突处理**：重复不同内容、序号冲突、缺口、证据不足、并发旧版本写入进入待协调或返回明确阻断码。
- **不做工艺控制**：不推荐接种量，不自动控制冷却，只做记录、校验和授权。

## 快速开始

```bash
npm install
cp .env.example .env

# 方式 A：使用嵌入式 PGlite（无需外部数据库）
npm run migrate
npm run seed
npm run dev:api      # http://localhost:8787
npm run dev          # Solid PWA http://localhost:5173

# 方式 B：PostgreSQL
docker compose up -d
DATABASE_URL=postgres://ferment:ferment@localhost:5432/fermented_milk npm run migrate
DATABASE_URL=postgres://ferment:ferment@localhost:5432/fermented_milk npm run seed
DATABASE_URL=postgres://ferment:ferment@localhost:5432/fermented_milk npm run dev:api
npm run dev
```

演示账号：

| 账号 | 密码 | 权限 |
|---|---|---|
| alice | alice123 | 操作员，可接种签字 |
| bob | bob123 | 班长，可接种签字 |
| carol | carol123 | 见习，无接种资格 |
| admin | admin123 | 管理员 |

典型双签：使用 Alice 登录打开批次点“在线接种确认”，登出后使用 Bob 登录再次确认。两次必须是不同有效账号。

## 设备模拟

```bash
npm run simulate          # 迁移、播种、校准、读数、重复同步、晚到 pH
npm run simulate -- --loop
```

模拟器会：

1. 为温度/pH 来源写入不同时钟漂移锚点；
2. 写入温度和 pH 序号；
3. 重复发送同一 pH 事件，验证幂等；
4. 发送晚到 pH，验证不覆盖事实且按来源序号排序。

## 主要 API

- `POST /auth/login`
- `GET /batches` / `POST /batches` / `GET /batches/:id`
- `PATCH /batches/:id`：换绑菌种/奶基，乐观锁 `expected_version`。
- `POST /batches/:id/commands`：`ready|start_cooling|complete_cooling|start_filling|complete_filling`。
- `POST /batches/:id/readings`：在线接收单个温度/pH 事实。
- `POST /batches/:id/inoculation/confirm`：在线接种签名/触发签发检查。
- `POST /sync`：批量上传 IndexedDB 读数和离线提案。
- `GET /coordination` / `POST /coordination/:id/resolve`
- `POST /sources/:id/calibrations`
- `GET/POST /strains`、`GET/POST /milk-bases` 及其 `transition`

阻断码会返回给前端并翻译为操作解释，例如 `SAME_ACCOUNT`、`UNQUALIFIED`、`BATCH_VERSION_CONFLICT`、`INSUFFICIENT_EVIDENCE`、`OFFLINE_CANNOT_ISSUE`。

## 数据模型与迁移

迁移文件：`src/db/migrations/001_init.sql`，包含：

- 身份与会话：`users`, `sessions`
- 批次谱系：`batches`, `batch_versions`
- 物料：`strain_versions`, `milk_bases`
- 设备：`sources`, `calibration_anchors`, `source_watermarks`
- 不可丢事实：`events`
- 双签：`inoculation_confirmations`
- 冲突：`coordination_items`
- 审计：`authorization_log`

生产 PostgreSQL 使用 `DATABASE_URL`；本地无数据库时 PGlite 将数据放在 `.data/pglite`。

## 测试

```bash
npm test
npm run typecheck
npm run build
```

测试覆盖：

1. 重复同步幂等；
2. 菌种换签导致旧版本签名失效；
3. 晚到 pH 与来源序号缺口；
4. 同账号两次点击不能双签、无资格账号被阻断；
5. 两名不同合格账号满足证据后在线签发；
6. 两人基于同一版本并发改批的乐观锁冲突；
7. 证据水位不足时进入待协调；
8. 使用持久 PGlite 目录验证关闭/重启后身份和批次仍存在。

边界说明见 [`docs/boundary.md`](docs/boundary.md)。
