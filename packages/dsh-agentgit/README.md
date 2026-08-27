# dsh-agentgit

AgentGit 的 DeepSeek Harness 插件适配层。它把 Harness 的会话事件追加到
`.agentgit/events.db`，并向模型提供 AgentGit 的消息、任务、检查点和历史审计工具。

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

## Web UI 历史面板

安装到带 Web UI 的 Harness profile 后，侧边栏底部会出现 `AgentGit` 按钮。
点击后打开独立的历史浮层，展示概览、任务、最近事件和 refs/checkpoints。
面板只通过插件自己的 `GET /agentgit/api` 读取 AgentGit 投影数据，每 2 秒刷新一次；
不会改变 Harness 原有的对话、工具调用或会话流程。

当前版本的面板是只读的：事件详情可展开查看，任务和 checkpoint 的修改仍由
AgentGit 工具或 CLI 完成。若 profile 没有启动 WebServer，Host 插件仍可作为
纯工具/事件采集插件使用，Web route 会在 WebServer 可用时自动注册。
