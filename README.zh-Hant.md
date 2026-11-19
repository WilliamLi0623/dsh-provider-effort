# @local/dsh-provider-effort

[简体中文](README.md) | 繁體中文 | [日本語](README.ja.md) | [한국어](README.ko.md) | [English](README.en.md)

為 DSH 的第三方 provider（`@deepseek-ai/dsh-llm-pi-ai` 路由）自動注入 reasoning effort：能力（模型可選層級）與預設層級（請求自動攜帶）。

## 安裝

**方式一：從 GitHub 克隆**（`WilliamLi0623/dsh-provider-effort`）

```sh
git clone https://github.com/WilliamLi0623/dsh-provider-effort.git
```

然後在 DSH 裡 **Plugins > Add plugin**，選擇克隆出的目錄（`dsh-provider-effort/`）。

**方式二：本機目錄安裝**

選擇本目錄（`provider-effort/`），或在帶 `plugin_manager` 工具的工作階段執行：

```text
plugin_manager action: install_bundle, target: <本目錄絕對路徑>
```

安裝後對所有會話生效，重新啟動後依然生效（寫入經由 profile patch 持久保存）。

### 本機開發提示

`dsh plugin --profile <name> add <本機目錄>` 以 pnpm `link:` 方式安裝：**不安裝外掛的傳遞依賴**（如 `@deepseek-ai/schemastery`），且 Node 按符號連結的真實路徑解析，外掛會載入失敗。本機開發請改用 tarball（與 GitHub/registry 安裝行為一致）：

```sh
npm pack   # 在外掛目錄內執行，產生 local-dsh-provider-effort-1.0.0.tgz
dsh plugin --profile <name> add <產生的 .tgz 路徑>
```

## 做了什麼

- **能力注入**：手寫閘道路由 `models` 清單中缺 `reasoningEfforts` 的模型條目會被注入層級表（`off` + 設定的層級），此後模型可選 effort、UI 顯示層級、驗證可通過。被收窄的目錄路由保持模型的原生目錄能力（注入的層級表會整體替換目錄的線上拼寫，故不注入）；其路由預設值仍經執行時驗證後生效。
- **預設層級**：當路由的所有模型都支援所選層級時，寫入路由層級 `reasoning` 預設值。此後所有未顯式指定 effort 的請求自動攜帶（runtime `requested ?? reasoning.defaultEffort` 物化），OpenAI 相容閘道線上表現為 `reasoning_effort`。
- **安全**：混合能力路由（部分模型不支援該層級）不設定路由預設值，避免非推理模型報 `UNSUPPORTED_REASONING_EFFORT`；可用 `routes.<route>.force: true` 強制。DeepSeek 官方路由不動。
- **冪等自癒**：只補缺失欄位；Models 頁刪掉注入欄位會自動補回；不攔截、不改寫任何模型請求。

## 設定（Settings > Plugins > provider-effort，即時生效）

| 欄位 | 預設 | 說明 |
|---|---|---|
| `effort` | `medium` | 注入的預設層級：`off/minimal/low/medium/high/xhigh/max` |
| `levels` | `off, minimal, low, medium, high` | 注入的 `reasoningEfforts` 層級表 |
| `namespace` | `llm-pi-ai` | 目標轉接器的 settings 命名空間 |
| `skip` | `[]` | 完全跳過的路由名稱清單 |
| `routes` | `{}` | 按路由覆寫：`effort` / `levels` / `skip` / `force` / `routeDefault: false` |

## 驗證

1. **Settings > Models**：第三方路由出現 `reasoning` 預設值，手寫路由的模型條目出現 `reasoningEfforts`。
2. 經由第三方 provider 發送一次請求：turn 的呼叫標頭顯示 `reasoningEffort`（adapter 預設值），閘道端請求主體出現 `reasoning_effort`。
3. 在 Models 頁刪除一個注入欄位 → 稍候片刻自動補回。

## 限制

- 需要 profile 啟動（settings 服務存在）；無 profile 的 headless 組合中閒置。
- 未設定 key 的目錄路由在能列舉模型前跳過路由預設值（手寫閘道路由不受影響）。
