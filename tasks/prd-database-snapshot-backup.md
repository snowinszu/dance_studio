# PRD: 数据库快照备份

## Introduction / Overview

这是一个 Electron 桌面应用，所有业务数据（学员、考勤、课程、库存）都存在**一个 SQLite 文件**里：`{userData}/dance-studio.db`（WAL 模式，运行时还带 `-wal` / `-shm` 两个伴生文件）。目前应用**没有任何备份机制**——文件损坏、误操作清空、迁移出错、磁盘故障，任何一种都会造成数据不可逆丢失。

本功能给应用加一套**自动 + 手动的快照备份**：

- **自动**：每个使用日在应用启动时自动生成一份经过完整性校验的快照；每次数据库结构迁移之前，额外生成一份「迁移前里程碑」快照。
- **手动**：新增一个「设置 / 数据备份」页，用户可随时点击「立即备份」，也可以「另存一份到指定目录」（U 盘 / 网盘），以及「打开备份目录」。
- **恢复**：本期**不做**程序化恢复。设置页提供「打开备份目录」入口和一段手动恢复步骤说明；随附一份 `docs/backup-and-restore.md` 文档。

技术要点：备份一律走 SQLite 的在线备份能力（`better-sqlite3` 的 `db.backup()`，迁移前里程碑用 `VACUUM INTO`），**绝不直接 `fs.copyFile` 活动中的 `.db` 文件**——WAL 模式下那样会漏数据或拷到撕裂的文件。

面向读者：初级开发者 / AI agent。名词已在上文解释。

## Goals

- 每个使用日（应用启动时）自动产出至少一份**通过 `PRAGMA quick_check` 校验**的数据库快照
- 每次结构迁移前，先产出一份「迁移前里程碑」快照，且该快照通过完整性校验
- 用户可在「设置 / 数据备份」页手动触发备份，并看到结果（文件路径 + 大小 + 时间）
- 用户可把一份快照另存到自选目录（除默认备份目录外再拷一份）
- 用户可一键打开备份目录所在文件夹
- 备份文件按数量轮换（默认保留最近 20 份日常快照），「迁移前里程碑」快照永久保留
- 备份 / 恢复失败时有明确的错误提示，不静默失败、不抛未捕获异常
- 提供手动恢复的书面步骤（应用内说明 + `docs/backup-and-restore.md`）

## User Stories

### US-001: 备份核心模块（`src/db/backup.ts`）
**Description:** As a developer, I want 一个不依赖 Electron API、可单测的备份核心模块, so that 快照的生成、校验、轮换逻辑有单一可靠的实现，且能在单元测试里验证口径。

**Acceptance Criteria:**
- [ ] 新增 `src/db/backup.ts`，导出以下函数（入参显式传目录 / 路径，不在模块内读 `app.getPath`）：
  - [ ] `createSnapshot(opts: { dir: string; tag?: string }): Promise<SnapshotMeta>` —— 用 `getDb().backup(tmpPath)` 写到 `<final>.tmp`；成功后以只读连接打开 `.tmp` 跑 `PRAGMA quick_check`，结果非 `'ok'` 则删除 `.tmp` 并抛错；通过则读 `PRAGMA user_version`，再 `fs.renameSync(.tmp, final)`（同盘原子替换）
  - [ ] `createMilestoneSnapshot(opts: { dir: string; version: number }): SnapshotMeta` —— 用 `db.exec("VACUUM INTO '<tmpPath>'")` 生成，同样先写 `.tmp`、校验、原子改名；`tag` 固定为 `premigrate-v<version>`
  - [ ] `listSnapshots(dir: string): SnapshotMeta[]` —— 读目录内 `dance-studio-*.db`，按创建时间倒序；每项含 `name` / `path` / `bytes` / `createdAt`（ISO 字符串）/ `kind`（`'daily' | 'milestone'`，由文件名是否含 `-premigrate-v` 判定）
  - [ ] `pruneSnapshots(opts: { dir: string; keep: number }): string[]` —— 仅对 `kind==='daily'` 的快照按创建时间倒序保留最近 `keep` 份，其余删除并返回被删路径数组；`kind==='milestone'` 的一律不删
