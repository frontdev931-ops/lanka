import { CONTENT_KINDS, HANDOFF_REASON_CODES, NEXT_ACTIONS } from './decision-contract';

// The strict JSON schema of the agent's decision (Messages API structured outputs, `output_config.format`). It closes what the model may say in the
// form: kinds, actions and hand-over codes are enumerations; services are named only by the references of THIS request. It does not replace the code's
// own checks (resolveDecision, the references, the reason codes still run on the parsed object), and a truncated answer is never read as valid.
// Advantages and objections do not exist yet (Stage 2), so they are not in the schema.
export function decisionSchema(serviceRefs: string[]): Record<string, unknown> {
  const ref = serviceRefs.length ? { type: 'string', enum: serviceRefs } : { type: 'string' };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['content', 'next'],
    properties: {
      content: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'reply', 'after', 'prices'],
        properties: {
          kind: { type: 'string', enum: [...CONTENT_KINDS] },
          reply: { type: 'string' },
          after: { type: 'string' },
          prices: { type: 'array', items: ref },
        },
      },
      next: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'service', 'reason'],
        properties: {
          action: { type: 'string', enum: [...NEXT_ACTIONS] },
          service: { anyOf: [ref, { type: 'null' }] },
          reason: { anyOf: [{ type: 'string', enum: [...HANDOFF_REASON_CODES] }, { type: 'null' }] },
        },
      },
    },
  };
}
