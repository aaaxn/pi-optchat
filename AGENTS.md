# Development rules

pi-optchat is a Pi extension that implements [Victor Taelin's OptChat recipe](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449). This repository is a fork of [jonaslsaa/pi-optchat](https://github.com/jonaslsaa/pi-optchat) that follows the recipe more strictly than upstream.

When sources disagree, follow them in this order:

1. The user's explicit instructions.
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
| 2 | Put a whole message in the view. The view holds summaries only, not even the last reply | `src/memory.ts` |
| 3 | Show cut text for an unsummarized message. A turn or a spawn waits in `settle` until every view line is a summary (§6) | `src/memory.ts`, `src/index.ts` |
| 4 | Call the compactor without the `<chat>` context block (§4.2) | `src/compactor.ts` |
| 5 | Put ids anywhere in a compactor call: not in the context, the step, or `SCALE` | `src/compactor.ts` |
| 6 | Trust the model to count bytes. Use `SCALE`, the cut-at-limit retry, 5 tries, and keep the shortest (§4.3) | `src/compactor.ts` |
| 7 | Shorten summary lines below 512 bytes | `src/memory.ts` |
| 8 | Log model thoughts | `src/transcript.ts` |
| 9 | Put volatile content (dates, state) in the system prompt or tool definitions. They stay byte-identical across calls (§7.2) | `src/index.ts`, `src/tools.ts` |
| 10 | Use 1-hour cache entries or keep-alive pings (§8) | `src/cache.ts` |
| 11 | Carry conversation across turns. Each user message starts a fresh call: system prompt, view, new message (§7) | `src/transcript.ts` |
| 12 | Use exponential backoff in the compactor. A failed node waits 10 s and retries forever (§4.1) | `src/memory.ts` |
| 13 | Write without fsync, or let two processes write one profile. The profile lock is a Unix socket (§2) | `src/memory.ts`, `src/profiles.ts` |
| 14 | Let the compactor follow instructions it reads | `src/prompts.ts` |
| 15 | Build hybrid trees. The tree is purely binary (§3) | `src/memory.ts` |

Accepted deviations from the recipe:

- Pi is the host: its TUI, sessions, and SDK replace the recipe's own harness.
- Profiles give separate memories and instructions.
- Import adapters for Claude Code, Codex, and ChatGPT keep user messages and final replies (§10).
- OpenAI requests send no `prompt_cache_breakpoint`, because the gpt-5.6 models reject it with a 400 error. The view relies on implicit prefix caching.
- `tell` to a finished subagent resumes it with its earlier conversation (from upstream 0.6.6).

## Keep the fork's design

Upstream deviates from the recipe in several places. This fork keeps the recipe's behavior. When you merge upstream or port its code, never bring back the upstream side of these rows:

| Area | This fork (keep) | Upstream (do not take) |
|---|---|---|
| Turn context | The view and the new message only (recipe §7, checklist item 11). `src/transcript.ts` has no previous exchange | The view plus the last exchange (`previousExchange`, `RUN_BOUNDARY`) |
| `settle` | Waits until every view line is a summary (§6) | Also waits until the view fits its budget |
| Who delegates | Only the main agent. Subagents get `zoom`, `date`, and `tell_parent`, with no `spawn` or `tell` (§9) | Subagents delegate two more levels; a parent waits for its children |
| Reports | One spawn, one report: all its subagents' reports reach the main agent as one message (§9) | Each child reports as soon as it finishes |
| `tell_parent` | Always reaches the main agent | Reaches the direct parent |
| Windows | One Pi window per profile, meant to stay open. A second window on a busy profile gets **Back** only | Connected windows, `/tell-main`, `/complete`, and handoff summaries |
| Tab title | Main window only (`src/title.ts`) | Per-window titles and status states |
| OpenAI | `reasoning.context: "all_turns"` (§8). The compactor uses session id `optchat-compactor` over SSE, so its calls share one cache key | No OpenAI settings |
| `SCALE` | A realistic, dense, multi-item line of exactly 512 bytes, tagged with every kind, with no ids or numbers (§4.2). `test/memory.test.ts` checks it | A shorter line padded with dots |
| Import | Claude Code slash-command and shell-command output is dropped; typed commands stay as `/name args` or `!command`. Header: `[Historical <source> · YYYY-MM-DD HH:MMZ · <first 13 characters of the id> · <title>]` | XML wrappers imported as user messages; full id and millisecond timestamp in the header |

[FORK.md](FORK.md) describes each difference for users. Keep this table and FORK.md in sync.

## Sync with upstream

1. Run `git fetch upstream`, then merge `upstream/main` into a branch named `sync-upstream-<version>` in a worktree. Use a merge, not a rebase or a squash, so the next sync starts from the last merge.
2. Resolve each conflict toward the fork for the rows in [Keep the fork's design](#keep-the-forks-design), and take everything else from upstream.
3. Search the merged code for anything those rows exclude, even where git reported no conflict: nesting in tool descriptions, `previousExchange`, connected windows, per-child reports. Also check that the fork's own features survived. The 0.6.3 sync silently dropped `IMPORT_GUIDANCE` from subagent instructions.
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

- After code changes (not docs), run `npm run check` (`tsc --noEmit`) and read the full output. Fix every error before committing.
- `npm test` runs the test suite. It makes no model calls. Run one file with `npx tsx --test test/memory.test.ts`.
- If you create or modify a test file, run it and iterate until it passes.
- A regression test must fail when its fix is reverted. Revert the fix, run the test, and confirm it fails rather than hangs.
- Tests use a temporary `OPTCHAT_HOME`. Never read or write real profiles in `~/.optchat`, and never modify `~/.pi`, `~/.claude`, or `~/.codex`. Import reads those last three and must not change them.
- Write ad-hoc scripts to a temporary file, run them, and remove them when done. Don't embed multi-line scripts in shell commands.
- CI (`.github/workflows/check.yml`) runs `npm ci --ignore-scripts`, `npm run check`, `npm test`, and `npm pack --dry-run`.

## Dependencies

- Treat dependency and lockfile changes as reviewed code. The Pi packages stay pinned to exact versions in `devDependencies`.
- Install with `npm install --ignore-scripts`, or `npm ci --ignore-scripts` for a clean install. Don't run lifecycle scripts unless the user asks.
- If dependency metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- `version` in `package.json` follows the last upstream release merged. Don't bump it in the fork.

## Git

The user's always-on Pi loads this extension from the main checkout. Switching branches there changes the code that Pi runs.

- Keep the main checkout on `main` and clean. Work in a git worktree beside it: `git worktree add ../pi-optchat-<branch> -b <branch> origin/main`, then symlink `node_modules` from the main checkout.
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
