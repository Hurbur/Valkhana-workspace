# AgentWorld auxiliary world model

AgentWorld is exposed through `world_model.simulate`, not the model picker or
Slots 1–5. `POST /api/world-model/simulate` accepts a bounded state capsule and
returns a predicted observation, side effects, and uncertainties. `GET` and
`POST /api/world-model` provide status and explicit start/stop/switch lifecycle control.

The service is installed as `agentworld-llama.service` and is intentionally
disabled. It may own loopback port 8080 only while no other managed model owns
that port. Starting verifies the artifact hash, waits for the port, and checks
the `/v1/models` alias and 114688 context. Stopping waits for port release.
Routine status reads deliberately report artifact presence but do not hash the
35B file; `artifactVerified` is `null` until the explicit start-time gate
performs that expensive verification.

Rollback: stop the service, remove `~/.config/systemd/user/agentworld-llama.service`,
run `systemctl --user daemon-reload`, and remove the two `world-model` route/module
files plus the service template. Existing Slot 1–5 units and model-picker files
are not modified by this integration.

## Validation record (2026-08-30)

| Test                      | Expected                                 | Actual                                                                | Result              |
| ------------------------- | ---------------------------------------- | --------------------------------------------------------------------- | ------------------- |
| Artifact hash             | Locked SHA-256                           | `a6988d8c542e5307be35ee75dd9bb194ee303bb6eb205a1a6a86ef204ace7aa7`    | PASS                |
| Service boot policy       | Disabled                                 | `disabled`                                                            | PASS                |
| Service startup           | Loopback service becomes healthy         | `/health` returned `{"status":"ok"}`                                  | PASS                |
| Model identity            | Alias and effective context match        | `valkhana-agentworld-35b-a3b`, `n_ctx=114688`                         | PASS                |
| Harmless simulation       | Predict port collision without execution | Valid JSON predicted existing owner remains active and new bind fails | PASS                |
| Clean shutdown            | Inactive and port free                   | `inactive`; port 8080 free                                            | PASS                |
| Existing fleet regression | Retained service definitions unchanged   | Existing Slot 1–5 units were not edited                               | PASS (static scope) |

The running service is intentionally left stopped after validation. Full
application-route invocation requires the normal ValKhana web server and its
authentication session; the server build completed successfully and the
capability unit tests pass.