- [ ] 文件名规则：日常 `dance-studio-YYYYMMDD-HHmm.db`；里程碑 `dance-studio-YYYYMMDD-HHmm-premigrate-vN.db`（本地时间）
- [ ] `dir` 不存在时 `createSnapshot` / `createMilestoneSnapshot` 先 `fs.mkdirSync(dir, { recursive: true })`
- [ ] `SnapshotMeta` 类型定义在 `src/shared/types.ts`（或现有类型文件），主进程与渲染进程共用
- [ ] 关键逻辑（为何写 `.tmp` 再改名、为何不能 copy 活动库、`VACUUM INTO` 会持读锁）在代码里以「为什么」为主的注释说明，复杂块加块首概述
- [ ] 新增 `tests/unit/backup.test.ts`（`node:test`）：用 `STUDIO_DB_PATH` 指向临时库，断言：
  - [ ] `createSnapshot` 产出的文件能被独立打开且行数与源库一致
  - [ ] 源库故意写坏后（或对空库）`quick_check` 仍为 `ok` 的正常路径；`.tmp` 不残留
  - [ ] `listSnapshots` 正确区分 `daily` / `milestone` 并按时间倒序
  - [ ] `pruneSnapshots({ keep: 3 })` 在有 5 份日常 + 2 份里程碑时，只删 2 份最旧日常，里程碑全留
- [ ] `npm run typecheck && npm run lint && npm run test:unit` 通过

### US-002: 启动自动备份 + 迁移前里程碑
**Description:** As a 管理者, I want 应用每次启动时自动留存当日快照、并在任何结构升级前留存里程碑, so that 我不需要记得手动备份，出事也总有一个「升级前」的干净还原点。

**Acceptance Criteria:**
- [ ] `src/main.ts` 的 `initDatabase()` 中，解析备份目录为 `path.join(app.getPath('userData'), 'backups')`，并按 `connection.ts` 同款写法用可选链兜底测试环境（`app?.getPath`）
- [ ] **迁移前里程碑**：`getDb()` 后、`runMigrations(db)` **之前**，若 `PRAGMA user_version < LATEST_VERSION`，调用 `createMilestoneSnapshot({ dir, version: LATEST_VERSION })` 并 **await / 同步等其完成** 再迁移；里程碑失败时记录 `console.error` 并弹 `dialog.showErrorBox`，但**不阻断**迁移与启动
- [ ] **每日快照**：`runMigrations` 成功后，若 `listSnapshots(dir)` 中不存在「创建时间在最近 24 小时内的 `daily` 快照」，则调用 `createSnapshot({ dir })`；已有则跳过
- [ ] 每日快照成功后调用 `pruneSnapshots({ dir, keep: 20 })`
- [ ] 自动备份 / 轮换过程中的任何异常都被 `try/catch` 兜住，只 `console.error`，不影响窗口创建；控制台无未捕获异常
- [ ] 每日快照相关判断（「最近 24 小时内是否已有 daily 快照」）有单元测试：`tests/unit/backup-schedule.test.ts` 或并入 `backup.test.ts`，构造不同 mtime 的假快照文件断言「应备 / 应跳过」
- [ ] `npm run typecheck && npm run lint && npm run test:unit` 通过
- [ ] 应用内验证（`run` skill）：删空 `{userData}/backups/` 后启动应用，目录下出现一份 `dance-studio-*.db`；立刻再次重启，**不**新增第二份（24h 内跳过）

### US-003: 备份 IPC 频道 + preload 暴露 + 类型
**Description:** As a developer, I want 渲染进程能通过 `studioShell.backup.*` 调用备份能力, so that 设置页的按钮可以触发主进程的备份逻辑并拿到结构化结果。

