# SecretStore and service-identity design

Last reviewed: 2026-08-30 UTC

Status: SecretStore backend, Linux Tauri/Electron SSR-to-Core service authentication, bounded rotation/revocation, and isolated locked-wallet behavior are implemented and live-probed; cross-platform parity, stronger same-user isolation, and human approval remain open.

## Requirements carried forward from the v1.3.3 documents

- ValKhana owns its service tokens and integration credentials.
- Vendor-owned Claude, Codex, and Hermes credential locations are never copied or rewritten.
- Linux secrets use Secret Service/KWallet or another explicitly approved encrypted backend.
- There is no plaintext-file fallback.
- When the credential store is unavailable or locked, secret-backed capabilities fail closed while unrelated local capabilities can remain available.
- Autonomous agents must not be able to elevate themselves by supplying a principal, approval identifier, or credential that they can retrieve as the same OS user.

## What Secret Service proves

The freedesktop Secret Service API stores byte secrets in a login-session service, supports encrypted transfer sessions, and exposes non-secret lookup attributes. ValKhana uses the default collection, an encrypted Diffie-Hellman session, exact namespaced attributes, and no automatic unlock prompt from the Core daemon.

This provides:

- encrypted-at-rest storage as supplied by the desktop wallet;
- encrypted secret transfer between the client and Secret Service;
- no secret value in ValKhana configuration files;
- bounded, typed retrieval of ValKhana-owned entries only;
- fail-closed behavior when the service or collection is unavailable or locked.

It does **not** by itself provide:

- proof that a request came from a human;
- a specification-level per-application access-control boundary;
- isolation from every other process running as the same logged-in user;
- protection after a trusted process has retrieved the secret into memory;
- replay protection for a static bearer token.

Secret Service lookup attributes are not secret material. IDs, classes, and labels must therefore contain no credential value, vendor token, or sensitive payload.

## Trust boundaries

```text
browser/webview
    │ authenticated desktop/web session
    ▼
trusted SSR sidecar ── service authentication ──► ValKhana Core
    │                                                │
    │                                                ├─ policy ledger
    │                                                └─ Hermes adapter
    ▼
Secret Service/KWallet
```

There are two distinct claims:

1. **Service authentication:** the caller possesses a ValKhana-owned service credential. This can support attribution such as `service:valkhana-dashboard` only within the documented same-user threat limit.
2. **Human authorization:** a specific user intentionally approved a high-impact action. A reusable Secret Service bearer token does not prove this claim.

The implementation must never turn claim 1 into claim 2 merely by naming the principal `human:*`.

## Current backend behavior

- Backend: freedesktop Secret Service via `secret-service` 5.1.0.
- Transfer encryption: `EncryptionType::Dh`; there is no downgrade to `Plain`.
- Collection: default collection only.
- Namespace attributes:
  - `application=valkhana`
  - `valkhana-secret-id=<validated id>`
  - `valkhana-secret-class=<validated class>`
- Reads, writes, deletes, and listings are limited to that namespace.
- Duplicate IDs, malformed metadata, foreign items, and class changes fail closed.
- Listing reads metadata only and never calls `GetSecret`.
- The Core-facing probe reads no item and causes no unlock prompt.
- The daemon does not automatically unlock a wallet. The operator-only CLI performs explicit provisioning.

## Failure behavior

| Condition | Required behavior |
|---|---|
| Secret Service absent | Secret-backed operation unavailable; no plaintext fallback |
| Default collection absent | Secret-backed operation unavailable |
| Collection locked | Fail closed; background Core does not prompt |
| Secret missing | Authentication fails without revealing whether another item exists |
| Duplicate ValKhana ID | Fail closed and require operator repair |
| Malformed/foreign metadata | Reject the item; do not read its secret |
| Wrong or short token | Reject in bounded constant-time comparison path |
| Service token valid | Establish service identity only, not human identity |
| Approval needs human presence | Require the future user-presence bridge; do not accept service token alone |

## Rollout plan and gates

### Gate A: SecretStore backend

- [x] Typed secret IDs, classes, metadata, and bounded secret values.
- [x] Redacted debug representation and memory clearing on drop.
- [x] No plaintext fallback.
- [x] Encrypted Secret Service session.
- [x] Exact ValKhana namespace and duplicate detection.
- [x] Unit tests for bounds, metadata, token comparison, and unavailable backend.
- [x] Read-only live probe against the KDE Secret Service on this workstation.
- [x] Disposable create/get/replace/list/delete integration drill with cleanup.
- [x] Locked-wallet and unavailable-session-bus integration tests in disposable isolated sessions.

