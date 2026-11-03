// Whether marketing messages may be sent to the patient. A refusal (WITHDRAWN) always blocks.
// "Unknown" counts as consent only if the clinic owner confirmed that the patients' standard consent covers it.
export const marketingAllowed = (consent: string, assumeConsent: boolean) => consent === 'GIVEN' || (assumeConsent && consent === 'UNKNOWN');
