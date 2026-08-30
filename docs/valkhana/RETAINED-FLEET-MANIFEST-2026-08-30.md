# Retained ValKhana fleet manifest

Generated from the live host on 2026-08-30 UTC. This manifest covers retained
production candidates only; retired/deleted artifacts are intentionally absent.

| Slot | Model / role | Public slug | Runtime alias | Context | Service | Artifact | Size (bytes) | SHA-256 | Status |
|---|---|---|---|---:|---|---|---:|---|---|
| 1 | Ornith 1.5 9B / local | `ornith-1.5-9b` | `slot1-ornith-1.5-9b` | 262144 | `ornith-9b.service` | `/mnt/linux-data/AI/models/valkhana-fleet/slot1/ornith-1.5-9b/Ornith-1.5-9B-Q8_0.gguf` | 9527501248 | `6874eeb25c71081dc8f0bbe88f3ebb786312447132745371cd980bce95d259b9` | accepted |
| 2 | Gemma 4 26B-A4B / local | `gemma-4-26b` | `slot2-gemma-4-26b` | 98304 | `gemma-4-26b.service` | `/mnt/linux-data/AI/models/valkhana-fleet/slot2/gemma-4-26b-a4b/gemma-4-26B-A4B-APEX-I-Compact.gguf` | 14810083136 | `6af4e64b2060af7afa01aa44863e6192a215ee43379bd75bab4688e1f95d4212` | accepted |
| 3 | Ornith 1.5 35B-A3B / local | `ornith` | `slot3-ornith-1.5-35b-a3b` | 102400 | `ornith-llama.service` | `/mnt/linux-data/AI/models/valkhana-fleet/slot3/ornith-1.5-35b-a3b/Ornith-1.5-35B-A3B-APEX-Compact.gguf` | 16538851328 | `846eb4121c1b28df0e2dff06c3f3d174084231a7400c649ba02023843ea41021` | accepted / permanent |
| 4 | Agents-A1 35B-A3B / multimodal local | `agents-a1` | `slot4-agents-a1` | 65536 | `agents-a1.service` | `/mnt/linux-data/AI/models/valkhana-fleet/slot4/agents-a1/Agents-A1-APEX-I-Compact.gguf` | 16538851328 | `dbdd972647ae4c16a0c018bbf49d4b9f59e08de5f1d8c5f4cabaec275ad9e7cf` | retained; acceptance pending |
| 5 | Qwen3.8 27B / local | `qwen3.8` | `slot5-qwen3.8` | 77824 | `qwen3.8.service` | `/mnt/linux-data/AI/models/valkhana-fleet/slot5/qwen3.8-27b/Qwen3.8-27B-UD-IQ4_XS.gguf` | 14252845984 | `40fac4050e940397dbf13087afd50f4734a11805bf9d65ef8ddd7483470e6199` | retained |

Slot 4 additionally references `/mnt/linux-data/AI/models/valkhana-fleet/slot4/agents-a1/mmproj.gguf` (902821920 bytes, SHA-256 `c8772fe61cfceefd1bc42e3b06f53bb2e751abd15d1450d58ba0c113d3782396`).

All local llama services use `/usr/bin/llama-server` except Slot 5, which uses `/mnt/linux-data/AI/llama.cpp-fa-all-quants-10566/build-fa-all-quants/bin/llama-server`. The former host binary hash is `748a47e6e06acdf248d98fe96bbc322ad1162df2cc1d85c4033100c5dec53dd7` (14424 bytes); the latter hash is `7978faa6de0f1be5eeb9db6d3f2a01b02a0b05e4a84742f217896b83fb17eb41`. Retained GGUF/mmproj files are mode `0444` and their immediate production directories are mode `0555`; the custom Slot 5 binary is mode `0555`.

Upstream repository/revision, license, quantizer provenance, benchmark references,
and an independently protected copy of this manifest remain required before
autonomous promotion. The paths and hashes above are a local integrity baseline,
not upstream authenticity proof.
