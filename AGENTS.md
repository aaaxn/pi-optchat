# Development rules

pi-optchat is a Pi extension that implements [Victor Taelin's OptChat recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449). This repository is a fork of [jonaslsaa/pi-optchat](https://github.com/jonaslsaa/pi-optchat) that follows the recipe more strictly than upstream.

When sources disagree, follow them in this order:

1. The user's explicit instructions. Before overriding a rule here, ask for confirmation (see [User override](#user-override)).
2. The recipe.
3. The fork's design, listed in [Keep the fork's design](#keep-the-forks-design) and in [FORK.md](FORK.md).
4. Upstream.

## Conversational style

- Keep answers short and concise.
- No emojis in commits, issues, PR comments, or code.
- No fluff or cheerful filler text.
- Technical prose only. Be direct.
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, say whether you agree or disagree before saying what you changed.
- Reply in the language of the user's message. Code, identifiers, commits, and repository docs stay in English.

## Follow the recipe

Read the recipe before changing memory, the compactor, the view, turns, caching, subagents, or import. Fetch the current text with:

```sh
gh api gists/91837951a5ce5b38f341ec1ba1df6449 --jq '.files[].content'
```

[docs/victor-recipe.md](docs/victor-recipe.md) maps the recipe to the source files. The recipe tells implementers to follow it exactly and to deviate only for a reason it does not already refute. If a change would deviate from the recipe, stop and ask the user. Record an accepted deviation in `docs/victor-recipe.md`.

The recipe's four prompts (`COMPACT`, `MASTER`, `VIEW_DOC`, `SUBAGENT`) are verbatim in `src/prompts.ts`. Never reword them.

Its constants stay as the recipe sets them:

| Name | Value | Where |
|---|---|---|
| `NODE` | 512 bytes per summary line | `src/memory.ts` |
| `VIEW` | 128,000 bytes of view | `src/memory.ts` |
| `CAP` | 30,000 characters per tool result | `src/memory.ts` |
| Cache marks | 50,000, 80,000, and 100,000 characters into the view | `src/cache.ts` |

The recipe's checklist (§11), with where this code enforces each item:

| # | Never | Where |
|---|---|---|
| 1 | Recompute the view to fit the budget. Append, merge the most due pair, and never split (§5.2) | `src/memory.ts` |
| 2 | Put a whole message in the view. The view holds summaries only, not even the last reply. A message of at most 512 bytes is its own summary, word for word (§3) | `src/memory.ts` |
| 3 | Show cut text for an unsummarized message. A turn or a spawn waits in `settle` until every view line is a summary (§6) | `src/memory.ts`, `src/turn.ts`, `src/agents.ts` |
| 4 | Call the compactor without the `<chat>` context block (§4.2) | `src/memory.ts`, `src/compactor.ts` |
| 5 | Put ids anywhere in a compactor call: not in the context, the step, or `SCALE` | `src/memory.ts`, `src/compactor.ts` |
| 6 | Trust the model to count bytes. Use `SCALE`, the cut-at-limit retry, 5 tries, and keep the shortest (§4.3) | `src/compactor.ts` |
| 7 | Lower `NODE` below 512 bytes. 128-byte lines were too short to be useful | `src/memory.ts` |
| 8 | Log model thoughts | `src/transcript.ts` |
| 9 | Put volatile content (dates, state) in the system prompt or tool definitions. They stay byte-identical across the calls of a session (§7.2) | `src/index.ts`, `src/profiles.ts`, `src/tools.ts` |
| 10 | Use 1-hour cache entries or keep-alive pings (§8). Pi's cache warming is off and the compactor uses short retention | `src/index.ts`, `src/cache.ts`, `src/agents.ts`, `src/compactor.ts` |
| 11 | Carry conversation across turns. Each user message starts a fresh call: system prompt, view, new message (§7) | `src/transcript.ts`, `src/turn.ts` |
| 12 | Use exponential backoff in the compactor. A failed node waits 10 s and retries forever (§4.1) | `src/memory.ts` |
| 13 | Write without fsync, or let two processes write one profile. The profile lock is a Unix socket (§2) | `src/memory.ts`, `src/profiles.ts` |
| 14 | Let the compactor follow instructions it reads | `src/prompts.ts` |
| 15 | Build hybrid trees. The tree is purely binary (§3) | `src/memory.ts` |

Accepted deviations from the recipe:

- Pi is the host: its TUI, sessions, and SDK replace the recipe's own harness.
- Pi's prompt sections (global and repository `AGENTS.md` files, skills, working directory) follow the recipe's preamble, so the system prompt depends on where Pi runs.
- Subagents also get `tell_parent`, to reach the main agent while they run.
- Profiles, the inspector, the usage ledger, and import are additions. Import keeps user messages and final replies, as the recipe's reference did (§10), through adapters for Claude Code conversations and memories, Codex, and ChatGPT.
- OpenAI requests send no `prompt_cache_breakpoint`, because the gpt-5.6 models reject it with a 400 error. The view relies on implicit prefix caching.
- `tell` to a finished subagent resumes it with its earlier conversation (from upstream 0.6.6).
- Not done: computer use and hosting on an always-on machine.

The README section "How it differs from the recipe" describes these for users. Keep it in sync with this list.

## Keep the fork's design

Upstream deviates from the recipe in several places. This fork keeps the recipe's behavior. When you merge upstream or port its code, never bring back the upstream side of these rows:

| Area | This fork (keep) | Upstream (do not take) |
|---|---|---|
| Turn context | The view and the new message only (recipe §7, checklist item 11). `src/transcript.ts` has no previous exchange | The view plus the last exchange (`previousExchange`, `RUN_BOUNDARY`) |
| `settle` | Waits until every view line is a summary (§6) | Also waits until the view fits its budget |
| Who delegates | Only the main agent. Subagents get `zoom`, `date`, and `tell_parent`, with no `spawn` or `tell` (§9) | Subagents delegate two more levels; a parent waits for its children |
| Reports | One spawn, one report: the final reports of all its subagents reach the main agent as one message (§9). `tell_parent` messages and a resumed subagent's report arrive on their own | Each child reports as soon as it finishes |
| `tell_parent` | Always reaches the main agent | Reaches the direct parent |
| Windows | One Pi window per profile, meant to stay open, with a tab title for the main window only (`src/title.ts`). On a busy profile, a new session gets only **Back**, and a resumed session gets an error | Connected windows, `/tell-main`, `/complete`, handoff summaries, and per-window titles and status states |
| OpenAI | `reasoning.context: "all_turns"` (§8). The compactor uses session id `optchat-compactor` over SSE, so its calls share one cache key | No OpenAI settings |
| `SCALE` | A realistic, dense, multi-item line of exactly 512 bytes, tagged with `user`, `talk`, `tool`, `echo`, and `work`, with no ids or numbers (§4.2). `test/memory.test.ts` checks it | A shorter line padded with dots |
| Import | An import keeps what the user typed and drops the text each source adds around it. For Claude Code, slash-command and shell-command output is dropped, typed commands stay as `/name args` or `!command`, and a slash command without arguments is dropped and never becomes the title. For Codex, the context messages it injects (AGENTS.md instructions, environment context, and the other fragments in `codexContext`) are dropped from entries and titles. A resumed Claude transcript is listed under its file name, and its copied messages keep the session id they had, so a re-import counts them once. Conversation header: `[Historical <source> · YYYY-MM-DD HH:MMZ · <first 13 characters of the id> · <title>]`; the full id stays in the structured origin | XML wrappers and Codex's injected messages imported as user messages; a conversation id taken from a `sessionId` in the file's first 60 lines; full id and millisecond timestamp in the header |

[FORK.md](FORK.md) describes each difference for users. Keep this table and FORK.md in sync.

## Sync with upstream

1. Run `git fetch upstream`, then merge `upstream/main` into a branch named `sync-upstream-<version>` in a worktree. Use a merge, not a rebase or a squash, so the next sync starts from the last merge.
2. Resolve each conflict toward the fork for the rows in [Keep the fork's design](#keep-the-forks-design), and take everything else from upstream.
3. Run `npm test` before you read the merge. `test/fork.test.ts` fails on the rows it covers (see [Rules and their enforcement](#rules-and-their-enforcement)). Then search the merged code for the rows no test covers, even where git reported no conflict: connected windows, per-child reports, `tell_parent` reaching the direct parent, the `settle` budget wait, and the OpenAI settings. Also check that the fork's own features survived.
4. Update FORK.md: remove rows that upstream adopted and add new differences.
5. Run `npm run check` and `npm test`.
6. Merge the sync PR with a merge commit. Squash ordinary PRs.

A fix that suits both designs can go upstream. Show the user the diff and the PR text before opening anything on jonaslsaa/pi-optchat, and open it only after the user agrees.

## Code quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check `node_modules/@earendil-works/pi-*` for Pi's API types. Don't guess.
- No inline imports (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps. Upgrade the dep instead.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Match the surrounding code: dense lines, few comments, and comments that record why, such as the recipe section a rule comes from.

## Commands

- After code changes (not docs), run `npm run check` and read the full output. It runs `tsc --noEmit` and then the lint in `scripts/lint.ts`. Fix every error before committing.
- `npm test` runs the test suite. It makes no model calls. Run one file with `npx tsx --import ./test/support.ts --test test/<name>.test.ts`. The `test-sandbox` lint rule enforces the sandbox import in every test file.
- If you create or modify a test file, run it and iterate until it passes.
- A regression test must fail when its fix is reverted. Revert the fix, run the test, and confirm it fails rather than hangs.
- Build test providers, runtimes, and `Children` with `fakeProvider`, `fakeRuntime`, and `makeChildren` from `test/fakes.ts`.
- Never read or write `~/.optchat`, and never modify `~/.pi`, `~/.claude`, or `~/.codex`. The test sandbox keeps the suite away from them. Import reads `~/.claude` and `~/.codex`, and subagents read `~/.pi` through Pi.
- Write ad-hoc scripts to a temporary file, run them, and remove them when done. Don't embed multi-line scripts in shell commands.
- CI (`.github/workflows/check.yml`) runs `npm ci --ignore-scripts`, `npm run check`, `npm test`, and `npm pack --dry-run`.

## Rules and their enforcement

Each row names a rule, the mistake that produced it, and what fails when you break it. `npm run check` runs `tsc --noEmit`, then `scripts/lint.ts` over `src` and `test`. `npm test` runs the suite. A rule in another section of this file with no row here relies on review.

| Rule | Mistake it came from | What fails |
|---|---|---|
| Write `NODE`, `VIEW`, and `CAP` only in `src/memory.ts`. Everywhere else, import them | `30_000` repeated in the run context, which `5bbc93c` replaced with `CAP` | Lint rule `recipe-literal` fails a numeric literal equal to 512, 128,000, or 30,000 in any file of `src` or `test` except `src/memory.ts` and `src/prompts.ts` |
| Only `Memory.render()` spells the view tags `<chat>` and `</chat>` | A summary that quoted `</chat>` cut the cache marks from four to one, because the cache code searched the text for the closing tag | Lint rule `view-tag-owner` fails a string, template, or regular-expression literal that holds either tag, outside `src/memory.ts` and `src/prompts.ts`. `cachePayload` marks the view blocks by identity, and the test `stable cache cuts preserve every character and cap marks at four` quotes the closing tag in a summary |
| Compose agent instructions only in `agentInstructions()` in `src/profiles.ts` | `IMPORT_GUIDANCE` was joined in three places, and a sync dropped it from subagents | Lint rule `import-guidance-owner` fails an import of `import/guidance` outside `src/profiles.ts`, `src/compactor.ts`, and `test/fork.test.ts`. Two fork tests check the composed text (see [Fork design checks](#fork-design-checks)) |
| Change a run's `state` only through `transition()` in `src/runs.ts` | Seven places wrote `RunInfo.state`, so a second stop rewrote a completed run to `stopping` | Lint rule `run-state-owner` fails an assignment to `.state` outside `src/runs.ts`. The `moves` table is a `Record<RunState, readonly RunState[]>`, so a new state does not compile until it lists its moves. `transition()` returns false for a move the table lacks, and the finished states move nowhere. Tests: `a stop that arrives while a finished child shuts down leaves it completed` and `a tell that loses the race with the child finishing is refused, not reported as queued` |
| Put per-source import behavior in the adapter table in `src/import/sources.ts` | 25 `source === '<name>'` branches, so a fifth source silently produced no entries | Lint rule `source-branch` fails a comparison of `.source` with an import source name, or a `case` on `.source`, outside `src/import/sources.ts`. It reads the names from `Origin` in `src/memory.ts` and fails when it finds none |
| Give every `Origin` source an adapter with every part | The same silent source with no adapter | `adapters satisfies Record<Source, Adapter>` fails `tsc` when a source lacks an adapter or an adapter lacks a part. The test `a source added to Origin without an adapter fails tsc` adds a fifth source and expects that error |
| Take a source's label in the memory browser from its adapter | `src/browser.ts` kept a second per-source name map | The required `Adapter.browserLabel` field fails `tsc` when an adapter lacks it, and `exportBrowser` reads each label from `adapters`. The test `the memory page names an imported message's source with the label from the adapter table` checks the page |
| Let one process write a profile's log. Stop a second writer before it writes | Two Pi processes on one profile, locked under different `TMPDIR`s, corrupted a log until it would not open | `appendJson(file, value, size)` throws when the file's size is not `size`, and nothing is written. `Memory.lastSeenBytes` holds the size of each log file that `Memory` loaded or wrote, and `append` passes it. `checkLog` runs before the first write to a day file that `Memory` has not seen, and throws when any known log file changed size or a new one appeared. Tests: `appendJson appends without a size, and with one it refuses a file of any other size`, `a second writer on one profile is refused before it writes, and the profile still opens`, and `a second writer that got past the lock is refused on its next turn, with the log intact` |
| Keep the memory log's order, sizes, and files true to its entries | A timezone change made a profile refuse to open. A torn last line swallowed the next record. `cap` split a surrogate pair. Newline runs inflated the view size. A checkpoint wrote `.gitignore` only at `git init` | Tests in `test/memory.test.ts` and `test/checkpoint.test.ts`: `a log whose day files sort against the order of the entries still opens, and a broken one does not`, `an append ends an unterminated last line, in every file, and counts the byte it wrote`, `cap never cuts a surrogate pair in half`, `cap states exactly how many characters it omitted and stays within the limit`, `view size counts the flattened text that render emits, for new and reloaded summaries`, and `a checkpoint writes the ignore file whenever it is missing, and never replaces one` |
| Settle before a turn, and send only the view and the new message (recipe checklist items 3 and 11) | The turn state lived in a closure of `src/index.ts`. A stopped wait for summaries left its working message on every later spinner | `test/turn.test.ts` runs `Turn` against a real `Memory`: `a turn waits until every view line is a summary, then sends the view (checklist 3)`, `the context holds the view and the current run only, and the view stays fixed during the run (checklist 11)`, and `an aborted wait for summaries clears the working message and refuses the turn (B4-F)` |
| Import only what the user wrote, and count a message once | Codex's injected context became conversation titles, a resumed Claude transcript imported its copied messages again, and a time without a zone moved with the machine's zone | Tests in `test/import.test.ts`: `Codex titles and entries skip the contextual messages Codex injects, and keep what the user typed`, `a resumed Claude transcript is listed under its file name, and its copied messages keep the old session key so they import once`, and `a time without a zone is UTC whatever the machine zone` |
| Reject a usage record on write that a reload would reject, and keep future-dated records in All time | A NaN cost passed `add` and vanished on reload | Tests in `test/usage.test.ts`: `add rejects a record that a reload would reject, so totals match after a restart` and `All time keeps entries dated after now` |
| Let the import picker's filter hold a space | Space always toggled, so a filter such as `pi optchat` could not be typed | Test in `test/multi-select.test.ts`: `Space types into a non-empty filter, toggles on an empty one, and Tab always toggles` |
| Handle every error, or list the site in `exceptions` | Failure paths that hid an error instead of reporting it | Lint rule `swallowed-error` fails an empty `catch` block and a `.catch(() => {})`. See [Lint exceptions](#lint-exceptions) |
| Run tests in fresh temporary `HOME`, `OPTCHAT_HOME`, and `PI_CODING_AGENT_DIR` directories | An agent ran `rm -rf` in `~`, and test isolation was prose only | `npm test` loads `test/support.ts` into each test file's process. It points the three variables at new temporary directories and removes them at exit. Lint rule `test-sandbox` fails a `test/*.test.ts` file that does not import `./support.ts` or `./fakes.ts` before its first import from `../src/` or `@earendil-works/`, so a single-file run is isolated too. `test/support.test.ts` checks the directories, their removal, and the lint rule |

### Fork design checks

`test/fork.test.ts` loads the extension against a fake Pi and fails when an upstream sync brings back a design the fork rejects. A failure names the AGENTS.md row it breaks. Two tests read this file, so keep the rows of [Keep the fork's design](#keep-the-forks-design) and the constants table.

| Test | What it asserts |
|---|---|
| `spawn never allows subagents to delegate` | The main agent's `spawn` description has no wording about nesting, levels, or delegation (row "Who delegates") |
| `the only registered command is optchat` | The extension registers one command, `optchat` (row "Windows") |
| `a turn sends the view and the new message, never the previous exchange` | `src/transcript.ts` exports no `previousExchange`, and `buildContext` ignores a fifth argument that holds the previous exchange (row "Turn context") |
| `a subagent gets zoom, date and tell_parent beside Pi's built-ins, and cannot spawn or tell` | A spawned child has the tools `zoom`, `date`, and `tell_parent` beyond Pi's built-ins (row "Who delegates") |
| `AGENTS.md states the NODE, VIEW and CAP the code uses` | The constants table matches `NODE`, `VIEW`, and `CAP` in `src/memory.ts` |
| `AGENTS.md states the cache marks where splitView cuts the view` | The cache marks in the constants table are where `splitView` cuts a view |
| `the main agent gets the profile instructions followed by IMPORT_GUIDANCE` | The main agent's `instructions` section is the profile's `AGENTS.md`, then `IMPORT_GUIDANCE` |
| `a subagent gets the profile instructions followed by IMPORT_GUIDANCE` | A spawned child's system prompt holds the same text |

### Lint exceptions

The `exceptions` list in `scripts/lint.ts` holds each allowed hit as `{ file, rule, count, reason }`. The lint fails when a file has more hits of a rule than its entry allows, and when an entry allows more than the file has, so a stale entry fails too. No comment in the code silences a rule. Adding or raising an entry needs the user's approval. Add one only when the code is right as it is, and name each added or raised entry with its reason under a `## Lint exceptions` heading in the PR description.

### Rules no check can hold

These two need judgment, so the review holds them.

- Measure a performance guess before you ship it. Time the old and the new code under the same load and report the numbers. `a171b00` bounded Pi's in-process transcript at 2 MB to save a clone. `e838c70` reverted it after measuring about 1 ms per MB, less than the size check cost.
- Run a verifier subagent only for a behavior change or a change across several files. For a doc edit, a one-line refactor, or a config or ignore-file change, read the diff and run the fast checks yourself.

## Dependencies

- Treat dependency and lockfile changes as reviewed code. The Pi packages stay pinned to exact versions in `devDependencies`.
- Install with `npm install --ignore-scripts`, or `npm ci --ignore-scripts` for a clean install. Don't run lifecycle scripts unless the user asks.
- If dependency metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- `version` in `package.json` follows the last upstream release merged. Don't bump it in the fork.

## Git

The user's always-on Pi loads this extension from the main checkout. Switching branches there changes the code that Pi runs.

- Keep the main checkout on `main` and clean. Work in a git worktree at `.worktrees/<branch>`: run `git worktree add .worktrees/<branch> -b <branch> origin/main` from the main checkout, then symlink `node_modules` from the main checkout.
- After a merge, run `git pull --ff-only` in the main checkout, then remove the worktree and delete the local and remote branch. Pi loads the new code when it restarts. A paused import resumes from its staging file.
- Commit only when the user asks.
- Commit only files you changed in this session. Stage explicit paths (`git add <path>`). Never `git add -A` or `git add .`.
- Run `git status` before committing and check that only your files are staged.
- Message format: `{feat,fix,docs,test,refactor,chore}: <message>`, such as `fix: keep the start of the conversation id in the import header`. The message is informative and concise, and says what changed in behavior.
- No AI attribution: no `Co-Authored-By` trailers and no generated-with lines in commits, PRs, or comments.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or `git commit --no-verify`.
- Never force push. If a rebase conflicts in a file you did not modify, abort and ask the user.

## Issues and PRs

- Open PRs on the fork, aaaxn/pi-optchat, unless the user approves an upstream PR (see [Sync with upstream](#sync-with-upstream)).
- When reviewing a PR, don't run `gh pr checkout` or `git switch` unless the user asks. Use `gh pr view`, `gh pr diff`, `gh api`, and `git show <ref>:<path>` against fetched refs.
- Write issue and PR comments to a temporary file and post them with `--body-file`, never multi-line markdown through `--body`.
- Keep comments concise, technical, and in the user's tone.
- To close an issue from a commit, include `fixes #<number>` or `closes #<number>`, repeating the keyword for each issue.

## User override

If the user's instructions conflict with a rule in this document, ask for explicit confirmation before overriding it. Only then follow their instructions.
