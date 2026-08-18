/**
 * W4 rule-based reply classifier. No model is invoked.
 * confidence is rule-match strength, not AI confidence.
 */
export const CATEGORIES = [
  'OPT_OUT',
  'OUT_OF_OFFICE',
  'WRONG_PERSON',
  'NOT_INTERESTED',
  'PRICE_REQUEST',
  'QUESTION',
  'FOLLOW_UP',
  'INTERESTED',
  'UNKNOWN',
];

const RULES = [
  {
    classification: 'OPT_OUT',
    patterns: [
      /\bunsubscribe\b/i,
      /\bremove me\b/i,
      /\btake me off\b/i,
      /\bopt[ -]?out\b/i,
      /\bdon'?t contact me\b/i,
      /\bdo not contact\b/i,
      /\bstop emailing\b/i,
      /\bno more emails?\b/i,
      /\bstop (emailing|messaging|contacting)\b/i,
    ],
  },
  {
    classification: 'OUT_OF_OFFICE',
    patterns: [
      /\bout of (the )?office\b/i,
      /\bautomatic reply\b/i,
      /\bauto[- ]?reply\b/i,
      /\bautoresponder\b/i,
      /\baway from (the )?office\b/i,
      /\bon (annual )?leave\b/i,
      /\bi am currently away\b/i,
    ],
  },
  {
    classification: 'WRONG_PERSON',
    patterns: [
      /\bwrong person\b/i,
      /\bnot the right person\b/i,
      /\byou'?ve got the wrong\b/i,
      /\bno longer (work|works) here\b/i,
      /\bleft the company\b/i,
      /\bnot my (department|role|area)\b/i,
      /\bplease contact .+ instead\b/i,
    ],
  },
  {
    classification: 'NOT_INTERESTED',
    patterns: [
      /\bnot interested\b/i,
      /\bno thanks\b/i,
      /\bno thank you\b/i,
      /\bnot a (good )?fit\b/i,
      /\bdon'?t need\b/i,
      /\bdo not need\b/i,
      /\bpass on this\b/i,
      /\bwe will pass\b/i,
    ],
  },
  {
    classification: 'PRICE_REQUEST',
    patterns: [
      /\bpric(e|ing|es)\b/i,
      /\bquot(e|ation)\b/i,
      /\bhow much\b/i,
      /\bcost(s)?\b/i,
      /\brate card\b/i,
      /\bbudget\b/i,
      /\bunit price\b/i,
    ],
  },
  {
    classification: 'FOLLOW_UP',
    patterns: [
      /\bfollow(ing)? up\b/i,
      /\bjust checking\b/i,
      /\bcircling back\b/i,
      /\bany (update|news)\b/i,
      /\bdid you (get|receive)\b/i,
      /\bchecking in\b/i,
    ],
  },
  {
    classification: 'INTERESTED',
    patterns: [
      /\binterested\b/i,
      /\blet'?s (talk|chat|meet|schedule)\b/i,
      /\bschedule a (call|meeting)\b/i,
      /\bsend (more )?info\b/i,
      /\bsounds good\b/i,
      /\bwe'?d like\b/i,
      /\bwe would like\b/i,
      /\bplease send (a )?proposal\b/i,
      /\bbook a demo\b/i,
    ],
  },
  {
    classification: 'QUESTION',
    patterns: [
      /\?/,
      /\bhow (do|does|can|would)\b/i,
      /\bwhat (is|are|would)\b/i,
      /\bcan you\b/i,
      /\bcould you\b/i,
      /\bplease clarify\b/i,
      /\bquestion\b/i,
    ],
  },
];

export function classifyReply({ subject = '', body = '', snippet = '' } = {}) {
  const text = [subject, body, snippet].filter(Boolean).join('\n');
  const hay = String(text || '').trim();
  if (!hay) {
    return {
      classification: 'UNKNOWN',
      confidence: 0,
      reason: 'empty_message',
      signals: [],
      method: 'rules',
    };
  }

  for (const rule of RULES) {
    const signals = [];
    for (const pattern of rule.patterns) {
      const m = hay.match(pattern);
      if (m) signals.push(m[0]);
    }
    if (signals.length) {
      const confidence = Math.min(0.95, 0.62 + signals.length * 0.11);
      return {
        classification: rule.classification,
        confidence: Math.round(confidence * 100) / 100,
        reason: `rule:${rule.classification.toLowerCase()} matched ${signals.length} signal(s)`,
        signals,
        method: 'rules',
      };
    }
  }

  return {
    classification: 'UNKNOWN',
    confidence: 0.2,
    reason: 'no_rule_matched',
    signals: [],
    method: 'rules',
  };
}

export function isOptOut(classification) {
  return classification === 'OPT_OUT';
}

export const NOTIFY_CATEGORIES = new Set([
  'INTERESTED',
  'QUESTION',
  'PRICE_REQUEST',
  'FOLLOW_UP',
  'OPT_OUT',
]);
