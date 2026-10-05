# pi-optchat

Victor Taelin's OptChat memory workflow as a Pi extension, with separate work and personal profiles. Built and tested with Pi 1.0.2.

## Install

```sh
pi install git:github.com/jonaslsaa/pi-optchat
```

Restart Pi, choose **+ Create profile**, and create a profile such as `work` or `personal`. Chat normally. Its memory follows it across directories and Pi sessions; the footer shows which profile is active. The extension runs inside ordinary Pi, without a fork or separate launcher.

Requires Pi 1.0.2 or a compatible version, Node.js 22.19+, and Git. Tested on macOS; the offline tests also run on Linux. Web access is included, so a separate `pi-web-access` installation is unnecessary.

The main agent uses the model and effort selected in Pi. Subagents default to **Anthropic Opus 5.5, high**; memory compression defaults to **Anthropic Sonnet 5.5, medium**. Change these with `/optchat agents model` and `/optchat model` before chatting if you use other models. Both settings are stored separately in each profile and are independent of the main model. All descendants use the profile's subagent setting; changing it affects new launches. Authentication uses Pi's existing provider login.

Compression and background agents make additional model requests using your configured provider credentials. The import preview shows the amount of text to index; it is not a price quote.

## Commands

| Command | Action |
| --- | --- |
| `/optchat` | Show status and the actions menu. |
| `/optchat profile` | Select or create a profile; switching starts a fresh Pi session. |
| `/complete` | End a connected-window conversation and send a handoff to the main agent. |
| `/tell-main <message>` | Send the main agent a message from a connected window. |
| `/optchat model` | Select this profile's compactor model and effort. |
| `/optchat agents` | Open the live agent tree and saved run history. |
| `/optchat agents model` | Select this profile's subagent model and effort, independently of the main model. |
| `/optchat usage` | Usage by session, time range, role, and model. |
| `/optchat instructions` | Edit this profile's persistent `AGENTS.md` in Pi. |
| `/optchat browse` | Open a local HTML memory snapshot with the current view, every tree level, exact messages, date spans, and sizes. Run again to refresh it. |
| `/optchat import` | Import Claude Code, Codex, or ChatGPT history; resume or discard a paused import. |
| `/model` | Pi's normal main-model selector. |

To delegate, say something like: “Spawn an agent to investigate this repository and report back.” Each direct child reports independently when finished. Children get the same profile's memory and instructions, a frozen view, read-only `zoom`/`date`, and normal coding and web tools. You can ask the parent to send a running child guidance through `tell`.

Delegation supports **main → child → grandchild → great-grandchild**, with at most **8 active agents per profile**, counting parents waiting for their descendants. Attempts beyond either limit return an error; there is no automatic queue. Descendant reports go to their immediate parent after that parent's current run ends. The harness keeps the parent session alive to process them and report back, without polling or waiting in model tools. A failed parent stops its remaining descendants. Stopping an agent stops its entire subtree.

## Agent inspector and usage

A compact **Agents | Usage** bar sits below the input. With an empty input and no autocomplete open, press **Down** to focus it, **Left/Right** to choose a section, and **Enter** to open it. **Escape/Up** returns to editing. Typing also returns to the editor. **F6** opens Agents directly while preserving an unfinished draft; `/optchat agents` and `/optchat usage` are alternative entry points. To use another shortcut, launch with `OPTCHAT_INSPECT_KEY=ctrl+shift+a pi`. If another extension supplies a custom editor, OptChat preserves it and offers the shortcut/commands instead of taking over its Down key.

The list shows task names, parent/child indentation, state, elapsed time, current tools, and last activity. Use **Up/Down**, **Page Up/Down**, **Home/End**, and **Enter** to inspect a run; **M** in the list selects the subagent model. Inside a transcript, **T** expands tool arguments/results, **F** follows live output, **S** composes guidance, **X** stops the selected subtree, and **Escape** goes back. Scrolling pauses following so incoming output does not move the text you are reading. Guidance is shown as queued until it enters the child's conversation, or undelivered if the child stops first. Direct user guidance is also saved in the profile's main memory. Model reasoning is not displayed.

Completed and partial transcripts remain browsable after restart. Pre-inspector child sessions are indexed too; uncertain interrupted work is labelled accordingly. Closing Pi still stops agents; this is not detached execution. Inspecting history does not add those transcripts to the manager's model context or make model requests.

Press **Tab** to switch between Agents and Usage. In Usage, **Left/Right** selects this session, last hour, today (local time), last seven days, or all time. Totals and model breakdowns separate main-agent, subagent, compactor, and import work, including uncached input, output, cache reads/writes, and API-equivalent cost estimates. A child's transcript shows its own usage. Current parent context size is a separate Pi estimate, not cumulative consumption. Costs are estimates from model API rates, not a subscription bill or remaining allowance; unavailable rates can report zero.

