# Conventions

- **Language of the project:** documentation, code comments, commit messages, internal notes and identifiers are in **English**. Only the product itself is multilingual (see the next point). Existing Russian code comments are being replaced gradually; write every new comment in English.
- The UI is trilingual: Ukrainian (default), Russian, English. Every UI string goes through a key in `apps/web/lib/i18n.tsx` (`t('key')`); the `ru` and `en` dictionaries are typed against `uk`, so a forgotten translation breaks the type check. No hard-coded single-language strings in components.
- Texts produced by the server (report titles and rules, column labels, CSV, errors, task titles created from reports) live in `apps/api/src/common/i18n.ts`. The language comes from the `Accept-Language` header (uk|ru|en, otherwise uk). Exceptions throw an error KEY (for example `throw new BadRequestException('bad_api_key')`), not text: `I18nExceptionFilter` substitutes the translation. Add every new key in all three languages at once. An object response (`{ message: 'key', detail: '...' }`) passes through, so `detail` can carry a technical reason.
- Values that the client labels (visit statuses, roles, contact results) are sent by the server as codes, not as text.
- Clinic data (patient names, services, titles) is never translated: it is shown as it arrives from Cliniccards.
- TypeScript strict. API: one NestJS module per area (`auth`, `reports`, `integrations`, `automations`, `ai`, `report-builder`, …), DTOs with class-validator.
- New report: a method in `ReportsService` (the rule and the data update date in the response), an endpoint, CSV/Excel/PDF export, a page in web. Custom reports go through the report builder (`apps/api/src/report-builder/`): add datasets and fields to `fields.ts` (a whitelist), never accept raw queries.
- New integration: an implementation of `ClinicConnector`, with no direct calls to an external API from services.
- Prisma migrations only through `prisma migrate dev`; never edit an applied migration. After every migration run `npm run test:prepare` in `apps/api`.
- Every new endpoint that touches clinic data gets a tenant-isolation test and a role test.
- Tests never call real external services: Telegram and the AI client are replaced with fakes (`LlmClient`, `TelegramApi`).
- Before finishing a task: `nest build` in `apps/api` and `tsc --noEmit` in `apps/web` without errors; the full API test suite passes.
- UI pages: check in a browser at 390 px (no horizontal scroll, inputs 16 px or larger, buttons 44 px or larger). Use `useConfirm()` for confirmations, never `window.confirm`.
- Node 22 (`.nvmrc`); the default system Node is old, so activate it with nvm (`source ~/.nvm/nvm.sh && nvm use 22`).
- There is no git repository yet: before any bulk edit of many files, copy them aside. Do not run commands that open a file for writing before reading it.
