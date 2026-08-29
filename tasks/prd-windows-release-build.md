# PRD: GitHub Actions 打包 Windows 版并发布到 Release

## 1. 概述 / Introduction

「晓·乐舞艺术空间」是一个 Electron 桌面应用，目前只能在开发机上 `npm start` 运行。本功能给它加一条**手动触发的发布流水线**：在 GitHub 网页上点一下「Run workflow」，CI 就用 [electron-builder](https://www.electron.build/) 在 Windows runner 上打出 **x64 安装包（NSIS `.exe`）和免安装版（portable `.exe`）**，并自动创建一个已发布的 GitHub Release，把两个安装包和校验和挂上去，用户直接在 Release 页面下载。

打个比方：现在交付软件像「把源代码抄给对方自己编译」；这条流水线让交付变成「点一下按钮，货架上就摆出打包好的成品，附下载地址」。

面向读者：初级开发或 AI agent 均可据此实现。应用不做代码签名，Windows SmartScreen 首次运行会提示「未知发布者」，属预期。

## 2. 目标 / Goals

- 一次手动操作（GitHub Actions「Run workflow」），无需本地 Windows 环境，即可产出可分发的 Windows x64 安装包
- 每次发布同时产出 **NSIS 安装包** 与 **portable 免安装 `.exe`** 两种形态
- 产物自动挂到一个**已发布**的 GitHub Release，页面即下载地址
- 每个安装包提供 SHA-256 校验和
- 除仓库自带的 `GITHUB_TOKEN` 外，不需要配置任何 secret

## 3. 用户故事 / User Stories

### US-001: 应用图标与 electron-builder 打包配置
**Description:** 作为开发者，我需要 electron-builder 的配置与一个 Windows 图标，以便本地/CI 都能打出 Windows 安装包。

**Acceptance Criteria:**
- [ ] `electron-builder` 加入 `devDependencies` 并锁定主版本；`npx electron-builder --version` 能打印版本号
- [ ] 存在打包配置（`electron-builder.yml` 或 `package.json` 的 `build` 字段），含 `appId`、`productName`、`artifactName`
- [ ] `artifactName` 为纯 ASCII，产物名形如 `dance-studio-Setup-<version>-x64.exe` 与 `dance-studio-Portable-<version>-x64.exe`
- [ ] 配置的 `files` 白名单只含运行时资源：`dist/**`、`index.html`、`placeholder.html`、`colors_and_type.css`、`package.json`；不含 `src/`、`tests/`、`ui_kits/`、`tasks/`、`scripts/`、`.github/`
- [ ] `directories.output` 设为 `release/`（不与 tsc 的 `dist/` 冲突），且 `release/` 已加入 `.gitignore`
- [ ] 存在 `build/icon.ico`，尺寸 ≥ 256×256，Windows 配置引用它
- [ ] 新增 npm 脚本 `dist:win`：先 `npm run build` 再对 Windows x64 跑 electron-builder
- [ ] Typecheck / lint 通过

### US-002: workflow_dispatch 手动触发 Windows x64 打包
**Description:** 作为发布者，我想在 Actions 页面手动触发一个 workflow，让它在 Windows runner 上打出安装包并可从该次运行下载。

**Acceptance Criteria:**
- [ ] 新增 `.github/workflows/release-windows.yml`，**只**由 `workflow_dispatch` 触发，可在 Actions 页面看到「Run workflow」按钮
- [ ] 有一个可选输入 `version`；留空时使用 `package.json` 的 `version` 字段
- [ ] 提供了非 semver 的 `version` 时，job 在打包前失败并打印原因
- [ ] job 运行在 `windows-latest`，Node 版本取 `.nvmrc`（22）
- [ ] 打包前依次执行 `npm ci` → `npm run lint` → `npm run typecheck` → `npm run build`，任一失败即终止
- [ ] 执行 `electron-builder --win nsis portable --x64 --publish never`
- [ ] 运行成功后，该次运行的 Artifacts 里有 `*-Setup-*-x64.exe` 和 `*-Portable-*-x64.exe` 两个文件，大小均 > 0
- [ ] job summary 列出这两个产物的文件名、字节大小、SHA-256
- [ ] Blocked by US-001

### US-003: 创建带安装包的已发布 GitHub Release
**Description:** 作为用户，我想在一个 GitHub Release 页面直接下载 Windows 安装包和校验和。

**Acceptance Criteria:**
- [ ] workflow 解析版本：用 `version` 输入，缺省回退到 `package.json` 的 `version`
- [ ] workflow 在触发所用的 commit 上创建 Git tag `v<version>`
- [ ] workflow 创建一个**已发布（非 draft）**的 Release，标题 `v<version>`，附件为两个 `.exe` 和 `SHA256SUMS.txt`
- [ ] `SHA256SUMS.txt` 每行是 `<sha256>  <文件名>`，覆盖两个 `.exe`
- [ ] Release 正文包含两个安装包的下载条目，以及「应用未签名，Windows SmartScreen 首次运行可能提示未知发布者」的说明
- [ ] 当 tag 或 Release `v<version>` 已存在时，job 以非零退出失败并指明冲突，且不修改已存在的 Release
- [ ] workflow 仅用内置 `GITHUB_TOKEN`，`permissions` 声明 `contents: write`，无需额外 secret
- [ ] 运行成功后 `gh release view v<version>` 显示 3 个附件（2 exe + 校验和文件）
- [ ] Blocked by US-002

### US-004: 发布流水线的端到端测试
**Description:** 作为 QA 工程师，我想要一条自动化端到端校验，覆盖「触发 → 打包 → 建 Release → 产物可用」的完整链路以及关键失败路径。

**Acceptance Criteria:**
- [ ] E2E 用一个一次性预发布版本号触发（形如 `0.0.0-ci.<run_number>`），全流程在 CI 中执行并通过
- [ ] 发布后自动校验：通过 `gh api` 拉取该 Release，断言恰好包含 `*-Setup-<v>-x64.exe`、`*-Portable-<v>-x64.exe`、`SHA256SUMS.txt` 三个附件，且每个大小 > 0
- [ ] 下载 portable `.exe`，重新计算 SHA-256 并断言与 `SHA256SUMS.txt` 一致
- [ ] 冒烟：在 windows runner 上启动打包后的 portable `.exe`（用 Playwright `_electron` 指定 `executablePath`），断言主窗口标题为 `晓·乐舞艺术空间 · 管理中心`，随后关闭
- [ ] 失败路径：对一个已存在 Release 的版本号再次触发，断言 job 失败且该 Release 未被改动
- [ ] 测试自带清理：结束时删除这条一次性预发布的 tag 与 Release，可重复运行

## 4. 功能需求 / Functional Requirements

- FR-1: 系统必须将 `electron-builder` 加入 `devDependencies` 并锁定主版本
- FR-2: 系统必须提供 electron-builder 配置，指定 `appId`、`productName` 与纯 ASCII 的 `artifactName`
- FR-3: electron-builder 的 `files` 必须只包含 `dist/**`、`index.html`、`placeholder.html`、`colors_and_type.css`、`package.json`
- FR-4: electron-builder 的 `files` 必须排除 `src/`、`tests/`、`ui_kits/`、`tasks/`、`scripts/`、`.github/`
- FR-5: electron-builder 的 `directories.output` 必须为 `release/`
- FR-6: 系统必须把 `release/` 加入 `.gitignore`
- FR-7: 系统必须提供 `build/icon.ico`，尺寸不小于 256×256
- FR-8: Windows 构建配置必须引用该 `.ico` 作为应用图标
- FR-9: 系统必须提供 npm 脚本 `dist:win`，先执行 TypeScript 构建再执行 Windows x64 的 electron-builder
- FR-10: Windows 构建必须产出一个 NSIS 安装包 `.exe`
- FR-11: Windows 构建必须产出一个 portable `.exe`
- FR-12: 两个 Windows 产物架构必须均为 x64
- FR-13: 系统必须提供一个 GitHub Actions workflow，仅由 `workflow_dispatch` 触发
- FR-14: 该 workflow 必须提供可选输入 `version`
- FR-15: `version` 输入为空时，workflow 必须使用 `package.json` 的 `version` 字段
- FR-16: `version` 输入非 semver 时，workflow 必须在打包前使 job 失败
- FR-17: 该 workflow 必须运行在 `windows-latest` runner 上
- FR-18: 该 workflow 必须在打包前依次执行 `npm ci`、`npm run lint`、`npm run typecheck`、`npm run build`，任一失败即终止 job
- FR-19: 该 workflow 必须执行 `electron-builder --win nsis portable --x64`
- FR-20: 该 workflow 必须将两个 `.exe` 作为 workflow artifact 上传到该次运行
- FR-21: 该 workflow 必须生成 `SHA256SUMS.txt`，含每个 `.exe` 的 SHA-256
- FR-22: 该 workflow 必须在触发所用 commit 上创建 Git tag `v<version>`
- FR-23: 该 workflow 必须创建一个非 draft 的 GitHub Release，标题为 `v<version>`
- FR-24: 该 Release 必须附带两个 `.exe` 与 `SHA256SUMS.txt`
- FR-25: 该 Release 正文必须包含两个安装包的下载条目
- FR-26: 该 Release 正文必须包含应用未签名、SmartScreen 可能告警的说明
- FR-27: 当 tag 或 Release `v<version>` 已存在时，workflow 必须以非零退出失败且不修改已存在的 Release
- FR-28: 该 workflow 必须只使用内置 `GITHUB_TOKEN`，并声明 `permissions: contents: write`
- FR-29: 该 workflow 的 job summary 必须列出每个已发布附件的文件名、字节大小与 SHA-256

## 5. 非目标 / Non-Goals (Out of Scope)

- 代码签名 / EV 证书 / 公证 —— 产物以未签名形式发布
- 自动更新（electron-updater / `latest.yml` 分发）
- macOS 与 Linux 打包
- arm64 / ia32(32 位) Windows 构建
- MSI、AppX、Squirrel.Windows、winget 清单
- 发布到 GitHub Releases 之外的任何商店或 CDN
- 由 CI 把版本号回写提交到 `main`
- 增量更新 / blockmap（除 electron-builder 默认产出外不额外处理）
- 自动生成 changelog / release notes 正文（正文用固定模板 + 下载表）

## 6. 设计考量 / Design Considerations

- 打包配置放在 `electron-builder.yml`（[Assumption]），保持 `package.json` 精简
- `productName` 可用中文「晓·乐舞艺术空间」；`artifactName` 固定 ASCII：`dance-studio-Setup-${version}-x64.${ext}` / `dance-studio-Portable-${version}-x64.${ext}`
- `build/icon.ico`：用品牌方块（accent 红圆角 + 火花标记，与顶栏 `.xhs-mark` 一致）现做一版占位图标（[Assumption]），后续设计可替换
- Release 正文用固定模板：标题、两个下载链接、SHA-256、未签名说明
- 现有 `.github/workflows/e2e.yml`（Linux）继续作为 PR 门禁，本 workflow 仅用于发布

## 7. 技术考量 / Technical Considerations

- `scripts/ensure-electron.js`（postinstall）会在 Windows runner 上 `npm ci` 时拉取 win32 版 Electron 二进制
- 项目当前无生产 `dependencies`，electron-builder 打出的包体只有 Electron 运行时 + 我方文件
- electron-builder 的 GitHub 发布用 `GH_TOKEN=${{ secrets.GITHUB_TOKEN }}`，需 `permissions: contents: write`；也可改为 `--publish never` + 显式 `gh release create`（实现时择一，行为需满足 FR-22~FR-27）
- Node 22（`.nvmrc` / `engines`）
- 版本漂移：`package.json` 的 `version` 为缺省来源；输入高于它时不回写（见待确认）
- US-004 的打包冒烟用 Playwright `_electron.launch({ executablePath })` 指向 portable `.exe`

## 8. 成功指标 / Success Metrics

- 从点「Run workflow」到出现可下载的已发布 Release：单次手动操作，无需本地构建
- 两个 `.exe` 在干净的 Windows 10/11 x64 机器上都能安装/运行并进入首页
- workflow 单次运行 10 分钟内完成
- 除默认 token 外零 secret 配置

## 9. 待确认问题 / Open Questions

- workflow 是否应把 `package.json` 版本号回写 `main`（通过 PR），还是长期接受「tag 即事实来源」？
- Release 建为已发布还是先 draft 供人工确认？（PRD 现假设已发布）
- 除 `SHA256SUMS.txt` 外，是否也产出 electron-builder 的 `latest.yml` 以备将来自动更新？
- 发布流水线是否也在 Windows runner 上跑完整 Playwright E2E，还是 lint+typecheck+build + 打包冒烟即足够？
- 图标：现在就做一版品牌 `.ico`，还是先用 Electron 默认图标占位到设计给图为止？
