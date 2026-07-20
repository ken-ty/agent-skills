# agent-skills

エージェント用スキルの唯一の canonical source。自作スキルと 3rd party スキルをここに集約し、
各エージェント (Claude Code / Codex / Gemini CLI / Cursor / …) へは symlink で配る。

**すべてのスキルは `catalog.json` に等しく載る。** 自作も 3rd party も、作者・参考 URL・
経緯を同じ形式で記録する。違うのは `kind` — つまり「壊れたときに何で戻すか」だけ:

| kind | 出自 | 実体 | 復元 | `skills.lock` |
| --- | --- | --- | --- | --- |
| `own` | 自分 | コミットする | git | 載らない |
| `remote` | GitHub 等 | コミットしない | `npm run sync` | 載る |
| `vendored` | 手動配置 | コミットする | git | 載らない |

`vendored` は「自作ではないが、取得元のリモートが無い」もの — 配布された zip、社内共有、
既に消えたリポジトリからの写しなど。`npx skills` が再取得できないので、自作と同じく
実体をコミットする。

```json
{
  "version": 1,
  "skills": {
    "create-notion-db": {
      "kind": "own",
      "author": "ken-ty",
      "refs": ["https://note.com/xxxx/n/xxxx"],
      "addedAt": "2026-07-20"
    },
    "find-skills": {
      "kind": "remote",
      "author": "vercel-labs",
      "refs": ["https://github.com/vercel-labs/skills"]
    },
    "some-skill": {
      "kind": "vendored",
      "author": "社内 platform チーム",
      "origin": "Slack #skills で配布された zip",
      "refs": ["https://note.com/yyyy/n/yyyy"],
      "note": "upstream 無し。更新は配布元に問い合わせる"
    }
  }
}
```

| フィールド | 必須 | 用途 |
| --- | --- | --- |
| `kind` | ○ | `own` / `remote` / `vendored` |
| `author` | | 誰が書いたか |
| `refs` | | 参考 URL。note 記事、ドキュメント、issue など何でも |
| `origin` | `vendored` のみ○ | 実体がどこから来たか (URL では表せないので散文) |
| `note` | | ライセンス、更新の問い合わせ先、注意点 |
| `addedAt` | | 追加日 |

> [!NOTE]
> `catalog.json` に取得 URL は書かない。取得は `skills.lock` (= `skills` CLI が書く
> ファイル) の担当で、そこに手を入れると CLI の書き込みで消える。`catalog.json` は
> **CLI が持たない情報だけ**を持ち、`kind: remote` の整合性は `npm run doctor` が
> `skills.lock` と突き合わせて検証する。自作スキルに `../skills/.` のような疑似 URL を
> 書かないのも同じ理由 — 誰も解決できない URL は `npm run sync` で取得できるという
> 誤解を招くだけで、`kind` の方が正確に同じことを表す。

