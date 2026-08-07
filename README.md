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
| `agent-skills sync` | `kind: remote` で実体が無いものを取得し、`skills/.gitignore` を再生成し、有効なエージェントへ symlink を配る |
| `agent-skills agents` | どのエージェントへ配るかの一覧と現在の状態 (read-only)。`enable <name>` / `disable <name>` で切り替え |
| `agent-skills distribute` | 有効なエージェントのディレクトリを store に合わせる (`--dry-run` 可) |
| `agent-skills doctor` | store・symlink・hook・`skills.lock`・`catalog.json`・remote 実体の git 追跡・各エージェントの配線・実行したツリーの `.claude/skills` との同名衝突を検査 (read-only)。`--repo` で「実行した git リポジトリの中身」だけに絞る (pre-commit hook 用) |
| `agent-skills audit` | 実行した git リポジトリの staged 内容に秘密・マシン固有情報が無いか検査 (`--all` で全追跡ファイル、gitleaks があれば併用) |
| `agent-skills push` | store のスキルを **API ワークスペース**へアップロード (`--dry-run` 可、`--include-remote` で remote も) |
| `agent-skills share <name>` | スキルを 1 本だけ**外部の人に渡す**。既定は期限つきの一時共有、`--keep` で恒久共有 (`--dry-run` 可) |

`npm run <cmd>` でも同じものが動く（リポジトリ内でのみ）。`agent-skills`/`skill` はどこからでも。

## どのエージェントへ配るか

store が唯一の正で、各エージェントはそこへの **per-skill symlink** 越しに見る。誰に配るかは
`~/.config/agent-skills/config.json` の `agents` が決める。

```bash
agent-skills agents                    # 一覧（どこへ張るか・いま何が入っているか）
agent-skills agents enable codex       # 配布先に加える
agent-skills agents disable openclaw   # 外す（既存の symlink はそのまま残る）
agent-skills distribute                # 実際に張る・直す・掃除する
```

```json
{ "agents": { "codex": true, "cursor": true, "openclaw": false } }
```

キーを書かなければ**既定値**に従う。既定は `claude-code` だけ true で、残りは全て false。

**インストール済みであることは同意ではない、という理由でこの既定にしてある。** wrangler 4.119 は
逆をやる: エージェントを 11 個「検出」して、断りなく全部のディレクトリへ Cloudflare のスキルを
copy モードで置いていく（2026-08-07 に実際に踏んだ）。ディレクトリの存在は配ってよい根拠にならない。

配布で触るのは **symlink だけ**。実体のディレクトリが同名で居座っていたら、退けずに報告して飛ばす
（そのエージェント同梱のスキルかもしれず、消してよいのはそれを見た人間だけ）。store から消えた
スキルの残骸は、`~/.agents/skills` を指す symlink に限って掃除する。

`warp` は `~/.agents/skills`（= store そのもの）を読むので配布対象にできない。`enable` してもエラーになる。

## サーフェスは 5 つあり、互いに同期しない

