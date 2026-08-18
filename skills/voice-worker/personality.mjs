/**
 * Optional wording layer for Aitzaz AI voice.
 * Does not impersonate Aitzaz as a person.
 * Does not over-process every reply.
 */
export const DEFAULT_TRAITS = [
  'professional',
  'natural',
  'confident',
  'friendly',
  'concise',
  'business-oriented',
];

export const DEFAULT_DISCLOSURE = 'This is Aitzaz AI speaking on behalf of Aitzaz.';

export function applyPersonalityLayer(text, {
  traits = DEFAULT_TRAITS,
  disclosure = DEFAULT_DISCLOSURE,
  includeDisclosure = false,
  kind = 'reply',
} = {}) {
  let out = String(text || '').trim();
  if (!out) return out;

  // Keep short conversational replies intact.
  const sentences = out.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (traits.includes('concise') && sentences.length > 4 && kind !== 'script') {
    out = sentences.slice(0, 4).join(' ');
  }

  if (includeDisclosure && !out.toLowerCase().includes('aitzaz ai')) {
    out = `${disclosure} ${out}`.trim();
  }

  return out;
}

export function ownerVoiceNotice({ client, company, channel, conversation, suggested } = {}) {
  const who = [client, company].filter(Boolean).join(' · ') || 'Unknown client';
  return {
    title: 'Sir, client requested a voice reply.',
    client: client || null,
    company: company || null,
    channel: channel || null,
    conversation: conversation || null,
    suggested_response: suggested || null,
    actions: ['APPROVE VOICE', 'EDIT RESPONSE', 'GENERATE', 'CANCEL'],
    summary: `Sir, client requested a voice reply. ${who} on ${channel || 'unknown channel'}.`,
  };
}
