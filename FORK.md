# How this fork differs from jonaslsaa/pi-optchat

This fork tracks [jonaslsaa/pi-optchat](https://github.com/jonaslsaa/pi-optchat) and merges its changes, except those that conflict with the design below. It follows [Victor Taelin's recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) more strictly and is built for one Pi window that stays open and delegates to every project.

Fixes that suit both designs go upstream. Upstream already took these from the fork: faster memory, `/skill:` inputs, broken `package.json` files, `~` in a spawn's `cwd`, and child cleanup ([#29](https://github.com/jonaslsaa/pi-optchat/pull/29), [#30](https://github.com/jonaslsaa/pi-optchat/pull/30)).

## Turns

| | This fork | Upstream |
|---|---|---|
| A run's context | The memory view and the new message (recipe, checklist item 11). The agent zooms when it needs earlier wording | The memory view, plus the last exchange (your messages and the final answer), with no size bound |
| Waiting for memory | Waits until every view line is a summary (recipe §6) | Also waits until the view fits its budget, which can wait on an unrelated merge |

## Subagents

| | This fork | Upstream |
|---|---|---|
| Who delegates | Only the main agent. Subagents have no `spawn` or `tell` | Subagents may delegate two more levels. A parent waits for its children's reports |
| Reports | One spawn, one report: the results of all its subagents reach the main agent together | Each child reports as soon as it finishes |
| `tell_parent` | Always reaches the main agent | Reaches the direct parent |

## Windows

| | This fork | Upstream |
|---|---|---|
| Same profile in a second terminal | Refused. A new session can go **Back** and pick another profile | Can connect as a subagent conversation in that terminal's directory, with `/tell-main`, `/complete`, and a handoff summary |
| Tab title | Set by the main window only | Set by each window, with its status |

## Cache and compactor

| | This fork | Upstream |
|---|---|---|
| OpenAI Responses APIs | `reasoning.context: all_turns`, so a message that arrives mid-run keeps earlier reasoning. The compactor shares one cache key over SSE | No OpenAI-specific settings |
| Compactor scale line | A realistic 512-byte example with every kind and no ids or numbers (recipe §4.2) | A shorter example padded with dots to 512 bytes |

## Import

| | This fork | Upstream |
|---|---|---|
| Claude Code slash commands, `!` shell commands, and their output | Output is dropped, and so is a slash command without arguments, which never becomes the conversation title. What the user typed is kept as plain `/name args` or `!command` | Imported as user messages with their XML wrappers |
| Codex's own context messages | Dropped from entries and from the title: the AGENTS.md instructions, the environment context, and the other fragments Codex marks as injected | Imported as user messages, so a conversation can be titled `# AGENTS.md instructions for ...` |
| A resumed Claude Code transcript | Listed under its file name. Its copied messages keep the session id they had, so a re-import counts them once | Takes the conversation id from a `sessionId` in the file's first 60 lines |
| Header on each imported message | `[Historical <source> · YYYY-MM-DD HH:MMZ · <first 13 characters of the conversation id> · <title>]`. The full id stays in the structured origin | The full conversation id and an ISO timestamp with milliseconds |
