# @local/dsh-provider-effort

[简体中文](README.md) | [繁體中文](README.zh-Hant.md) | 日本語 | [한국어](README.ko.md) | [English](README.en.md)

DSH のサードパーティ provider（`@deepseek-ai/dsh-llm-pi-ai` ルート）へ、推論 effort を自動で注入します：能力（モデルが選択できるレベル）とデフォルトレベル（リクエストに自動付与）。

## インストール

**方法 1：GitHub からクローン**（`WilliamLi0623/dsh-provider-effort`）

```sh
git clone https://github.com/WilliamLi0623/dsh-provider-effort.git
```

その後、DSH の **Plugins > Add plugin** でクローンしたディレクトリ（`dsh-provider-effort/`）を選択します。

**方法 2：ローカルディレクトリからインストール**

このディレクトリ（`provider-effort/`）を選択するか、`plugin_manager` ツールがあるセッションで実行します：

```text
plugin_manager action: install_bundle, target: <このディレクトリの絶対パス>
```

インストール後はすべてのセッションに適用され、再起動後も有効です（書き込みは profile patch で永続化されます）。

### ローカル開発の注意

`dsh plugin --profile <name> add <ローカルディレクトリ>` は pnpm の `link:` でインストールされます：**プラグインの推移依存はインストールされません**（例：`@deepseek-ai/schemastery`）。さらに Node はシンボリックリンクの実パスから解決するため、プラグインの読み込みに失敗します。ローカル開発では tarball からのインストールを使用してください（GitHub/registry からのインストールと同一の挙動）：

```sh
npm pack   # プラグインディレクトリ内で実行。local-dsh-provider-effort-1.0.0.tgz が生成されます
dsh plugin --profile <name> add <生成された .tgz のパス>
```

## 何をするか

- **能力の注入**：手動定義したゲートウェイルートの `models` リストのうち、`reasoningEfforts` を持たないモデルエントリにレベルマップ（`off` + 設定したレベル）を注入します。以降、モデルで effort を選択でき、UI にレベルが表示され、バリデーションも通ります。絞り込んだカタログルートは、モデルのカタログ本来の能力を保持します（宣言マップはカタログのワイヤ綴りを丸ごと置き換えるため注入しません）。ルートのデフォルト値はランタイム検証の後に適用されます。
- **デフォルトレベル**：ルートのすべてのモデルが選択レベルに対応している場合、ルート単位の `reasoning` デフォルト値を書き込みます。以降、effort を明示しないすべてのリクエストに自動で付与されます（ランタイムの `requested ?? reasoning.defaultEffort` により実体化）。OpenAI 互換ゲートウェイではワイヤ上は `reasoning_effort` になります。
- **安全性**：混合能力ルート（一部のモデルがそのレベルに対応しない）にはルートのデフォルト値を設定しません。非推論モデルが `UNSUPPORTED_REASONING_EFFORT` で失敗するのを防ぐためです。`routes.<route>.force: true` で強制できます。DeepSeek 公式ルートには触れません。
- **冪等で自己修復**：欠けているフィールドだけを補完します。Models ページで注入フィールドを削除すると自動で復元し、モデルリクエストの傍受や書き換えは一切行いません。

## 設定（Settings > Plugins > provider-effort、即時反映）

| フィールド | デフォルト | 説明 |
|---|---|---|
| `effort` | `medium` | 注入するデフォルトレベル：`off/minimal/low/medium/high/xhigh/max` |
| `levels` | `off, minimal, low, medium, high` | 注入する `reasoningEfforts` のレベルマップ |
| `namespace` | `llm-pi-ai` | 対象アダプターの settings 名前空間 |
| `skip` | `[]` | 完全にスキップするルート名のリスト |
| `routes` | `{}` | ルート単位の上書き：`effort` / `levels` / `skip` / `force` / `routeDefault: false` |

## 検証

1. **Settings > Models**：サードパーティルートに `reasoning` のデフォルト値が現れ、手動定義ルートのモデルエントリに `reasoningEfforts` が現れます。
2. サードパーティ provider 経由で 1 回リクエストを送る：ターンの呼び出しヘッダーに `reasoningEffort`（アダプターデフォルト）が表示され、ゲートウェイ側のリクエストボディに `reasoning_effort` が現れます。
3. Models ページで注入フィールドを 1 つ削除 → しばらくすると自動で復元されます。

## 制限

- プロファイル起動（settings サービスが存在）が必要です。プロファイルのない headless 構成ではアイドル状態になります。
- キーが未設定のカタログルートは、モデルを列挙できるようになるまでルートのデフォルト値を設定しません（手動定義ゲートウェイルートは影響を受けません）。