Usage updates when responses finish, including retries and reported usage on failures. Tool overhead can be an additional usage record, so record counts are not always request counts. Existing compactor/import records and saved child usage remain available by date. Main-agent tracking starts with this version and backfills a resumed session; older main sessions are not scanned globally. Historical records without parent-session attribution are excluded from **This session**. All views stay within the active profile.

Web search and page fetching are bundled through `pi-web-access`. Keyless Exa search and fetching were verified live. The extension exposes its own additional commands, including `/websearch` for search configuration.

## Import existing history

Restart Pi after updating the extension, choose the destination profile, and run `/optchat import`.

1. Choose **Claude Code**, **Codex**, or **ChatGPT export**. Claude Code scans `~/.claude/projects`; Codex scans `~/.codex/sessions` and `~/.codex/archived_sessions`. Separate Claude Code and Codex subagent transcripts are excluded, with no inclusion toggle. These are read locally; scanning makes no model calls.
2. For coding agents, select projects. **Space** toggles the highlighted row without moving your position; **Enter** continues. Type to filter, use **Page Up/Down** or **Home/End** to navigate, **Ctrl+A** to select matching rows, and **Ctrl+D** to clear them. **Esc** cancels. Optionally filter by conversation start date. Select all matching conversations or choose individual ones. Nothing is automatically classified as work or personal. Claude workflow journals are excluded because they are orchestration metadata, not conversations.
3. For ChatGPT, enter an export ZIP, extracted directory, or conversation JSON path. Both `conversations.json` and numbered variants are supported. ZIP reading requires `unzip`. See OpenAI's [export instructions](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data) and [conversation-file description](https://help.openai.com/en/articles/9106926-transfer-exported-conversations-between-chatgpt-accounts).
4. If the profile has history, choose **Append** to reuse its existing summaries, or **Rebuild by conversation start date** to regenerate the combined tree. Rebuild keeps imported conversations together; native profile history is grouped by user turn. This is conversation ordering, not global message-by-message timestamp sorting. Empty profiles skip this choice.
5. Review the destination, new/duplicate message counts, text size, rough source-token estimate, and selected compactor. Start when ready. Estimates are not a price quote: prior context, merges, and retries add model usage.

Historical imports follow Victor's lighter recipe: **user messages and final assistant replies**, with original dates and source labels. Tool calls/results, intermediate commentary, reasoning, agent-to-agent traffic, and recognized replayed/compacted context are excluded. Main-agent final replies that describe child work remain included. There is no full-trace import option; normal live OptChat logging is unchanged.

Explicit final/stop markers are used when present. For older exports without them, the importer keeps the last assistant text before the next user message or conversation end, discarding candidates followed by more tool work or known interruption markers. ChatGPT final replies from alternate branches remain labelled as alternatives. Duplicate exported records are removed; distinct user requests with identical wording are retained rather than guessing that repeated instructions were accidental. Image/audio/file bytes are not imported.

Unsupported or damaged records are reported before starting so you can cancel or continue with supported records. Claude/Codex transcripts that disappear during discovery or before reading are skipped with a warning; cancellation and other I/O errors still stop the operation. ChatGPT parsing is verified against synthetic export fixtures. This policy applies to newly selected imports: existing memory and staged imports are not filtered retroactively, including when you resume or rebuild existing memory.

Re-importing unchanged messages skips them, even if titles or source paths changed. Newly appended messages are added; changed source messages can produce a separate historical version. Historical dates and branch labels are included in agent and compactor guidance, so old imported requests are not treated as new instructions. As with any model summary, inspect originals for consequential details.

Compression uses the destination profile's model and effort. **Pause import** (or Escape) saves progress; `/optchat import` offers **Resume** or **Discard staged import**. Restarting Pi also preserves progress. Chatting in that profile remains blocked until the import completes or is discarded. You can switch to another profile while it is paused, or use another Pi process with a different profile during compression. Imports require the parent and its subagents to be idle.

Both modes build in a separate memory generation. The active-memory pointer changes atomically only after the whole tree is ready, and the previous generation stays on disk. Completion starts a fresh Pi session bound to the same profile. Source files are never modified. No real user history was imported during installation/testing.

## Storage and operation

- Data: `~/.optchat/profiles/work/` and `~/.optchat/profiles/personal/`.
- `main/`: authoritative dated JSONL conversation log, without model reasoning.
- `tree/`: persistent binary summary nodes; the current view is reconstructed from the log and tree on startup.
- After an import, `active-memory.json` points to `memories/<id>/`, which contains the active `main/` and `tree/`. Prior generations remain retained. `imports/pending.json` tracks resumable work; completed import records include the previous generation path. Keep these directories in backups.
- `AGENTS.md`: profile instructions; `config.json`: compactor/subagent models.
- `pending-inputs.json` and `pending-reports.json`: recovery journals.
- `runs/`: child Pi sessions and `*.optchat.json` run metadata; `usage.jsonl`: usage ledger for all roles; `memory.html`: browser snapshot.
- Pi also retains its native sessions in Pi's normal session directory.

