/* LANKA chat widget for a clinic website.
   <script src="https://lankaclinic.app/widget.js" data-key="KEY" async></script>
   It talks to the same site address (/backend/webchat/KEY/...), keeps a session token in this browser only, and
   draws everything inside a shadow root so the clinic's own styles do not touch it. No third-party code, no cookies. */
(function () {
  var script = document.currentScript || document.querySelector('script[data-key][src*="widget.js"]');
  if (!script) return;
  var key = script.getAttribute('data-key');
  if (!key || window.__lankaWidget) return;
  window.__lankaWidget = true;
  var base = new URL(script.src).origin + '/backend/webchat/' + encodeURIComponent(key);
  var lang = (navigator.language || 'uk').slice(0, 2);
  var T = {
    uk: { open: 'Написати в клініку', title: 'Чат клініки', ph: 'Ваше повідомлення', send: 'Надіслати', name: 'Ваше ім’я (необов’язково)', phone: 'Телефон (необов’язково)', start: 'Почати розмову', wait: 'Повідомлення отримано. Адміністратор клініки відповість найближчим часом.', err: 'Не вдалося надіслати. Спробуйте ще раз.', close: 'Закрити', note: 'Не пишіть тут про стан здоров’я: для цього зателефонуйте до клініки.' },
    ru: { open: 'Написать в клинику', title: 'Чат клиники', ph: 'Ваше сообщение', send: 'Отправить', name: 'Ваше имя (необязательно)', phone: 'Телефон (необязательно)', start: 'Начать разговор', wait: 'Сообщение получено. Администратор клиники ответит в ближайшее время.', err: 'Не удалось отправить. Попробуйте ещё раз.', close: 'Закрыть', note: 'Не пишите здесь о состоянии здоровья: для этого позвоните в клинику.' },
    en: { open: 'Message the clinic', title: 'Clinic chat', ph: 'Your message', send: 'Send', name: 'Your name (optional)', phone: 'Phone (optional)', start: 'Start chatting', wait: 'Message received. The clinic administrator will reply soon.', err: 'Could not send. Please try again.', close: 'Close', note: 'Please do not write about your health here: call the clinic for that.' }
  };
  var t = T[lang] || T.uk;
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  var tokenKey = 'lanka-chat-' + key;
  var token = store.get(tokenKey);
  var last = null;
  var shown = {};
  var timer = null;

  function api(method, path, body) {
    var h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    return fetch(base + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      if (r.status === 401) { token = null; store.set(tokenKey, ''); throw new Error('session'); }
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }

  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}' +
    '.fab{background:#0e9aa0;color:#fff;border:0;border-radius:28px;padding:0 20px;height:52px;font-size:16px;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.2)}' +
    '.panel{display:none;flex-direction:column;width:min(360px,calc(100vw - 24px));height:min(520px,calc(100vh - 100px));background:#fff;border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,.25);overflow:hidden}' +
    '.panel.on{display:flex}.head{background:#0e9aa0;color:#fff;padding:12px 14px;display:flex;justify-content:space-between;align-items:center;font-weight:600}' +
    '.x{background:none;border:0;color:#fff;font-size:22px;cursor:pointer;min-width:44px;min-height:44px}' +
    '.log{flex:1;overflow:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f3f6f8}' +
    '.m{max-width:85%;padding:9px 12px;border-radius:12px;font-size:15px;line-height:1.35;white-space:pre-wrap;word-wrap:break-word}' +
    '.in{align-self:flex-end;background:#0e9aa0;color:#fff}.out{align-self:flex-start;background:#fff;color:#14212b;border:1px solid #e2e8ee}' +
    '.btns{display:flex;flex-wrap:wrap;gap:6px;align-self:flex-start}.b{border:1px solid #0e9aa0;color:#0a7c81;background:#fff;border-radius:999px;padding:0 14px;min-height:44px;font-size:15px;cursor:pointer}' +
    '.note{font-size:12px;color:#5b6b79;padding:6px 12px;background:#fff}' +
    '.row{display:flex;gap:8px;padding:10px;background:#fff;border-top:1px solid #e2e8ee}' +
    'input{flex:1;min-height:44px;border:1px solid #cdd5dc;border-radius:10px;padding:0 12px;font-size:16px}' +
    '.go{background:#0e9aa0;color:#fff;border:0;border-radius:10px;min-height:44px;padding:0 16px;font-size:15px;cursor:pointer}' +
    '.form{display:flex;flex-direction:column;gap:8px;padding:14px;background:#fff;flex:1}' +
    '</style>' +
    '<button class="fab" type="button"></button>' +
    '<div class="panel" role="dialog" aria-label=""><div class="head"><span class="ttl"></span><button class="x" type="button"></button></div>' +
    '<div class="form"><div class="note n1"></div><input class="nm" autocomplete="name" maxlength="80"><input class="ph" autocomplete="tel" inputmode="tel" maxlength="30"><button class="go st" type="button"></button></div>' +
    '<div class="log" style="display:none"></div><div class="note n2" style="display:none"></div>' +
    '<div class="row" style="display:none"><input class="tx" maxlength="1000"><button class="go sd" type="button"></button></div></div>';
  var q = function (s) { return root.querySelector(s); };
  q('.fab').textContent = t.open;
  q('.ttl').textContent = t.title;
  q('.x').textContent = '×'; q('.x').setAttribute('aria-label', t.close);
  q('.panel').setAttribute('aria-label', t.title);
  q('.n1').textContent = t.note; q('.n2').textContent = t.note;
  q('.nm').placeholder = t.name; q('.ph').placeholder = t.phone;
  q('.st').textContent = t.start; q('.sd').textContent = t.send; q('.tx').placeholder = t.ph;

  function add(m) {
    if (m.id && shown[m.id]) return;
    if (m.id) shown[m.id] = 1;
    var log = q('.log');
    var d = document.createElement('div');
    d.className = 'm ' + (m.direction === 'IN' ? 'in' : 'out');
    d.textContent = m.text;
    log.appendChild(d);
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
      log.appendChild(w);
    }
    log.scrollTop = log.scrollHeight;
  }
  function post(text, payload) {
    if (!text.trim()) return;
    add({ direction: 'IN', text: text });
    api('POST', '/messages', { text: text, payload: payload }).then(function (r) {
      var got = r.messages || [];
      got.forEach(add);
      if (!got.length) add({ direction: 'OUT', text: t.wait });
    }).catch(function () { add({ direction: 'OUT', text: t.err }); });
  }
  function chat() {
    q('.form').style.display = 'none';
    q('.log').style.display = 'flex'; q('.n2').style.display = 'block'; q('.row').style.display = 'flex';
    if (timer) clearInterval(timer);
    // answers of staff arrive later: ask for new messages while the panel is open
    timer = setInterval(function () {
      if (!q('.panel').classList.contains('on')) return;
      api('GET', '/messages' + (last ? '?after=' + encodeURIComponent(last) : '')).then(function (r) { (r.messages || []).filter(function (m) { return m.direction === 'OUT'; }).forEach(add); }).catch(function () {});
    }, 6000);
  }
  function start() {
    api('POST', '/session', { name: q('.nm').value, phone: q('.ph').value }).then(function (r) {
      token = r.token; store.set(tokenKey, token);
      chat();
    }).catch(function () { q('.st').textContent = t.err; });
  }

  q('.fab').onclick = function () {
    q('.fab').style.display = 'none';
    q('.panel').classList.add('on');
    if (token) { chat(); api('GET', '/messages').then(function (r) { (r.messages || []).forEach(add); }).catch(function () { q('.form').style.display = 'flex'; q('.log').style.display = 'none'; q('.row').style.display = 'none'; q('.n2').style.display = 'none'; }); }
  };
  q('.x').onclick = function () { q('.panel').classList.remove('on'); q('.fab').style.display = ''; };
  q('.st').onclick = start;
  q('.sd').onclick = function () { var i = q('.tx'); var v = i.value; i.value = ''; post(v); };
  q('.tx').addEventListener('keydown', function (e) { if (e.key === 'Enter') q('.sd').click(); });

  // Only show the button if the site is allowed to use this chat
  fetch(base + '/config').then(function (r) { if (r.ok) document.body.appendChild(host); }).catch(function () {});
})();
