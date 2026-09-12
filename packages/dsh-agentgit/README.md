# dsh-agentgit

AgentGit 的 DeepSeek Harness 插件适配层。它把 Harness 的会话事件追加到
`.agentgit/events.db`，并向模型提供 AgentGit 的消息、任务、检查点和历史审计工具。

插件版本需与 Harness 的运行时匹配。当前 DeepSeek Harness CLI 要求
Node.js 22.19+；Node.js 20+ 仍可用于独立 AgentGit CLI、MCP server 和本地测试。

## 本地开发

在仓库根目录执行：

```sh
npm install
npm --prefix packages/dsh-agentgit install
npm --prefix packages/dsh-agentgit run build
```

开发时可以用 patch overlay 指向源码模块：

```yaml
- insert:
    - id: agentgit
      name: "/absolute/path/to/Lim/packages/dsh-agentgit/src/index.mjs"
      config:
        repo: "/absolute/path/to/target-project"
        agentId: "coder"
```

正式安装使用 bundle 自带的 `cordis.patch.yml`：

```sh
dsh plugin --profile agentgit-dev add /absolute/path/to/dsh-agentgit
```

在 profile 自己的 `cordis.patch.yml` 中用相同的 `id: agentgit` 重述该行，
覆盖 `repo` 和 `agentId`。Harness 的 patch 是整行覆盖，因此要同时保留
这两个配置字段：

```yaml
- insert:
    - id: agentgit
      name: dsh-agentgit
      config:
        repo: "/absolute/path/to/target-project"
        agentId: "coder"
```

随后可以运行 `dsh --profile agentgit-dev --dump-config` 检查组合结果，再启动
`dsh --profile agentgit-dev`。

插件向 Harness 注册以下工具：

- `agentgit_read_inbox`、`agentgit_send_message`、`agentgit_acknowledge_message`
- `agentgit_create_task`、`agentgit_update_task`、`agentgit_task_history`、`agentgit_state_at`、`agentgit_list_tasks`
- `agentgit_create_checkpoint`、`agentgit_verify_history`、`agentgit_rebuild_task_projection`
- `agentgit_get_metrics`、`agentgit_health_check`

## Web UI 历史面板

安装到带 Web UI 的 Harness profile 后，侧边栏底部会出现 `AgentGit` 按钮。
点击后打开独立的历史浮层，展示概览、任务、最近事件和 refs/checkpoints。
面板只通过插件自己的 `GET /agentgit/api` 读取 AgentGit 投影数据，每 2 秒刷新一次；
不会改变 Harness 原有的对话、工具调用或会话流程。

当前版本的面板是只读的：事件详情可展开查看，任务和 checkpoint 的修改仍由
AgentGit 工具或 CLI 完成；投影异常时可直接调用
`agentgit_rebuild_task_projection` 从不可变任务事件恢复当前任务状态。若 profile 没有启动 WebServer，Host 插件仍可作为
纯工具/事件采集插件使用，Web route 会在 WebServer 可用时自动注册。

`agentgit_state_at` 可以按事件 ID 或本地序列只读重放当时的任务状态和事件统计，
不会修改当前任务投影，也不会切换 Git 工作区。

`agentgit_get_metrics` 返回事件吞吐、工作流延迟、采集新鲜度和本地存储占用；
`agentgit_health_check` 返回完整性、采集失败、阻塞任务和陈旧消息告警。两者都只读，
不会向外部监控服务发送数据。
