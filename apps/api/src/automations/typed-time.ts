// A time a person typed as an answer to the times we offered: "19:00", "на 11", "давай на 11", "в 19-30", "11 годин".
// Only a short statement counts; a question ("а 12:00 буде лікар?") or a long message is not a choice. Returns "HH:MM" or null.
export function parseTypedTime(text: string): string | null {
  const t = text.trim().toLowerCase();
  if (t.length === 0 || t.length > 40 || t.includes('?')) return null;
  const fmt = (h: string, m?: string) => {
    const hour = Number(h);
    const min = m ? Number(m) : 0;
    return hour <= 23 && min <= 59 ? `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}` : null;
  };
  // "19:00" anywhere
  const colon = /(?<!\d)(\d{1,2}):(\d{2})(?!\d)/.exec(t);
  if (colon) return fmt(colon[1], colon[2]);
  // a number after a preposition: "на 11", "в 19-30", "о 15.30", "к 10"
  const after = [...t.matchAll(/(?<![\p{L}\d])(?:на|в|во|о|об|к|at)\s*(\d{1,2})(?:[.\-](\d{2}))?(?![\d:.\-])/gu)].pop();
  if (after) return fmt(after[1], after[2]);
  // nothing but a number (and a polite word): "11", "давай 11", "11 годин"
  const bare = /^(?:давай(?:те)?|добре|ок|окей|хочу|можна|можно|пусть)?\s*(\d{1,2})(?:[.\-](\d{2}))?\s*(?:годин[іуи]?|часов|часа|час|год\.?|ч\.?)?\.?$/u.exec(t);
  if (bare) return fmt(bare[1], bare[2]);
  return null;
}
