# gpt-dsh-bridge

**让 ChatGPT 做主控，让 DeepSeek Harness（DSH）在本地持久会话中自主执行。**

[English](README.md) · [ChatGPT 连接本地电脑教程](docs/connect-chatgpt.md) · [完整架构](docs/architecture.md) · [实操演示](examples/README.md) · [安全说明](SECURITY.md)

> **当前状态：** v0.1.0 开源候选版。单元测试已通过；全新环境的真实安装验证和代码权属检查仍待完成。**本项目不是 OpenAI 或 DeepSeek 官方产品。**

## 30 秒看懂它做什么

你对 ChatGPT 说：

> “帮我修复项目里发票金额算错的问题，跑测试验证，再告诉我改了什么。”

GPT 不需要亲自列出每条 Shell 命令，而是识别项目和历史工作会话，把**目标、边界、验收标准**交给 DSH；DSH 自己调查、修复和测试。GPT 依据证据验收，不通过就继续使用**原 Session**返工。

~~~mermaid
flowchart TB
    U["👤 用户<br/>提出目标 / 关键授权"] --> G["🧠 ChatGPT · 主控<br/>目标 · 边界 · 路由 · Review"]
    G --> C["已授权的电脑连接工具<br/>如 Remote Desktop Commander"]
    C --> CLI["tools/dsho.ps1<br/>PowerShell 客户端"]
    CLI -->|"认证 HTTP · 仅本机 localhost"| P

    subgraph HOST["用户电脑 · 常驻 DSH Web Host"]
        P["dsh-orchestrator 插件<br/>调用 DSH 原生控制服务"]
        subgraph WS["DSH 原生 Workspace · 项目根目录"]
            A["Session A · 修复缺陷<br/>DSH Agent + 持久上下文"]
            B["Session B · 文档工作<br/>DSH Agent + 持久上下文"]
        end
        P --> A
        P --> B
    end

    A -. "状态与证据" .-> P
    B -. "状态与证据" .-> P
    CLI -. "结果 + GPT 专属协作提醒" .-> G
    G -. "验收 / 返工 / 上报决策" .-> U
~~~

**它不是再造一个 Agent Runtime。** DSH 自己管理 Workspace、Session、Agent 和历史上下文；插件只通过 DSH 原生接口提供本地控制能力。

## 为什么需要它？

| 常见问题 | 我们的处理方式 |
| --- | --- |
| Agent 每轮执行都像重新开始 | **同一工作块复用同一个持久 Session** |
| GPT 事无巨细替执行 Agent 指挥命令 | 用协作 SOP 明确：**GPT 管目标和验收，DSH 管实现** |
| DSH 说“完成了”，但实际没验收 | **GPT 对照测试证据 Review** |
| 会话繁忙、报错，就盲目新开会话 | **不通过新开 Session 绕过占用、锁或临时故障** |
| 同一项目里有多个任务 | 独立工作块可用**不同 Session 并行**，避免共享写冲突 |
| 长期任务中 GPT 忘记自己的职责 | DSH 最终回报附带独立的 **`gptReviewReminder`** |

### 角色怎么分工？

- **用户**：提出最终目标，决定重大方向，批准高风险或不可逆操作。
- **ChatGPT（主控）**：明确目标、背景、边界、验收标准；选择正确的 Workspace / Session，协调工作块，并依据证据 Review。
- **DSH（执行者）**：观察本地环境，自主选择实现方式、运行命令、调试、自测，报告真正的结果与风险。
- **`dsho.ps1` 和插件**：只负责连接、认证、路由和状态查询，**不承担 AI 规划判断**。

## 一次任务的完整闭环

~~~mermaid
sequenceDiagram
    autonumber
    actor U as 用户
    participant G as ChatGPT
    participant C as dsho.ps1 / 本地插件
    participant D as 持久 DSH Session

    U->>G: 修好发票金额，并验证结果
    G->>C: 查询 Workspaces 和 Sessions
    C-->>G: 找到已有 Session 或确认没有匹配
    opt 该工作块没有可复用 Session
        G->>C: 在项目 Workspace 内新建 Session
    end
    G->>C: 发送目标、背景、边界、验收
    C->>D: 派单 + 自动附加 Runtime Contract
    D->>D: 调查 → 实现 → 测试 → 返回证据
    G->>C: status -Wait
    C-->>G: 最终结果 + 独立的 GPT 协作提醒
    G->>G: 根据验收标准核查证据
    alt 未通过
        G->>C: 只说明差距，继续原 Session
    else 通过
        G-->>U: 汇报已验收结果和证据
    end
