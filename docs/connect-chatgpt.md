# Connect ChatGPT to your computer / 将 ChatGPT 连接到本机

[English README](../README.md) · [中文 README](../README.zh-CN.md) · [Architecture](architecture.md)

This project needs **two independently configured connections**:

```text
ChatGPT
   │ Remote Desktop Commander (third-party plugin, user authorized)
   ▼
Your computer / PowerShell
   │ tools/dsho.ps1 (this repository)
   ▼
Local authenticated dsh-orchestrator plugin
   ▼
Resident DSH Web Host → native Workspace / Session
```

**Nothing in this repository installs, bundles, proxies, or impersonates Remote Desktop Commander.** Its hosted remote service is a separate third-party product. This repository ships only the DSH-side plugin/client and instructions for using an authorized computer connector.

## Option A: Remote Desktop Commander (recommended example)

The instructions below follow the provider's official setup guide. Actual UI labels and access requirements can change.

1. In ChatGPT, open the [Remote Desktop Commander plugin](https://chatgpt.com/plugins/plugin_asdk_app_6a057d268ebc81919918d37eec718425) and choose **Install / Connect** when available. Installation and connection require your explicit authorization.
2. On the computer you want ChatGPT to reach, ensure Node.js 18+ is available (`node --version`), then follow the device-pairing instructions in the [official setup guide](https://github.com/desktop-commander/remote-desktop-commander/blob/main/docs/SETUP.md). Their current terminal command is:

   ```powershell
   npx @wonderwhy-er/desktop-commander@latest remote
   ```

3. Follow the browser/account flow and **verify that the pairing code in the browser matches the terminal**. Keep the local agent running to maintain the connection.
4. Finish the ChatGPT OAuth / permission step using the same Remote Desktop Commander account as the paired device. Access availability depends on your ChatGPT plan and workspace policies.
5. In ChatGPT, verify the selected device explicitly with a **read-only** request such as:

   > Using Remote Desktop Commander on my authorized computer, show `node --version` and the current working directory. Do not edit files.

6. Then verify the **separate DSH control path**, using the cloned repo's actual path:

   > Using Remote Desktop Commander, run `<repo-root>\tools\dsho.ps1 health` in PowerShell on that same computer and report only the success status, DSH version and capability status. Do not show any authentication token.

A successful remote filesystem request proves the **ChatGPT → computer** segment works. A successful `dsho.ps1 health` additionally proves the **computer → DSH plugin** segment works. Both are required before you can delegate DSH work.

**Official sources:** [ChatGPT plugin listing](https://openai.com/business/plugins/remote-desktop-commander/) · [Remote Desktop Commander setup](https://github.com/desktop-commander/remote-desktop-commander/blob/main/docs/SETUP.md) · [provider website](https://desktopcommander.app/).

## Option B: Another authorized computer connector

You can replace Remote Desktop Commander with another tool that reliably supports:

- Reading project files and executing PowerShell commands on a **user-authorized** computer.
- Returning command output and error codes to the ChatGPT controller.
- Running the local `tools/dsho.ps1` command without exposing DSH credentials or requiring an unrelated public HTTP service.

The plugin's DSH control API stays on `127.0.0.1`; **do not expose its port to the LAN or internet**. You are responsible for the connector's own security, access controls and network transport.

## Common mistakes

| Symptom | What it indicates | Next check |
| --- | --- | --- |
| ChatGPT cannot list local files | Computer connection not established | Pairing status, connected device, permission grants |
| ChatGPT can see files, but `dsho.ps1 health` fails | DSH Host / plugin / compatibility issue | Start the **web** profile, verify plugin installation and tested DSH version |
| Health succeeds, but the prompt fails | Workspace / Session / sandbox / Agent issue | Read returned structured error; do not open a duplicate Session or auto-escalate |
| A remote device appears offline | Local agent is not currently connected | Check provider dashboard and device-agent process |
| Model refuses the task or needs approval | Action not authorized by the user or DSH sandbox | Review requested scope and permissions; never silently bypass them |

## 中文说明

我们仓库会提供 **Remote Desktop Commander 的安装和连接教程**，不会复制它的第三方源码、登录态或设备配置。

- 在 ChatGPT 中安装并授权 [Remote Desktop Commander 插件](https://chatgpt.com/plugins/plugin_asdk_app_6a057d268ebc81919918d37eec718425)。
- 按 [官方配对文档](https://github.com/desktop-commander/remote-desktop-commander/blob/main/docs/SETUP.md) 在目标电脑运行设备 Agent，并核对网页和终端显示的一次性配对码。
- 先让 ChatGPT **只读**查询本机目录/Node.js 版本，确认第一段连接成功。
- 再让 ChatGPT 通过电脑插件执行本仓库的 `tools/dsho.ps1 health`，验证 DSH Web Host 与我们的控制插件。
- 两段都成功后，读取 `agent-skills/dsh-orchestrator/SKILL.md` 和 `agent-skills/dsh-handoff.md`，再开始委派任务。

**安全提醒：** Remote Desktop Commander 是独立的远程服务。请自行评估其权限与隐私政策；随时可以撤销设备授权。不要把设备配对码、凭据文件或 API Key 放入 Git 仓库。
