# Voicebox integration notes (inspected, not vendored)

Voicebox: https://github.com/jamiepine/voicebox.git  
Inspected: README, CHANGELOG 0.5.0, `backend/models.py`, `docs/PROJECT_STATUS.md`.

AITZAZ AI 2070 does **not** vendor Voicebox source. Voicebox stays a local companion process.

## Where it plugs in

This repository is an OpenClaw 7-layer workspace + local skills. There is no separate application to create.

| Layer | File | Role |
|-------|------|------|
| Main Brain | `workspace/AGENTS.md` | Decides TEXT vs VOICE after intent |
| Conversation | `workspace/AGENTS.md` + `intent.mjs` | Classifies `VOICE_REQUEST` |
| Voice Worker | `skills/voice-worker/` | Approval, generate, verify, deliver plan |
| VoiceService | `skills/voice-worker/voice-service.mjs` | Only module that talks to Voicebox |
| Config | `workspace/voice.yaml` | Authorized Aitzaz profile (no fake id) |
| Dashboard | `dashboard/` + Voice Center | Status, jobs, approval |
| Memory | job JSON under `$OPENCLAW_HOME/voice/` | Metadata, not raw samples |

Existing SDR skills are unchanged. Voice Worker is an additional capability.

## REST vs MCP

**REST is the right fit for this architecture.**

Voicebox ships both:

- MCP at `http://127.0.0.1:17493/mcp` — `voicebox.speak`, `transcribe`, `list_captures`, `list_profiles`
- REST `POST /speak` — documented as the wrapper for anything that is not MCP-native (scripts, ACP, A2A)

AITZAZ skills run as Node CLI from OpenClaw, the same pattern as `chroma.mjs`. Adding an MCP client would add a transport we do not otherwise use.

`X-Voicebox-Client-Id: aitzaz-ai-2070` is sent on every call so Voicebox can bind this worker in **Settings → MCP**.

## Voicebox API actually used

| Method | Path | Why |
|--------|------|-----|
| GET | `/health` | Reachability, GPU, model loaded |
| GET | `/profiles` | Real profile ids / names |
| GET | `/models/status` | Available engines |
| POST | `/speak` | Agent speech (`text`, `profile`, `language`, `personality`) |
| POST | `/generate` | When emotion/speed need `instruct` (not on SpeakRequest) |
| GET | `/history/{id}/export-audio` | Pull WAV locally for validation |
| GET | `/history` | Recent generations for Voice Center |

`SpeakRequest` fields (real): `text`, `profile`, `engine`, `personality`, `language`.  
There is **no** first-class `speed` or `emotion` field. VoiceService maps those to `instruct` on `/generate`.

`GenerationResponse` fields (real): `id`, `profile_id`, `text`, `language`, `audio_path`, `duration`, `engine`, `status`, `error`, …

HTTP **202** = model still downloading. That is **not** success.

## What we reuse from Voicebox

- Local TTS engines and cloned-voice profiles
- `/speak` agent path + optional personality rewrite
- Profile CRUD already in the Voicebox app (sample upload stays there)

What we do **not** copy: frontend, Tauri shell, engine backends, SQLite schema.

## Dependencies

AITZAZ side: Node.js 18+ only (`fetch`). No extra npm packages.

Voicebox side (their requirements):

- Voicebox desktop app **or** `just dev` from their repo
- Python 3.11+, Bun, Rust (if building from source)
- Hardware: Apple Silicon MLX, NVIDIA CUDA, AMD ROCm, Intel Arc, DirectML, or CPU
- Default bind: `127.0.0.1:17493`
- Models downloaded in-app (Qwen3-TTS, Whisper, optional local Qwen3 LLM for personality)

## What can be tested locally without Voicebox

```bash
npm test
```

Includes a mock Voicebox (`skills/voice-worker/test/voice-worker.test.mjs`) covering intent, approval, generate/validate, failure, unbound profile, and delivery confirmation rules.

With a real Voicebox + an Aitzaz profile:

```bash
export VOICEBOX_BASE_URL=http://127.0.0.1:17493
node skills/voice-worker/voice-worker.mjs health
node skills/voice-worker/voice-worker.mjs bind
node skills/voice-worker/voice-worker.mjs speak \
  --text "Sure, happy to. I can send you a quick voice introduction." \
  --channel local --intro
```

## Hardware / runtime

Voice generation happens **on the Voicebox host**, not inside OpenClaw. The worker only needs HTTP access to that host. For production, run Voicebox on the same machine or a trusted LAN; do not expose `/speak` to the public internet without auth (`VOICEBOX_TOKEN` is supported if you put a reverse proxy in front).
