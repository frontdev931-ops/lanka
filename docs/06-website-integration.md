# Website integration for existing forms

LANKA receives a copy of enquiries accepted by the clinic's existing website forms. The site's validation, confirmation, email and other destinations stay in place. Website form intake is included in Start and Pro. Custom website work and non-standard forms are quoted separately.

## Request an assisted connection

1. The clinic owner opens **Settings → Channels → Website**, enters the website address and selects **Request connection**. The request is saved in the platform inbox, and the team uses the account email to coordinate with the clinic's website maintainer. Each clinic can have one open request. Keep credentials out of the request.
2. The platform owner opens **/platform → Website connections**, opens the clinic and saves the allowed website address and the existing form's configuration. The current browser code appears in both the platform and clinic screens. Clinics with a prepared code or verified receipt can continue without a new request. Intake on/off stays under the clinic's control.
3. The team or website maintainer installs the code. The platform owner records installation separately. After an actual enquiry arrives, the platform owner checks its receipt and completes the request. The code alone does not verify receipt. For a prepared browser adapter the evidence must match its page and form ID. For server forwarding include the source `page_url` on the requested website so the team can identify the enquiry.

The platform reuses the existing contact-request inbox storage and mail service. The saved request stays visible if a notification fails. The new request fields and open-request unique index are in migration `20261118105238_assisted_website_connection`. Prepared form configuration uses the existing migration `20261118103755_lead_form_config`.

## Choose a delivery method

Use one delivery method per form. **Website installation code** provides the complete snippet once a platform owner has prepared the configuration. **Instructions for my developer** contains guidance, key management and the server alternative.

### Website server (recommended)

Use a backend or plugin hook that runs after the original handler confirms acceptance. Keep the site's existing actions intact. Where the platform provides a queue, enqueue the mapped copy for delivery by a worker with a timeout and backoff. Treat forwarding and queue failures separately from the original form result. If using a plugin's webhook, check that its failures cannot turn an accepted enquiry into a form error.

1. Turn on website form intake in LANKA. The clinic owner creates the server secret and saves it directly in the website's server configuration or secret store. LANKA shows it once and subsequently displays only its last four characters.
2. For each accepted submission, send a server request with the secret and a stable submission ID. Use the site's original entry ID when available. Prefix it with the site's or form's identifier if entry IDs can collide in the clinic. If the platform does not assign an ID, generate one when enqueuing and reuse it for all attempts.
3. Stop after acceptance by LANKA. Retry timeouts, network errors, HTTP 429 and 5xx using the same ID. Respect `Retry-After` if present. Surface permanent failures or exhausted retries in the site's delivery log or queue for staff to review. Log identifiers and delivery status without the secret, request body or contact values. A platform with no durable queue may lose the copy on a process or network failure.

```http
POST https://app.lankaclinic.app/backend/leads/v1/enquiries
Authorization: Bearer lsk_…
Idempotency-Key: contact:entry-12345
Content-Type: application/json

{"name":"…","phone":"…","message":"…","form_id":"contact",
 "page_url":"https://clinic.example/contact","utm_source":"google"}
```

The endpoint also accepts `application/x-www-form-urlencoded` and an ID in `submission_id` instead of the header. Keep the secret out of browser scripts, page markup and tag managers. The API resolves the clinic from that secret.

### Browser adapter

Use this option when server integration is unavailable and the existing form has a reliable success hook. Add the exact HTTPS origin where the form runs to the clinic's allowed origins. For a configured Elementor form, copy the whole block from **Website installation code**. LANKA uses the current public key and the web origin of its deployment. For custom integrations, the public key is also available under **Instructions for my developer**. If the site uses CSP, allow the LANKA origin in `script-src` and `connect-src`.

```html
<script src="https://app.lankaclinic.app/lanka-forms.js" data-form-key="PUBLIC_FORM_KEY" defer></script>
```

Use the adapter for the specific platform or wire these calls into the existing form handler. Capture the mapped values before the form can reset. Keep the returned function with that submission and call it only in its confirmed success callback:

```js
const forward = LankaForms.capture(existingForm, 'contact', 'name=your-name; phone=your-phone');
```

Call `forward()` after acceptance. The function shares one delivery attempt chain and stable ID across repeated calls. A later submission gets a fresh ID even if its fields match. The form receives `lanka:sent` with the enquiry ID and duplicate status, or `lanka:failed` after delivery fails. A temporary failure is retried once while the page is running. Navigation, browser policy or tab closure may interrupt delivery.

A click, submit event, form reset or attempted request cannot confirm acceptance. Forms with no reliable success hook need a platform-specific adapter or server integration. Existing attribute-only copy installations need to be wired to the original success hook before upgrading.

## Data and attribution

