# pi backend (experimental)

[Documentation index](README.md) · [中文](pi-backend.md) · [Agent backends](agent-backend-design.md)

dsh-TUI can front your own [pi](https://github.com/earendil-works/pi): the
interface stays the same while the session runs on your `pi` — one
`pi --mode rpc` child per session, speaking JSONL over stdio. pi loads its own
settings, models and logins, extensions, skills, prompt templates and
`AGENTS.md`; session files are shared with pi, so there is no history to migrate.

> This page describes the current development branch, not a release. The
> validated baseline is **pi 0.87.1**, the minimum **0.84.4**; other versions run
> with a drift notice. What was and was not verified is listed at the end.

## Install and start

Install dsh-TUI as in [Getting started](getting-started.en.md), then install and
set up your own pi:

```sh
npm install -g @earendil-works/pi-coding-agent   # or pi.dev's install script
pi                                               # /login or set an API key in pi, check that it answers
dsh-tui --backend pi
```

- dsh-TUI bundles no pi and does not depend on pi's SDK package. It looks for
  `pi` on `PATH`; `DSH_TUI_PI_EXECUTABLE` selects an executable. On Windows the
  npm launcher (`pi.cmd`) resolves to pi's JS entry, run with the current Node.
- The launchpad "Kernel" entry, `/kernel` or `/pi` switch to pi, and the choice
  is remembered. A dsh-tui config row `backend: pi` or `DSH_TUI_BACKEND=pi` work
  too. One process runs one backend; switching restarts.
- Your pi directory (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) is used as
  is: settings, models, logins, extensions, skills and prompt templates apply.
  dsh-TUI **does not write pi's configuration**, except pi's `trust.json` when
  you answer the trust question with a choice to remember (see below); its own
  preferences (last session, `/color`) live in
  `~/.dsh-tui/backends/pi/prefs.json`.

Resume a session pi or dsh-TUI started:

```sh
dsh-tui --backend pi --resume <session-id>
dsh-tui --backend pi --resume        # the pi session dsh-TUI used last on this machine
pi --session <session-id>            # back to pi's own interface
```

- A resume opens the session file by path. An unknown session, or one whose
  recorded working directory is gone, fails loudly and exits; no new session is
  started instead. The session's recorded directory is used.
- `/resume` lists pi's sessions (the current project by default), titled by
  pi's `/name` or else the opening prompt.
- The replay reads every entry of the session file's current branch: history a
  compaction folded away stays visible, and the summary shows as a checkpoint.

## What works

| Feature | Notes |
| --- | --- |
| Streaming replies and thinking | Thinking shows as thinking rows |
| Tool cards | `read`/`write`/`edit`/`bash`/`grep`/`find`/`ls`/`powershell` get dedicated cards: `edit` shows pi's unified patch, `bash` live output and the exit code; extension and MCP tools use the generic card |
| Queueing and steering | A message sent mid-run joins pi's follow-up queue; a steer joins the **running turn** after the current tool calls, before the next model call; pending messages show in the queue |
| Interrupt | Esc interrupts the turn and keeps what pi queued; "interrupt and clear" clears pi's queue first |
| `/model`, `/effort` | Provider tabs as on DSH (recents plus one tab per signed-in pi provider; `/model provider/model` switches directly); the same model id under two providers is two entries. Effort is pi's thinking level (the values the model offers), clamped the way pi clamps it on a switch |
| `/compact`, `/context` | pi compacts and its summary shows as a checkpoint; context usage comes from pi's session stats |
| `/` commands | pi's extension commands, prompt templates and skills (`/skill:name`) join the command list and run or expand as in pi |
| Extension dialogs | An extension's select / confirm / input / editor show on the questionnaire panel, notify as a notice; a dialog with a timeout closes when it expires |
| Images | Pasted or `@`-mentioned images go with the message; pi resizes them to the model's limits |
| `/rename`, `/color`, `/doctor` | Renames are written to the pi session; colours stay local; `/doctor` shows pi's path, version, session file and model |
| Project trust, `/trust` | The trust question pi's own interface asks shows on the questionnaire panel, with pi's choices; `/trust` reopens it anytime. See "Project trust" below |
| `/fork`, double-`Esc` rewind | `/fork` copies the current branch into a new session and leaves the current one alone; a rewind copies the conversation before the picked message into a new session, switches to it and puts the message back in the composer. Only the conversation rewinds, not files (pi keeps no file snapshots) |
| Session browser | Listing, preview, rename (a `session_info` entry, as pi's `/name` writes) and delete (to the trash when a `trash` command exists, as pi's `/resume` does) |

## Differences from native pi and limitations

- **No tool approval**: pi does not ask before running tools, and dsh-TUI does
  not intercept either (`/permission` reports it unsupported). For
  confirmations, install a permission-gate style pi extension; its dialogs show
  on the questionnaire panel.
- **Sign in through pi**: RPC has no login. With no usable model pi exits at
  startup and dsh-TUI shows pi's own message; use `pi`'s `/login`, or set the
  provider's API key variable.
- An extension's custom components (`ctx.ui.custom()`), status line and widgets
  (`setStatus`/`setWidget`) and editor-text edits do not show in dsh-TUI.
- pi's own interface commands (`/tree`, `/settings`, `/login`, …) do not go
  through RPC; pi itself has no subagents or background tasks.
- One pi child per session. If it exits unexpectedly, that session takes no
  more messages; reopen it with `/resume`.

## Project trust

Settings, MCP config, extensions, skills, prompt templates, themes and system
prompts under a project's `.pi/` (and `.agents/skills` in the project or a
parent folder) load only when pi trusts the project. pi's own interface asks
about a project it has no decision for; RPC mode does not ask and treats it
as untrusted. dsh-TUI asks for pi:

