---
name: create-notion-db
description: Notion のデータベース管理 DB に新しいデータベースを作成する。DB 名やプロパティを指定して呼び出す。
disable-model-invocation: true
allowed-tools: Bash, Read
---

# Notion DB 作成スキル / Create Notion DB Skill

Notion の「データベース管理」DB 配下に新しいデータベースを作成する。

## 定数 / Constants

- データベース管理 DB ID: `1a4c89f5-c113-80b0-ae12-d3a78efb84e4`
- Notion API Key 環境変数: `NOTION_API_KEY`
- API Version: `2022-06-28`

## 手順 / Steps

### Step 1: 引数の確認

ユーザーから以下を確認する（未指定なら質問する）:

- **DB 名** (例: `DB_test`)
- **アイコン** (emoji, 例: `🧪`)
- **プロパティ定義** (JSON 形式。title 型のプロパティは必須)

### Step 2: データベース管理 DB にページを作成

Notion MCP の `API-post-page` で管理 DB にページエントリを作成する。

```
parent: { database_id: "1a4c89f5-c113-80b0-ae12-d3a78efb84e4" }
properties: { "データベース": { title: [{ text: { content: "<DB名>" } }] } }
icon: { type: "emoji", emoji: "<アイコン>" }
```

作成されたページの `id` を控える。

### Step 3: ページ内にインライン DB を作成

**重要: `is_inline: true` を必ず指定すること。** これにより管理 DB に2重登録されない。

Notion API を curl で直接呼ぶ（MCP の create-a-data-source は API バージョン制約で使用不可）:

```bash
curl -s -X POST 'https://api.notion.com/v1/databases' \
  -H "Authorization: Bearer ${NOTION_API_KEY}" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{
    "parent": {"page_id": "<Step2のページID>"},
    "is_inline": true,
    "icon": {"type": "emoji", "emoji": "<アイコン>"},
    "title": [{"text": {"content": "<DB名>"}}],
    "properties": <プロパティJSON>
  }'
```

### Step 4: 結果の報告

作成された DB の ID と URL をユーザーに報告する。

## プロパティ定義の例 / Property Examples

```json
{
  "name": {"title": {}},
  "status": {"status": {}},
  "due_date": {"date": {}},
  "priority": {"select": {"options": [{"name": "high", "color": "red"}, {"name": "low", "color": "blue"}]}},
  "url": {"url": {}},
  "memo": {"rich_text": {}},
  "tags": {"multi_select": {"options": [{"name": "work", "color": "blue"}]}},
  "related_tasks": {"relation": {"database_id": "<対象DB_ID>", "single_property": {}}}
}
```

## 注意事項 / Notes

- 列名・データは英語小文字 snake_case で統一する
- relation を指定する場合は、対象 DB の `database_id`（URL に含まれる ID）を使用する
- MCP の `create-a-data-source` エンドポイントは API version 2025-09-03 では DB 作成に使えないため、curl を使う
