# OptChat recipe reference

Author: Victor Taelin.

Source: https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449

The implementation was compared with the recipe fetched on 2026-10-04. The reference content SHA-256 was `8f6997e8944d85e4df53b5704bf7c4e393e4da361071181e9cc2f7d9d1b6e430`.

The source remains upstream rather than duplicating the full article here. Its four prompt strings are preserved in `src/prompts.ts`, with attribution in `THIRD_PARTY_NOTICES.md`.

## Implementation mapping

- `src/memory.ts`: append-only log, binary summary tree, compression scheduling, bounded view, zoom/date.
- `src/compactor.ts`: contextual compression and size retries.
- `src/cache.ts`: stable Anthropic cache boundaries.
- `src/transcript.ts`: fresh context per parent run (view plus new input), current-run tool loop retained.
- `src/agents.ts`: asynchronous Pi SDK children and automatic completion reports.
- `src/import/`: profile-scoped historical imports retain user messages and final assistant replies, following the lighter history described in recipe section 10. Source adapters, final-reply detection, replay filtering, and ChatGPT branch labels are integration choices. Live-chat tool logging remains unchanged.

Profiles, native Pi UI, conversation import, and local Git checkpoints are integration choices described in the README.
