# Mongo Admin

Express + TypeScript MongoDB web client (Django-admin style), rendered with `swiftssr`.
SQLite stores users, encrypted connection URIs, per-user database access and connection-management permissions.

## Run

```bash
cp .env.example .env     # set SECRET, ROOT_USERNAME, ROOT_PASSWORD
npm install
npm run dev              # or: npm run build && npm start   (Node >= 20.6)
```

The root admin is created on first start if `ROOT_USERNAME` doesn't exist yet; a password later changed in the UI is
never overwritten by the env var. **Don't change `SECRET`** after saving connections, or they can't be decrypted.

## Model

- **Admins**: manage users, grant database access (per connection: a database name, or `*` for all), set permissions, open everything.
- **Users**: see/open only granted databases. Connection records can be added/edited/deleted only with the
  add / edit / delete permissions an admin gives them. Creating a connection auto-grants its creator `*` on it.
- Connection URIs are AES-256-GCM encrypted at rest and only ever shown masked.

## Explorer

Collections with counts; documents table with filter / sort / projection / paging (Extended JSON such as
`{"$oid": "..."}` or `{"$date": "..."}`); insert, edit (full replace), delete; update-by-query and delete-by-query
(first match or all); indexes (create/drop); aggregation runner; stats and top-values-of-a-field.
JSON boxes validate, format and indent client-side.

## Safety notes

- `$where`, `$function`, `$accumulator`, `$out`, `$merge` and cross-database `$lookup`/`$unionWith` are rejected so database
  permissions can't be bypassed and no server-side JS runs.
- CSRF token on every POST, HttpOnly SameSite=Lax session cookie, login throttling, scrypt password hashes.
- Serve over HTTPS and set `COOKIE_SECURE=true` (and `TRUST_PROXY=true` behind a proxy).
- Access is database-level: anyone who can open a database can write to it.

## About swiftssr

Requires `swiftssr@^1.0.3` (the release matching its README: `Fragment`, `htmlFor`, `SendHTML`, branded nodes).
Attribute names in the typed JSX are lowercase where HTML is (`autocomplete`, `colspan`, `autofocus`).