~~~

**Session 纪律：** 同一连续工作块优先使用同一 Session，一个 Session 不同时接管多个独立工作块；独立工作块在无依赖和共享写冲突时可以并行。人工也可以在 DSH Web UI 里查看和续接同一个 Session。

## 5 步跑通

### 0. 环境准备

- Windows PowerShell 5.1 / PowerShell 7；开发和测试建议 Node.js 20+。
- DeepSeek Harness **`0.2.0-rc.2` 或 `0.2.1-rc.2`**。这是已验证兼容的目标版本，**不代表已支持后续所有版本**。
- 常驻的 DSH **Web Host**。插件依赖 Web profile 的会话控制服务，不安装在 headless profile。**真正发送 Agent 任务之前，还需在 DSH Web UI → 设置 → 模型中配置可用模型**；不要把 API Key 写入仓库或聊天。
- 如果要让 GPT 真正派单，还需要接入一个**用户授权的电脑连接工具**。普通 ChatGPT 聊天不会因为克隆了仓库就获得本机权限。请先参照 **[ChatGPT 连接本地电脑教程](docs/connect-chatgpt.md)**，完成 Remote Desktop Commander 的设备配对、ChatGPT 授权和两段连通性验证。

DSH 的安装与源码入口可参考 [DeepSeek Harness 官方网站](https://www.deepseek.com/zh/harness/)。

### 1. 安装控制插件

在本仓库根目录打开 PowerShell：

~~~powershell
$pluginDir = (Resolve-Path -LiteralPath .\dsh-orchestrator).Path
dsh plugin --profile web add "file:$pluginDir"
~~~

### 2. 启动 DSH Web Host

安装后需要启动或**安全重启** Web Host。已有重要执行任务时，不要强制中断：

~~~powershell
dsh web --host 127.0.0.1 --port 3080 --no-open
~~~

让它保持运行。另开一个 PowerShell 终端，并在本仓库根目录执行：

~~~powershell
.\tools\dsho.ps1 health
~~~

预期可以看到 `ok: true` 和正常的能力检查结果。插件只监听 loopback，通过 DSH 自有凭据进行认证；不要把 token 复制进聊天、日志或截图。

### 3. 找到项目 Workspace

~~~powershell
.\tools\dsho.ps1 ensure -Path "D:\path\to\your-project"
.\tools\dsho.ps1 workspaces
.\tools\dsho.ps1 sessions
~~~

以**项目根目录的规范化路径**确定 Workspace，再在其已有 Session 中寻找精确标题 `GPT-<工作块>`。用户明确指定人工 Session 时，在确认其工作目录后也可以直接续接。

### 4. 新任务才创建 Session，然后派单

从 `ensure` 返回结果获取 `workspaceId`。仅在该工作块没有可复用 Session 时执行 `new`：

~~~powershell
.\tools\dsho.ps1 new -Workstream "invoice-demo" -WorkspaceId "<workspace-id>"
.\tools\dsho.ps1 prompt -Session "<session-id>" -TextFile ".\examples\demo-task.md"
~~~

后续工作使用已有的 `sessionId`，不重复新建。任务卡包含目标、必要事实、边界、验收和证据即可，具体实现步骤尽量留给 DSH。

### 5. 等待、Review、决定是否返工

~~~powershell
.\tools\dsho.ps1 status -Session "<session-id>" -Wait -TimeoutMs 120000 -Pretty
~~~

看到 `running: true`、`timeout`、`stream-ended`，都**不能判定任务完成**；应继续等待原 Session。DSH 原生 Goal 也可能跨多个回合运行。

每次派单时，客户端会把 `Runtime Contract` 附在任务文本后；符合条件的已结束结果会附一个独立的 `gptReviewReminder` 字段，用来提醒 GPT 恢复协作规范，**不污染 DSH 五块式汇报正文**。

## 动手体验：一个真的会失败的例子

仓库附带一份**故意写错**的发票金额计算器：

~~~text
examples/sample-project/
├── src/invoice.js           # 故意忽略商品数量
├── test/invoice.test.mjs     # 期望 50；修复前得到 19
└── package.json
~~~

先在仓库根目录验证失败用例：

~~~powershell
node --test .\examples\sample-project\test\invoice.test.mjs
~~~

你会看到一个用例通过、一个用例失败。建议把示例复制到临时目录，再让 DSH 修复，不直接修改仓库本身。对已经连接电脑的 ChatGPT，可以这样说：

> 请读取本地仓库的 `agent-skills/dsh-orchestrator/SKILL.md` 和 `agent-skills/dsh-handoff.md`。根据 `examples/demo-task.md`，在正确的 Workspace / Session 里交给 DSH 修复发票金额问题；实现方式由 DSH 自主决定。请运行测试核对真实结果，不要只根据“完成”二字验收。若已有相同工作块的 Session，就复用它。

更完整的复制、派单、验收步骤在 **[演示教程](examples/README.md)**。

### 还适合什么任务？

| 场景 | GPT 派单目标 | GPT 怎么验收 |
| --- | --- | --- |
| **代码修复** | 修复数量没有参与合计的问题，不改无关文件 | 测试实际通过、变更范围正确 |
| **只读排查** | 调查某个本地测试偶发失败的原因，不修改源码 | 有可复现的发现和日志证据 |
| **独立工作块并行** | 文档整理与测试覆盖分析分别交给不同 Session | 分别验收，确认没有重复执行或共享写冲突 |

以上是**示例任务模板**，不是编造的真实 DSH 执行成绩。

## GPT 如何学会使用这套协作方式？

GPT 必须能通过授权的电脑连接工具读取并使用这两份文件：

1. [`agent-skills/dsh-orchestrator/SKILL.md`](agent-skills/dsh-orchestrator/SKILL.md)：负责控制面连接、Session 路由、复用、派单和恢复。
2. [`agent-skills/dsh-handoff.md`](agent-skills/dsh-handoff.md)：负责 GPT / DSH 分工、风险上报和证据验收。

**注意：** 克隆仓库不等于给 ChatGPT 安装了全局 Skill，也不会自动赋予电脑控制权限；DSH Web Host 也需要独立运行。

## 目录结构

~~~text
dsh-orchestrator/
  lib/                 # 仅本机监听、需认证的控制插件
  test/unit-*.mjs      # 不需要真实 DSH Host 的单元测试
  README.md            # HTTP API 说明
tools/dsho.ps1         # PowerShell 控制客户端
agent-skills/
  dsh-orchestrator/SKILL.md  # GPT 路由与派单指南
  dsh-handoff.md             # 交接、风险、验收及 GPT 提醒
examples/              # 故意失败的演示项目和任务卡
docs/architecture.md   # 更详细的技术架构与时序图
~~~

## 测试

~~~powershell
Push-Location .\dsh-orchestrator
$tests = @(Get-ChildItem .\test -Filter 'unit-*.mjs' -File | ForEach-Object FullName)
node --test $tests
Pop-Location
~~~

当前公开候选版已通过 **126 项单元测试**，包括从压缩包独立解压后的验证。这**不等于**已在全新电脑上完成 DSH 真实安装和端到端测试。

## 安全、限制与常见问题

- **这是官方产品吗？** 不是，属于独立的社区项目。
- **安装后 GPT 就能操作电脑吗？** 不能，还需要用户授权和配置电脑连接工具。
- **DSH Web Host 关掉了还能用吗？** 不能，插件依赖常驻 Web Host。
- **为什么不每次使用 headless？** 原生 Web Session 能复用 Workspace、会话状态和人类 Web UI，不必维护另一套外部会话映射。
- **为什么不直接另开 Session？** 可能造成上下文丢失和重复劳动，应优先恢复原 Session。
- **能直接用在生产环境吗？** 不建议默认相信它安全。先阅读 [SECURITY.md](SECURITY.md)，使用有限权限，避免自动提权。

更多信息：[完整架构](docs/architecture.md) · [接口说明](dsh-orchestrator/README.md) · [贡献指南](CONTRIBUTING.md) · [MIT LICENSE](LICENSE)。公开发布前仍需核实代码权属及许可。
