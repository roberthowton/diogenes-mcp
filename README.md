# diogenes-mcp

MCP server for a local [Diogenes](https://github.com/pjheslin/diogenes) install: search, read and export TLG texts.

TS server (stdio) → `perl/dio.pl` JSON shim → the `Diogenes::*` Perl modules and Perseus data bundled in `Diogenes.app`. Headless; the app only needs to be running for `open_in_diogenes`.

## Tools

| Tool | Does |
|---|---|
| `list_authors`, `list_works` | author/work numbers, citation levels |
| `search` | brute-force pattern search, multi-pattern, reject pattern, paging |
| `morph_search` | lemma → all inflected forms → TLG word-index search |
| `word_list` | TLG word index: forms + frequencies |
| `lookup_lemmata`, `parse_word`, `define` | Perseus morphology, LSJ |
| `read_passage` | text from a citation |
| `list_corpora`, `save_corpus`, `delete_corpus` | Diogenes' saved corpora (shared with the app) |
| `export_work` | whole works as TEI XML, markdown or plain text |
| `open_in_diogenes` | open a passage / search / morph search screen (cmux browser pane, else default browser) |

Search scope: `corpus` (saved corpus name), `authors` (`["0557"]`), or `works` (`{"0557": ["002"]}`); none = whole TLG.

## Setup

```sh
pnpm install && pnpm build
claude mcp add --scope user diogenes -- node "$PWD/dist/index.js"
```

TLG location comes from Diogenes' own prefs. Env overrides: `DIOGENES_SERVER_DIR`, `DIOGENES_DATA_DIR`, `DIOGENES_SETTINGS_DIR`, `DIOGENES_PERL`, `DIOGENES_OPEN_CMD`, `DIOGENES_CMUX`.

## Limits

- TLG only (no PHI/DDP, no Latin morphology yet).
- `morph_search` matches word forms, not parsed lemmata: forms shared between lemmata are all counted. Check `forms_found`.
- `open_in_diogenes` searches can only be scoped to the whole TLG or a saved corpus.
- Unscoped searches scan the whole TLG and can take a minute.
