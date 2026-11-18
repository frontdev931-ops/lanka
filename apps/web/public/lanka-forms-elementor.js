/* Elementor Pro Forms adapter. Load after lanka-forms.js; configure one existing form on this script tag. */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var selector = script.getAttribute('data-form-selector');
  var formId = script.getAttribute('data-form-id');
  var fields = script.getAttribute('data-lanka-fields');
  if (!selector || !formId || !fields) return;

  var form = document.querySelector(selector);
  if (!form || !form.matches('form.elementor-form') || document.querySelectorAll(selector).length !== 1) return;

  var forward;
  var listening = false;
  form.addEventListener('submit', function () {
    if (form.classList.contains('elementor-form-waiting') || !window.LankaForms || !window.jQuery) return;

    // Elementor ignores a second submit while waiting. Its own success event comes before reset or redirect.
    if (!listening) {
      window.jQuery(form).on('submit_success.lankaCopy error.lankaCopy', function (event) {
        if (event.target !== form) return;
        var accepted = forward;
        forward = undefined;
        if (event.type === 'submit_success' && accepted) accepted();
      });
      listening = true;
    }
    forward = window.LankaForms.capture(form, formId, fields);
  }, true);
})();
