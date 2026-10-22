# pi-orca-strator

A Pi extension for cloning the current session into Orca tabs and worktrees.

## commands

```text
/spawn
/migrate
/migrate <worktree-name>
```

- `/spawn` opens a cloned session in a new tab in the current Orca worktree.
- `/migrate` creates a new worktree from the repository's default branch and opens the cloned session there.
- migrated worktrees keep Orca lineage to the original worktree through `--parent-worktree active`.

The extension waits for Pi to become idle and preserves the current session tree leaf when the persisted session file is not already at that leaf.

## requirements

- Pi with extension support
- the Orca CLI available as `orca`
- a persisted Pi session running in an Orca-managed worktree

The current working directory must be a repository that Orca can manage for `/migrate`.

## install

From a local checkout:

```bash
pi install ./pi-orca-strator
```

From GitHub after publishing:

```bash
pi install git:github.com/eskirk/pi-orca-strator
```

For a one-off local test:

```bash
pi -e ./pi-orca-strator
```

Run `/reload` after installing or changing the extension.

## environment overrides

```bash
ORCA_CLI_COMMAND=/path/to/orca
PI_CLI_COMMAND=/path/to/pi
```

Both default to the command name on `PATH` when unset.