**Acceptance Criteria:**
- [ ] `src/ipc/channels.ts` 新增分组：`backupCreate: 'backup:create'`、`backupList: 'backup:list'`、`backupReveal: 'backup:reveal'`、`backupCreateToFolder: 'backup:createToFolder'`
- [ ] `src/ipc/register.ts` 用现有 `handle()` 包装注册四个频道：
  - [ ] `backup:create` —— 无入参，调用 `createSnapshot({ dir: <userData>/backups })`，返回 `SnapshotMeta`
  - [ ] `backup:list` —— 无入参，返回 `SnapshotMeta[]`
  - [ ] `backup:reveal` —— 无入参，`fs.mkdirSync` 兜底后 `shell.openPath(backupDir)`（或 `shell.showItemInFolder` 定位最近一份），返回 `{ dir }`
  - [ ] `backup:createToFolder` —— 无入参：先 `dialog.showOpenDialog({ properties: ['openDirectory'] })`；取消则抛 `AppError('IO_CANCELLED', ...)`；否则先 `createSnapshot({ dir: 默认 backups })`，再把该文件 `fs.copyFile` 到用户所选目录（跨盘用 copy 不用 rename），返回 `{ primary: SnapshotMeta, copiedTo: string }`
- [ ] 备份失败统一走 `AppError`：磁盘写失败 → `IO_WRITE_FAILED`；完整性校验未过 → 新增错误码 `BACKUP_VERIFY_FAILED`（在 `src/ipc/errors.ts` 注册）；均带可读中文 message
- [ ] `src/preload.ts` 暴露 `studioShell.backup.create()` / `.list()` / `.reveal()` / `.createToFolder()`，签名与返回类型与频道一致
- [ ] `studioShell.d.ts` 补 `backup` 命名空间的完整类型（含 `SnapshotMeta`）
- [ ] `npm run typecheck && npm run lint` 通过；`npm run test:unit` 通过（现有用例不回归）

### US-004: 「设置 / 数据备份」页 + 首页入口 + 备份列表 + 立即备份
**Description:** As a 管理者, I want 一个能看到所有备份、并能一键立即备份的页面, so that 我能确认数据有在被备份，并在关键操作前主动留档。

**Acceptance Criteria:**
- [ ] 新增 `settings.html` + `settings.js`，`<head>` 链接 `colors_and_type.css`；页面结构 copy 自 `ui_kits/app/index.html` 模板，顶部导航与 `index.html` 一致
- [ ] `index.html` 增加进入设置页的入口：顶部导航右侧新增「设置」链接（`href="settings.html"`，带 `data-od-id`），不新增 `.js` 文件即可（沿用 index 内联脚本或纯 `<a>`）
- [ ] 设置页含「数据备份」区块，展示 `studioShell.backup.list()` 结果的列表：每行显示创建时间（本地可读格式）、大小（如 `2.4 MB`）、类型徽章（`日常` / `迁移前`）
- [ ] 列表为空时显示占位文案「暂无备份记录」
- [ ] 「立即备份」按钮：点击后禁用并显示进行中态 → 调 `studioShell.backup.create()` → 成功后 toast / 行内提示「已备份到 <路径>」并刷新列表；失败显示 `unwrap` 出的错误 message，按钮恢复可用
- [ ] `window.studioShell` / `studioShell.backup` 不存在，或 IPC 返回 `ok:false`，或 `unwrap` 抛错时：页面显示错误态文案，控制台无未捕获异常
- [ ] 遵循项目设计规则：不用裸 hex（一律 `var(--token)`）；hover 态不降低文字对比度；`--accent` 每屏最多出现两次
- [ ] 响应式：移动端向上扩展；列表在窄屏不横向溢出（必要时容器内滚动）；交互控件触控尺寸达标
- [ ] `npm run typecheck && npm run lint` 通过
- [ ] 在浏览器 / 应用中验证（`run` skill）：设置页能打开、列表能加载、「立即备份」后新增一行

