GOAL: Let the user attach images to a message and have the agent send them to the model as OpenAI-style image content parts. Headless, TUI, and sessions. Web composer image input is a follow-up (do not do it).

WORKTREE: /tmp/opencode/wt/image-input (branch feat/image-input, based on feat/agent-capabilities). node_modules is a symlink; never run pnpm install.

DATA SHAPE (implement exactly this, it is the design):
- In src/providers/types.ts add `export interface ImagePart { type: "image"; mediaType: string; data: string }` where `data` is base64 with NO `data:` prefix, and `mediaType` is like `image/png`.
- `UserMessage` gains `images?: ImagePart[]` (keep `content: string`; do not turn it into a union).

SCOPE (write): src/providers/types.ts, src/providers/openai-compatible.ts, src/agent/agent.ts, src/session/store.ts, src/cli/run.ts, src/index.ts, src/tui/state.ts, src/tui/App.tsx, src/tui/index.tsx (only if needed), README.md, CHANGELOG.md, test/providers/*, test/session/*, test/cli/*, test/tui/*.
SCOPE (read only): src/providers/presets.ts, src/serve/solo.ts, shared/protocol.ts, test/helpers/mock-provider.ts.

IMPLEMENT:
- Provider serialization in src/providers/openai-compatible.ts: when a user message has images, emit `content` as an array `[{ type: "text", text }, ...images.map(i => ({ type: "image_url", image_url: { url: "data:" + i.mediaType + ";base64," + i.data } }))]`. When there are no images, keep the plain string exactly as today. Type it with the OpenAI SDK's content-part type, not `any`.
- agent.ts: `RunAgentOptions` gains `images?: ImagePart[]`; the first user message includes them. Leave `drainInput` messages text-only.
- session store: the user message schema gains an optional `images` array of `{ type: "image"; mediaType: string; data: string }`; sessions round-trip images. Do not change SESSION_VERSION.
- headless `my-agent run`: add a repeatable `--image <path>` (also on the root command). Read the file, infer mediaType from the extension (.png/.jpg/.jpeg/.gif/.webp), base64 it, and pass to runAgent. Reject an unsupported extension or a missing file with a clear error and a non-zero exit before the run starts. Cap the file at 8 MiB with a clear error.
- TUI: `/image <path>` sets a pending attachment, shown in the status row, and the next submitted message carries it and then clears it. Add the pending state to the reducer (src/tui/state.ts) and read the file in App.tsx. `/clear` or a new session clears it.
- Add a small shared helper to read an image file into an ImagePart (mediaType inference + size cap), used by both the CLI and TUI.

ACCEPTANCE:
- `toOpenAIMessages` returns a literal `image_url` data URL for a user message with an image, and the plain string when there are none (assert both).
- A session with an image round-trips through save/load and yields the same ImagePart.
- A headless run with the injected mock provider receives the image part (assert the request messages).
- `--image` with a bad extension, a missing file, or an oversized file exits non-zero with a clear message and never calls the provider.
- The TUI `/image <path>` attaches and the next message includes it.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` green.

NOTES: vision only works on models that support it; that is the user's choice. Web composer image input, pasting into the TUI, and images in tool results are follow-ups.

FORBIDDEN: no new runtime deps, no edits outside SCOPE, no push/rebase.
REPORT: at most 15 lines.
