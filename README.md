![Pi-OptChat: persistent memory for Pi](https://raw.githubusercontent.com/jonaslsaa/pi-optchat/main/docs/banner.jpg)

# pi-optchat

A Pi extension that implements [Victor Taelin's OptChat recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449): one endless chat per profile, remembered through a summary tree instead of compaction.

- **Memory**: every message is logged and summarized into a binary tree. Each turn starts from a fresh context holding a bounded memory view; the agent uses `zoom` and `date` to read originals.
- **Profiles**: separate memories and instructions, such as `work` and `personal`.
- **Subagents**: delegate tasks to background agents, inspect them live, and send them guidance.
- **Import**: bring in history from Claude Code (conversations and memories), Codex, or ChatGPT.
- **Connected windows**: a second Pi window on the same profile becomes a subagent you talk to directly.

It runs inside ordinary Pi, with no fork or separate launcher.

## Install

```sh
pi install npm:pi-optchat
pi install npm:pi-web-access   # optional, for web search and page fetching
```

Or from GitHub: `pi install git:github.com/jonaslsaa/pi-optchat`.

Requirements: Pi 1.0.2 or compatible, Node.js 22.19+, and Git. Tested on macOS; the offline tests also run on Linux.

Web access is not bundled. Subagents load the Pi extensions you have installed (except pi-optchat itself), so installing `pi-web-access` gives web tools to the main agent and every subagent.

To uninstall, run `pi remove git:github.com/jonaslsaa/pi-optchat`. Profile data is kept.

## Quick start

1. Restart Pi.
2. Choose **+ Create profile** and name it, for example `work`.
3. Chat normally.

The footer shows the active profile. Memory follows the profile across directories and Pi sessions. New sessions show the profile picker with the last-used profile first; resumed sessions restore their profile.

For headless use, pass `--optchat-profile work`.

## Commands

| Command | Action |
| --- | --- |
| `/optchat` | Status and actions menu. |
| `/optchat profile` | Select or create a profile. Switching starts a fresh Pi session. |
| `/optchat settings` | This profile's settings: models, subagent levels and limits, previous exchange, summary size tolerance. |
| `/optchat model` | Compactor model and effort for this profile. Type to filter the models you are logged in to; the current one is marked. |
| `/optchat agents` | Live agent tree and saved run history. |
| `/optchat agents model` | Subagent model and effort for this profile, picked the same way. |
| `/optchat usage` | Token usage and cost estimates. |
| `/optchat activity` | Memory gauge: view size, summaries catching up, running agents. |
| `/optchat instructions` | Edit this profile's `AGENTS.md`. |
| `/optchat browse` | Open a readable snapshot of memory: the shape of what the model sees, summaries you can open down to the original messages, and search that shows where each message is folded. Run again to refresh. |
| `/optchat import` | Import history, or resume/discard a paused import. |
| `/complete` | In a connected window: end the conversation and hand off to the main agent. |
| `/tell-main <message>` | In a connected window: message the main agent. |

## Models

| Role | Default | Change with |
| --- | --- | --- |
| Main agent | Whatever is selected in Pi | `/model` |
| Subagents | Anthropic Opus 5.5, high | `/optchat agents model` |
| Compactor (summaries, imports, handoffs) | Anthropic Sonnet 5.5, medium | `/optchat model` |

Subagent and compactor settings are saved per profile and do not follow the main model. If you use other providers, change them before chatting. Authentication uses Pi's existing provider login.

Compression and subagents make extra model requests with your provider credentials.

## Settings

`/optchat settings` opens this profile's settings. Each row shows its value and default, the selected row says what it does and when a change applies, and a change is saved right away to the profile's `config.json`. Defaults follow Victor's recipe, except Previous exchange and Summary size tolerance, which keep OptChat's earlier behaviour.

| Setting | Default | What it does |
| --- | --- | --- |
| Compactor model | Sonnet 5.5, medium | Same as `/optchat model`. Applies to the next summary. |
| Subagent model | Opus 5.5, high | Same as `/optchat agents model`. Applies to new subagents. |
| Subagent levels | 1 | 1: only the main agent starts subagents (the recipe). 2 or more: subagents may start their own, that many levels deep. Applies to subagents started or resumed after the change. |
| Max active agents | 8 | Subagents running at once in the profile, all levels together, so it also caps how deep a chain can go. |
| Group subagent reports | on | The subagents started by one spawn report together, in one message once the last of them finishes (the recipe). Off: each reports as soon as it finishes. Applies to the next spawn. |
| Previous exchange | on | Replays your last request and answer in full with the next turn (see below). Off is the recipe. |
| Previous exchange limit | 16 KB | A larger last exchange is left out. |
| Memory search | off | Gives the agent, and subagents started or resumed after the change, a `search` tool over your original messages (see below). Off is the recipe: zoom and date only. Applies from the next turn. |
| Summary size tolerance | 640 bytes | The compactor is always asked for 512-byte lines; a longer line up to this size is kept instead of retried. 512 is the recipe's strict rule. |

Numbers must be whole numbers of at least 1 (512 for the summary size tolerance). Missing keys in an older `config.json` take their defaults.

**Upgrading from 0.6.x:** subagent levels used to be fixed at 3 and now default to 1, so subagents no longer start their own subagents until you set Subagent levels to 2 or 3.

![Settings page](docs/screenshots/settings.png)

## Subagents

Ask in plain words, for example: "Spawn an agent to investigate this repository and report back."

- Children get the profile's memory view (frozen at launch), its instructions, read-only `zoom`/`date`, and normal coding tools plus your installed extensions.
- Children also get the Pi built-in extensions the main session loaded: MCP, codemode and tool search. Your MCP servers (`~/.pi/agent/mcp.json`, the project's `.pi/mcp.json`) work in subagents, with the sign-ins you made in Pi. If MCP is off in the main session (`--no-mcp`, `-builtin:mcp` in settings, or an extension that replaces `/mcp`), it is off in subagents too. Each subagent opens its own server connections (stdio servers start once per subagent) and closes them when it ends.
- The children of one spawn report together: when the last of them finishes, their reports reach the parent as one message, `[id] report` each, in spawn order. A stopped or failed child counts as finished, with its stop or error text as its report. Each finished report is journaled right away, so if Pi dies before the rest finish, the reports it already has are delivered at the next start. Turn **Group subagent reports** off to get each report as soon as its child finishes. Messages sent with `tell_parent`, connected windows and their handoffs are never held back, and a child resumed with `tell` reports on its own. The parent stays alive to receive reports; it never polls.
- In the main chat, subagent messages and reports appear in a dark grey box labelled `↳ subagent <id> · still running` or `· report`, so they don't look like something you typed. The model still receives them as ordinary user messages. (One exception: reports recovered at startup, before your first message in the session, still show as plain user messages.)
- The parent can send a running child guidance with `tell`, and the child can message its parent mid-run with `tell_parent` (a question, an early finding). It reaches the parent like a report, marked "still running": between tool calls if the parent is busy, or waking it if it's waiting.
- `tell` to a finished child resumes it: the same agent (ID, parent, model, directory) reopens its saved transcript, gets the message as a new prompt, and sends a new report. This also works for children from earlier Pi sessions. Only the agent that started the child can resume it, and the resumed child takes one active slot. Connected windows can't be resumed, and a child whose transcript is missing must be spawned fresh.
- By default only the main agent starts subagents. Set **Subagent levels** in `/optchat settings` to let them delegate further (3 means child, grandchild, great-grandchild).
- **Max active agents** (8 by default) caps how many agents can be active per profile, including parents waiting on descendants. Going over a limit returns an error; there is no queue.
- Stopping an agent stops its whole subtree. A failed parent stops its descendants.
- Agents run inside the Pi process. Closing Pi stops them; there is no detached mode.

## Agents, usage and activity inspector

An **Agents | Usage | Activity** bar sits below the input.

| Key | Action |
| --- | --- |
| **Down** (empty input) | Focus the bar |
| **Left/Right**, **Enter** | Pick and open a section |
| **Escape**, **Up**, or typing | Back to the editor |
| **F6** | Open Agents directly, keeping your draft |
| **Tab** | Cycle Agents, Usage and Activity |

Set a different shortcut with `OPTCHAT_INSPECT_KEY=ctrl+shift+a pi`. If another extension supplies a custom editor, OptChat leaves its Down key alone; use the shortcut or commands instead.

**Agents** lists runs as a tree with state, elapsed time, current tool, and last activity. Navigate with **Up/Down**, **Page Up/Down**, **Home/End**, and press **M** to pick the subagent model.

**Enter** swaps the screen to that agent's conversation, drawn with Pi's own chat components, so it reads like the main chat: its task, replies, and collapsed tool calls, following live output. Typing and **Enter** send it guidance. Guidance from the main agent and reports from the agent's own agents show in labelled boxes, so only your own messages look typed. **Escape** goes back to the main chat.

| Key | Action |
| --- | --- |
| **Escape** | Clear a draft, else back to the main chat |
| **Ctrl+C** | Clear a draft, else interrupt the agent's current step. Never ends the agent: queued messages go to it at once and it carries on; with none queued it waits for you (**interrupted · waiting for you**) until your next message, or a `tell` from the main agent, resumes it |
| **Up** (empty input) | Take your newest queued message back to edit; send it again, or clear it to drop it |
| **Ctrl+X** twice | Stop this agent and the agents it started (the only key that ends it) |
| **Page Up/Down**, mouse wheel | Scroll; back at the bottom it follows again. The wheel needs Pi's default fullscreen mode |
| **Ctrl+O** | Expand tool output (Pi's own toggle) |

Guidance shows as queued until delivered, or undelivered if the child stops first. When you interrupt an agent with nothing queued, the agent that started it gets a one-line note instead of a report, so it isn't left waiting. Guidance you send is also saved in main memory. Reasoning is not shown. Transcripts stay browsable after restart, and browsing them makes no model calls.

**Usage** shows this session, last hour, today, last 7 days, or all time (**Left/Right**): one row per role and model (main agent, subagents, compactor, imports) with estimated cost, share of the total, output tokens, and how much input came from the cache. Costs are API prices, not your subscription bill.

![Usage page](docs/screenshots/usage.png)

**Activity** is a memory gauge: how many messages the profile holds and how much of the 128 KB view they fill, then either **Settled** or **Catching up · 12 of 40 summaries** with a progress bar counted from when the backlog last grew from empty. If summarizing keeps failing, the last error and the retry countdown show under it. It also counts running agents, and interrupted ones waiting for you; their list is on Agents. While summaries or agents are at work, the bar's Activity item gets a **●**.

![Activity page](docs/screenshots/activity.png)

- Costs are API-rate estimates, not your subscription bill. Unknown rates show zero.
- Record counts are not request counts; retries and tool overhead can add records.
- Main-agent tracking starts with v0.3.0 (resumed sessions are backfilled). Older records without a parent session are left out of **This session**.
- All views are limited to the active profile.

## Import history

Pick the destination profile, then run `/optchat import`.

1. **Source**: Claude Code (`~/.claude/projects`), Claude Code memories, Codex (`~/.codex/sessions`, `~/.codex/archived_sessions`), or a ChatGPT export (ZIP, folder, or `conversations.json`; ZIP needs `unzip`). Scanning is local and makes no model calls.
2. **Select**: for Claude Code, its memories, and Codex, pick projects (busiest first), optionally filter by start date, then take all conversations or pick some. **Tab** toggles (and **Space** when the filter is empty), **Enter** continues, type to filter, **Ctrl+A**/**Ctrl+D** select/clear matches, **Esc** cancels. Nothing is classified as work or personal for you.
3. **Mode** (only if the profile already has history):
   - **Append**: keep existing summaries and add the import. Faster and cheaper.
   - **Rebuild by conversation start date**: regenerate the whole tree, ordered by conversation start.
4. **Preview**: destination, new and duplicate counts, text size, rough token estimate, and compactor. This is not a price quote: a big import costs about 3x that estimate in compactor input, because every message is summarized and then re-read in merges, each with the memory view as (mostly cached) context.

**What gets imported**: user messages and final assistant replies, with original dates and source labels, as in Victor's recipe. Tool calls and results, intermediate commentary, reasoning, subagent transcripts, replayed context, and image/audio/file bytes are left out. So is the output Claude Code logs for slash and shell commands; the command itself stays as typed (`/name args` or `!command`). So are the context messages Codex injects, such as the AGENTS.md instructions and the environment context. Dropped text never becomes a conversation's title. ChatGPT alternate branches are labelled as alternatives. Imported records are marked as historical so old requests are not treated as new instructions.

**Claude Code memories**: the auto-memory topic files in `~/.claude/projects/*/memory/` (not `MEMORY.md`, which only indexes them), picked by project. Each file becomes one dated note in the memory tree, not part of the prompt. An edited file comes in again as a newer note.

**Duplicates**: re-importing skips messages already present, even if titles or paths changed. A resumed Claude Code session copies earlier messages into its own file; those copies are matched by message id and text, so they come in once, also against messages an earlier import stored. Changed source messages can appear as a separate historical version.

**Pausing**: **Pause import** (or Escape) saves progress, and so does restarting Pi. `/optchat import` then offers **Resume** or **Discard staged import**. While an import is pending, chat in that profile is blocked; other profiles still work. Imports need the main agent and its subagents to be idle.

**Safety**: imports build a new memory generation and switch to it only when the whole tree is ready. The previous generation stays on disk. Source files are never modified.

Damaged or unsupported records are listed before you start, so you can cancel or continue without them. Conversations that disappear during the scan are skipped with a warning.

See OpenAI's guides on [exporting ChatGPT data](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data) and the [conversation file format](https://help.openai.com/en/articles/9106926-transfer-exported-conversations-between-chatgpt-accounts).

## Connected windows

Each profile is locked to one Pi process. If you open the same profile in a second terminal, Pi offers to connect it to the original window as a subagent, or to go back to the profile picker.

- Your first message starts a subagent in the second window's working directory. Later messages continue the same conversation.
- The window looks like a normal Pi chat: replies, tool calls with their output and running time, the working spinner, and reports from the subagent's own agents in the dark box. Ctrl+O expands tool output.
- The subagent runs inside the original process, which stays the only writer of memory. It appears in the original window's inspector and uses one of the 8 agent slots. While it is open, the original window can't switch profile or import.
- The main agent is told when the conversation starts. Use `/tell-main <message>` to message it yourself; the subagent can use `tell_parent`, and the main agent replies with `tell`. Routine turns don't wake the main agent.
- Run `/complete` when done. The window closes, remaining work stops, and the compactor writes a handoff for the main agent: decisions, changes, evidence, failures, unfinished work, and links to the transcripts.
- Closing or force-quitting the window also produces a handoff, marked **interrupted**.
- If the original window is closed cleanly, handoffs are delivered on next start. If it is killed, reopening the profile recovers unfinished handoffs (work is not restarted).
- Text only. For images, give the agent a file path.
- The connection is a local socket restricted to your OS user. No daemon or server.

Handoff limits: the whole transcript is summarized in one call if it fits in about 128,000 input tokens (estimated at 4 bytes per token; less on smaller models), otherwise in chunks. Output is up to 16,000 tokens, with a 5-minute timeout per call. If summarizing fails, a labelled fallback still reports the task, last result, and transcript locations.

## Storage

Profile data lives in `~/.optchat/profiles/<name>/` (override the root with `OPTCHAT_HOME`):

| Path | Contents |
| --- | --- |
| `main/` | The conversation log (dated JSONL, no reasoning) |
| `tree/` | Summary nodes |
| `active-memory.json`, `memories/<id>/` | After an import: pointer to the active `main/` and `tree/`. Older generations are kept. |
| `imports/pending.json` | Resumable import state |
| `AGENTS.md` | Profile instructions |
| `config.json` | Compactor and subagent models |
| `pending-inputs.json`, `pending-reports.json` | Recovery journals |
| `runs/` | Subagent sessions and run metadata |
| `usage.jsonl` | Usage ledger |
| `memory.html` | Snapshot from `/optchat browse` |

Each profile folder is a local Git repository, committed after each turn and on clean shutdown (memory and config; not runs, HTML, or usage). It has no remote, so it is not a backup. To back up, copy the folder while Pi is closed.

To delete a profile, delete its folder. Your original Pi sessions are kept in Pi's normal session directory.

## Good to know

- **Profiles separate memory and instructions only.** Agents keep full filesystem access and share provider credentials.
- **Tab title**: the terminal tab shows the profile and what it is doing: `π personal` while waiting for you, `● π personal` while the agent works, plus `· 2 agents` while subagents run. A connected window shows `↳ personal`, `● ↳ personal`, then `↳ personal · done` or `↳ personal · disconnected`. OptChat replaces Pi's default title and puts its own back when Pi resets it (new session, reload, rename).
- **Use worktrees** when parallel agents edit the same repository; they share the filesystem.
- **Instructions**: the main agent and subagents get Pi's usual global and repository `AGENTS.md` files and your skills, followed by the profile's `AGENTS.md`, which comes last and wins. OptChat replaces only Pi's opening prompt. Prompt templates work in the main session only.
- **Images** are available during the current run but stored in memory as text placeholders.
- **Pi's auto-compaction is off.** A single very long run can still hit the model's context limit; stop it and continue in a new turn.
- **Restarts**: unsent inputs are recovered into memory, and pending subagent reports are delivered. Interrupted subagents are not restarted.
- **Prompt-template inputs** can be saved twice: expanded, and later in their original form as an unanswered input, because Pi expands them after the input journal records them. Skill commands (`/skill:name`) are matched back to their journaled input and don't have this problem. Plain text chat is unaffected.

## How it differs from the recipe

The recipe's four prompts are kept verbatim in `src/prompts.ts` (the view doc adds one sentence: you can zoom out too, from a message to the summaries above it), along with its numbers: 512-byte summary nodes (by default summaries up to 640 bytes are accepted without a retry, as long as they are smaller than what they replace; see Summary size tolerance), a 128,000-byte memory view, binary merges, 8 compression workers, fixed retry delays, 5 shortening attempts, and a 30,000-character tool output cap. Each compactor request shows a 512-byte example line for scale. It is a true line about OptChat itself, labelled as not from the chat and fenced off in `<example>` tags, with the text to summarize in `<input>` tags: shown bare, a made-up example was sometimes summarized as if it were chat and spread up the tree. Anthropic requests get stable cache breakpoints on the view, and when that view is not cached yet, one compactor call goes first and the others wait until it starts answering, so they read the cache instead of each writing it. See `docs/victor-recipe.md` for notes.

Each run's context is the memory view, the previous exchange, and your new message. Deliberate additions (the ones that change the recipe's behaviour are settings, see [Settings](#settings)):

1. **Previous exchange kept verbatim.** Your last request (with any steering) and the final answer are included in full, so "why is that?" refers to what you actually read. Tool calls and reasoning are not carried over. It comes on top of the 128,000-byte view. If it is over 16,000 bytes (about 4,000 tokens, usually a big paste; Previous exchange limit) it is left out entirely, and the model relies on the view and zoom as in Victor's recipe. A new Pi session starts with the memory view only.
2. **Subagents** are built in with Pi's SDK rather than a separate package. With Subagent levels above 1 they can delegate further.
3. **Memory search** (off by default). With the setting on, the agent also gets `search(text, before?)`: plain, case-insensitive text matching over the original messages, never the summaries (a summary can be wrong, and one fact repeats at every level of the tree), skipping logged zoom and search results. It returns 20 hits at a time, newest first, each with its id, the view line that holds it when that is a summary (`1234 (in 1024+256)`), its date and a snippet; `before: id` pages back, and `zoom(id, 1)` reads a hit. One line about it is added to the system prompt. Turning it on or off changes the cached prompt once.
4. **Profiles**, the **inspector**, the **usage ledger**, **import**, and **connected windows** are additions. Import adds historical-record guidance to the prompts.
5. **Not done**: computer use and hosting on an always-on machine.

## Development

```sh
git clone https://github.com/jonaslsaa/pi-optchat.git
cd pi-optchat
npm ci --ignore-scripts
pi install .
```

Restart Pi after source changes. Use `OPTCHAT_HOME` to test against a throwaway data directory.

```sh
npm run check      # type check
npm test           # offline tests, no paid model calls
npm run test:live  # paid Anthropic calls on synthetic data in a disposable profile
```

### Publishing to npm

Pi's [package directory](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) lists npm packages with the `pi-package` keyword, which the manifest already has. GitHub alone is not enough.

Publishing a GitHub release publishes to npm. The [Publish workflow](.github/workflows/publish.yml) uses npm trusted publishing, so no token or `npm login` is involved:

1. Merge a PR that bumps `version` in `package.json`.
2. `gh release create vX.Y.Z --target main --generate-notes`

The workflow checks that the tag matches `package.json`, runs the type check and tests, and publishes with provenance. It skips versions already on npm. To retry a tag, run it by hand: `gh workflow run publish.yml -f tag=vX.Y.Z`.

## Credits and license

Based on [Victor Taelin's OptChat recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) and [OptMem](https://github.com/VictorTaelin/OptMem). This is an independent Pi implementation, not Victor's official OptChat.

MIT licensed. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