### US-005: 另存到指定目录 + 打开备份目录 + 手动恢复说明
**Description:** As a 管理者, I want 把备份另存到 U 盘/网盘，并知道万一要还原该怎么操作, so that 本机磁盘坏了也有异地副本，且我能自助恢复。

**Acceptance Criteria:**
- [ ] 设置页「数据备份」区块新增「打开备份目录」按钮：调 `studioShell.backup.reveal()`，成功后系统文件管理器打开 `{userData}/backups/`
- [ ] 新增「另存一份到…」按钮：调 `studioShell.backup.createToFolder()` → 系统目录选择框 → 成功后提示「已另存到 <所选目录>」并刷新列表；用户取消选择时无错误 toast、按钮恢复可用
- [ ] 设置页展示一段「如何手动恢复」说明：关闭应用 → 打开备份目录 → 备份当前 `dance-studio.db` → 用某份快照替换 `dance-studio.db` → 删除同目录的 `dance-studio.db-wal` / `dance-studio.db-shm` → 重新打开应用（结构会自动迁移到最新版）
- [ ] 新增 `docs/backup-and-restore.md`：写明备份目录位置（各平台 `userData` 路径）、自动备份触发时机、文件名含义（日常 vs 迁移前）、逐步的手动恢复步骤、常见问题（快照打不开怎么办、想回滚结构版本怎么办）
- [ ] `npm run typecheck && npm run lint` 通过
- [ ] 在应用中验证（`run` skill）：「打开备份目录」能打开文件夹；「另存一份到…」选一个目录后，该目录出现一个 `dance-studio-*.db` 且能被 SQLite 工具打开

### US-006: 数据库快照备份端到端测试
**Description:** As a QA engineer, I want 一个覆盖「备份全链路」的自动化端到端测试, so that 「启动自动备份 → IPC → 设置页手动备份 → 列表刷新」这条链路的回归能被捕获。

**Acceptance Criteria:**
- [ ] 在 `tests/e2e/backup-flow.spec.ts` 新增用例（Playwright `_electron`，独立临时 `STUDIO_DB_PATH`，备份目录随之落在临时 `userData`，自建自清）
- [ ] happy path：首次启动后断言临时备份目录中已生成 ≥1 份 `dance-studio-*.db`；打开 `settings.html`，断言列表至少 1 行且类型徽章可见
- [ ] 手动备份：点击「立即备份」→ 断言列表行数 +1、出现成功提示、磁盘上对应新增一个文件
- [ ] 完整性：读取任意一份生成的快照文件，用 better-sqlite3 打开跑 `PRAGMA quick_check`，断言结果为 `ok` 且表结构与主库一致
- [ ] 边界/失败路径：把备份目录设为不可写（或 mock `createSnapshot` 抛 `BACKUP_VERIFY_FAILED`）→ 点击「立即备份」→ 断言页面显示错误提示、无 `pageErrors`、按钮恢复可用
- [ ] 测试在 CI 通过，独立可重复

## Functional Requirements