- When a session opens on a project with such resources, no decision for it
  (or a parent) in pi's `trust.json`, and `defaultProjectTrust` at its default
  `ask`, the questionnaire panel lists what was found and offers pi's five
  choices: Trust, Trust parent folder, Trust (this session only), Do not trust,
  Do not trust (this session only).
- Trust, Trust parent folder and Do not trust are remembered: written to pi's
  `trust.json` in pi's format, under pi's lock, shared with pi's own
  interface. The two session-only choices write nothing and last for this run:
  later sessions in the same folder follow them (the child gets `--approve` /
  `--no-approve`), and the next launch asks again.
- pi settles trust only at startup, so a choice that changes what was loaded
  restarts the pi child on the **same session**: the conversation, session id
  and file stay, and the project's prompt templates, skills and extensions
  appear or go. A running turn finishes first.
- Dismissing the opening question leaves the project untrusted for this run,
  as dismissing pi's prompt does. `/trust` reopens the question anytime and
  says whether the project's resources are loaded; dismissing it changes
  nothing.
- With `defaultProjectTrust` set to `always` / `never` in pi's settings, or a
  decision already in `trust.json`, nothing is asked. A global or CLI
  extension's `project_trust` handler that decides otherwise wins, as in pi.

## Data and environment

- Session files are pi's own: `~/.pi/agent/sessions/--<dir>--/<time>_<id>.jsonl`
  (or `PI_CODING_AGENT_SESSION_DIR`, or the `sessionDir` of pi's global
  settings). dsh-TUI reads them, and writes only on three user actions: `/fork`
  and the rewind write a new file in pi's session format (a new header plus the
  branch's entries copied as they are, as pi's own fork does), a rename from the
  session browser appends a `session_info` entry, and a delete removes the file.
  The current session renames through its pi child.
- The only file written in pi's directory is `trust.json`, and only for a
  trust choice you asked to remember (see "Project trust").
- The child inherits your environment minus what a parent pi session exports
  to its tool processes (`PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`,
  `PI_MODEL`, `PI_REASONING_LEVEL`, `PI_CODING_AGENT`): dsh-tui may itself run in
  a terminal inside a pi session.
- pi's stderr goes to the debug log and deduplicated notices only, never to
  the terminal.

## Verification scope

- **Verified**:
  - An end-to-end run of the local pi 0.87.1 on a scripted faux model (no
    network, no charge), `scripts/verify-pi-live.ts`, 55 checks: a tool turn,
    extension dialogs, thinking level, interrupt, a steer joining the running
    turn, `/fork` and rewind (real pi opens the files they write), offline
    rename and delete, a resume that replays and continues, and project trust
    (real pi leaves the project's prompt template out until the answer, the
    restarted pi loads it and runs it on the same session, and reads the
    `trust.json` written).
  - A real provider: `deepseek/deepseek-flash` through `scripts/verify-pi-real.ts`
    (25 checks; only cheap tiers such as flash/mini/haiku run, in a throwaway
    agent directory, with the credential from the environment): a plain reply,
    bash and edit tools (the file really changes), thinking, an interrupt, a
    steer, `/context`, a real compaction, a resume that continues after it, and a
    fork; the TUI also ran on the same model in a real terminal.
  - CI regressions: live/replay agreement over recorded fixtures
    (`verify-pi-translate`), the session layer on a fake child
    (`verify-pi-session`, including every trust choice, `trust.json`'s format
    and lock, the restart and the restart after a turn, and `/trust`), the
    offline catalog (`verify-pi-catalog`), and the cross-backend event
    invariants.
- **Not verified**: a run with your own full set of pi extensions (such as
  `pi-permission-system` or a memory extension; the real run was isolated on
  purpose so nothing reached your memories or settings), pi 1.x on a real
  machine (aligned with the protocol docs and source only; newer fields are read
  as optional), and Windows.
