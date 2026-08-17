# Latest Sync Report — v2026.4.24

**Date:** 2026-04-25
**Previous:** v2026.4.23
**New:** v2026.4.24
**Status:** Complete (WeChat pending — credential error)

## Release Summary

OpenClaw 2026.4.24 is the biggest communication-channel release in months:
- Google Meet joins as a bundled AI participant plugin
- Realtime voice AI (`openclaw_agent_consult`) shared across Talk, Voice Call, and Meet
- DeepSeek V4 Flash confirmed as onboarding default (1M token, 5-8× cheaper)
- WeCom channel source pinned for Chinese-market reliability
- Browser automation: coordinate clicks, 60s action budget, per-profile headless
- Gemini Live new voice provider
- BREAKING: tool-result middleware API (`registerEmbeddedExtensionFactory` removed)

## Key Fixes
- Heartbeat injection into normal runs (critical)
- WhatsApp media delivery, voice note transcription, group system prompts
- Telegram polling persistence across restarts
- Browser profile lock recovery (Chromium Singleton*)
- Scheduler delay overflow (Node timer cap)
- DeepSeek V4 thinking-replay on follow-up tool-call turns

## Change Classification
| Change | Category |
|--------|----------|
| Google Meet bundled participant plugin | RELEVANT |
| Realtime voice AI (`openclaw_agent_consult`) | RELEVANT |
| DeepSeek V4 Flash as onboarding default | RELEVANT |
| WeCom channel source pinned | RELEVANT |
| Browser automation improvements | RELEVANT |
| Gemini Live voice provider | RELEVANT |
| OTEL observability | RELEVANT |
| BREAKING: tool-result middleware | RELEVANT (plugin authors) |
| Codex harness seams | WATCH |
| Node-LLAMA-CPP opt-in | WATCH |
| OpenCode Go catalog | SKIP |

## Template Changes

- `README.md`: Updated "New" banner to v2026.4.24
- `README.zh-CN.md`: Added Chinese banner for v2026.4.24
- `CHANGELOG.md`: Added full v2026.4.24 entry

## Blog Posts

| Lang | Title | URL | Status |
|------|-------|-----|--------|
| EN | OpenClaw 2026.4.24: Google Meet AI, Realtime Voice & DeepSeek V4 Flash Default | https://pulseagent.io/en/blog/openclaw-v2026-4-24-google-meet-voice-deepseek-default | published |
| ZH | OpenClaw 2026.4.24：Google Meet AI参会、实时语音与DeepSeek V4 Flash默认模型 | https://pulseagent.io/en/blog/openclaw-v2026-4-24-google-meet-voice-deepseek-zh | published |

## WeChat

**Status**: FAILED — `WeChat API error: 40125 invalid appsecret rid: 69ed4af2-5dc24a61-3fcdf23b`
**Note**: Same error as previous cycle (v2026.4.22 sync). Server-side credential issue.
**Action required**: Refresh WeChat Official Account appsecret in PulseAgent platform settings. Draft saved at `.sync/blog-drafts/openclaw-v2026.4.24-zh.json` for manual re-publish.
