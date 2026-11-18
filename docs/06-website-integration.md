# Website integration for existing forms

LANKA receives a copy of enquiries accepted by the clinic's existing website forms. The site's validation, confirmation, email and other destinations stay in place. Website form intake is included in Start and Pro. Custom website work and non-standard forms are quoted separately.

## Request an assisted connection

1. The clinic owner opens **Settings → Channels → Website**, enters the website address and selects **Request connection**. The request is saved in the platform inbox, and the team uses the account email to coordinate with the clinic's website maintainer. Each clinic can have one open request. Keep credentials out of the request.
2. The platform owner opens **/platform → Website connections** to review the request. For browser installation, save the existing form's configuration through the authorized API below. The installer adds the adapter to the website and the platform owner selects **Record installation**. Intake for an existing setup stays under the clinic's control.
3. After an actual enquiry arrives, refresh the status in **/platform → Website connections** and select **Complete request**. The receipt must come from that clinic after the request was made. When a saved form configuration belongs to the requested origin, the receipt must also match the saved page and form ID. For server forwarding without a saved form configuration, send the source `page_url` on the requested website. The clinic screen shows the most recent website enquiry across its forms and links to **Inquiries**.

The platform reuses the existing contact-request inbox storage and mail service. The saved request stays visible if a notification fails. The new request fields and open-request unique index are in migration `20261118105238_assisted_website_connection`. Prepared form configuration uses the existing migration `20261118103755_lead_form_config`.

## Save browser configuration through the platform API

1. Sign in to LANKA with authorized platform access. Find the clinic ID in `GET /backend/platform/clinics` or in `GET /backend/platform/website-requests` for an open request. For a session in the target clinic, `GET /backend/auth/me` returns `clinicId` and `clinicName`.
2. Read `GET /backend/platform/clinics/{clinicId}/website`. Verify `origins`, `enabled`, and the saved `formConfig`. Use the existing `formKey` in browser code. A clinic owner or manager can also read the key from `GET /backend/automations/leads` in the target clinic's session.
3. Send `PATCH /backend/platform/clinics/{clinicId}/website` with `Content-Type: application/json` and a body containing `formConfig` with the verified `page`, `formId`, `selector`, and `fields`. Omit `origins` when the page's exact origin is already allowed. When adding an origin, include the current list plus the new origin because the field replaces the list. Each clinic stores one form configuration for the verification match, so check which form the current configuration describes before replacing it. Saving this configuration preserves the existing public key and intake setting. A new key is issued only if the clinic lacks one. The authenticated response includes the complete `snippet` when a public key and matching origin are present.

Use the app's own origin for these requests. In a signed-in browser tab, same-origin `fetch` uses the existing session cookie.

## Choose a delivery method

Use one delivery method per form.

### Website server (recommended)

Use a backend or plugin hook that runs after the original handler confirms acceptance. Keep the site's existing actions intact. Where the platform provides a queue, enqueue the mapped copy for delivery by a worker with a timeout and backoff. Treat forwarding and queue failures separately from the original form result. If using a plugin's webhook, check that its failures cannot turn an accepted enquiry into a form error.

1. Turn on intake with the clinic control or send `PATCH /backend/automations/leads` with `{"enabled":true}` as a clinic owner or manager. For a new server integration, the clinic owner can use `POST /backend/automations/leads/secret` to create its secret and save the returned `secret` directly in the website's server configuration or secret store. Check `secret.set` in the settings first. The POST replaces any existing secret, so reuse the site server's stored secret when it exists.
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

Use this option when server integration is unavailable and the existing form has a reliable success hook. Add the exact HTTPS origin where the form runs to the clinic's allowed origins. Use the public key from the authorized API. For a configured Elementor form, use the response's `snippet` or the two scripts shown in the 112 Dental example with that site's verified selector and mapping. If the site uses CSP, allow the LANKA origin in `script-src` and `connect-src`.

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

The previous 112 Dental setup had intake enabled and `https://www.112dental.com.ua` on the allowed list. Check the current settings through the API before installation. Verification requires an actual enquiry.

1. In LANKA, use the 112 Dental clinic ID and send `PATCH /backend/platform/clinics/{clinicId}/website` with the body below if this form configuration has not already been saved. Keep `https://www.112dental.com.ua` in `origins` and reuse the current `formKey`.

   ```json
   {
     "formConfig": {
       "page": "https://www.112dental.com.ua/",
       "formId": "4229aa4d",
       "selector": "body.home [data-id=\"4229aa4d\"] form.elementor-form",
       "fields": {
         "name": "form_fields[name]",
         "phone": "form_fields[email]",
         "message": "form_fields[message]"
       }
     }
   }
   ```

2. Replace `PUBLIC_FORM_KEY` with the current 112 Dental `formKey`. In WordPress, open **Elementor → Custom Code → Add New** and paste both tags into one entry. Set **Location** to **`<body>` – End** and **Display Conditions** to **Include → Singular → Front Page** for `https://www.112dental.com.ua/`. Publish the entry and keep the form widget and its submission actions in place. [Elementor Custom Code](https://elementor.com/help/custom-code-pro/) · [Display conditions](https://elementor.com/help/conditions/)

   ```html
   <script defer src="https://app.lankaclinic.app/lanka-forms.js"
           data-form-key="PUBLIC_FORM_KEY"></script>
   <script defer src="https://app.lankaclinic.app/lanka-forms-elementor.js"
           data-form-selector='body.home [data-id="4229aa4d"] form.elementor-form'
           data-form-id="4229aa4d"
           data-lanka-fields="name=form_fields[name]; phone=form_fields[email]; message=form_fields[message]"></script>
   ```

3. Keep both LANKA script URLs intact and in order. In LiteSpeed Cache → Page Optimization → Tuning, put both URLs in **JS Excludes** if combining or rewriting them, and in **JS Deferred/Delayed Excludes** if LiteSpeed delays them. Clear the home page cache. If CSP is set, allow `https://app.lankaclinic.app` for scripts and connections. [LiteSpeed settings](https://docs.litespeedtech.com/lscache/lscwp/pageopt/)
4. For an open request, use **Record installation** in `/platform`. Submit one agreed test enquiry from the footer's existing **Консультація** form. Check the site's usual confirmation and email delivery, then find exactly one matching **Website form** entry in the 112 Dental **Inquiries** log. Refresh the clinic status to view the latest receipt and refresh the platform status to see the matching receipt before completing an open request.

### Removal

In **Elementor → Custom Code**, move the LANKA entry to Draft or Trash and clear the home page cache. Remove matching LiteSpeed and CSP entries if they are no longer used. In LANKA remove the 112 Dental browser origin only if no other form there uses it. Disable intake only if the clinic no longer uses it for any form. The website's original handler and historical enquiries remain available.

The site was inspected without submitting an enquiry. The [local fixture](../examples/clinic-website/README.md) reproduces the selected form's lifecycle. The production flow still requires the owner's authorized end-to-end verification.
