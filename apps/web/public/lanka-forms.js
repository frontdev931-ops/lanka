/* LANKA website form adapter.
   <script src="https://app.lankaclinic.app/lanka-forms.js" data-form-key="PUBLIC_FORM_KEY" async></script>
   Copy: call LankaForms.capture(form, formId, 'name=your-name; phone=your-phone') before the form resets.
   Call the returned function only from the original handler's confirmed success hook for that submission.
   Existing data-lanka-mode="lanka" forms still use the original LANKA-only flow and its data-lanka-* options.
   Events on the form: "lanka:sent" (detail: {id, duplicate}) and "lanka:failed" (detail: {status, message}).
   From the site's own script: LankaForms.send({ name, phone, email, message, service, form_id }) -> Promise<{ ok, id, duplicate }>.
   Sent: the mapped fields, the page address WITHOUT its query (utm_source / utm_medium / utm_campaign separately), the referring site (origin only).
   No cookies, no other fields, no page contents. The public key only works from the sites listed in LANKA; it is not a secret. */
(function () {
  if (window.LankaForms) return;
  var script = document.currentScript || document.querySelector('script[data-form-key][src*="lanka-forms.js"]');
  if (!script) return;
  var key = script.getAttribute('data-form-key');
  if (!key) return;
  var endpoint = new URL(script.src).origin + '/backend/leads/' + encodeURIComponent(key);
  var lang = ((document.documentElement.getAttribute('lang') || navigator.language || 'uk').slice(0, 2)).toLowerCase();
  var T = {
    uk: { sending: 'Надсилаємо…', ok: 'Дякуємо! Заявку отримано, клініка зв’яжеться з вами.', err: 'Не вдалося надіслати заявку. Спробуйте ще раз або зателефонуйте до клініки.' },
    ru: { sending: 'Отправляем…', ok: 'Спасибо! Заявка получена, клиника свяжется с вами.', err: 'Не удалось отправить заявку. Попробуйте ещё раз или позвоните в клинику.' },
    en: { sending: 'Sending…', ok: 'Thank you! Your request was received; the clinic will contact you.', err: 'Could not send your request. Please try again or call the clinic.' }
  };
  var t = T[lang] || T.uk;
  var FIELDS = ['name', 'phone', 'email', 'message', 'service'];
  var UTM = ['utm_source', 'utm_medium', 'utm_campaign'];
  var store = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  };

  // the campaign marks of the address the visitor came in by, kept for this browser tab (a form on a later page still gets them)
  (function () {
    var q = new URLSearchParams(location.search);
    var got = {};
    var any = false;
    UTM.forEach(function (k) { var v = q.get(k); if (v) { got[k] = v.slice(0, 120); any = true; } });
    if (any) store.set('lanka-utm', JSON.stringify(got));
  })();
  function utm() { try { return JSON.parse(store.get('lanka-utm') || '{}'); } catch (e) { return {}; } }
  function referrer() { try { return document.referrer ? new URL(document.referrer).origin : ''; } catch (e) { return ''; } }
  function newId() {
    if (window.crypto && crypto.randomUUID) return 'web-' + crypto.randomUUID();
    return 'web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  // A form-urlencoded body needs no CORS preflight; keepalive lets the browser attempt delivery across navigation.
  async function post(data, keepalive) {
    var body = new URLSearchParams();
    Object.keys(data).forEach(function (k) { if (data[k]) body.append(k, String(data[k])); });
    return fetch(endpoint, { method: 'POST', body: body, keepalive: !!keepalive, credentials: 'omit', mode: 'cors' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.ok && j && j.ok) return { ok: true, id: j.id || null, duplicate: !!j.duplicate };
        var e = new Error((j && j.message) || ('HTTP ' + r.status));
        e.status = r.status;
        throw e;
      });
    });
  }
  // Retry once with the same submission id on a network failure, 429 or 5xx.
  function deliver(data, keepalive) {
    return post(data, keepalive).catch(function (e) {
      if (e.status && e.status < 500 && e.status !== 429) throw e;
      return new Promise(function (res) { setTimeout(res, 1500); }).then(function () { return post(data, keepalive); });
    });
  }

  function payload(values, formId, submissionId) {
    var d = { submission_id: submissionId, form_id: formId || '', page_url: location.origin + location.pathname, referrer: referrer() };
    FIELDS.forEach(function (f) { if (values[f]) d[f] = String(values[f]).slice(0, 1000); });
    var u = utm();
    UTM.forEach(function (k) { if (u[k]) d[k] = u[k]; });
    return d;
  }

  function mapping(fields) {
    var m = {};
    (fields || '').split(/[;,]/).forEach(function (pair) {
      var p = pair.split('=');
      var k = (p[0] || '').trim();
      var v = (p[1] || '').trim();
      if (FIELDS.indexOf(k) >= 0 && v) m[k] = v;
    });
    return m;
  }
  function read(form, m) {
    var out = {};
    Object.keys(m).forEach(function (k) {
      var el = form.elements.namedItem(m[k]);
      if (el && typeof el.value === 'string') out[k] = el.value.trim();
    });
    return out;
  }
  function fire(form, name, detail) {
    try { form.dispatchEvent(new CustomEvent(name, { detail: detail, bubbles: true })); } catch (e) {}
  }
  function capture(form, formId, fields) {
    var data = payload(read(form, mapping(fields)), formId, newId());
    var delivery;
    return function forwardAcceptedSubmission() {
      if (!delivery) {
        delivery = deliver(data, true);
        delivery.then(function (r) { fire(form, 'lanka:sent', r); }, function (e) {
          fire(form, 'lanka:failed', { status: e.status || 0, message: e.message });
        });
      }
      return delivery;
    };
  }
  function statusEl(form) {
    var s = form.querySelector('[data-lanka-status]');
    if (!s) {
      s = document.createElement('div');
      s.setAttribute('data-lanka-status', '');
      form.appendChild(s);
    }
    s.setAttribute('role', 'status');
    s.setAttribute('aria-live', 'polite');
    return s;
  }

  function connect(form) {
    if (!form || form.__lanka || form.getAttribute('data-lanka-mode') !== 'lanka') return;
    form.__lanka = true;
    var m = mapping(form.getAttribute('data-lanka-fields'));
    var formId = (form.getAttribute('data-lanka-form') || '').slice(0, 80);
    var last = { sig: '', id: '' };
    form.addEventListener('submit', function (ev) {
      var values = read(form, m);
      // the same values again (a retry after a failure, a double press) keep the same submission id
      var sig = JSON.stringify(values);
      if (sig !== last.sig) last = { sig: sig, id: newId() };
      var data = payload(values, formId, last.id);
      ev.preventDefault();
      var s = statusEl(form);
      var btn = form.querySelector('[type="submit"]');
      if (btn) btn.disabled = true;
      s.textContent = t.sending;
      deliver(data, false).then(function (r) {
        s.textContent = form.getAttribute('data-lanka-success') || t.ok;
        last = { sig: '', id: '' };
        fire(form, 'lanka:sent', r);
        form.reset();
        var to = form.getAttribute('data-lanka-redirect');
        if (to) location.assign(to);
      }, function (e) {
        // never silent: the visitor sees that it did not go through, and the filled form stays for another try
        s.textContent = (e.status === 400 && e.message ? e.message + '. ' : '') + (form.getAttribute('data-lanka-error') || t.err);
        fire(form, 'lanka:failed', { status: e.status || 0, message: e.message });
      }).then(function () { if (btn) btn.disabled = false; });
    });
  }

  function scan() {
    var list = document.querySelectorAll('form[data-lanka-form]');
    for (var i = 0; i < list.length; i++) connect(list[i]);
  }

  window.LankaForms = {
    capture: capture,
    connect: connect,
    scan: scan,
    // for a site's own script: one enquiry; pass submission_id to make your own retries safe
    send: function (values) {
      values = values || {};
      return deliver(payload(values, values.form_id, values.submission_id || newId()), false);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();
})();
