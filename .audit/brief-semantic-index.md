GOAL: Add a `semantic_search` tool backed by a local vector index of the workspace, built from an OpenAI-compatible embeddings endpoint.

WORKTREE: /tmp/opencode/wt/semantic-index (branch feat/semantic-index, based on feat/agent-capabilities). node_modules is a symlink; never run pnpm install.

DATA SHAPE (implement exactly this, it is the design; keep the embedder a seam so tests run offline):
- Config top-level `embeddings` block: `{ "embeddings": { "baseURL": "https://api.openai.com/v1", "model": "text-embedding-3-small", "apiKeyEnv": "OPENAI_API_KEY", "dimensions": 1536 } }`. `baseURL` and `model` required, `apiKeyEnv` required, `dimensions` optional. Absent block means the tool is not registered. Parse it in src/config/resolve.ts the way `search`/`mcp` are, project over global.
- Index file at `~/.local/share/my-agent/index/<project-slug>/index.json`, project-slug = the same slug rule the session store uses. `MY_AGENT_INDEX_DIR` overrides the base, read in one place. Shape: `{ version: 1, model: string, dimensions: number, files: Record<string, { mtimeMs: number; size: number }>, chunks: Array<{ path: string; startLine: number; endLine: number; text: string; vector: number[] }> }`.
- An `Embedder` seam: `type Embedder = (texts: string[]) => Promise<number[][]>`. Production wraps `POST {baseURL}/embeddings` with header `Authorization: Bearer <key>` and body `{ model, input: texts, ...(dimensions ? { dimensions } : {}) }`, reading `data[].embedding`. Tests inject a deterministic fake embedder.

IMPLEMENT:
- `semantic_search { query: string, k?: int 1..20 default 5 }`, readOnly true, default `ask`.
- On first call, build or update the index: walk the workspace with fast-glob respecting .gitignore, skip node_modules/.git, cap file count (say 5000) and file size (say 256 KiB). Chunk each file by lines (about 40 lines per chunk with 10 lines overlap). Embed chunks in batches (say 64). Reuse unchanged files by mtimeMs+size; drop chunks for deleted files; reject the index and rebuild when the model or dimensions differ from the config.
- Search: embed the query, cosine similarity against every chunk vector, return the top k as `<path>:<startLine>-<endLine> (score 0.xx)` plus the chunk text (truncated). Write the index atomically (temp file + rename), like the session store.
- If there is no `embeddings` config, do not register the tool. A missing key returns a clear error naming the env var.

ACCEPTANCE:
- The index build is offline-tested with a deterministic fake embedder: a query whose fake vector matches a known chunk ranks that chunk first, asserting the literal path and score ordering.
- Incremental behavior: a second search does not re-embed unchanged files (assert the embedder call count), and editing a file re-embeds just that file.
- Index round-trips (atomic write then read); a model/dimensions mismatch rebuilds.
- Chunking is unit-tested with literal line ranges.
- The tool is absent without the `embeddings` block and present with it.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` green.

NOTES: this cannot be verified against a live embeddings API here (no key, no general internet), so tests use the injected embedder; say so in the report. Retrieval quality is unmeasured by design; note it as the top follow-up.

FORBIDDEN: no new runtime deps (fast-glob and ignore are already present), no edits outside SCOPE, no push/rebase.
REPORT: at most 15 lines.
