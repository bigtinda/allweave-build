# 1.2.1 运行时自主化与适配计划

状态：阶段 0–2 完成，阶段 3 待开始
开始日期：2026-11-04
目标版本：1.2.1
范围：模型层、MCP 层、工具沙箱层的契约化与依赖替换评估
非目标：打包安装器、发布、远程沙箱、远程工作区、增加 CLI

## 1. 目标与约束

用户要求（2026-11-04）：

- 全部产品内容按本项目自主开发维护，不再以 Pi 分支/插件生态的形式出现。
- 保留工具沙箱并嵌入项目，不引入远程执行方案。
- 版本从 1.2.1 起步。
- 打包由用户完成，本计划不执行 `npm run build`、安装器构建或发布。
- 模型、MCP、沙箱可以使用成熟现成方案，但必须封装到完全适配当前项目。
- 先完成计划、阶段 0（审计）、阶段 1（契约）、阶段 2（候选 spike），再替换代码。

硬约束：

- 内核路径保持单进程；不增加运行时依赖到 `packages/kernel`。
- `packages/kernel` 只依赖 `@allweave/protocol` 与 Node 标准库。
- 模型、MCP、沙箱的第三方类型不得越过 `packages/kernel-adapters`。
- 沙箱中的脚本只能调用显式注入的只读工具，不能直接访问文件系统、网络、进程或环境变量。
- 不保留“为了兼容旧版本”的双实现；替换失败用提交回滚，不用长期运行开关。

## 2. 阶段 0：审计结果

### 2.1 当前工作树

基线提交：`3367eb869 fix(agent): forward session id to provider routing`

工作树包含上一轮 1.2.1 改名与清理，尚未提交：

| 类型 | 数量 |
|---|---:|
| 删除 | 327 |
| 修改 | 107 |
| 重命名 | 363 |
| 重命名并删除 | 8 |
| 重命名并修改 | 43 |
| 未跟踪 | 3 |

未跟踪项：

- `.allweave/`：运行时数据，不应提交。
- `packages/model/src/api/allweave-messages.ts`
- `packages/model/src/api/allweave-messages.lazy.ts`

处理要求：阶段 3 第一步把 `.allweave/` 加入 `.gitignore`，并在提交前确认 `git status` 只包含本次计划相关文件。

### 2.2 版本与包

所有 workspace 均为 1.2.1：

`@allweave/{server,web,kernel,kernel-adapters,mcp,model,protocol,sandbox,telemetry}`。

包职责：

| 包 | 职责 | 是否允许依赖第三方运行时 |
|---|---|---|
| `packages/kernel` | 会话、循环、上下文、工具、存储 | 否（Node 标准库除外） |
| `packages/kernel-adapters` | 模型、MCP、沙箱适配 | 是，仅在此层 |
| `packages/model` | 模型协议、provider、认证、目录 | 是 |
| `packages/mcp` | MCP 客户端、传输、OAuth | 是 |
| `packages/sandbox` | QuickJS + Worker 沙箱 | 是 |
| `packages/protocol` | 共享协议类型 | 否 |
| `packages/telemetry` | 模型层遥测类型 | 否 |

### 2.3 残留 Pi 标识

产品源码已无 `@earendil-works/*` 或 `@pi-console/*` 引用。剩余匹配只在：

- `scripts/check-kernel-boundaries.mjs` 的禁止列表，作为防回归守卫保留。
- 本地未提交目录 `.pi/`、`.pi-console/`，不是产品源码。
- `package-lock.json` 的旧 extraneous 条目仍需清理。

以下 Pi 时代内容仍需在阶段 3 处理：

- `.github/workflows/{build-binaries,env,env-daemons,ci}.yml` 仍包含旧发布/守护进程路径。
- `.pi/skills/` 与 `AGENTS.md` 中仍有旧工作流说明。
- `pi-test.bat`、`pi-test.sh`、`desktop/compile-installer.ps1`、旧 issue 模板。
- `packages/model/src/utils/pi-user-agent.ts` 文件名，以及 `packages/model/test/pi-messages.test.ts` 文件名。
- `apps/server/src/mcp/config.ts` 仍从 `<cwd>/.pi/mcp.json` 读取项目级 MCP 配置，应改为 `.allweave/mcp.json`。
- `.gitignore` 只忽略 `.pi-console/`，未忽略 `.allweave/`。

