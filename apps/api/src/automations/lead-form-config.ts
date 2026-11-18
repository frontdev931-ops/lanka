export const FORM_ID = /^[\p{L}\p{N} ._:/-]{1,80}$/u;
const MAPPED_FIELDS = new Set(['name', 'phone', 'email', 'message', 'service']);

export interface LeadFormConfig {
  page: string;
  formId: string;
  selector: string;
  fields: Record<string, string>;
}

export function readLeadFormConfig(value: unknown): LeadFormConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { page, formId, selector, fields } = value as Record<string, unknown>;
  if (typeof page !== 'string' || page.length > 1000 || !URL.canParse(page)) return null;
  const url = new URL(page);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  if (typeof formId !== 'string' || !FORM_ID.test(formId.trim())) return null;
  if (typeof selector !== 'string' || !selector.trim() || selector.length > 500) return null;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;

  const mapped: Record<string, string> = {};
  for (const [key, name] of Object.entries(fields)) {
    if (!MAPPED_FIELDS.has(key) || typeof name !== 'string' || !name.trim() || name.length > 160 || /[,;=]/.test(name)) return null;
    mapped[key] = name.trim();
  }
  if (!mapped.phone && !mapped.email) return null;
  return { page: url.href, formId: formId.trim(), selector: selector.trim(), fields: mapped };
}

function attr(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function leadInstallationCode(site: string, key: string, form: LeadFormConfig) {
  const fields = Object.entries(form.fields).map(([field, name]) => `${field}=${name}`).join('; ');
  return [
    `<script defer src="${attr(`${site}/lanka-forms.js`)}"`,
    `        data-form-key="${attr(key)}"></script>`,
    `<script defer src="${attr(`${site}/lanka-forms-elementor.js`)}"`,
    `        data-form-selector="${attr(form.selector)}"`,
    `        data-form-id="${attr(form.formId)}"`,
    `        data-lanka-fields="${attr(fields)}"></script>`,
  ].join('\n');
}
