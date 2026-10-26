# Project maintenance

The production website at https://imagemeow.top runs on the user's Ubuntu server.
The Sites project `appgprj_6ad3602eac1c8191beccd3a66e796b09` is a paused source mirror.
Its retained custom-domain binding is not evidence of current public DNS routing.

- The user may start a change from the Sites project. Read its source, and check the
  GitHub `main` head before editing or pushing so newer work is not overwritten.
- Keep the full tracked source tree in Sites and GitHub
  `yunjingliu07-beep/jituAPI_GUI_interface` synchronized after each change. Preserve
  both repositories' history; do not force-push to reconcile them.
- Verify changes and add a release entry in `worker/core.js` for user-visible
  changes. Operational documentation/build-only changes need no release popup.
- Save and publish the matching Sites version, preserving its existing audience,
  secrets, database bindings, and migration pause. Do not unfreeze the Site unless
  the user explicitly requests it. Publishing the mirror does not update production.
- Do not run commands on the user's Ubuntu server. Give manual update instructions
  after changes. Frontend-only changes with no pending schema changes require a pull
  and service restart; schema changes require the backup/migration update script.
- The production checkout `/opt/image-meow` is owned and managed by root. Every
  server update instruction must use `sudo git pull --ff-only origin main`,
  followed by the appropriate `sudo` update script or service restart. Chain
  dependent steps with `&&` so a failed pull cannot continue into deployment.
  `safe.directory` only establishes Git trust; it does not grant write access to
  `.git/FETCH_HEAD`. Do not omit `sudo` or change checkout ownership/permissions
  to work around this error; the `image-meow` service account must not own code.
- Never copy server data, secrets, uploads, runtime files or Git credentials into
  either repository. Code synchronization does not synchronize databases or files.
- Applied SQLite migration files in `drizzle/` are immutable. The Sites build uses
  the explicit schema-only override in `drizzle/sites/` for migration 0006, whose
  original server migration contains a legacy historical-data backfill. Keep both
  resulting schemas compatible and do not modify an applied hosted override.
- For this custom Worker build, run `npm run build`, then
  `node scripts/package-sites.mjs /absolute/path/deployment.tar.gz`. The archive
  must contain `.openai/hosting.json`, `dist/server/index.js`, and `drizzle/` at
  the root so Sites can discover the hosted migrations. Do not package only dist/.