- FR-1: 系统必须新增 `src/db/backup.ts`，提供 `createSnapshot` / `createMilestoneSnapshot` / `listSnapshots` / `pruneSnapshots` 四个函数。
- FR-2: `createSnapshot` 必须通过 `better-sqlite3` 的 `db.backup()` 生成快照，不得对活动中的 `.db` 文件做文件系统复制。
- FR-3: `createMilestoneSnapshot` 必须通过 `VACUUM INTO` 生成快照。
- FR-4: 每次生成快照，系统必须先写入 `<final>.tmp`，以只读连接对其执行 `PRAGMA quick_check`。
- FR-5: 当 `quick_check` 结果不为 `ok` 时，系统必须删除 `.tmp` 并以 `BACKUP_VERIFY_FAILED` 报错，不得产出正式快照文件。
- FR-6: 当 `quick_check` 通过时，系统必须记录该快照的 `PRAGMA user_version`，并以原子 `rename` 将 `.tmp` 转为正式文件。
- FR-7: 日常快照文件名必须为 `dance-studio-YYYYMMDD-HHmm.db`（本地时间）。
- FR-8: 里程碑快照文件名必须为 `dance-studio-YYYYMMDD-HHmm-premigrate-vN.db`（本地时间，N 为目标结构版本）。
- FR-9: 应用启动时，在 `runMigrations` 之前，若 `user_version < LATEST_VERSION`，系统必须先生成一份里程碑快照并等其完成。
- FR-10: 里程碑快照生成失败时，系统必须提示用户但不得阻断迁移与应用启动。
- FR-11: 应用启动完成迁移后，若最近 24 小时内不存在 `daily` 类型快照，系统必须自动生成一份日常快照。
- FR-12: 生成日常快照后，系统必须执行轮换：`daily` 类型仅保留最近 20 份，其余删除。
- FR-13: 轮换必须永久保留所有 `milestone` 类型快照，不受数量上限约束。
- FR-14: 所有自动备份与轮换逻辑必须被异常捕获包裹，失败时仅记录日志，不得使应用启动失败或抛出未捕获异常。
- FR-15: 系统必须提供 `backup:create` IPC 频道，触发一次日常快照并返回其元数据。
- FR-16: 系统必须提供 `backup:list` IPC 频道，返回备份目录内全部快照的元数据（含类型、大小、创建时间）。
- FR-17: 系统必须提供 `backup:reveal` IPC 频道，在系统文件管理器中打开备份目录。
- FR-18: 系统必须提供 `backup:createToFolder` IPC 频道：弹出目录选择框，生成一份日常快照，并将其额外复制到用户所选目录。
- FR-19: 用户在目录选择框中取消时，`backup:createToFolder` 必须返回 `IO_CANCELLED` 且前端不显示为错误。
- FR-20: 系统必须通过 `preload.ts` 暴露 `studioShell.backup.create/list/reveal/createToFolder`，并在 `studioShell.d.ts` 提供对应类型。
- FR-21: 系统必须新增 `settings.html` + `settings.js`，`<head>` 链接 `colors_and_type.css`，结构基于 `ui_kits/app/index.html` 模板。
- FR-22: `index.html` 顶部导航必须新增指向 `settings.html` 的「设置」入口。
- FR-23: 设置页必须展示备份列表，每行显示创建时间、文件大小、类型徽章（`日常` / `迁移前`）；无数据时显示占位文案。
- FR-24: 设置页必须提供「立即备份」按钮，点击后进入进行中态，完成后刷新列表并提示结果路径，失败时显示错误 message。
- FR-25: 设置页必须提供「打开备份目录」按钮，调用 `backup:reveal`。
- FR-26: 设置页必须提供「另存一份到…」按钮，调用 `backup:createToFolder`，成功后提示所选目录并刷新列表。
- FR-27: 设置页必须展示手动恢复的分步说明文字。
- FR-28: 当 `window.studioShell` 或 `studioShell.backup` 不可用、或 IPC 返回 `ok:false`、或 `unwrap` 抛错时，设置页必须显示错误态且控制台无未捕获异常。
- FR-29: 系统必须新增 `docs/backup-and-restore.md`，记录备份目录位置、触发时机、文件名含义与手动恢复步骤。
- FR-30: 设置页样式必须遵循项目设计规则：仅用 `var(--token)`、hover 不降对比度、`--accent` 每屏至多两次、移动优先且窄屏不横向溢出。

## Non-Goals (Out of Scope)

- **程序化恢复 / 应用内一键还原**：本期不做。仅提供「打开备份目录」+ 书面步骤，用户手动替换文件。
- **备份列表中选择某份直接恢复**的 UI：不做。
- **压缩 / 加密**快照：不做，快照为明文单文件 `.db`。
- **应用运行期间的定时备份**（如每小时）：不做，仅在启动时与手动时备份。
- **GFS（日/周/月）轮换**：不做，采用简单的「按数量保留最近 N 份」。
- **云端同步 / 自动上传**：不做。
- **备份数据库以外的内容**（配置文件、导出的 xlsx、日志）：不做，仅备份 SQLite 数据库。
- **退出应用时自动备份**：本期不做（列入 Open Questions）。
- **跨版本结构降级 / 回滚工具**：不做；恢复旧快照后由现有迁移自动升级到最新版。

