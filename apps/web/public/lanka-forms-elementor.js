/* Elementor Pro Forms adapter. Load after lanka-forms.js; configure one existing form on this script tag. */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var selector = script.getAttribute('data-form-selector');
  var formId = script.getAttribute('data-form-id');
  var fields = script.getAttribute('data-lanka-fields');
  if (!selector || !formId || !fields) return;

  // Elementor rebuilds popup forms when they open. Resolve the configured form on submit.
  var pending = new WeakMap();
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('form.elementor-form') ||
        !form.matches(selector) || document.querySelectorAll(selector).length !== 1) return;

    if (form.classList.contains('elementor-form-waiting') || !window.LankaForms || !window.jQuery) return;

    // Elementor ignores a second submit while waiting. Its own success event comes before reset or redirect.
    if (!pending.has(form)) {
      window.jQuery(form).on('submit_success.lankaCopy error.lankaCopy', function (event) {
        if (event.target !== form) return;
        var accepted = pending.get(form);
        pending.set(form, undefined);
        if (event.type === 'submit_success' && accepted) accepted();
      });
    }
    pending.set(form, window.LankaForms.capture(form, formId, fields));
  }, true);
})();