Anthropic のスキル置き場は複数あり、**公式に「サーフェス間で自動同期しない」と明記されている**
([cross-surface availability](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview.md#cross-surface-availability))。
store を canonical に置き、そこから配るのがこのツールの立場だが、**届く先は 2 つだけ**:

| サーフェス | 読むところ | store からの反映 |
| --- | --- | --- |
| ローカル FS (`~/.claude/skills`) | **ローカルで動く** Claude Code — CLI / デスクトップ / VS Code / JetBrains | **自動** — `agent-skills link` が張る symlink |
| API ワークスペース | Messages API | **自動** — `agent-skills push` |
| クラウドセッション | claude.ai/code / routines | **届かない** — リポジトリ側で用意する（下記） |
| Cowork | 対話・スケジュール両方 | **届かない** — claude.ai アカウントのスキルのみ |
| claude.ai 個人スキル | claude.ai Web / Desktop | **手動のみ** — API が存在しない |

> **このツールの SSOT は「ローカル Claude Code + API ワークスペース」までを指す。**
> 下 3 つは symlink でも `push` でも届かず、`agent-skills` の管轄外にある。

### クラウドセッションと Cowork には symlink が届かない

どちらも Anthropic 側のマシンで動くので、**このマシンの `~/.claude/skills` を読まない**
（[公式明記](https://code.claude.com/docs/en/skills#skills-in-cowork-and-cloud-sessions)）。
どれだけ綺麗に symlink を張っても不可視。**ただし対処法が違うので、混同しないこと**:

- **クラウドセッション** (claude.ai/code / routines) … clone されたリポジトリの
  `.claude/skills` にコミットするか、リポジトリの `.claude/settings.json` でプラグインを宣言する。
  リポジトリが宣言したプラグインはセッション開始時に入るが、**ユーザ設定で有効化しただけの
  プラグインは転送されない**（[plugins](https://code.claude.com/docs/en/plugins) /
  [marketplace](https://code.claude.com/docs/en/plugin-marketplaces)）
- **Cowork** … 対話・スケジュールとも **claude.ai アカウントで有効化したスキル**をセッション開始時に
  同期する。リポジトリにコミットしてもプラグインを宣言しても届かない

なお **plugin / marketplace 化は採らない**と決めている（[#10](https://github.com/ken-ty/agent-skills/issues/10)）。
塞げるのはクラウドセッションだけで、しかもリポジトリ単位。Cowork と claude.ai は塞がらないため、
store を marketplace 構造へ組み替えるコストに見合わない。

### 同名は personal が project に勝つ

優先順位は **enterprise > personal (`~/.claude`) > project (`.claude`) > plugin > bundled**
（[出典](https://code.claude.com/docs/en/skills#where-skills-live)）。
つまり global store に同名スキルがあると、**プロジェクト固有として置いたスキルが黙って負ける**。
プラグインだけは `plugin-name:skill-name` の名前空間を持つので衝突しないが、上記の通り
プラグイン化は採らないので、この衝突は検出で対処する（[#11](https://github.com/ken-ty/agent-skills/issues/11)）。

`agent-skills doctor` は**実行したツリーの `.claude/skills`** を見て、store と同名のものを BAD に
する（`audit` と同じく「呼ばれた場所」が対象）。プロジェクト内で 1 回打てば分かる:

```text
project skills (~/work/foo/.claude/skills)
  BAD   ghq: shadowed by the store — personal skills override project ones, so
        ~/work/foo/.claude/skills/ghq is never loaded. Rename one, or drop it from the store.
```

`.claude/skills` が無い場所では「無かった」と 1 行報告する（見ていないのか、見て問題が無かったのかを
区別できるようにするため）。

### claude.ai (Web / Desktop) は手動アップロード

**claude.ai の個人スキルだけは API が無く、自動化できない。** これは外部の制約であって、このツールの
手抜きではない。`agent-skills push` を実行しても claude.ai には何も入らない。

- **出す**: store の `skills/<name>/` を zip して、claude.ai の 設定 → スキル → 追加 でアップロードする。
  **store を更新しても claude.ai 側は古いまま**なので、更新のたびに上げ直す。
- **取り込む**: claude.ai にしか無いスキルは Web UI から取得して `skills/<name>/` に置き、
  store の `add-agent-skill` の **vendored** 手順（`origin` に「claude.ai からエクスポート」と書く）に乗せる。

`agent-skills doctor` の `surfaces` セクションが、この 5 サーフェスの状態を毎回思い出させる。

## スキルの追加

store 側の作業。3 種とも「実体を用意し、`catalog.json` に登録し、`agent-skills doctor` で確認」という
同じ形。kind ごとの詳細は **store の README** を参照。要点:

- **own** … `skills/<name>/SKILL.md` を書く → `catalog.json` に `kind: own` → doctor → commit。
  各エージェントへの symlink は `agent-skills distribute`（`sync` の末尾でも走る）が張る。手で `ln -s` する必要は無い。
- **remote** … `npx skills add <owner>/<repo> -g`（**必ず 2 エージェント以上を選ぶ**。1 つだと copy モードに
  なり store を経由しない）→ `catalog.json` に `kind: remote` → `agent-skills sync` → commit。
  **`sync` の前に `git add -A` しないこと** — gitignore を書くのは `sync` なので、その前に足すと
  実体が git に追跡され、以後 gitignore が効かなくなる（`doctor` が BAD で検出する）。
- **vendored** … 実体を `skills/<name>/` に置く → `catalog.json` に `kind: vendored`（`origin` 必須）→ commit。

## スキルを 1 本だけ人に渡す

store も `agent-skills` も持っていない人に、URL 1 つで渡す。配布面は
[ken-ty/agent-skills-share](https://github.com/ken-ty/agent-skills-share)（public）。
判断を含む手順は store の **`share-agent-skill`** スキルにある（[#24](https://github.com/ken-ty/agent-skills/issues/24)）。

```bash
agent-skills share ghq                # 一時共有（既定）。7 日後の日付が branch 名に入る
agent-skills share ghq --days 30      # 期限を変える
agent-skills share ghq --keep         # 恒久共有。既にあれば更新になる
agent-skills share ghq --dry-run      # 何を publish するか見るだけ
```

出力の最後に、そのまま相手へ送れる 1 行が出る:

```text
Published:
  https://github.com/ken-ty/agent-skills-share/tree/share-ghq-20260806/ghq

Send them this:
  npx skills add https://github.com/ken-ty/agent-skills-share/tree/share-ghq-20260806/ghq
```

**配布先は `~/.config/agent-skills/config.json` の `shareRepo`**（`"<owner>/<repo>"`）。
`AGENT_SKILLS_SHARE_REPO` か `--repo` でも指定できる。store の設定とは別なので、共有しない運用なら
設定しなくてよい。

`share` が publish の前に断るもの:

- **`kind: remote`** … 相手は元のリポジトリから直接取れる。写しを配ると出自が隠れるだけ
- **`kind: own` でも catalog に無い** … 出自の記録が無いものを人に渡さない
- **`kind: vendored`** … 再配布はライセンス次第。確認したうえで `--force`
- **秘密・マシン固有情報** … `audit` と同じ検査を publish 直前に流す。publish は取り消せない

```text
agent-skills ──操作──▶ agent-skills-store ──切り出し──▶ agent-skills-share ──▶ 他人
   (tool)              (private, SSOT)              (public, 配布面)
```

**依存は一方向。** share は store を知らないし、store も share を知らない。切り出しは同期ではなく
一方向のコピーなので、`catalog.json` に「共有中」は書かない ── 出自ではなく配布状態であり、
書いた瞬間に store が外部配布を知ることになる。

**これは 6 つ目のサーフェスではない。** 上の 5 つは「自分のスキルがどこで動くか」の話で、
これは「他人に渡す」。別の関心事なので `doctor` の surfaces にも出さない。

| | 一時共有 | 恒久共有 |
| --- | --- | --- |
| 置き場 | orphan branch `share-<name>-<expiry>` | `main` の `<name>/` |
| URL | `tree/share-<name>-<expiry>/<name>` | `tree/main/<name>` |
| 撤回 | ブランチ削除 | フォルダ削除 |

受け取る側から見た使い方は同じ。どちらも `npx skills add <URL>` で入り、URL を開けば読める。
**ローカルに台帳は持たない** — 期限はブランチ名に埋め、生きている共有は GitHub に聞く。

渡す URL には**必ずブランチ名を使う**。commit SHA は `npx skills` が受け付けない上
（`--depth 1 --branch` のため）、ブランチを消しても SHA を知る人は読み続けられる。
制約の詳細は `share-agent-skill` を参照。

## 設計

```text
このリポジトリ (ツール)              store リポジトリ (データ, 別リポジトリ)
  bin/agent-skills                     skills/<name>/SKILL.md   own+vendored=commit
  install.sh          ── 操作 ──▶      skills/.gitignore        remote=ignore (sync が管理)
  scripts/                             catalog.json             来歴 (このツールが検査)
    run.js  … Node 検査 + dispatch      skills.lock              取得 (npx skills が書く)
    init link list sync doctor audit    hooks/pre-commit → audit + `doctor --repo`
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

### pre-commit が止めるもの

store の `hooks/pre-commit` は 2 つを順に走らせる（`agent-skills link` が設置、
`core.hooksPath=hooks` で有効化）:

1. `agent-skills audit` … staged 内容の秘密・マシン固有情報
2. `agent-skills doctor --repo` … `catalog.json` / `skills.lock` / スキル実体の整合

`--repo` は**フル `doctor` とは見る範囲が違う**。commit の可否に関係するものだけを見る:

- **見る** … 実行した git リポジトリの中身（lockfile / catalog / スキル実体）。config の store では
  なく「いま commit しようとしているツリー」なので、store の worktree からでも正しく効く
- **見ない** … `~/.agents` の symlink、各エージェントへのファンアウト、サーフェス一覧。
  これらが壊れていても commit の内容は健全なので、止める理由が無い
- **warn に落とす** … `kind: remote` の実体欠如。gitignore されていて commit に入らないため。
  新しい worktree は必ずこの状態になる

どちらも `git commit --no-verify` で迂回できる。ミスの backstop であって、セキュリティ境界ではない。

### gitleaks があれば秘密検査を強化する（任意）

`audit` と `push` の秘密スキャンは、[gitleaks](https://github.com/gitleaks/gitleaks) が PATH に
あれば自動で併用する。組み込みのルールは手書きの短いリストなので、入れておくと検出範囲が広がる:

```bash
brew install gitleaks
```

**入れなくても動く。必須依存にはしない**（[#9](https://github.com/ken-ty/agent-skills/issues/9) の決定）。
そのため挙動は次の通り:

- **入っていない** … 組み込みスキャンのみ。問題として扱わない
- **入っていて壊れている**（設定エラー等で起動に失敗）… 警告だけ出して**続行する**。ここで止めると
  「壊れた gitleaks が全 commit をブロックする」＝実質必須依存になってしまうため
- **入っていて検出した** … 組み込みの検出と同じ扱いでブロックする。`audit-ignore` の
  escape hatch も同じように効く

`audit` の出力末尾がどちらで検査したかを必ず書くので、「clean」が片方だけの検査だったのか
両方だったのかを取り違えない:

```text
audit: 21 file(s) clean (built-in only — gitleaks not on PATH)
audit: 21 file(s) clean (built-in + gitleaks)
```

## 対応待ちは issue にある

**判断や作業が保留になっているものは、すべて [issues](https://github.com/ken-ty/agent-skills/issues)
に上げる。** 会話やメモに残さない。人間は issue を見て判断する。

エージェントもこの運用に従うこと — 実装の途中で「これは人が決めるべき」と判断したものは、
その場で聞いて止まるのではなく `gh issue create` で残してから先に進める。issue には
**状況・人間の判断が要ること・完了条件**を書く。

## トラブルシューティング

`agent-skills doctor` がまず答えを出す。よくあるもの:

- **`no store configured`** — `agent-skills init <dir>` か `link <dir>`、または `AGENT_SKILLS_STORE` を設定
- **store が `does not exist`** — config のパスが古い。`agent-skills link <正しいパス>` で更新
- **`~/.claude/skills/<name>` が実ディレクトリ / 別の store を指す** — copy モードか旧配線。消して
  2 エージェント以上で入れ直すか、`agent-skills link` で張り替える
- **`kind: remote` なのに実体が無い** — `agent-skills sync`
- **`<name>: N file(s) tracked by git`** — `sync` 前に `git add -A` した。`git rm -r --cached skills/<name>`
  してから `agent-skills sync`
- **`kind: own`/`vendored` なのに実体が無い** — `git checkout -- skills/<name>`（store で）
- **`core.hooksPath unset`** — pre-commit 検査が動いていない。`agent-skills link`
- **`pre-commit differs from the tool's template`** — ツール側の hook が更新され、store の
  コピーが古いまま。`agent-skills link` で入れ直す
- **`This repo needs Node >= 22.18`** — `nvm install 22` などで上げる
