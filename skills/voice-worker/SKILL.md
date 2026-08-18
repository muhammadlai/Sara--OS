---
name: voice-worker
description: "AITZAZ AI 2070 Voice Worker. Classifies VOICE_REQUEST intent, generates speech through VoiceService → Voicebox using Aitzaz's authorized voice profile only, requires owner approval for client outbound, and delivers audio only on authorized channels."
---

# Voice Worker — Authorized Aitzaz Voice

Speak client-facing replies using **Aitzaz's own authorized Voicebox profile**. Never clone anyone else's voice. Never impersonate a client.

```
MAIN BRAIN
    ↓
CONVERSATION AGENT   (classify VOICE_REQUEST)
    ↓
VOICE WORKER
    ↓
VoiceService.speak()
    ↓
VOICEBOX  (local REST)
    ↓
AITZAZ VOICE PROFILE
    ↓
GENERATED AUDIO
    ↓
AUTHORIZED CHANNEL  (Telegram / WhatsApp / Email / Teams / local preview)
```

## When to use

Conversation Agent classifies the inbound message.

| Client says | Intent |
|-------------|--------|
| "Can I hear your voice?" | `VOICE_REQUEST` |
| "Can you send me a voice message?" | `VOICE_REQUEST` |
| "Can we talk?" | `VOICE_REQUEST` |
| "Send me a quick voice reply." | `VOICE_REQUEST` |
| Anything else | `TEXT_REQUEST` |

Main Brain then:

1. Write the **actual conversational reply first** (do not invent a generic voice script).
2. Decide whether voice is appropriate (request + channel + permission + Voicebox availability).
3. If yes → Voice Worker. If no → send the text reply only.

Example text that then goes to TTS:

> Sure, happy to. I can send you a quick voice introduction.

## Tool: `voice.speak`

From the **git repository root** (`git rev-parse --show-toplevel`), not from `$HOME`:

```bash
node skills/voice-worker/voice-worker.mjs speak \
  --text "Sure, happy to. I can send you a quick voice introduction." \
  --channel telegram \
  --client "Ahmed" \
  --company "Desert Logistics" \
  --conversation conv-123
```

Inputs: `text`, `voice_profile` (default Aitzaz), `language`, `speed`, `emotion`, `personality`  
Output (shape adapted from the real Voicebox generation object):

```json
{
  "status": "completed",
  "phase": "AUDIO_VALIDATED",
  "voice_profile": "Aitzaz",
  "audio": "/path/to/local.wav",
  "verified": true
}
```

Never assume generation succeeded. If Voicebox errors, returns HTTP 202 (model downloading), or audio cannot be validated → `VOICE_GENERATION_FAILED`. Notify Main Brain. Do **not** tell the client the voice was sent.

## Approval (client outbound)

Notify the owner:

> Sir, client requested a voice reply.

Show: Client, Company, Channel, Conversation, Suggested response.

| Action | Command |
|--------|---------|
| APPROVE VOICE | `voice-worker.mjs approve <id>` |
| EDIT RESPONSE | `voice-worker.mjs edit <id> --text "..."` |
| GENERATE | `voice-worker.mjs generate <id>` |
| CANCEL | `voice-worker.mjs cancel <id>` |

Local preview (`--channel local`) auto-approves. Client channels require explicit approval.

## Delivery

Voice Worker is channel-independent. It only plans an official audio operation:

| Channel | Operation | Authorized |
|---------|-----------|------------|
| Telegram | `sendVoice` | yes |
| WhatsApp | `sendVoiceNote` | yes |
| Email | `attachAudio` | yes |
| Teams | `uploadFile` | yes |
| LinkedIn | none | **no** |
| local / web | `localPreview` | yes |

If the channel cannot deliver:

> Voice generation completed, but this channel does not support authorized audio delivery through the current integration.

Do **not** report `DELIVERY_CONFIRMED` / "Voice sent" unless the destination service returns an official ack (`--confirmed --reference <id>`).

## Authorized profile

`skills/voice-worker/voice.yaml` + `workspace/voice.yaml`

- Name: **Aitzaz** · Owner: **Aitzaz** · Purpose: AITZAZ AI 2070 Worker Agent
- `consent_confirmed: true` — this is Aitzaz's own voice
- `id` is empty in git. The real id is resolved from Voicebox `GET /profiles`
- Do not hardcode a fake profile id
- Do not commit recordings, WAVs, or Voicebox tokens

Provision on a machine that already has Voicebox running and Aitzaz's sample imported in the Voicebox UI:

```bash
node skills/voice-worker/voice-worker.mjs bind
```

If no profile named `Aitzaz` exists, bind fails. Create the profile **inside Voicebox** from Aitzaz's own sample, then bind again.

## Personality

Professional, natural, confident, friendly, concise, business-oriented.

Optional Voicebox personality rewrite (`personality: true` on `/speak`) if the Aitzaz profile has a persona set in Voicebox.

Do **not** say "I'm Aitzaz personally speaking" unless explicitly intended. Prefer:

> This is Aitzaz AI speaking on behalf of Aitzaz.

## VoiceService (do not call Voicebox from other skills)

```js
speak({ text, voice_profile, language, emotion, speed, personality })
```

REST is the integration path (see `INTEGRATION.md`). MCP is optional for other agents; AITZAZ talks HTTP.

## Pipeline phases

`VOICE_REQUESTED` → `VOICE_GENERATION_STARTED` → `VOICE_GENERATED` → `AUDIO_VALIDATED` → `DELIVERY_REQUESTED` → `DELIVERY_CONFIRMED`  
or `VOICE_GENERATION_FAILED`

## Commands

| Command | Purpose |
|---------|---------|
| `classify` | Intent only |
| `request` | Open an approval job |
| `approve` / `edit` / `cancel` / `generate` | Owner workflow |
| `speak` | Request + generate (local auto-approves) |
| `deliver` | Plan delivery; `--confirmed` only after channel ack |
| `bind` / `health` / `status` / `jobs` / `purge` | Ops |

## Hard rules

- Only the Aitzaz authorized profile
- Do not clone third-party or client voices
- Do not store raw samples in git
- Do not expose Voicebox tokens
- Do not bypass CAPTCHA, auth, or website restrictions
- Do not over-process every reply — short conversational answers stay short