The extension takes an exclusive lock per profile. You can run work and personal simultaneously, but two Pi processes cannot write the same profile. A second interactive window offers to connect to the original window as a subagent (see below). Resuming a Pi session restores its bound profile. New sessions offer the picker with the last-used profile first. For headless use, pass `--optchat-profile work`; this does not permit resuming a session bound to a different profile or attaching as a connected window.

These profiles separate memory and instructions, not filesystem access or provider credentials. Agents retain normal Pi tool access. Jobs run in the Pi process: keep it open for background work. On restart, unsent inputs are recovered into memory and you can ask to continue them; completed pending child reports are delivered automatically. Interrupted children are not automatically restarted.

Local Git checkpoints are made after parent turns and on clean shutdown. They include memory and configuration, excluding child runs, rendered HTML, and usage logs. They have no remote and are not an off-machine backup. Copy the full profile directory while Pi is closed if you want a separate backup.

## Connected agent windows

Open Pi in another terminal and select the same profile. Pi identifies the original owner and asks whether to start a connected subagent conversation. Your first message starts one child in the second window's working directory; subsequent messages continue that conversation. Responses appear in the transcript, with current activity above the editor. The child also appears in the original window's agent inspector. Text input is supported; for images, provide a file path for the agent to read.

The original Pi process hosts the child and remains the only writer of shared memory. The child uses the profile's subagent model and normal delegation limits (including two more levels), and stays alive between replies. An open connected conversation occupies one of the eight agent slots and prevents profile switching/importing in the owner until it ends. Its transcript and user guidance are saved continuously.

Communication has three parts: the main agent receives the initial request when the conversation starts; either side can communicate explicitly during work; and the owner always prepares a final handoff when it ends. Use `/tell-main <message>` to contact the main agent yourself. The child has a `tell_main` tool, and the main agent can reply through its existing `tell` tool. Those replies appear in the connected window as labelled main-agent guidance. Routine conversation turns do not repeatedly wake the main agent. Notifications are journaled and wake an idle main agent or enter its running conversation through Pi's steering mechanism.

Use **`/complete`** when you are done. It records your decision, closes the secondary Pi session, and asks the owner to stop remaining work (including descendants) and prepare the handoff asynchronously. Completion refers to the conversation ending, not proof that every task succeeded. Closing or force-quitting the secondary window also stops its work and generates a handoff, explicitly marked **interrupted**. There is no detach-and-keep-working or reattach mode in this version.

Handoffs use the profile's compactor model and effort with a dedicated prompt, rather than the 512-byte memory-summary limit. The whole conversation and descendant evidence are summarized in one call when they fit within approximately **128,000 input tokens**. Budgeting estimates one token per four UTF-8 bytes (roughly 512,000 ASCII characters), including instructions and any prior summary. Smaller models get a reduced budget: 20% of their context window is reserved for estimation error, plus room for output. This is a heuristic, not an exact tokenizer count. Oversized transcripts are folded in chunks without cutting Unicode characters or dropping evidence between chunks.

The handoff has an output allowance of up to **16,000 tokens**, capped by the model's output limit and one quarter of its context window, with no fixed word limit. Each call has a **five-minute timeout**. Handoffs preserve user decisions/corrections, changes, evidence, failures, and unfinished work, and link to all saved transcripts; private reasoning and the initial memory snapshot are excluded. Usage appears under compactor usage. If summarization fails, times out, or hits its output limit, a clearly labelled fallback still reports the initial task, last recorded result, undelivered guidance, and transcript locations. These handoff budgets do not change the memory tree or its summary sizes.

Keep the original Pi window open to host the agents. Graceful owner shutdown stops the conversations and saves their handoffs for next startup. If the owner is killed, opening that profile again recovers unfinished conversations and undelivered handoffs without restarting their work. The connection is local to this machine through a socket restricted to the same OS user; there is no new daemon or remote server. Parallel agents retain shared filesystem access—use separate Git worktrees for independent edits when needed.

## How closely this follows the recipe

