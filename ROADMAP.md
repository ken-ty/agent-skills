# ROADMAP

`/loop` が毎サイクル 1 項目を拾うためのバックログ。**着手可能** から S サイズを 1 つ選び、
実装 → テスト → 自己レビュー → ドキュメント更新 → コミットの 1 サイクルを回す。

- 判断が要ることはチャットで聞かず **issue に上げる**（`human-input` 相当は `question` ラベル）。
  README の「保留中の作業は会話ではなく issue へ」ルールに従う。
- 完了した項目はこの表から消し、[完了ログ](#完了ログ) に 1 行で残す。

## 確定している設計方針

`/loop` が毎サイクル読み直す前提。これに反する実装をしないこと。

| 方針 | 決定 | 出所 |
| --- | --- | --- |
| SSOT の目的 | **一貫性**（復旧ではない） | [#10](https://github.com/ken-ty/agent-skills/issues/10) |
| SSOT の到達範囲 | **ローカル Claude Code + API ワークスペース限定**。Cowork と claude.ai 個人スキルには原理的に届かない | [#10](https://github.com/ken-ty/agent-skills/issues/10) |
| plugin / marketplace 化 | **やらない**。得られるのはクラウドセッションへ repo 単位のみ | [#10](https://github.com/ken-ty/agent-skills/issues/10) |
| claude.ai 側スキルの削除 | **保留**（[#13](https://github.com/ken-ty/agent-skills/issues/13) の結論待ち。削除は Cowork を捨てる決定と等価） | [#10](https://github.com/ken-ty/agent-skills/issues/10) |
| 管轄範囲 | **skills 限定**。dotfiles / harness には広げない（chezmoi を独立に使う） | [#9](https://github.com/ken-ty/agent-skills/issues/9) |
| 外部ツール依存 | 必須は **Node >= 22.18 だけ**。他は optional 併用に留める | [#9](https://github.com/ken-ty/agent-skills/issues/9) |
| catalog の位置づけ | スキルの **出自と更新手段**を持つ唯一の場所。エントリの無い実体は失敗扱い | [#8](https://github.com/ken-ty/agent-skills/issues/8) |

## 着手可能

（空）**S サイズのバックログは尽きた。**

項目 7（★3）の分割案は
[#8 にコメント済み](https://github.com/ken-ty/agent-skills/issues/8#issuecomment-5117507276)（S-A 〜 S-D の 4 件）。
ただし **Q1「`add` は git 操作をするか」/ Q2「own・vendored の symlink を誰が張るか」の回答待ち**なので、
まだこの表には書き戻していない。回答が付いたら S-A 〜 S-D をここへ移す。

項目 8（★5）の分割案も
[#8 にコメント済み](https://github.com/ken-ty/agent-skills/issues/8#issuecomment-5117573009)。
実測したところ `~/.claude/skills` の 15 件は全て symlink で、allowlist の想定対象だった
`unity-mcp-skill` は既に `vendored` として取り込み済みだった。**allowlist に入れるべきものが 0 件**
なので S 1 件（S-E）に落ちる見込みだが、**Q3「allowlist を作らずに済ませてよいか」/ Q4「格上げの温度感」**
の回答待ち。

**要分割の 2 件はどちらも提案済み・回答待ち。`/loop` はサイクルをスキップすること。**
新しいタスクをでっち上げない。回答が付いたら S-A 〜 S-E をこの表へ移す。

## 要分割（そのままでは 1 サイクルに収まらない）

| # | 内容 | サイズ | 出所 |
| --- | --- | --- | --- |
| 7 | ★3 `agent-skills add` を新設し、全 kind で「実体用意 → catalog 追記 → sync → doctor」を原子化する（G1、#8 の本命） | M | [#8](https://github.com/ken-ty/agent-skills/issues/8) |
| 8 | ★5 copy モードで `~/.claude` に入った実体を bad 相当にする（G4）。allowlist が要るかは実測の結果 [再検討中](https://github.com/ken-ty/agent-skills/issues/8#issuecomment-5117573009)（S 1 件に落ちる見込み） | M→S? | [#8](https://github.com/ken-ty/agent-skills/issues/8), [#11](https://github.com/ken-ty/agent-skills/issues/11) |

拾う場合は、まず S に割る提案を issue へコメントしてから着手する。**両件とも提案済みなので、
次にやるのは提案ではなく回答待ち。**

## ブロック中（loop は拾わない）

| # | 内容 | ブロック理由 |
| --- | --- | --- |
| B1 | `push` の実送信を検証する | `ANTHROPIC_API_KEY` の用意が要る（人間）。[#6](https://github.com/ken-ty/agent-skills/issues/6) |
| B2 | claude.ai から store を MCP で読み書きする | 方針未決。MCP はデータアクセスでありスキル登録ではないため、claude.ai 側で自動発火しない点を含めて評価が要る。[#13](https://github.com/ken-ty/agent-skills/issues/13) |
| B3 | API ワークスペースの `skill_id` の永続化先を決める | B1 の実送信検証に依存。[#14](https://github.com/ken-ty/agent-skills/issues/14) |

## 完了ログ

| 日付 | 内容 |
| --- | --- |
| 2026-07-27 | ★1 doctor が「実体はあるが catalog に無い」を `bad` として落とすようになった（`cb31bde`、[#8](https://github.com/ken-ty/agent-skills/issues/8)） |
| 2026-07-29 | [#10](https://github.com/ken-ty/agent-skills/issues/10) plugin 化を見送り、claude.ai 削除は #13 待ちで保留と決定 |
| 2026-07-29 | [#9](https://github.com/ken-ty/agent-skills/issues/9) 管轄は skills 限定と決定し close。audit は gitleaks を optional 併用 |
| 2026-07-29 | README / `docs/architecture.md` / `doctor` のサーフェス記述を 5 サーフェスに正確化。Cowork は plugin でも届かないことと、plugin 化しない決定を反映（[#10](https://github.com/ken-ty/agent-skills/issues/10)） |
| 2026-07-29 | `audit` と `push` に gitleaks の optional 併用を実装（`scripts/lib/gitleaks.ts`）。未導入・起動失敗はブロックしない（[#9](https://github.com/ken-ty/agent-skills/issues/9)） |
| 2026-07-29 | `doctor` が hook の内容 drift を BAD として検出するようになった（`hookDrift()`、[#8](https://github.com/ken-ty/agent-skills/issues/8)） |
| 2026-07-29 | ★2 pre-commit が `audit` に加えて `doctor --repo` を実行するようになった。catalog とズレた commit を止める（[#8](https://github.com/ken-ty/agent-skills/issues/8)） |
| 2026-07-29 | `doctor` が実行ツリーの `.claude/skills` と store の同名衝突を BAD として検出するようになった（[#11](https://github.com/ken-ty/agent-skills/issues/11) の選択肢 4） |
| 2026-07-29 | ★4 `doctor` が remote 実体の git 追跡を BAD として検出するようになった。`--repo` でも走る（[#8](https://github.com/ken-ty/agent-skills/issues/8)） |
