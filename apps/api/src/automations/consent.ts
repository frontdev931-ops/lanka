// Можно ли слать пациенту рекламные сообщения. Отказ (WITHDRAWN) блокирует всегда.
// «Невідомо» считается согласием только если владелец клиники подтвердил, что стандартное согласие пациентов это охватывает.
export const marketingAllowed = (consent: string, assumeConsent: boolean) => consent === 'GIVEN' || (assumeConsent && consent === 'UNKNOWN');
