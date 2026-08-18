/**
 * Authorized channel capability matrix for voice delivery.
 * Only official/authorized audio operations. No browser automation.
 */

export const CHANNEL_CAPABILITIES = {
  telegram: {
    id: 'telegram',
    audio_operation: 'sendVoice',
    authorized: true,
    notes: 'Telegram Bot API sendVoice / sendAudio — official file upload.',
  },
  whatsapp: {
    id: 'whatsapp',
    audio_operation: 'sendVoiceNote',
    authorized: true,
    notes: 'OpenClaw WhatsApp media send for voice notes. Confirm delivery receipts.',
  },
  email: {
    id: 'email',
    audio_operation: 'attachAudio',
    authorized: true,
    notes: 'Gmail/gws send with audio attachment. Formal channel.',
  },
  teams: {
    id: 'teams',
    audio_operation: 'uploadFile',
    authorized: true,
    notes: 'Microsoft Graph file upload when Teams integration is configured.',
  },
  slack: {
    id: 'slack',
    audio_operation: 'filesUpload',
    authorized: true,
    notes: 'Slack files.upload when the Slack channel plugin is enabled.',
  },
  linkedin: {
    id: 'linkedin',
    audio_operation: 'none',
    authorized: false,
    notes: 'No authorized audio delivery API in the current integration.',
  },
  web: {
    id: 'web',
    audio_operation: 'localPreview',
    authorized: true,
    notes: 'Local / Voice Center preview only.',
  },
  local: {
    id: 'local',
    audio_operation: 'localPreview',
    authorized: true,
    notes: 'Operator local preview. Not a client channel.',
  },
};

export const UNSUPPORTED_AUDIO_MESSAGE =
  'Voice generation completed, but this channel does not support authorized audio delivery through the current integration.';

export function getChannelCapability(channel) {
  const key = String(channel || '').trim().toLowerCase();
  return CHANNEL_CAPABILITIES[key] || {
    id: key || 'unknown',
    audio_operation: 'none',
    authorized: false,
    notes: 'Unknown channel — no authorized audio operation.',
  };
}

export function canDeliverAudio(channel) {
  const cap = getChannelCapability(channel);
  return Boolean(cap.authorized && cap.audio_operation && cap.audio_operation !== 'none');
}

/**
 * Build a delivery instruction. Does NOT send.
 * Delivery is only CONFIRMED when the caller reports an official channel ack.
 */
export function planDelivery({ channel, audioPath, generationId } = {}) {
  const cap = getChannelCapability(channel);
  if (!canDeliverAudio(channel)) {
    return {
      status: 'unsupported',
      phase: 'DELIVERY_REQUESTED',
      confirmed: false,
      channel: cap.id,
      operation: cap.audio_operation,
      message: UNSUPPORTED_AUDIO_MESSAGE,
      audio: audioPath || null,
      generation_id: generationId || null,
    };
  }
  return {
    status: 'ready',
    phase: 'DELIVERY_REQUESTED',
    confirmed: false,
    channel: cap.id,
    operation: cap.audio_operation,
    message: `Ready to deliver via authorized ${cap.audio_operation} on ${cap.id}. Not marked sent until the channel confirms.`,
    audio: audioPath || null,
    generation_id: generationId || null,
    notes: cap.notes,
  };
}

export function confirmDelivery(plan, channelAck) {
  if (!plan || plan.status === 'unsupported') {
    return { ...plan, confirmed: false, phase: 'DELIVERY_REQUESTED' };
  }
  if (!channelAck || channelAck.ok !== true) {
    return {
      ...plan,
      status: 'failed',
      confirmed: false,
      phase: 'DELIVERY_REQUESTED',
      message: 'Channel did not confirm delivery. Not reporting voice as sent.',
      ack: channelAck || null,
    };
  }
  return {
    ...plan,
    status: 'confirmed',
    confirmed: true,
    phase: 'DELIVERY_CONFIRMED',
    message: `Delivery confirmed by ${plan.channel} (${channelAck.reference || 'ack'}).`,
    ack: channelAck,
  };
}