取得と各エージェントへの配布は [`skills` CLI](https://github.com/vercel-labs/skills) に委譲している。
このリポジトリが自前で持つのは `~/.agents/` をここへ向ける 2 本の symlink だけ。

## セットアップ

必要なのは **Node >= 22.18** だけ (理由は[後述](#要件は-node--2218-だけ))。`npm install` は要らない。

```bash
git clone git@github.com:ken-ty/agent-skills.git ~/ghq/github.com/ken-ty/agent-skills
cd ~/ghq/github.com/ken-ty/agent-skills

npm run link -- --dry-run   # 何が起きるか確認 ($HOME を触るので必ず先に実行)
npm run link                # 実行
npm run sync                # kind: remote のスキルを復元
npm run doctor              # 配線を検査
```

`npm run link` は**何も削除しない**。既存のディレクトリやファイルが邪魔な場合は
`~/.agents/skills.bak-<timestamp>` に退避してから symlink を張る。

## スキルの追加

どの kind でも手順は同じ形をしている — **実体を用意し、`catalog.json` に登録し、`npm run doctor`
で確認する**。違うのは最初の一手だけ。

### 自作 (`own`)

```bash
mkdir -p skills/my-skill && $EDITOR skills/my-skill/SKILL.md
$EDITOR catalog.json          # kind: "own", author, refs (参考にした記事など)
npm run doctor
git add catalog.json skills/my-skill && git commit
```

`~/.agents/skills` が `skills/` を指しているので、universal agent (Codex / Gemini CLI / Cursor)
からは即座に見える。Claude Code だけは per-skill の symlink が要る:

```bash
ln -s ../../.agents/skills/my-skill ~/.claude/skills/my-skill
```

### 3rd party (`remote`)

```bash
npx skills add <owner>/<repo> -g
```

> [!IMPORTANT]
> **必ず 2 つ以上のエージェントを選ぶこと。** `skills` CLI はインストール先が 1 つだけだと
> symlink ではなく copy モードに切り替わり、スキル本体が `~/.agents/skills`
> (= このリポジトリ) を経由せず、エージェントのディレクトリに直接コピーされる。
> そうなるとこのリポジトリの管理下から外れる。詳細は [docs/architecture.md](docs/architecture.md)。

`npm run sync` が実行する `skills add` は、この罠を避けるため `skills.lock` の
`lastSelectedAgents` を全部 `-a` で渡す。

```bash
$EDITOR catalog.json          # kind: "remote", author, refs
npm run sync                  # skills/.gitignore を更新
npm run doctor
git add catalog.json skills.lock skills/.gitignore && git commit
```

### 手動配置 (`vendored`) — リモートが無いもの

配布された zip や社内共有など、`npx skills` で取得できないスキル。実体を直接置く:

```bash
unzip ~/Downloads/some-skill.zip -d skills/some-skill   # SKILL.md がルートに来ること
$EDITOR catalog.json          # kind: "vendored", origin は必須
npm run doctor
git add catalog.json skills/some-skill && git commit
```

`origin` だけは必須にしてある。他の kind は URL や git 履歴を辿れば出自が分かるが、
vendored にはそれが無く、散文で残さないと 1 年後に誰も来歴を再構成できないため。
空だと `npm run doctor` が落ちる。

Claude Code へは自作と同じく per-skill の symlink が要る:

```bash
ln -s ../../.agents/skills/some-skill ~/.claude/skills/some-skill
```

> [!NOTE]
> vendored は誰も更新してくれない。取得元が後から GitHub に現れたら、`catalog.json` の
> `kind` を `remote` にして `npx skills add` で入れ直せば `skills.lock` 管理に移行できる。

## コマンド

| コマンド | 説明 |
| --- | --- |
| `npm run link` | `~/.agents/{skills,.skill-lock.json}` をこのリポジトリへ向ける (冪等、`--dry-run` 可) |
| `npm run sync` | `kind: remote` で実体が無いものを取得し、`skills/.gitignore` を再生成 (git 由来のものは欠落を報告するだけ) |
| `npm run doctor` | symlink・hook・`skills.lock`・`catalog.json`・各エージェントの配線を検査 (read-only) |
| `npm run audit` | コミット予定の内容に秘密・マシン固有情報が無いか検査 (`--all` で全追跡ファイル) |
| `npm run typecheck` | `tsc --noEmit` |

### 要件は Node >= 22.18 だけ

スクリプトは Node の型ストリップで `.ts` を直接実行するので、**`npm install` 無しで動く**
(`link` / `sync` / `doctor` の import は `node:fs` などの組み込みのみ)。npm パッケージへの
依存はゼロだが、その代わり Node のバージョンが唯一の前提条件になる。

```bash
git clone git@github.com:ken-ty/agent-skills.git && cd agent-skills
npm run doctor     # npm install の前でも通る
```

`package.json` の `engines` はこれを守れない — npm が見るのは `npm install` のときだけで、
そもそもインストールが不要だからだ。代わりに `scripts/run.js` (plain JS) が起動時に
バージョンを検査する。`.ts` の中に書けないのは、古い Node では解析段階で落ちてガードに
到達しないため。

`devDependencies` の TypeScript は `npm run typecheck` 専用。型ストリップは型検査をしないので、
`tsconfig.json` で `erasableSyntaxOnly` を有効にし、検査は typecheck が担当する
(こちらだけは `npm install` が要る)。

## 構成

```text
agent-skills/
├── skills/              # ← ~/.agents/skills がここを指す
│   ├── .gitignore       #   kind: remote を無視する生成ブロック (sync が管理)
│   └── <name>/SKILL.md
├── skills.lock          # ← ~/.agents/.skill-lock.json がここを指す (取得のため。CLI が書く)
├── catalog.json         #   全スキルの kind / author / refs (来歴のため。このリポジトリが書く)
├── hooks/
│   └── pre-commit       #   秘密混入を止める。core.hooksPath で有効化 (link が設定)
└── scripts/
    ├── run.js           #   Node のバージョン検査 → .ts へ委譲 (plain JS でないと検査できない)
    ├── link.ts
    ├── sync.ts
    ├── doctor.ts
    ├── audit.ts
    └── lib/paths.ts
```

## 秘密・プロジェクト情報の混入を防ぐ

`skills/` は `~/.agents/skills` 経由で**全エージェントの全セッション**に読み込まれる。
あるプロジェクトの情報がスキルに混ざると、**無関係なプロジェクトで作業中にその内容が
LLM へ送信される**。リポジトリが private かどうかはこの経路に影響しない。private が守るのは
GitHub 上の可視性だけで、漏洩経路はエージェントの側にある。

### 第一の防御は置き場所のルール

このリポジトリは `-g` のグローバルストアなので、**プロジェクト固有のものはここに置かない**。

| 置き場所 | 対象 |
| --- | --- |
| `agent-skills/skills/` (ここ) | どのプロジェクトでも成立する汎用スキル |
| 各プロジェクトの `.claude/skills/` | そのプロジェクト固有の手順・固有名詞・URL |

正規表現は必ず漏れるが、「固有名詞が出てきたら置き場所が違う」は判定が明快で、
問題の分類ごと消える。

### 第二の防御は pre-commit hook

`hooks/pre-commit` が `npm run audit` を走らせ、引っかかればコミットを中断する。

```text
audit: BLOCKED — 1 problem(s)

  skills/foo/SKILL.md:5  [github-token] GitHub token
    matched: ghp_***89 (40 chars)
```

検出するもの: 各種 API キー・トークン (GitHub / AWS / Slack / Google / `sk-` 系)、
秘密鍵ブロック、`api_key = ...` 形式の代入、`/Users/<name>/` のマシン固有パス、
`.env` や `*.pem` の混入。マッチ内容は**伏字で表示する** — 報告自体が漏洩にならないように。

誤検知はその行に `audit-ignore` と書けば通る。

`kind: remote` のスキルは gitignore 済みでコミットされないため、検査対象は自動的に
`own` + `vendored` だけになる。

> [!IMPORTANT]
> **hook は `npm run link` を実行したマシンでしか動かない。** `core.hooksPath` は
> リポジトリローカルな設定でクローンに引き継がれないため、新しいクローンは無防備な状態から
> 始まる。`npm run doctor` が未設定を BAD として報告する。
>
> また `git commit --no-verify` で迂回できる。これは git の仕様であり、**この hook は
> うっかりミスへの防護柵であってセキュリティ境界ではない**。

## トラブルシューティング

`npm run doctor` がまず答えを出す。よくあるもの:

- **`~/.claude/skills/<name>` が実ディレクトリになっている** — copy モードで入った合図。
  そのディレクトリを消し、2 つ以上のエージェントを指定して入れ直す
- **`npx skills remove` が "Found 0 skills" と言う** — project スコープを見ている。
  `skills/<name>` と各エージェントの symlink を消し、`skills.lock` と `catalog.json` から
  手で削るのが確実
- **`kind: remote` なのに実体が無い** — `npm run sync`
- **`kind: own` / `vendored` なのに実体が無い** — 取得元が無いので `sync` では直らない。
  `git checkout -- skills/<name>` で作業ツリーから戻す
- **`kind` と `skills.lock` が食い違う** — commit すべきか ignore すべきかが矛盾する。
  リモートから取れるなら `kind: remote` に直し、取れないなら `skills.lock` から削る
- **`not in catalog.json` と出る** — 実体はあるが来歴が未記録。`catalog.json` に追記する
- **`This repo needs Node >= 22.18` と出る** — 型ストリップが無い Node。`nvm install 22` などで
  上げる。インストールするものは他に無い
- **`core.hooksPath unset` と出る** — pre-commit の検査が動いていない。`npm run link`
- **`audit: BLOCKED` でコミットできない** — 誤検知ならその行に `audit-ignore` を書く。
  本物なら `--amend` では消えない (履歴に残る) ので、混入経路ごと直す
