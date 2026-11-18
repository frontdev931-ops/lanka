/* LANKA chat widget for a clinic website.
   <script src="https://app.lankaclinic.app/widget.js" data-key="PUBLIC_CHAT_KEY" async></script>
   Loads after the page (async), never blocks it. Talks only to /backend/webchat/KEY/... of the same address it was loaded from; works only on the sites
   listed in LANKA. Draws everything inside a shadow root (the clinic's styles do not touch it, and it does not touch them). No cookies, no third-party code.
   Session: a token kept in this browser's localStorage for 24 hours; within it a reload or another page of the site continues the same conversation;
   after it a new conversation starts. Text is always inserted as text (never as HTML). */
(function () {
  var script = document.currentScript || document.querySelector('script[data-key][src*="widget.js"]');
  if (!script) return;
  var key = script.getAttribute('data-key');
  if (!key || window.__lankaWidget) return;
  window.__lankaWidget = true;
  var base = new URL(script.src).origin + '/backend/webchat/' + encodeURIComponent(key);
  var lang = ((document.documentElement.getAttribute('lang') || navigator.language || 'uk').slice(0, 2)).toLowerCase();
  var T = {
    uk: { open: 'Написати в клініку', close: 'Закрити чат', ph: 'Ваше повідомлення', send: 'Надіслати', name: 'Ваше ім’я (необов’язково)', phone: 'Телефон (необов’язково)', start: 'Почати розмову', loading: 'Завантаження…', unavailable: 'Чат зараз недоступний. Зателефонуйте, будь ласка, до клініки.', sending: 'Надсилається…', failed: 'Не надіслано.', retry: 'Повторити', staff: 'Покликати адміністратора', staffAsked: 'Ви попросили адміністратора', staffWho: 'Відповідає адміністратор клініки, щойно прочитає повідомлення.', aiWho: 'Відповідає ШІ-помічник клініки; адміністратора можна покликати будь-коли.', note: 'Не пишіть тут про стан здоров’я: для цього зателефонуйте до клініки.', wait: 'Повідомлення отримано. Відповідь з’явиться тут, щойно адміністратор його прочитає.', expired: 'Попередня розмова завершилась. Почніть нову.' },
    ru: { open: 'Написать в клинику', close: 'Закрыть чат', ph: 'Ваше сообщение', send: 'Отправить', name: 'Ваше имя (необязательно)', phone: 'Телефон (необязательно)', start: 'Начать разговор', loading: 'Загрузка…', unavailable: 'Чат сейчас недоступен. Позвоните, пожалуйста, в клинику.', sending: 'Отправляется…', failed: 'Не отправлено.', retry: 'Повторить', staff: 'Позвать администратора', staffAsked: 'Вы попросили администратора', staffWho: 'Отвечает администратор клиники, как только прочитает сообщение.', aiWho: 'Отвечает ИИ-помощник клиники; администратора можно позвать в любой момент.', note: 'Не пишите здесь о состоянии здоровья: для этого позвоните в клинику.', wait: 'Сообщение получено. Ответ появится здесь, как только администратор его прочитает.', expired: 'Предыдущий разговор завершён. Начните новый.' },
    en: { open: 'Message the clinic', close: 'Close chat', ph: 'Your message', send: 'Send', name: 'Your name (optional)', phone: 'Phone (optional)', start: 'Start chatting', loading: 'Loading…', unavailable: 'The chat is not available now. Please call the clinic.', sending: 'Sending…', failed: 'Not sent.', retry: 'Retry', staff: 'Ask for a staff member', staffAsked: 'You asked for a staff member', staffWho: 'A clinic administrator replies as soon as they read your message.', aiWho: 'The clinic’s AI assistant replies; you can ask for a staff member at any time.', note: 'Please do not write about your health here: call the clinic for that.', wait: 'Message received. The reply will appear here as soon as an administrator reads it.', expired: 'The previous conversation has ended. Please start a new one.' }
  };
  var t = T[lang] || T.uk;
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} } };
  var tokenKey = 'lanka-chat-' + key;
  var token = store.get(tokenKey);
  var cfg = null;
  var last = null;
  var shown = {};
  var timer = null;

  function api(method, path, body) {
    var h = {};
    if (body) h['Content-Type'] = 'application/json';
    if (token) h.Authorization = 'Bearer ' + token;
    return fetch(base + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined, credentials: 'omit' }).then(function (r) {
      if (r.status === 401) { token = null; store.set(tokenKey, ''); var e = new Error('session'); e.session = true; throw e; }
      if (!r.ok) { var x = new Error('http ' + r.status); x.status = r.status; throw x; }
      return r.json();
    });
  }

  var host = document.createElement('div');
  host.setAttribute('data-lanka-chat', '');
  var root = host.attachShadow({ mode: 'open' });
  // white text on a dark accent, dark text on a light one (the clinic picks the colour; the text stays readable)
  function fgOn(hex) {
    var n = parseInt(hex.slice(1), 16);
    var lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.62 ? '#14212b' : '#fff';
  }
  function draw(color, left) {
    var fg = fgOn(color);
    host.style.cssText = 'position:fixed;' + (left ? 'left' : 'right') + ':16px;bottom:16px;z-index:2147483000;';
    root.innerHTML =
      '<style>' +
      ':host{all:initial}*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}' +
      '.fab{background:' + color + ';color:' + fg + ';border:0;border-radius:28px;padding:0 20px;height:52px;font-size:16px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.2)}' +
      '.fab:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #1d4ed8;outline-offset:2px}' +
      '.panel{display:none;flex-direction:column;width:min(370px,calc(100vw - 32px));height:min(560px,calc(100vh - 100px));background:#fff;color:#14212b;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.25);overflow:hidden}' +
      '.panel.on{display:flex}' +
      '@media (max-width:480px){.panel.on{position:fixed;inset:0;width:100vw;height:100%;border-radius:0}}' +
      '.head{background:' + color + ';color:' + fg + ';padding:8px 6px 8px 14px;display:flex;justify-content:space-between;align-items:center;gap:8px}' +
      '.ttl{font-weight:600;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.x{background:none;border:0;color:inherit;font-size:24px;cursor:pointer;min-width:44px;min-height:44px}' +
      '.who{font-size:13px;color:#3d4b57;padding:8px 12px;background:#f8fafb;border-bottom:1px solid #e2e8ee}' +
      '.log{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f3f6f8}' +
      '.m{max-width:85%;padding:9px 12px;border-radius:12px;font-size:15px;line-height:1.35;white-space:pre-wrap;overflow-wrap:anywhere}' +
      '.in{align-self:flex-end;background:' + color + ';color:' + fg + '}.out{align-self:flex-start;background:#fff;color:#14212b;border:1px solid #e2e8ee}' +
      '.sys{align-self:center;font-size:13px;color:#5b6b79;text-align:center}' +
      '.st{font-size:12px;align-self:flex-end;color:#5b6b79;margin-top:-4px}.st.bad{color:#b42318}' +
      '.st button{background:none;border:0;color:#b42318;text-decoration:underline;cursor:pointer;font-size:12px;min-height:32px}' +
      '.btns{display:flex;flex-wrap:wrap;gap:6px;align-self:flex-start}.b{border:1px solid ' + color + ';color:#14212b;background:#fff;border-radius:999px;padding:0 14px;min-height:44px;font-size:15px;cursor:pointer}' +
      '.note{font-size:12px;color:#5b6b79;padding:6px 12px;background:#fff}' +
      '.row{display:flex;gap:8px;padding:10px;background:#fff;border-top:1px solid #e2e8ee}' +
      'input{flex:1;min-width:0;min-height:44px;border:1px solid #cdd5dc;border-radius:10px;padding:0 12px;font-size:16px;color:#14212b;background:#fff}' +
      '.go{background:' + color + ';color:' + fg + ';border:0;border-radius:10px;min-height:44px;padding:0 16px;font-size:15px;cursor:pointer}' +
      '.go[disabled]{opacity:.6;cursor:default}' +
      '.ask{background:#fff;color:#14212b;border:1px solid #cdd5dc;border-radius:10px;min-height:44px;margin:0 10px 10px;font-size:14px;cursor:pointer}' +
      '.form{display:flex;flex-direction:column;gap:8px;padding:14px;background:#fff;flex:1}' +
      '.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}' +
      '</style>' +
      '<button class="fab" type="button" aria-haspopup="dialog" aria-expanded="false"></button>' +
      '<div class="panel" role="dialog" aria-modal="false"><div class="head"><span class="ttl" id="lk-ttl"></span><button class="x" type="button">×</button></div>' +
      '<div class="who"></div>' +
      '<div class="form"><p class="sys gr" style="margin:0"></p><div class="note"></div><label class="vh" for="lk-nm"></label><input id="lk-nm" class="nm" autocomplete="name" maxlength="80"><label class="vh" for="lk-ph"></label><input id="lk-ph" class="ph" autocomplete="tel" inputmode="tel" maxlength="30"><button class="go start" type="button"></button></div>' +
      '<div class="log" role="log" aria-live="polite" style="display:none"></div>' +
      '<button class="ask" type="button" style="display:none"></button>' +
      '<div class="row" style="display:none"><label class="vh" for="lk-tx"></label><input id="lk-tx" class="tx" maxlength="1000"><button class="go sd" type="button"></button></div></div>';
  }
  var q = function (s) { return root.querySelector(s); };

  function label() {
    q('.fab').textContent = t.open;
    q('.panel').setAttribute('aria-labelledby', 'lk-ttl');
    q('.ttl').textContent = cfg && cfg.name ? cfg.name : t.open;
    q('.x').setAttribute('aria-label', t.close);
    q('.who').textContent = cfg && cfg.ai ? t.aiWho : t.staffWho;
    q('.gr').textContent = (cfg && cfg.greeting) || '';
    q('.note').textContent = t.note;
    q('label[for="lk-nm"]').textContent = t.name; q('.nm').placeholder = t.name;
    q('label[for="lk-ph"]').textContent = t.phone; q('.ph').placeholder = t.phone;
    q('.start').textContent = t.start; q('.sd').textContent = t.send;
    q('label[for="lk-tx"]').textContent = t.ph; q('.tx').placeholder = t.ph;
    q('.ask').textContent = t.staff;
  }

  function scroll() { var log = q('.log'); log.scrollTop = log.scrollHeight; }
  function bubble(cls, text) {
    var d = document.createElement('div');
    d.className = 'm ' + cls;
    d.textContent = text;
    q('.log').appendChild(d);
    return d;
  }
  function add(m) {
    if (m.id && shown[m.id]) return;
    if (m.id) shown[m.id] = 1;
    bubble(m.direction === 'IN' ? 'in' : 'out', m.text);
    if (m.createdAt) last = m.createdAt;
    if (m.direction === 'OUT' && m.buttons && m.buttons.length) {
      var w = document.createElement('div');
      w.className = 'btns';
      m.buttons.forEach(function (b) {
        var e = document.createElement('button');
        e.type = 'button'; e.className = 'b'; e.textContent = b.label;
        e.onclick = function () { w.remove(); post(b.label, b.payload); };
        w.appendChild(e);
      });
      q('.log').appendChild(w);
    }
    scroll();
  }
  function sys(text) { var d = bubble('sys', text); scroll(); return d; }

  // a message of the visitor: shown at once with "sending", then either kept (answers follow) or marked "not sent" with a retry of the same words
  function post(text, payload, existing) {
    if (!text || !text.trim()) return;
    var b = existing || bubble('in', text);
    var st = document.createElement('div');
    st.className = 'st';
    st.textContent = t.sending;
    b.after(st);
    scroll();
    api('POST', '/messages', { text: text, payload: payload }).then(function (r) {
      st.remove();
      var got = r.messages || [];
      // the server stored the visitor's message too: do not draw it twice when polling
      got.forEach(add);
      if (!got.length) sys(t.wait);
    }).catch(function (e) {
      if (e.session) { st.remove(); b.remove(); sys(t.expired); showForm(); return; }
      st.className = 'st bad';
      st.textContent = t.failed + ' ';
      var again = document.createElement('button');
      again.type = 'button'; again.textContent = t.retry;
      again.onclick = function () { st.remove(); post(text, payload, b); };
      st.appendChild(again);
    });
  }
  function showForm() {
    q('.form').style.display = 'flex';
    q('.log').style.display = 'none'; q('.row').style.display = 'none'; q('.ask').style.display = 'none';
  }
  function chat() {
    q('.form').style.display = 'none';
    q('.log').style.display = 'flex'; q('.row').style.display = 'flex'; q('.ask').style.display = 'block';
    if (timer) clearInterval(timer);
    // answers of staff arrive later: new messages are asked for while the panel is open
    timer = setInterval(function () {
      if (!q('.panel').classList.contains('on') || !token) return;
      api('GET', '/messages' + (last ? '?after=' + encodeURIComponent(last) : '')).then(function (r) { (r.messages || []).forEach(function (m) { if (m.direction === 'OUT') add(m); else if (m.id) shown[m.id] = 1; }); }).catch(function () {});
    }, 6000);
  }
  function restore() {
    var l = sys(t.loading);
    api('GET', '/messages').then(function (r) {
      l.remove();
      chat();
      if (cfg && cfg.greeting) sys(cfg.greeting);
      (r.messages || []).forEach(add);
    }).catch(function (e) { l.remove(); if (e.session) sys(t.expired); showForm(); });
  }
  function start() {
    var btn = q('.start');
    btn.disabled = true;
    btn.textContent = t.loading;
    api('POST', '/session', { name: q('.nm').value, phone: q('.ph').value }).then(function (r) {
      token = r.token; store.set(tokenKey, token);
      chat();
      if (cfg && cfg.greeting) sys(cfg.greeting);
      q('.tx').focus();
    }).catch(function () { btn.textContent = t.unavailable; }).then(function () { btn.disabled = false; if (btn.textContent === t.loading) btn.textContent = t.start; });
  }
  function openPanel() {
    q('.fab').style.display = 'none';
    q('.fab').setAttribute('aria-expanded', 'true');
    q('.panel').classList.add('on');
    if (token) { q('.form').style.display = 'none'; q('.log').style.display = 'flex'; restore(); }
    else { showForm(); q('.nm').focus(); }
  }
  function closePanel() {
    q('.panel').classList.remove('on');
    q('.fab').style.display = '';
    q('.fab').setAttribute('aria-expanded', 'false');
    q('.fab').focus();
  }

  function wire() {
    label();
    q('.fab').onclick = openPanel;
    q('.x').onclick = closePanel;
    q('.panel').addEventListener('keydown', function (e) { if (e.key === 'Escape') closePanel(); });
    q('.start').onclick = start;
    q('.sd').onclick = function () { var i = q('.tx'); var v = i.value; i.value = ''; post(v); i.focus(); };
    q('.tx').addEventListener('keydown', function (e) { if (e.key === 'Enter') q('.sd').click(); });
    q('.ask').onclick = function () {
      var btn = q('.ask');
      btn.disabled = true;
      bubble('in', t.staffAsked);
      api('POST', '/handoff').then(function (r) {
        (r.messages || []).forEach(add);
        cfg = cfg || {}; cfg.ai = false;
        q('.who').textContent = t.staffWho;
        btn.style.display = 'none';
      }).catch(function () { sys(t.failed); btn.disabled = false; });
    };
  }

  function mount() {
    // only when the site is allowed to use this chat: otherwise nothing is drawn at all
    fetch(base + '/config', { credentials: 'omit' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (c) {
      if (!c) return;
      cfg = c;
      var color = /^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color : '#0e9aa0';
      draw(color, c.position === 'LEFT');
      wire();
      document.body.appendChild(host);
    }).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
