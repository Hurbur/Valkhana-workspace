# Hermes upgrade and rollback runbook

Last updated: 2026-08-17 UTC
Current live revision: v0.20.0 / `f5be9236e00ddf2f2a412697f267078fc4ee068e`
Qualified candidate: v0.20.2 / `341d5aebc6f51b8073f6099008e8d24bc74a8b0c`
Status: **promotion attempted and rolled back safely; messaging gate failed**

## 2026-08-17 maintenance execution record

- Maintenance window authorization: 2026-08-17 through 2026-08-20 UTC.
- Fresh live backup: `/mnt/data/backups/valkhana/hermes/20260817T062511Z/hermes-live-v0.20.0-20260817T062511Z.zip`, mode `0600`, 98,057,556 bytes, SHA-256 `bc2723a288b93428c57b89ac7d94db23debc459f9a82440a2ed3599e396fb406`.
- The isolated restore preserved `state.db`, the default board, and the canary board byte sizes/task counts; every SQLite integrity check returned `ok`.
- v0.20.2 was promoted through the `current` release pointer and ran under the reviewed unit with private temporary storage, a restrictive umask, no-new-privileges, and bounded memory/tasks.
- Doctor, dependency, board, and zero-finding security gates passed. Telegram first failed with `Any cannot be instantiated`, then remained at `Connecting to Telegram (attempt 1/8)` without confirming a platform.
- Immediate rollback restored exact v0.20.0 commit `f5be9236e00ddf2f2a412697f267078fc4ee068e`, prior unit hash `aff66a9abf6fa16c43ca1ae9a2a54b55d45e86185ef4405cd501460df091b255`, and an active gateway. Board counts were unchanged, so no data restore was necessary.
- Messaging health is still unproven after rollback: v0.20.0 also remained on its first Telegram connection attempt. General Telegram HTTPS connectivity succeeded, pointing next diagnosis at adapter/plugin loading rather than basic network reachability.

The live checkout is dirty and the gateway unit directly references its embedded venv. Never run `hermes update`, `git pull`, or dependency upgrades in that directory. Promotion must be a release-directory switch with an immediately reversible unit change.

## Current deployment findings

- Gateway unit: `~/.config/systemd/user/hermes-gateway.service`.
- Live command: `~/.hermes/hermes-agent/venv/bin/python -m hermes_cli.main gateway run`.
- Persistent state and credentials: `HERMES_HOME=~/.hermes`.
- Live code and venv directories are currently group-writable (`0775`).
- The service file is `0664`; the CLI wrapper is `0775` and path-coupled to the live checkout.
- `systemd-analyze --user security` reports `9.8 UNSAFE`; the unit has almost no sandbox or resource controls.
- The gateway carries live messaging integrations, so a restart requires an announced maintenance window.
- `gateway run` is not isolated by `HERMES_HOME`: a v0.20.2 candidate launch rewrote the global `~/.config/systemd/user/hermes-gateway.service` to candidate paths. The original unit was restored and daemon-reloaded without restarting the still-running v0.20.0 PID. Never launch a candidate gateway under the production user without first isolating `XDG_CONFIG_HOME` or using a separate OS user/VM.

## Preconditions

1. Keep the qualified candidate immutable at its exact commit.
2. Install all resolved dependencies in its own venv, including `setuptools==83.0.0`.
3. Require zero findings from `hermes security audit --json` and no broken requirements from `pip check`.
4. Require the focused Kanban test set and ValKhana compatibility canary to pass.
5. Record current unit text, current revision, active PID, and current CLI version.
6. Confirm the state filesystem and recovery destination are local filesystems.
7. Announce the messaging interruption and freeze new task admission.
8. Qualify gateway startup under a separate OS user/VM, or set and verify an isolated `XDG_CONFIG_HOME`; a separate `HERMES_HOME` alone does not protect the production user unit.

## Backup gate

Before stopping the gateway:

1. Create a private directory under the approved ValKhana backup root with mode `0700`.
2. Run the pinned live `hermes backup` to an explicit archive path.
3. Force archive mode `0600` and treat it as credentials-bearing.
4. Record SHA-256, size, Hermes version, command, UTC time, board inventory, and source revision.
5. Verify the archive contains `state.db` and every enumerated board database.
6. Restore into a separate local recovery directory with a separate `HERMES_HOME`.
7. Run SQLite `PRAGMA integrity_check` on `state.db`, the default Kanban DB, and every board DB.
8. Compare restored board/task counts with the source.

The isolated v0.20.2 candidate drill proved this sequence with a mode-0600 archive, SHA-256 `352bba76616259a9f775c1289d5a3da9f8ca259c0d5326177e62c7fe70a75f6a`, an ext4 recovery destination, matching board counts, and `integrity_check: ok`. That artifact contains only synthetic canary state and is not a substitute for a fresh live backup.

## Release layout

Use code outside `HERMES_HOME`, for example:

```text
~/.local/opt/hermes-agent/
├── releases/
│   ├── f5be9236.../
│   └── 341d5aeb.../
└── current -> releases/341d5aeb.../
```

Each release owns an immutable source tree and venv. `HERMES_HOME` remains `~/.hermes`. The systemd unit and CLI wrapper should reference `current`, not a mutable checkout. Release directories and executable files should not be group-writable.

## Promotion sequence

1. Stop task admission; ensure no task is running or claimed.
2. Create and verify the fresh live backup/restore artifact.
3. Stop `hermes-gateway.service` and verify its worker cgroup is empty.
4. Atomically repoint `current` to the qualified release.
5. Install a reviewed unit that references `current`, then daemon-reload.
6. Start the gateway and require stable `active/running` state with no restart loop.
7. Verify exact v0.20.2 CLI identity, configuration compatibility, messaging adapters, board discovery, first-class review, and the ValKhana read-only adapter.
8. Rerun doctor and the zero-finding security audit in the actual live venv.
9. Run one bounded scratch worker canary and require clean completion.
10. Resume admission only after all checks pass.

## Immediate rollback

Rollback if startup, messaging, model access, task state, audit, or canary verification fails:

1. Stop the candidate gateway.
2. Atomically repoint `current` to the prior immutable release and restore the prior reviewed unit if needed.
3. Daemon-reload and start the prior gateway.
4. Verify version, gateway stability, board inventory, and messaging health.
5. Restore data only if the upgrade changed state incompatibly. Stop the gateway first, verify the backup hash and local recovery destination, and use the previously rehearsed native import path.
6. Keep admission paused until reconciliation is complete.

## Unit hardening review

At minimum evaluate and test:

- `UMask=0077`
- `NoNewPrivileges=yes`
- empty capability and ambient-capability sets
- kernel, clock, control-group, and hostname protections
- `PrivateTmp=yes`
- `RestrictSUIDSGID=yes`
- `LockPersonality=yes`
- `SystemCallArchitectures=native`
- explicit `MemoryHigh`, `MemoryMax`, `TasksMax`, and CPU weight/quota
- bounded restart rate and startup/shutdown timeouts
- read/write paths limited to `HERMES_HOME` and approved workspace roots

Do not apply filesystem or syscall restrictions until a candidate gateway, worker spawn, Git worktree, messaging adapter, browser/tool integration, and cleanup pass under the exact profile. The current user-manager environment rejected capability/namespace hardening with `218/CAPABILITIES`; a reduced transient baseline with private `/tmp`, `UMask=0077`, and resource budgets started, but candidate shutdown returned exit 1 and rewrote the global unit. The objective is a tested reduction from `9.8 UNSAFE`, not an unverified hardening list that breaks worker lifecycle.