## Design Considerations

- 新页面 `settings.html` 以 `ui_kits/app/index.html` 为起点，顶部导航、页宽、留白与现有各模块页保持一致。
- 备份列表建议用卡片列表或轻量表格；类型徽章复用现有色板令牌（`日常` 用中性色，`迁移前` 用一个 `--cc-*` 强调色，注意 `--accent` 全屏≤2 次）。
- 「立即备份」为页面主操作，可用 `--accent`；「打开备份目录」「另存一份到…」为次级按钮，用描边 / 中性样式。
- 手动恢复说明用可折叠区块或次级信息层级，避免喧宾夺主。
- 首页「设置」入口放在顶部导航右侧（`.nav-right`），与时间显示并列即可，不必做成一张 `app-card`。

## Technical Considerations

- `db.backup()` 是**异步**方法（返回 Promise），只能在**主进程**用 `getDb()` 的句柄调用；`VACUUM INTO` 是同步 `db.exec`，执行期间持一个读锁，因此里程碑快照放在「迁移前、数据库尚空闲」时做，并等其完成再迁移。
- WAL 伴生文件（`-wal` / `-shm`）：`db.backup()` 与 `VACUUM INTO` 都会产出一致的单文件快照，无需手动 checkpoint；恢复时需一并删除目标目录里旧的 `-wal` / `-shm`。
- 原子性：`.tmp` 必须与最终文件同盘，才能用 `fs.renameSync` 原子替换；`backup:createToFolder` 往用户目录那一份可能跨盘，必须用 `fs.copyFile`。
- 备份目录路径依赖 `app.getPath('userData')`；`connection.ts` 已有 `STUDIO_DB_PATH` 覆盖与 `app?.getPath` 兜底写法，测试沿用同一套，把备份目录也重定向到临时目录。
- 复用现有 IPC 骨架：`handle()` 统一信封、`AppError` / `toIpcError` 错误码、`dialog` 选择框；新增错误码 `BACKUP_VERIFY_FAILED` 到 `src/ipc/errors.ts`。
- 遵循全局 Node 规范：TypeScript strict、不引入新的重依赖（`fs` / `path` / `node:` 内置即可）。
- 典型库体量为数 MB～数十 MB，`db.backup()` 一次通常 < 2s；`backup:list` 若对每份文件都跑 `quick_check` 会偏慢，故列表仅读文件元信息，完整性校验只在**生成时**做。

## Success Metrics

- 每个有使用记录的自然日，`{userData}/backups/` 中至少新增一份通过 `quick_check` 的日常快照（24h 内重启不重复生成）。
- 每次 `LATEST_VERSION` 提升后的首次启动，迁移前都存在一份对应的 `premigrate-vN` 快照且校验通过。
- 手动「立即备份」在典型库上于 2 秒内完成并显示成功路径。
- 备份目录中的日常快照数量稳定维持在 ≤ 20（加若干里程碑），无限增长不再发生。
- 一名用户仅凭 `docs/backup-and-restore.md` 即可完成一次手动恢复并成功启动应用（内部走查验证）。

## Open Questions

- 是否需要在应用「正常退出」时再补一份快照，以捕获当天最后状态？（当前列为 Non-Goal）
- 备份列表是否需要显示每份快照的结构版本号（`user_version`）以便用户判断「这份能不能用」？生成时已拿到，展示成本低。
- 手动恢复说明放在设置页内、`docs/` 文档、还是两处都放并保持同步？（当前方案：两处都放）
- 是否需要对备份目录做单实例 / 文件占用保护（用户同时开两个应用实例时）？当前应用未强制单实例。
- `keep: 20` 是否合适，是否需要做成设置项？（当前：写死常量）