Send only `name`, `phone`, `email`, `message`, `service`, `form_id`, `page_url`, `referrer`, `utm_source`, `utm_medium`, `utm_campaign` and `submission_id` as applicable. A valid phone or email is required. New integrations send a distinct ID for every accepted submission (8–100 characters from `A-Z a-z 0-9 . _ : -`). The API deduplicates concurrent deliveries with the same ID within a clinic. Older requests without an ID use the legacy short-window content check.

Use attribution that was actually available. Send the source page's origin and path, referrer origin, and the three supported UTM fields separately. Leave unknown values out. The browser adapter keeps those UTM fields in the tab's session storage and excludes all other query parameters and URL fragments. Do not map hidden identifiers, consent controls or unrelated fields.

LANKA creates a **Website form** entry in **Inquiries**. Intake does not send anything to the enquiry contact or create marketing consent or a verified identity. The usual phone matching for the clinic's funnel still applies. Browser access uses the public key and origin list, with rate limits and the existing honeypot checks. A public key is not a credential.

A stored enquiry returns HTTP 200 with `{ "ok": true, "id": "…", "duplicate": false }`. An identified retry returns the existing ID and `duplicate: true`. The honeypot can return success with a null ID and store nothing. Typical errors include 400 (invalid data), 401 (missing or incorrect server secret or missing browser Origin), 403 (unavailable clinic), 404 (intake off, unknown key or disallowed origin), and 429 (rate limit).

## 112 Dental pilot

Read-only inspection of the [public home page](https://www.112dental.com.ua/) and its [public form script](https://www.112dental.com.ua/wp-content/plugins/elementor-pro/assets/js/form.5fb35271b8ba3fb1e7d6.bundle.min.js) identified WordPress with Elementor Pro Forms 3.31.0. The page defines these four widgets:

| Widget ID | Location | Form |
| --- | --- | --- |
| `25b8db1b` | Main page, desktop/tablet | Отримати консультацію |
| `6966a236` | Main page, mobile | Отримати консультацію |
| `4229aa4d` | Contact section in the footer | Консультація |
| `ba0657` | Popup | Консультація |

The pilot selects only the footer form on the home page. It forwards the name, phone and optional message. The phone input is `type="tel"` even though its Elementor field name is `form_fields[email]`. The public script raises `submit_success` only on a successful AJAX response and does so before reset or redirect. This is the first usable integration method available from public inspection. The installed server-side actions and queue are not visible. Before choosing server delivery for this site, confirm an acceptance-only hook and independent queue on the installed stack.

### Install on 112 Dental

Intake is enabled in the 112 Dental LANKA account and `https://www.112dental.com.ua` is on the allowed list. Verification is pending the first received enquiry.

1. After the LANKA update and migrations are deployed, the platform owner opens **/platform → Website connections**, selects 112 Dental and saves the JSON below in **Elementor form configuration**. Keep `https://www.112dental.com.ua` in the allowed addresses. This configuration is applied explicitly to 112 Dental.

```json
{
  "page": "https://www.112dental.com.ua/",
  "formId": "4229aa4d",
  "selector": "body.home [data-id=\"4229aa4d\"] form.elementor-form",
  "fields": {
    "name": "form_fields[name]",
    "phone": "form_fields[email]",
    "message": "form_fields[message]"
  }
}
```

2. Use **Copy code** under **Website installation code**. In WordPress, open **Elementor → Custom Code → Add New** and paste the entire block into one entry. Set **Location** to **`<body>` – End** and **Display Conditions** to **Include → Singular → Front Page**. Publish the entry and keep the form widget and its submission actions in place. [Elementor Custom Code](https://elementor.com/help/custom-code-pro/) · [Display conditions](https://elementor.com/help/conditions/)
3. Keep both LANKA script URLs intact and in order. In LiteSpeed Cache → Page Optimization → Tuning, put both URLs in **JS Excludes** if combining or rewriting them, and in **JS Deferred/Delayed Excludes** if LiteSpeed delays them. Clear the home page cache. If CSP is set, allow `https://app.lankaclinic.app` for scripts and connections. [LiteSpeed settings](https://docs.litespeedtech.com/lscache/lscwp/pageopt/)
4. Submit one agreed test enquiry from the footer's existing **Консультація** form. Check the site's usual confirmation and email delivery, then look for one Website form entry in LANKA **Inquiries**. Refresh the status in **Settings → Channels → Website** to view the verification date after receipt.

### Removal

In **Elementor → Custom Code**, move the LANKA entry to Draft or Trash and clear the home page cache. Remove matching LiteSpeed and CSP entries if they are no longer used. In LANKA remove the 112 Dental browser origin only if no other form there uses it. Disable intake only if the clinic no longer uses it for any form. The website's original handler and historical enquiries remain available.

The site was inspected without submitting an enquiry. The [local fixture](../examples/clinic-website/README.md) reproduces the selected form's lifecycle. The production flow still requires the owner's authorized end-to-end verification.
