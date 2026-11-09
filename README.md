# Evelyn

An AI agent that runs on your machine, talks to the providers you choose, and
can edit its own code under supervision.

Two things live in this repository:

| | |
|---|---|
| **Evelyn** (desktop) | An Electron app: chat, an agent with tools, a model router, a budget ledger and a DEV mode that lets the agent work on this repository. |
| **ModelHub** (VS Code extension) | The original extension: model and provider management inside the editor. |

The Core is shared. Both hosts mount it and differ in what they expose to the
window.

## Running it

```sh
npm install

# The desktop app, from source
npm run desktop:start

# Build a distributable (writes to dist/release/)
npm run desktop:package

# The local service the app connects to when it is not the Core itself
npm run web:build
npm run web:start
```

The packaged app is not the repository. Point it at a checkout with
`MODELHUB_DEV_ROOT` when you want the DEV mode to find the code.

## Tests

```sh
npm run test:core       # everything: ~4 minutes
npm run test:unit       # logic with fakes, ~2 minutes
npm run test:process    # real processes: the service, the DEV lock helpers
npm run test:electron   # real windows, ~2 minutes
npm run test            # the VS Code extension, inside the editor host
```

`test:core` runs 2 651 tests. The split is by what each needs, not by size: a
process that starts a window is slow and says nothing about a pure function.

## The DEV mode

An agent that can change its own source is a different proposition from one
that only answers questions, so the DEV mode is a subsystem of its own:

- **a session**, opened and closed by the owner with a local password kept in
  DPAPI; the agent cannot open it;
- **checkpoints** before every write, and a restore that refuses a file the
  user changed afterwards;
- **a repository lock** shared across processes, with recovery only when the
  owner is provably gone;
- **`dev_run`**, which executes an allowlisted command with approval per
  command, a timeout and an output cap — under the user's permissions, not in
  a sandbox.

`docs/dev-sandbox-limitations.md` records what was measured when we tried to
confine `dev_run` in a Windows AppContainer and what blocked it. The DEV does
not claim an isolation it does not have.

### What is never in this repository

`owner-credential.json`, `unlock.bin`, `secrets.json` and the DEV lock live in
the data directory (`%USERPROFILE%\.modelhub\` on Windows), never in the
checkout. Cloning this repository gives you the code; using the DEV mode
requires configuring your own credential.

## Layout

```
src/core/        the Core: agent, providers, routing, DEV subsystem
src/desktop/     the Electron host and its interface
src/web/         the local service
src/host/vscode/ the VS Code extension host
src/app/         assembly shared by the hosts
src/adapters/    storage, secrets, logging
src/core-tests/  the Core suite
src/test/        the extension suite
docs/            decisions and limitations
```
