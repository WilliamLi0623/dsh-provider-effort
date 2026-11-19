# @local/dsh-provider-effort

简体中文 | [繁體中文](README.zh-Hant.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [English](README.en.md)

为 DSH 的第三方 provider（`@deepseek-ai/dsh-llm-pi-ai` 路由）自动注入 reasoning effort：能力（模型可选级别）与默认级别（请求自动携带）。

## 安装

**方式一：从 GitHub 克隆**（`WilliamLi0623/dsh-provider-effort`）

```sh
git clone https://github.com/WilliamLi0623/dsh-provider-effort.git
```

然后在 DSH 里 **Plugins > Add plugin**，选择克隆出的目录（`dsh-provider-effort/`）。

**方式二：本地目录安装**

选择本目录（`provider-effort/`），或在带 `plugin_manager` 工具的会话里执行：

```text
plugin_manager action: install_bundle, target: <本目录绝对路径>
```

安装后生效于所有会话，重启后依然生效（写入走 profile patch 持久化）。

## 做了什么

- **能力注入**：手写网关路由 `models` 列表中缺 `reasoningEfforts` 的模型条目被注入级别表（`off` + 配置的级别），此后模型可选 effort、UI 显示级别、校验可通过。
- **默认级别**：当路由的所有模型都支持所选级别时，写入路由级 `reasoning` 默认值。此后所有未显式指定 effort 的请求自动携带（runtime `requested ?? reasoning.defaultEffort` 物化），OpenAI 兼容网关线上表现为 `reasoning_effort`。
- **安全**：混合能力路由（部分模型不支持该级别）不设路由默认值，避免非推理模型报 `UNSUPPORTED_REASONING_EFFORT`；可用 `routes.<route>.force: true` 强制。DeepSeek 官方路由不动。
- **幂等自愈**：只补缺失字段；Models 页删掉注入字段会自动补回；不拦截/改写任何模型请求。

## 配置（Settings > Plugins > provider-effort，实时生效）

| 字段 | 默认 | 说明 |
|---|---|---|
| `effort` | `medium` | 注入的默认级别：`off/minimal/low/medium/high/xhigh/max` |
| `levels` | `off, minimal, low, medium, high` | 注入的 `reasoningEfforts` 级别表 |
| `namespace` | `llm-pi-ai` | 目标适配器的 settings 命名空间 |
| `skip` | `[]` | 完全跳过的路由名列表 |
| `routes` | `{}` | 按路由覆盖：`effort` / `levels` / `skip` / `force` / `routeDefault: false` |

## 验证

1. **Settings > Models**：第三方路由出现 `reasoning` 默认值，手写路由的模型条目出现 `reasoningEfforts`。
2. 通过第三方 provider 发一次请求：turn 的调用头显示 `reasoningEffort`（adapter 默认值），网关侧请求体出现 `reasoning_effort`。
3. 在 Models 页删掉一个注入字段 → 稍等片刻自动补回。

## 限制

- 需要 profile 启动（settings 服务存在）；无 profile 的 headless 组合中闲置。
- 未配置 key 的目录路由在能枚举模型前跳过路由默认值（手写网关路由不受影响）。
