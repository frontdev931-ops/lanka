# Local Elementor consultation fixture

This development page reproduces the selected 112 Dental footer form's field names and submission lifecycle. It uses synthetic values, a local original handler, and the same two scripts as the installation. The original handler responds with a success flag. On success, the fixture signals `submit_success` before resetting the fields. A rejection returns HTTP 200 with `success: false`.

1. Use a local LANKA test clinic with no external messaging connections. Run the API with `WEBSITE_ALLOW_LOCALHOST=true` and run the web app.
2. In Settings → Channels → Website, enable form intake and add `http://localhost:4100` as a browser origin.
3. From this folder run `LANKA_URL=http://localhost:3000 FORM_KEY=<public form key> node serve.mjs`.
4. Open `http://localhost:4100/?utm_source=google&utm_medium=cpc&utm_campaign=fixture&token=ignore-me`. Use synthetic contact details. Verify the accepted entry in Inquiries, with the page but without its query or the unmapped field.
5. Send the same values in a new submission and check for a second enquiry. A missing required field, the exact message `reject fixture`, or a submission from the other form should produce no LANKA enquiry. If the LANKA endpoint is unavailable, the fixture should still show its own success.

See [Website integration](../../docs/06-website-integration.md) for the site installation and removal instructions.

The focused browser regression uses a running local test instance backed by `stomat_test`, with website localhost intake enabled and email, external channels and background jobs disabled. With Playwright and Chromium available, run `TEST_LANKA_URL=http://localhost:3000 node --test verify.mjs`. The test registers a synthetic clinic. It uses fixture port 43117 by default. `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` can point to an existing Playwright module and Chromium executable.