### Gate B: Service authentication

- [x] Provision a ValKhana-owned dashboard service token through the explicit operator CLI.
- [x] Keep the token out of browser JavaScript, HTTP bodies, URLs, logs, and command-line arguments; Tauri and the packaged Linux Electron launcher supply it only to the trusted SSR child environment.
- [x] Sign each protected request with HMAC-SHA-256 over a versioned canonical message.
- [x] Bind the signature to service ID, method, exact path, action/payload digest, timestamp, and random nonce.
- [x] Accept only a 30-second clock window and atomically consume each valid nonce digest once in a private, durable Core replay ledger.
- [x] Add authenticated Linux Tauri/Electron SSR-to-Core complete/archive requests with missing/wrong-token/stale/substitution/replay tests and a live signed probe.
- [x] Add five-minute bounded rotation overlap, explicit finalization, immediate revocation marker, and safe reprovisioning behavior.
- [x] Document the remaining same-user process-access boundary; replay protection is restart-safe and retains only SHA-256 nonce digests until their expiry.
- [x] Attribute requests only as `service:valkhana-dashboard`.

### Gate C: Human authorization

- [ ] Select a user-presence mechanism that a same-user autonomous agent cannot silently satisfy.
- [ ] Bind the approval to the exact task, project, capability, target, expiry, and nonce.
- [ ] Persist the approval decision before executing the action.
- [ ] Reject replay, substitution, expired approval, revoked approval, and mismatched target.
- [ ] Expose approval mutation only through the user-presence bridge, not the general Unix socket.
- [ ] Only after these tests pass may an actor be attributed as `human:*`.

Candidates for Gate C must be evaluated explicitly. A desktop confirmation backed only by an already-unlocked reusable keyring token is insufficient. Viable directions include an OS-mediated interactive authorization mechanism, a hardware-backed user-presence signature, or a separately isolated approval broker.

### Current Hermes lifecycle gate

Read-only inspection of the qualified Hermes Agent v0.20.2 source on 2026-08-30 confirmed interactive approvals for dangerous agent tool commands, but no supported native approval object or CLI contract for Kanban assignment, dependency, promotion, reclaim, or review-rework mutations. The architecture requires Hermes-executed actions to use a supported Hermes-native approval mechanism rather than a parallel ValKhana decision object. Therefore, the current high-risk Core requests may create a pending, exact-input policy record but have no production approval-mutation path and cannot execute until an upstream/native bridge is available. This is intentional fail-closed behavior, not a completed Gate C.

## Decisions

- Approved now: Secret Service/KWallet as ValKhana's encrypted credential backend.
- Approved now: fail closed without automatic daemon prompts or plaintext fallback.
- Approved now: service and human identities remain separate.
- Not yet approved: static bearer token as sufficient authorization for completion, archival, or approval mutation.
- Not yet approved: any `human:*` attribution without an independently verified user-presence mechanism.

## Planned service-request protocol

Protected SSR-to-Core requests will use these server-only headers:

```text
X-ValKhana-Service-Id: service:valkhana-dashboard
X-ValKhana-Timestamp: <unix milliseconds>
X-ValKhana-Nonce: <32 lowercase hexadecimal characters>
X-ValKhana-Signature: <64 lowercase hexadecimal HMAC-SHA-256>
```

The versioned canonical message is:

```text
valkhana-service-request-v1
<service-id>
<HTTP method>
<exact path>
<action>
<SHA-256 of the action payload bytes, or the empty SHA-256>
<timestamp>
<nonce>
```

Core retrieves the ValKhana-owned key from Secret Service, verifies the HMAC in constant time, verifies the time window, and atomically consumes the nonce before policy evaluation or Hermes mutation. The long-lived key never crosses the Core socket. Rotation behavior must be explicit; a running sidecar must not silently continue with a revoked key.

This protocol prevents passive capture and replay of a prior request. It does not solve the documented same-user keyring-access threat, so the resulting actor remains `service:valkhana-dashboard`.

## Evidence

- Focused Rust tests and strict Clippy pass for `valkhana-secrets`.
- A read-only live Secret Service probe passes against the current KDE session.
- The freedesktop specification confirms that attributes are not secret material, locked items cannot be read or modified, encrypted transfer sessions are available, and application-level human presence is outside the guarantee provided by simple secret retrieval.