### 2.4 验证基线

| 项目 | 状态 |
|---|---|
| `npm run check` | 通过（改名与清理后执行） |
| kernel + kernel-adapters + server 测试 | 通过（server 50，adapters 6 通过/1 跳过） |
| `packages/model` 测试 | 未确认，命令此前没有返回可用输出，阶段 6 必须重跑 |
| `./test.sh` | 未执行 |
| `npm run build` | 未执行（按用户要求不打包） |

## 3. 阶段 1：契约冻结

详细接口见 [2026-11-04-runtime-contracts.md](2026-11-04-runtime-contracts.md)。

三个端口：

1. `ModelPort`：一个请求返回一个异步事件流；只暴露 `Native*` 类型、规范化 usage 与错误。
2. `McpPort`：连接、列工具、调用工具、关闭；不把 MCP SDK 的 client/transport 类型带出适配层。
3. `SandboxPort`：执行一段 JavaScript，返回文本/结构化值或规范化错误；超时、内存、取消由宿主控制。

边界规则：

- `NativeModelGateway` 继续由 kernel 定义，`ModelGateway` 实现它，不新增并行的模型抽象。
- MCP 适配层实现 `McpToolClient`，`createMcpNativeTools` 保持不变；底层客户端可替换。
- 沙箱适配层继续用 `CodemodeSandbox`，只稳定 `SandboxPort`，不重写执行模型。
- 错误在端口边界规范化，kernel 不解析 provider/SDK 错误文本。

验收：

- 契约文档中的每个字段都能在当前代码中找到对应类型或明确的映射。
- 新适配器可以只依赖端口类型实现，不需要修改 kernel。
- 安全不变量有对应测试项。

## 4. 阶段 2：候选 spike 结论

详细对比见 [2026-11-04-runtime-candidates.md](2026-11-04-runtime-candidates.md)。

| 层 | 决策 | 理由 |
|---|---|---|
| 模型 | 保留 `packages/model` + `ModelGateway`，只做契约封装 | 现有实现已覆盖多 provider、OAuth、Bedrock、usage/cost、thinking；迁移到通用 SDK 的适配成本高，收益低 |
| MCP | 主选官方 `@modelcontextprotocol/client@2.4.0`，回退 `@modelcontextprotocol/sdk@1.32.2` | 官方维护、协议完整、stdio/HTTP/OAuth 齐全；v2 是当前稳定线，v1 作为低风险回退 |
| 沙箱 | 保留 `quickjs-wasi@3.6.2` + `node:worker_threads` | 已嵌入、已验证、MIT；`quickjs-emscripten` 需要重写 host bridge，收益不足 |

阶段 2 只做桌面研究、API 对照和适配面估算，没有安装候选依赖，避免污染 lockfile。运行时验证放到阶段 3，用本地 fake server / 沙箱测试完成。

## 5. 阶段 3：MCP 适配器替换

预计 2–3 天。

步骤：

1. 在 `packages/mcp` 内新增官方 SDK 适配，不改公开导出；保留 `McpClient` 外观，内部改为官方 client/transport。
2. 先接 stdio，再接 Streamable HTTP，最后接 OAuth；每一步用本地测试服务器验证。
3. 把当前 `apps/server/src/mcp/config.ts` 的项目配置路径从 `.pi/mcp.json` 改为 `.allweave/mcp.json`，并保留 agent 级配置。
4. 映射内容块：text/image/audio/resource/resource_link 到当前 `ContentBlock`；未知类型降级为文本并记录诊断。
5. 映射错误：连接、协议、HTTP、OAuth、超时、取消；保持 `McpManager` 的“单服务器失败不影响其他服务器”行为。
6. 删除被替换的内部协议/传输实现，只保留仍在使用的类型和 OAuth helper；不保留双实现。
7. 增加测试：stdio 握手、工具列表、工具调用、HTTP 头、OAuth 未授权、服务器崩溃、关闭幂等。

验收：

- `createMcpManager` 的调用方零改动。
- 本地 stdio 与 HTTP MCP 服务器均能列出并调用工具。
- 连接失败产生诊断，不抛穿整个会话。
- `npm run check` 通过，MCP 相关测试通过。