The reference is [Victor's recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449), linked with implementation notes in `docs/victor-recipe.md`. Its four prompt constants are preserved. Memory uses 512-byte summary targets, a 128,000-byte view, binary merges, contextual compression, eight compression workers, fixed retry delays, and five attempts for oversized summaries. Long tool text is capped at 30,000 characters.

Every new parent run waits for pending summaries and freezes the memory view. Its fresh model context contains that view and the new input, as the recipe prescribes; earlier exchanges, including the last answer, appear only as summaries, and the agent zooms when it needs their exact wording. The current run's tool conversation, steering, and reasoning remain intact until it ends. Original logged messages are available through `zoom` and `date`. Anthropic requests get stable view cache breakpoints; this is not a guarantee of lower cost for every workload.

Implementation choices:

1. Native Pi UI and small built-in SDK `spawn`/`tell` support, without a separate subagent package or Pi fork.
2. Explicit profile `AGENTS.md` controls automatic instruction injection. Repository/global Pi `AGENTS.md` files are not automatically included in the OptChat prompt; tell the agent to read project instructions when needed. Skills and template expansion remain Pi features.
3. Historical memory is text-only. Image blocks remain available within their active Pi run/session, but OptChat stores placeholders rather than a searchable image archive.
4. Pi's automatic compaction and cache warming are disabled in favor of the recipe. An exceptionally long single run can still hit the model's context limit; stop it and continue in a new turn. When Pi's in-process transcript passes about 2 MB, a settled run appends a retain-none compaction entry so Pi stops cloning it on every model call; the session file keeps every entry, and the TUI redraws the chat from that point.
5. Import adds historical source/date/branch guidance alongside the recipe prompts. Computer use and hosting on an always-on machine remain deferred.
6. The agent inspector and usage ledger are local views, separate from the memory tree. Two intentional delegation changes: direct children report individually instead of waiting for their whole spawn batch, and children can delegate two extra levels with automatic parent continuation, bounded to 8 active agents. The original recipe prompt constants remain unchanged; child-specific delegation guidance is appended.

Known edge case: Pi can transform a skill/template invocation (or image input) after the durable input journal records it. The expanded message is logged correctly, but the original form may also be recovered later as an unanswered input. Ordinary text chat is unaffected; this conservatively preserves input rather than risking the loss of an unrelated queued message.

## Installation and development

To develop from a local checkout:

```sh
git clone https://github.com/jonaslsaa/pi-optchat.git
cd pi-optchat
npm ci --ignore-scripts
pi install .
```

Restart Pi after source updates. To remove the integration, run `pi remove git:github.com/jonaslsaa/pi-optchat` (or the local path used during installation); profile data is retained. `OPTCHAT_HOME` overrides the default data directory for isolated testing.

```sh
npm run check
npm test
npm run test:live
```

`test:live` makes paid Anthropic calls using synthetic data in a disposable profile. It checks actual Sonnet compression, exact zoom retrieval, fresh next-turn context, an Opus child, and its automatic parent wake-up. The eight offline tests cover tree coverage/restart, cancellation/retry, torn-write recovery, profile locking, cache boundaries, context projection, image preservation, and input crash recovery. All passed during setup. Native Pi profile selection/switching and real Opus web search/fetch also passed. Two independent subagents reviewed code correctness and fidelity against a fresh fetch of Victor's gist; fixes were re-reviewed.

Import adds eleven focused tests for the three adapters, ZIP reading, branch fidelity, discovery, duplicate detection, append/rebuild activation, pause/resume/discard, post-pointer crash recovery, and dialog cancellation. Local Claude Code/Codex discovery and sample transcript parsing were also exercised without storing their contents in profiles or sending them to a model. The import changes received separate lifecycle and parser/fidelity reviews.

Three picker tests cover scrolling through long lists, preserving position on toggle, narrow terminals/resizing, filtered selection, and shutdown cancellation. The custom picker was also checked in the native Pi terminal with 150 long project paths.

Agent/usage tests exercise real SDK sessions with a deterministic local provider: live streaming, independent results, queued/delivered guidance, stop and subtree cancellation, three-level result routing, depth/concurrency limits, persisted transcripts, profile boundaries, usage replay without double counting, legacy/torn records, local-date filters, and inspector keyboard navigation/resizing. They make no paid model requests.

The installed Pi UI was exercised end to end using a synthetic ChatGPT fixture: choose rebuild, start Sonnet compression, pause, confirm chat is blocked, quit/restart Pi, resume, activate the completed generation, then ask Opus to retrieve the exact original phrase with `zoom`. The original generation remained intact throughout.

## Publishing

The GitHub repository is installable directly using the command above. Pi's public package directory discovers npm packages carrying the `pi-package` keyword. The manifest includes that keyword and bundles its web extension dependency. To release an npm version as a package maintainer:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
npm publish --access public
```

Publishing requires npm authentication and ownership of the package name. GitHub publication alone does not put a package in the directory. See the [Pi package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).

## Credits and license

Inspired by [Victor Taelin's OptChat recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) and [OptMem](https://github.com/VictorTaelin/OptMem). The four recipe prompts are preserved in `src/prompts.ts`. This is an independent Pi implementation, not Victor's official OptChat distribution.

Original implementation code is MIT licensed. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md) for upstream attribution.
