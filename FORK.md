# How this fork differs from jonaslsaa/pi-optchat

This fork tracks [jonaslsaa/pi-optchat](https://github.com/jonaslsaa/pi-optchat) and merges its changes, except those that conflict with the design below. It follows [Victor Taelin's recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449) more strictly and is built for one Pi window that stays open and delegates to every project.

Fixes that suit both designs go upstream. Upstream already took these from the fork: faster memory, `/skill:` inputs, broken `package.json` files, `~` in a spawn's `cwd`, and child cleanup ([#29](https://github.com/jonaslsaa/pi-optchat/pull/29), [#30](https://github.com/jonaslsaa/pi-optchat/pull/30)).

## Turns

| | This fork | Upstream |
|---|---|---|
| A run's context | The memory view and the new message (recipe, checklist item 11). The agent zooms when it needs earlier wording | The memory view, plus the last exchange in full, with no size bound |
| Waiting for memory | Waits until every view line is a summary (recipe §6) | Also waits until the view fits its budget, which can wait on an unrelated merge |

## Subagents

| | This fork | Upstream |
|---|---|---|
| Who delegates | Only the main agent. Subagents have no `spawn` or `tell` | Subagents may delegate two more levels. A parent waits for its children's reports |
| Reports | One spawn, one report: its children's results reach the main agent together | Each child reports as soon as it finishes |
| `tell_parent` | Always reaches the main agent | Reaches the direct parent |

## Windows

| | This fork | Upstream |
|---|---|---|
| Same profile in a second terminal | Refused. A new session can go **Back** and pick another profile | Can connect as a subagent conversation in that terminal's directory, with `/tell-main`, `/complete`, and a handoff summary |

## Long-lived sessions and cost

| | This fork | Upstream |
|---|---|---|
| Pi's in-process transcript | Dropped once it passes 2 MB, because Pi copies it on every model call. The session file keeps every entry | Grows for the whole session |
| OpenAI Responses APIs | `reasoning.context: all_turns`, so a message that arrives mid-run keeps earlier reasoning. The compactor shares one cache key over SSE | No OpenAI-specific settings |
| Compactor scale line | A dense 512-byte example (recipe §4.2) | A shorter example padded with dots |