回退：如果 v2 在 OAuth 或传输行为上无法在 2 天内达到现状，切到 v1.32.2；仍不保留双实现。

## 6. 阶段 4：沙箱加固

预计 1–2 天。

不改执行模型，只补边界：

1. 明确 `SandboxPort` 的输入/输出与错误类型，适配层不再向调用方抛原始 QuickJS 错误。
2. 校验超时、内存上限、abort 三条路径都能终止 worker 并释放资源。
3. 校验嵌套工具只能调用传入的只读工具；写工具在构造阶段被过滤。
4. 校验返回值只允许 JSON 可序列化值；循环引用、函数、Symbol 返回明确错误。
5. 校验大输出截断发生在适配层还是工具层，避免双截断。
6. 增加测试：无限循环、内存炸弹、abort、工具抛错、工具返回非 JSON、worker 启动失败、wasm 缺失。

验收：

- 恶意脚本不能读文件、发网络请求或访问 `process`。
- 超时/内存/取消均在一个时间窗内结束，worker 不泄漏。
- `createCodemodeNativeTool` 的调用方零改动。

## 7. 阶段 5：模型层契约封装

预计 0.5–1 天。

1. 把 `ModelGateway` 的 provider 类型、usage、错误映射集中到 `packages/kernel-adapters/src/model/`。
2. kernel 只依赖 `NativeModelGateway`；不在 kernel 中出现 `Api`、`Model`、provider 名称。
3. 统一错误分类：`auth`、`rate_limit`、`context_length`、`network`、`aborted`、`provider`；保留可重试标记。
4. 统一 usage：input/output/cacheRead/cacheWrite/total/cost；缺失字段保持 `undefined`，不伪造 0。
5. 不替换 `packages/model`；Vercel AI SDK 只记录为后续候选。

验收：

- `rg '@allweave/model' packages/kernel` 为空。
- gateway 单测覆盖文本、thinking、tool call、usage、abort、provider 错误。

## 8. 阶段 6：完整验证与文档

预计 1 天。

命令：

```bash
npm run check
./test.sh
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts  # 按包补充
```

验收：

- `npm run check` 全部通过。
- `./test.sh` 0 fail；跳过项有原因。
- `packages/model` 测试有明确结果。
- MCP stdio/HTTP/OAuth、沙箱超时/内存/取消、模型错误映射均有测试。
- `docs/ARCHITECTURE.md` 与计划文档一致，不出现旧 Pi 运行时描述。
- 版本保持 1.2.1；不生成安装包。
- 提交信息使用 `fix(server): ...` / `refactor(kernel-adapters): ...` 等格式，只暂存本计划相关文件。

## 9. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 工作树已有大量未提交改名 | 难以区分本次改动 | 阶段 3 前先提交 1.2.1 改名基线，或至少用 `git diff --stat` 记录 |
| MCP v2 API 与现有自定义客户端差异大 | 适配超期 | 2 天时间盒，失败切 v1.32.2 |
| OAuth 行为回归 | 远程 MCP 不可用 | 先保留现有 OAuth helper，只替换传输/客户端；单独测试未授权与刷新 |
| 沙箱 worker 资源泄漏 | 长期运行内存增长 | 每次执行后强制 terminate，测试重复执行 100 次 |
| 模型层错误映射改变 UI 行为 | 错误提示退化 | 保留原始 message，只增加分类字段 |
| 旧 `.pi` 本地目录被误提交 | 仓库污染 | `.gitignore` 加 `.allweave/`，提交前 `git status` 检查 |

## 10. 完成定义

阶段 0–2 完成的标准：

- 本计划、契约文档、候选评估文档已写入 `docs/plans/`。
- 审计数据来自当前工作树，不是历史文档。
- 三个端口的字段、错误、生命周期、安全不变量可执行。
- MCP/沙箱/模型均有明确选择和回退方案。

阶段 3–6 完成的标准：

- 代码只通过端口使用第三方能力。
- 无 `@earendil-works/*`、`@pi-console/*` 产品引用。
- 检查、测试、文档全部通过。
- 版本 1.2.1，未打包。
