# Voice Worker — runbook (AITZAZ AI 2070)

Voicebox: https://github.com/jamiepine/voicebox.git  
This repository does **not** vendor Voicebox. Integration is **REST** via `VoiceService`.

## 0. Actual paths

The Voice Worker is **inside this git repository**, not under `$HOME/skills`.

```bash
pwd
git rev-parse --show-toplevel
# must print the AITZAZ AI 2070 repo (this checkout), e.g.
#   /home/user/Sara--OS
#   or whatever folder you cloned muhammadlai/Sara--OS into

ls skills/voice-worker/voice-worker.mjs
```

If you see:

```
Error: Cannot find module '/home/aitzazji91/skills/voice-worker/voice-worker.mjs'
```

you ran Node from `$HOME`. That path is **not** the project.

```bash
cd "$(git rev-parse --show-toplevel)"
node skills/voice-worker/voice-worker.mjs health
# or, from the repo, path-safe:
npm run voice:health
node scripts/aitzaz-voice.mjs health
```

| Item | Path |
|------|------|
| Repo root | `git rev-parse --show-toplevel` |
| Entry | `skills/voice-worker/voice-worker.mjs` |
| VoiceService | `skills/voice-worker/voice-service.mjs` |
| Config | `workspace/voice.yaml` (copy: `skills/voice-worker/voice.yaml`) |
| Launcher | `scripts/aitzaz-voice.mjs` |
| Tests | `skills/voice-worker/test/voice-worker.test.mjs` |

There is no `/home/<user>/skills/` layout in this project.

## 1. Start Voicebox

On the machine that will generate speech:

1. Install Voicebox from https://github.com/jamiepine/voicebox.git (desktop app or `just dev`).
2. Confirm it listens on `http://127.0.0.1:17493` (default).
3. In the Voicebox UI, create a profile **named `Aitzaz`** from **your own** voice sample.
4. Do **not** put that sample in this git repo.

## 2. Configure `VOICEBOX_BASE_URL`

Do **not** put tokens in workspace `.env` (OpenClaw ignores runtime keys there). Use the shell or `deploy/config.sh`.

```bash
export VOICEBOX_BASE_URL=http://127.0.0.1:17493
export VOICEBOX_CLIENT_ID=aitzaz-ai-2070
# optional reverse-proxy bearer only:
# export VOICEBOX_TOKEN=...
```

Defaults match Voicebox's local API if unset. Never commit `VOICEBOX_TOKEN`.

## 3. Health

From the **repository root**:

```bash
node skills/voice-worker/voice-worker.mjs health
# or
npm run voice:health
```

**Connected (only if Voicebox answers `/health`):**

```json
{ "ok": true, "status": "CONNECTED", "reachable": true, "base_url": "http://127.0.0.1:17493" }
```

**Not connected:**

```json
{ "ok": false, "status": "DISCONNECTED", "reachable": false, "error": "Voicebox is not reachable at ..." }
```

Exit code `1` when unreachable. The CLI never prints CONNECTED unless the HTTP health check succeeds.

## 4. Bind the Aitzaz profile

```bash
node skills/voice-worker/voice-worker.mjs bind
# or
npm run voice:bind
```

Bind calls Voicebox `GET /profiles` and matches name `Aitzaz`. It **does not invent** a profile id.

- Success: `{ "status": "bound", "bound": true, "profile": { "id": "<real Voicebox id>", "name": "Aitzaz" } }`
- Voicebox down: `{ "code": "VOICEBOX_UNREACHABLE", "bound": false }`
- No Aitzaz profile yet: `{ "code": "VOICE_PROFILE_NOT_CONFIGURED", "bound": false }`

Create the profile in Voicebox from your sample, then bind again.

## 5. Local speak test

Only after health is CONNECTED and bind is `bound`:

```bash
node skills/voice-worker/voice-worker.mjs speak --text "Sure, happy to." --channel local --intro
# or
npm run voice:speak
```

`--channel local` is a preview. It is **not** a client send.

The JSON reports `generation_started`, `generation_status` (`completed` | `failed`), `voice_profile` / id, `audio` path, `verified`, `delivered: false`.  
`verified: true` only after Voicebox returns a generation **and** audio validates.  
`delivered` stays false unless a channel adapter later confirms.

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---------|--------|-----|
| `Cannot find module '.../home/.../skills/voice-worker/...'` | Wrong cwd (`$HOME`) | `cd "$(git rev-parse --show-toplevel)"` |
| `DISCONNECTED` | Voicebox not running or wrong URL | Start Voicebox; check `VOICEBOX_BASE_URL` |
| HTTP 202 / `voicebox_model_not_ready` | TTS model still downloading | Wait in Voicebox UI; retry |
| `VOICE_PROFILE_NOT_CONFIGURED` | No profile named Aitzaz | Create it in Voicebox from your sample |
| `VOICE_GENERATION_FAILED` | TTS error or missing audio | Read `error`; do not tell the client it was sent |
| LinkedIn / unknown channel | No authorized audio API | Worker returns the unsupported-delivery message |

## 7. Delivery channels

Generation ≠ delivery.

| Channel | Authorized audio op | Delivery claim |
|---------|---------------------|----------------|
| Telegram | `sendVoice` | Only after Bot API ack |
| WhatsApp | `sendVoiceNote` | Only after OpenClaw delivery receipt |
| Email | `attachAudio` | Only after gws send ack |
| Teams | `uploadFile` | Only after Graph ack |
| local / web | `localPreview` | Never “sent” to a client |
| LinkedIn | none | *Voice generation completed, but this channel does not support authorized audio delivery through the current integration.* |

No browser hacks, cookie theft, CAPTCHA bypass, or unofficial automation.

## 8. Security

- Only Aitzaz's consented profile.
- Do not clone client or third-party voices.
- Do not commit WAV/MP3/OGG, `voice-samples/`, `VOICEBOX_TOKEN`, or generated audio.
- Audio cache: `$OPENCLAW_HOME/voice/audio` (24h TTL). Outside git.
- Do not expose `:17493` to the public internet without an authenticating proxy.

## 9. Dashboard Voice Center

```bash
npm run voice:center
```

Shows **real** states only:

- Voice Worker: `READY` / `ERROR` (module present)
- Voicebox: `CONNECTED` / `DISCONNECTED` (live `/health`)
- Profile: `Aitzaz` / `NOT CONFIGURED` (bind result)
- Last generation: stored phase/timestamp, or `NONE`

## 10. Tests (no live Voicebox required)

```bash
npm test
npm run test:voice
```
