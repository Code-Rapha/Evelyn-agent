# Change Log

All notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added

- **DEV mode.** The agent can read, write, verify and apply changes to its own
  repository, behind a session the owner opens with a local password.
  - `dev_read`, `dev_write`, `dev_checkpoint`, `dev_restore`, `dev_run` and
    `dev_apply`, each refusing when the session is not active.
  - A checkpoint before every write; a restore that touches only its own
    checkpoint and refuses a file changed afterwards.
  - A repository lock shared across processes. The owner is identified by pid
    and process start time, so a recycled pid does not fool recovery. A lock is
    removed only with evidence the owner is gone.
  - `dev_run`: an allowlist of five programs, approval per command with the
    exact text, timeout, output cap, and the whole process tree killed on stop.
    It runs with the user's permissions — not in a sandbox, and the
    documentation says so.
  - `dev_apply`: applies a prepared operation behind `confirm: true`, with
    checkpoints, required checks and a host reload or restart; a failed
    verification rolls back and keeps the checkpoint.
  - A run history: command, directory, decision, duration, exit code and why it
    ended — never the command's output.

- **Model router.** A policy that picks among declared endpoints or scores
  discovered models, with a circuit breaker, per-attempt budgets and fallback
  that does not lose the turn.

- **Model catalog and budget.** Declared and discovered facts about a model are
  kept apart; a field nobody reported stays unknown instead of being guessed.
  Consumption is recorded per attempt, and a ledger that refuses a write
  reports it rather than rejecting the answer.

- **Local service.** A web service that can own the data root, so the desktop
  connects to it instead of mounting a second Core over the same files. The
  desktop falls back to local mode when the service is absent, and reports the
  failure when it is present but broken.

- **Markdown in answers.** Rendered into DOM nodes, never HTML, so model text
  cannot become markup.

- **Task mode.** A turn can be marked as a multi-step task: a larger round cap
  and a time limit measured by inactivity instead of the clock.

### Changed

- The settings window is sectioned, one at a time, instead of two scrolling
  columns.
- The chat drawer holds conversations, the model picker and the system prompt;
  everything else moved to the settings window.
- `dev_run` no longer reuses an approval across commands, and `dev_apply`
  requires explicit confirmation — both close the "approve one thing, run
  another" gap.

### Fixed

- `run_command` inside an active DEV session was refused with "in use by
  another process" naming its own pid.
- Tool failures that were transient now retry; a task no longer dies on a busy
  lock or a dropped connection.
- Answers were cut short by a round cap counted in provider round-trips.
- `dev_run` failed with `spawn npm ENOENT` on Windows; `.cmd` now goes through
  `cmd.exe` with the path resolved from `PATH` and `PATHEXT`.
- Credential files such as `prod.env`, `.npmrc` and `.git-credentials` were
  readable by the DEV; the policy now covers them.
- The suite ran without a timeout, so 20 process tests failed when run as
  documented.
