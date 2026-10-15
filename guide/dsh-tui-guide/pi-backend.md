# pi 后端（实验性）

[文档索引](README.md) · [English](pi-backend.en.md) · [多后端架构](agent-backend-design.md)

dsh-TUI 可以作为你本机 [pi](https://github.com/earendil-works/pi) 的前端：界面不变，
会话跑在你自己的 `pi` 上——每个会话一个 `pi --mode rpc` 子进程，经 stdio 上的 JSONL
通信。pi 自己加载设置、模型与登录、扩展、skills、prompt 模板与 `AGENTS.md`；会话文件
与 pi 共用，不需要迁移历史。

> 本文描述当前开发分支，不表示已发布。验证基线为 **pi 0.87.1**，最低 **0.84.4**；
> 其他版本运行时给出 drift 提示。已验证与未验证的范围单列于文末。

## 安装与启动

先按[安装说明](getting-started.md)安装 dsh-TUI，再安装并配置你自己的 pi：

```sh
npm install -g @earendil-works/pi-coding-agent   # 或用 pi.dev 的安装脚本
pi                                               # 在 pi 里 /login 或配置 API key，确认能对话
dsh-tui --backend pi
```

- dsh-TUI 不捆绑 pi，也不依赖 pi 的 SDK 包。默认从 `PATH` 找 `pi`，
  `DSH_TUI_PI_EXECUTABLE` 可指定可执行文件。Windows 上的 npm 包装脚本
  （`pi.cmd`）会解析到 pi 的 JS 入口，用当前 Node 运行。
- 启动页「内核」、会话里的 `/kernel` 或 `/pi` 都能切到 pi；选择会被记住。也可在
  dsh-tui 配置行写 `backend: pi`，或设置 `DSH_TUI_BACKEND=pi`。一个进程只用一个后端，
  切换需要重启。
- 使用你的 pi 目录（`PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`）：settings、
  models、登录、扩展、skills、prompt 模板照常生效。dsh-TUI **不写 pi 的配置**；
  自己的偏好（上次会话、`/color`）保存在 `~/.dsh-tui/backends/pi/prefs.json`。

恢复 pi 或 dsh-TUI 建立的会话：

```sh
dsh-tui --backend pi --resume <session-id>
dsh-tui --backend pi --resume        # 本机 dsh-TUI 最近使用的 pi 会话
pi --session <session-id>            # 换回 pi 自己的界面
```

- 恢复按会话文件路径打开；找不到会话或它记录的工作目录已不存在时明确报错并退出，
  不会悄悄另开新会话。恢复沿用会话记录的工作目录。
- `/resume` 列出 pi 的会话（默认当前项目）。标题优先用 pi 的 `/name`，否则用首条提示。
- 历史回放读 pi 会话文件里当前分支的全部条目：压缩过的早期对话仍然可见，压缩摘要显示为
  检查点。

## 能用什么

| 功能 | 说明 |
| --- | --- |
| 流式回复与思考 | 思考内容显示为思考行 |
| 工具卡 | `read`/`write`/`edit`/`bash`/`grep`/`find`/`ls`/`powershell` 有专门卡片：`edit` 用 pi 给出的 unified patch，`bash` 显示实时输出与退出码；扩展与 MCP 工具为通用卡片 |
| 排队与插话 | 运行中发送的消息排在 pi 的 follow-up 队列；插话（steer）在当前工具调用结束、下一次模型调用之前并入**当前回合**；待发消息显示在队列里 |
| 中断 | Esc 中断当前回合，pi 已排队的消息保留；"打断并清空"先清 pi 的队列再中断 |
| `/model`、`/effort` | 列出 pi 已认证 provider 的模型；effort 即 pi 的思考等级（按模型给出可选值） |
| `/compact`、`/context` | 由 pi 自己压缩，摘要显示为检查点；上下文占用来自 pi 的会话统计 |
| `/` 命令 | pi 的扩展命令、prompt 模板与 skill（`/skill:名称`）合并进命令表，按 pi 的方式执行与展开 |
| 扩展对话框 | 扩展的 select / confirm / input / editor 显示在问卷面板，notify 变为提示；带超时的对话框到点自动收起 |
| 图片 | 粘贴或 `@` 引用的图片随消息发送，由 pi 按模型限制缩放 |
| `/rename`、`/color`、`/doctor` | 改名写进 pi 会话；颜色保存在本机；`/doctor` 显示 pi 路径、版本、会话文件与模型 |
| `/fork`、双击 Esc 回退 | `/fork` 把当前分支复制成新会话，当前会话不受影响；回退把被选消息之前的对话复制成新会话并切过去，被选消息回到输入框。只回退对话，不回退文件（pi 不记录文件快照） |
| 会话浏览器 | 列出、预览、改名（与 pi 的 `/name` 相同，写入一条 `session_info`）、删除（有 `trash` 命令时移入回收站，与 pi 的 `/resume` 相同） |

## 与原生 pi 的差异与限制

- **没有工具审批**：pi 本身在执行工具前不询问，dsh-TUI 也不拦截（`/permission` 显示
  不支持）。需要确认时可以安装 pi 的 permission-gate 类扩展，它的确认框会出现在问卷面板。
- **项目资源的信任**：RPC 模式没有信任提示。项目 `.pi/` 下的设置、扩展、skills、prompt
  模板（以及上层目录的 `.agents/skills`），只有你曾在 pi 里信任过该项目时才会加载。pi 还没
  有信任决定时，dsh-TUI 打开会话会提示一次；在终端运行一次 `pi` 并选择信任，或在 pi 设置里
  配置 `defaultProjectTrust`。dsh-TUI 不替 pi 做信任决定。
- **登录在 pi 里完成**：RPC 没有登录接口。没有可用模型时 pi 启动即退出，dsh-TUI 会显示
  pi 的原话；用 `pi` 的 `/login`，或设置 provider 的 API key 环境变量。
- 扩展的自定义组件（`ctx.ui.custom()`）、状态栏与小部件（`setStatus`/`setWidget`）、
  改写编辑器文本在 dsh-TUI 里不显示。
- pi 自己的内置界面命令（`/tree`、`/settings`、`/login` 等）不经过 RPC；pi 本身没有
  子代理与后台任务。
- 每个会话一个 pi 子进程。pi 进程意外退出后，该会话不再接收消息，用 `/resume` 重新打开。

## 数据与环境

- 会话文件是 pi 自己的：`~/.pi/agent/sessions/--<目录>--/<时间>_<id>.jsonl`（或
  `PI_CODING_AGENT_SESSION_DIR`、pi 全局 settings 的 `sessionDir`）。dsh-TUI 平时只读；
  只有三种用户操作会写：`/fork` 与回退按 pi 的会话格式写一份新文件（新 header 加原样复制的
  分支条目，与 pi 自己的分叉相同），会话浏览器的改名追加一条 `session_info`，删除移除文件。
  当前会话的改名经 pi 子进程写入。
- 子进程继承你的环境，只去掉父级 pi 会话导出给工具进程的变量（`PI_SESSION_ID`、
  `PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`、`PI_CODING_AGENT`），
  因为 dsh-tui 可能本身就跑在一个 pi 会话的终端里。
- pi 的 stderr 只进调试日志与去重后的提示，不输出到终端。

## 验证范围

- **已验证**：
  - 本机 pi 0.87.1 驱动脚本化 faux 模型（零网络、零费用）的端到端冒烟
    `scripts/verify-pi-live.ts`，共 48 项：工具回合、扩展对话框、思考等级、中断、插话并入
    当前回合、`/fork` 与回退（写出的文件由真 pi 打开）、离线改名与删除、恢复回放后继续对话。
  - 真实 provider：`deepseek/deepseek-flash` 跑 `scripts/verify-pi-real.ts`（25 项，只允许
    flash/mini/haiku 等廉价档，隔离的 agent 目录、凭据取自环境变量）：纯文本、bash 与 edit
    工具（文件确实被改）、思考块、中断、插话、`/context`、真实压缩、压缩后恢复并继续、分叉；
    并在真实终端里用同一模型跑过 TUI。
  - CI 回归：录制夹具的实时与回放一致性（`verify-pi-translate`）、假子进程会话层
    （`verify-pi-session`）、离线目录（`verify-pi-catalog`）、跨后端事件不变量。
- **未验证**：加载你自己全套 pi 扩展时的运行（如 `pi-permission-system`、记忆类扩展；实测
  特意隔离以免写入你的记忆与设置）、pi 1.x 实机（只按协议文档与源码对齐，新增字段一律按
  可选处理）、Windows。
