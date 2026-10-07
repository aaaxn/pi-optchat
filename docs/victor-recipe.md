# OptChat recipe reference

Author: Victor Taelin.

Source: https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449

The implementation was compared with the recipe fetched on 2026-10-04. The reference content SHA-256 was `8f6997e8944d85e4df53b5704bf7c4e393e4da361071181e9cc2f7d9d1b6e430`.

The source remains upstream rather than duplicating the full article here. Its four prompt strings are preserved in `src/prompts.ts`, with attribution in `THIRD_PARTY_NOTICES.md`.

## Implementation mapping

- `src/memory.ts`: append-only log, binary summary tree, compression scheduling, bounded view, zoom/date, and the opt-in text search over original messages (`src/tools.ts` has the tool; not in the recipe, off by default).
- `src/compactor.ts`: contextual compression and size retries.
- `src/cache.ts`: stable Anthropic cache boundaries. OpenAI requests get no marks: GPT-5.6 rejects the recipe's `prompt_cache_breakpoint` with a 400 (found by @aaaxn), so they rely on implicit prefix caching. OptChat doesn't set `reasoning.context` either: GPT-5.6 already defaults to the recipe's `"all_turns"`, and OpenAI documents it only for GPT-5.6 and GPT-6.1 Sol.
- `src/transcript.ts`: fresh context per parent run, current-run tool loop retained. The previous completed exchange is also retained in full text (left out if over 16,000 bytes by default), an intentional addition to the summary-only recipe for conversational continuity.
- `src/agents.ts`: asynchronous Pi SDK children and automatic completion reports.
- `src/settings.ts`: per-profile settings for the departures from the recipe. Defaults are the recipe's (one subagent level, no memory search), except the previous exchange (on) and the summary size tolerance (640 bytes, against the recipe's strict 512).
- `src/import/`: profile-scoped historical imports retain user messages and final assistant replies, following the lighter history described in recipe section 10. An import hands `Memory` one message at a time, each once the one before it is summarized, so the compactor sees the view a live chat would have shown it. Source adapters, final-reply detection, replay filtering, and ChatGPT branch labels are integration choices. Live-chat tool logging remains unchanged.

Profiles, native Pi UI, conversation import, and local Git checkpoints are integration choices described in the README.
