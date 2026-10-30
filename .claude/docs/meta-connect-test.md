# Connecting a Facebook Page and Instagram for the first live test

Status (2026-10-30): the Meta app is in development mode, the Messenger and Instagram webhooks are verified and subscribed to `messages`. The live connection through "Підключити через Facebook" has not been tested yet. Railway has `META_GRAPH_VERSION=v26.0`.

Each clinic uses its own Facebook Page and Instagram account; LANKA itself needs none. Until App Review and business verification pass, only people with a role in the Meta app can connect, so the first test uses the owner's own accounts.

## Steps

1. **Pick the test Page.** The owner manages four Pages (Ridno, Игры, ab__cake, Scandinavian_MOOD). Use the Page that matches the old Instagram account; if unclear, use the empty "Игры" Page. It must be a Page, not a personal profile.
2. **Link Instagram to the Page.** Facebook: switch to the Page, Settings, Linked accounts, Instagram, connect, sign in to the old account. The Instagram account must already be professional (it is).
3. **Allow message access in Instagram.** Instagram app: profile menu, Settings, Messages and replies, Message controls (connected tools), allow access to messages for connected tools.
4. **Check the Meta app roles.** developers.facebook.com, the app, App roles, Roles. The owner's Facebook account must be an Administrator. The account that writes the test messages must be added as a Tester (Add People, Testers) and accept the invitation in Facebook.
5. **Connect in the cabinet.** `app.lankaclinic.app`, sign in to the real account (not the demo), Automations, "Підключити через Facebook". In the Facebook window choose the Page and its Instagram and allow every permission. Back in the cabinet the Page must appear.
6. **Test receiving and sending.** From the tester account write to the Page (Messenger) and to the Instagram account; the message must appear in the chat inbox and a reply must reach the sender. If anything is missing, read the Railway logs: live webhook field names may differ from the fakes.

## Afterwards

- App Review and business verification (long external step; start in parallel).
- WhatsApp is a separate stage (Embedded Signup).
