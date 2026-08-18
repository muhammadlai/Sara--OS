/**
 * Conversation-agent voice intent classification.
 * Returns VOICE_REQUEST or TEXT_REQUEST. Does not generate replies.
 */

const VOICE_PATTERNS = [
  /\bcan i hear (your|the) voice\b/i,
  /\bhear your voice\b/i,
  /\bsend( me)? (a )?(quick )?(voice|audio) (message|note|reply|intro|introduction)\b/i,
  /\b(voice|audio) (message|note|reply|intro|introduction)\b/i,
  /\bcan we talk\b/i,
  /\blet'?s talk\b/i,
  /\btalk instead of (text|typing|writing)\b/i,
  /\bspeak (it|that|this|the (reply|response|answer)) (out|aloud|to me)?\b/i,
  /\bread (that|this|it) (out )?(loud|aloud|to me)\b/i,
  /\bvoice reply\b/i,
  /\bquick voice\b/i,
  /\bvoice note\b/i,
  /\bvoice memo\b/i,
  /\bsend (me )?audio\b/i,
];

export function classifyVoiceIntent(text) {
  const source = String(text || '').trim();
  if (!source) {
    return { intent: 'TEXT_REQUEST', confidence: 0, matched: null };
  }
  for (const pattern of VOICE_PATTERNS) {
    const match = source.match(pattern);
    if (match) {
      return { intent: 'VOICE_REQUEST', confidence: 0.9, matched: match[0] };
    }
  }
  return { intent: 'TEXT_REQUEST', confidence: 0.7, matched: null };
}

/**
 * Main Brain decision: should we actually produce voice?
 */
export function decideVoiceOutput({
  intent,
  channel,
  channelSupportsAudio,
  userPreference,
  permission,
  available,
  consentConfirmed,
  profileEnabled,
} = {}) {
  const reasons = [];
  if (intent !== 'VOICE_REQUEST') reasons.push('intent_is_text');
  if (userPreference === 'text') reasons.push('user_prefers_text');
  if (permission === false) reasons.push('permission_denied');
  if (available === false) reasons.push('voice_unavailable');
  if (consentConfirmed === false) reasons.push('owner_consent_missing');
  if (profileEnabled === false) reasons.push('profile_disabled');

  const voiceOk = reasons.length === 0 && intent === 'VOICE_REQUEST';
  return {
    mode: voiceOk ? 'VOICE_RESPONSE' : 'TEXT_RESPONSE',
    use_voice_worker: voiceOk,
    channel: channel || 'unknown',
    channel_supports_audio: Boolean(channelSupportsAudio),
    reasons,
  };
}
