# agent-skills

エージェントスキルを管理する CLI。**own / remote / vendored の 3 種スキルを、あなた自身の
git リポジトリ (= store) に集約し、各エージェント (Claude Code / Codex / Gemini CLI / Cursor / …)
へ symlink で配る。**

これは chezmoi / yadm と同じ **ツール / データ分離**:

- **このリポジトリ (ツール)** … コマンド本体。誰でも `git clone` + `install.sh` で入れて使える。
- **store リポジトリ (データ)** … あなたのスキル・来歴・ロックファイル。ツールが外から操作する。
  テンプレート: [agent-skills-store-template](https://github.com/ken-ty/agent-skills-store-template)。

ツールはどの store を操作するかを `~/.config/agent-skills/config.json`（`agent-skills init`/`link`
が書く）から読む。`AGENT_SKILLS_STORE` 環境変数で上書きできる。

取得と各エージェントへの配布は [`skills` CLI](https://github.com/vercel-labs/skills) に委譲している。
このツールが持つのは `~/.agents/` を store へ向ける 2 本の symlink と、来歴 (`catalog.json`) の検査だけ。

## インストール

必要なのは **Node >= 22.18** だけ（理由は[後述](#要件は-node--2218-だけ)）。`npm install` は要らない。

```bash
git clone git@github.com:ken-ty/agent-skills.git ~/ghq/github.com/ken-ty/agent-skills
cd ~/ghq/github.com/ken-ty/agent-skills
sh install.sh          # bin を ~/.local/bin/{agent-skills,skill} へ symlink
```

以後 `agent-skills`（短縮 `skill`）でどこからでも実行できる。

## store をつなぐ

```bash
# 新規に空の store を作る
agent-skills init ~/ghq/github.com/<you>/agent-skills-store

# 既存の store（clone 済みなど）を使う
agent-skills link ~/ghq/github.com/<you>/agent-skills-store

agent-skills sync      # kind: remote のスキルを取得
agent-skills doctor    # 配線を検査
```

`init`/`link` は **何も削除しない**。`~/.agents` に既存の実体があれば `.bak-<timestamp>` に退避し、
別の store を指す symlink があれば張り替える。config に store パスを記録し、store に pre-commit
audit フックを設置する。

## コマンド

| コマンド | 説明 |
| --- | --- |
| `agent-skills init <dir>` | 空の store を scaffold し、`link` して配線する |
| `agent-skills link <dir>` | 既存 store を config に登録し、`~/.agents` を向け、hook を設置 (冪等、`--dry-run` 可) |
| `agent-skills list` | store のスキルを kind ごとに一覧 (read-only) |
| `agent-skills sync` | `kind: remote` で実体が無いものを取得し、`skills/.gitignore` を再生成 |
| `agent-skills doctor` | store・symlink・hook・`skills.lock`・`catalog.json`・各エージェントの配線を検査 (read-only) |
| `agent-skills audit` | 実行した git リポジトリの staged 内容に秘密・マシン固有情報が無いか検査 (`--all` で全追跡ファイル) |

`npm run <cmd>` でも同じものが動く（リポジトリ内でのみ）。`agent-skills`/`skill` はどこからでも。

## スキルの追加

store 側の作業。3 種とも「実体を用意し、`catalog.json` に登録し、`agent-skills doctor` で確認」という
同じ形。kind ごとの詳細は **store の README** を参照。要点:

- **own** … `skills/<name>/SKILL.md` を書く → `catalog.json` に `kind: own` → doctor → commit。
  Claude Code へは per-skill symlink が要る: `ln -s ../../.agents/skills/<name> ~/.claude/skills/<name>`。
- **remote** … `npx skills add <owner>/<repo> -g`（**必ず 2 エージェント以上を選ぶ**。1 つだと copy モードに
  なり store を経由しない）→ `catalog.json` に `kind: remote` → `agent-skills sync` → commit。
- **vendored** … 実体を `skills/<name>/` に置く → `catalog.json` に `kind: vendored`（`origin` 必須）→ commit。

## 設計

```text
このリポジトリ (ツール)              store リポジトリ (データ, 別リポジトリ)
  bin/agent-skills                     skills/<name>/SKILL.md   own+vendored=commit
  install.sh          ── 操作 ──▶      skills/.gitignore        remote=ignore (sync が管理)
  scripts/                             catalog.json             来歴 (このツールが検査)
    run.js  … Node 検査 + dispatch      skills.lock              取得 (npx skills が書く)
    init link list sync doctor audit    hooks/pre-commit → `agent-skills audit`
    lib/{paths,store}.ts
  hooks/pre-commit … store へ配る雛形

  ~/.config/agent-skills/config.json   { "store": "<path>" }   ← init/link が書く
  ~/.agents/skills           → <store>/skills                  ← ツールが張る
  ~/.agents/.skill-lock.json → <store>/skills.lock             ← ツールが張る
  ~/.claude/skills/<name>    → ~/.agents/skills/<name>         ← npx skills が張る
```

詳細は [docs/architecture.md](docs/architecture.md)。

### 要件は Node >= 22.18 だけ

スクリプトは Node の型ストリップで `.ts` を直接実行するので **`npm install` 無しで動く**
（`init`/`link`/`sync`/`doctor` の import は `node:fs` などの組み込みのみ）。npm パッケージ依存は
ゼロで、代わりに Node のバージョンが唯一の前提。`scripts/run.js`（plain JS）が起動時に検査する
（古い Node では `.ts` が解析段階で落ちてガードに到達しないため、JS でないと検査できない）。

`devDependencies` の TypeScript は `npm run typecheck` 専用（型ストリップは型検査をしないため。
これだけは `npm install` が要る）。

## トラブルシューティング

`agent-skills doctor` がまず答えを出す。よくあるもの:

- **`no store configured`** — `agent-skills init <dir>` か `link <dir>`、または `AGENT_SKILLS_STORE` を設定
- **store が `does not exist`** — config のパスが古い。`agent-skills link <正しいパス>` で更新
- **`~/.claude/skills/<name>` が実ディレクトリ / 別の store を指す** — copy モードか旧配線。消して
  2 エージェント以上で入れ直すか、`agent-skills link` で張り替える
- **`kind: remote` なのに実体が無い** — `agent-skills sync`
- **`kind: own`/`vendored` なのに実体が無い** — `git checkout -- skills/<name>`（store で）
- **`core.hooksPath unset`** — pre-commit 検査が動いていない。`agent-skills link`
- **`This repo needs Node >= 22.18`** — `nvm install 22` などで上げる
