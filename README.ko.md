# @local/dsh-provider-effort

[简体中文](README.md) | [繁體中文](README.zh-Hant.md) | [日本語](README.ja.md) | 한국어 | [English](README.en.md)

DSH의 서드파티 provider(`@deepseek-ai/dsh-llm-pi-ai` 라우트)에 추론 effort를 자동으로 주입합니다: 기능(모델이 선택할 수 있는 레벨)과 기본 레벨(요청에 자동 첨부).

## 설치

**방법 1: GitHub에서 클론** (`WilliamLi0623/dsh-provider-effort`)

```sh
git clone https://github.com/WilliamLi0623/dsh-provider-effort.git
```

그런 다음 DSH의 **Plugins > Add plugin**에서 클론한 디렉터리(`dsh-provider-effort/`)를 선택합니다.

**방법 2: 로컬 디렉터리에서 설치**

이 디렉터리(`provider-effort/`)를 선택하거나, `plugin_manager` 도구가 있는 세션에서 실행합니다:

```text
plugin_manager action: install_bundle, target: <이 디렉터리의 절대 경로>
```

설치 후 모든 세션에 적용되며, 재시작 후에도 유지됩니다(기록은 profile patch로 영속화됩니다).

### 로컬 개발 참고

`dsh plugin --profile <name> add <로컬 디렉터리>`는 pnpm `link:` 방식으로 설치합니다: **플러그인의 전이 의존성이 설치되지 않습니다**(예: `@deepseek-ai/schemastery`). 또한 Node가 심볼릭 링크의 실제 경로에서 해석하기 때문에 플러그인 로드가 실패합니다. 로컬 개발에서는 tarball 설치를 사용하세요(GitHub/registry 설치와 동일한 동작):

```sh
npm pack   # 플러그인 디렉터리에서 실행. local-dsh-provider-effort-1.0.0.tgz 생성
dsh plugin --profile <name> add <생성된 .tgz 경로>
```

## 하는 일

- **기능 주입**: 수동으로 선언한 게이트웨이 라우트의 `models` 목록에서 `reasoningEfforts`가 없는 모델 항목에 레벨 맵(`off` + 설정된 레벨)을 주입합니다. 이후 모델에서 effort를 선택할 수 있고, UI에 레벨이 표시되며, 유효성 검사를 통과합니다.
- **기본 레벨**: 라우트의 모든 모델이 선택한 레벨을 지원할 때 라우트 단위 `reasoning` 기본값을 기록합니다. 이후 effort를 명시하지 않은 모든 요청에 자동으로 첨부됩니다(런타임의 `requested ?? reasoning.defaultEffort`로 실체화). OpenAI 호환 게이트웨이에서는 와이어상 `reasoning_effort`로 전송됩니다.
- **안전성**: 혼합 능력 라우트(일부 모델이 해당 레벨을 지원하지 않음)에는 라우트 기본값을 설정하지 않아, 비추론 모델이 `UNSUPPORTED_REASONING_EFFORT`로 실패하는 것을 방지합니다. `routes.<route>.force: true`로 강제할 수 있습니다. DeepSeek 공식 라우트는 건드리지 않습니다.
- **멱등 자가 복구**: 누락된 필드만 채웁니다. Models 페이지에서 주입된 필드를 삭제하면 자동으로 복원되며, 모델 요청을 가로채거나 수정하지 않습니다.

## 설정 (Settings > Plugins > provider-effort, 실시간 적용)

| 필드 | 기본값 | 설명 |
|---|---|---|
| `effort` | `medium` | 주입할 기본 레벨: `off/minimal/low/medium/high/xhigh/max` |
| `levels` | `off, minimal, low, medium, high` | 주입할 `reasoningEfforts` 레벨 맵 |
| `namespace` | `llm-pi-ai` | 대상 어댑터의 settings 네임스페이스 |
| `skip` | `[]` | 완전히 건너뛸 라우트 이름 목록 |
| `routes` | `{}` | 라우트별 재정의: `effort` / `levels` / `skip` / `force` / `routeDefault: false` |

## 검증

1. **Settings > Models**: 서드파티 라우트에 `reasoning` 기본값이 나타나고, 수동 선언 라우트의 모델 항목에 `reasoningEfforts`가 나타납니다.
2. 서드파티 provider로 한 번 요청 보내기: 턴의 호출 헤더에 `reasoningEffort`(어댑터 기본값)가 표시되고, 게이트웨이 측 요청 본문에 `reasoning_effort`가 나타납니다.
3. Models 페이지에서 주입된 필드 하나 삭제 → 잠시 후 자동으로 복원됩니다.

## 제한

- 프로필 기동(settings 서비스 존재)이 필요합니다. 프로필이 없는 headless 구성에서는 대기 상태로 유지됩니다.
- 키가 설정되지 않은 카탈로그 라우트는 모델을 나열할 수 있게 되기 전까지 라우트 기본값을 건너뜁니다(수동 선언 게이트웨이 라우트는 영향을 받지 않습니다).
