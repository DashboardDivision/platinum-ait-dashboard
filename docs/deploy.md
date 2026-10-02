# Deploying to ait.getstrategic.vip

Run on the VPS as an admin user. Approved scope (2026-10-02): a new EasyEngine site and certificate for ait.getstrategic.vip, the app, and its own database. Nothing else on the server is changed or restarted.

## 0. Before you start
- Disk is tight (about 27 GB free). Check `df -h /` first; the build needs about 2 GB.
- Pin images: reuse a Postgres 17 image already on the server (`docker images postgres`) and set `POSTGRES_IMAGE` to it; pin `NODE_IMAGE` to the digest you pull.

## 1. Code and secrets
```sh
mkdir -p /opt/ait && cd /opt/ait
git clone git@github.com:DashboardDivision/platinum-ait-dashboard.git src
mkdir -p secrets documents backups && chmod 700 secrets backups && chown 1000:1000 documents
openssl rand -hex 24 > secrets/db_password && chmod 600 secrets/db_password
cp src/.env.example app.env && chmod 600 app.env   # fill it in (DATABASE_URL uses the db_password)
```
Set `PROVISION_FROM` to the go-live instant so older Twenty records wait for the backfill.

## 2. Proxy site and certificate
```sh
ee site create ait.getstrategic.vip --type=html --ssl=le
cp src/deploy/proxy/user.conf /opt/easyengine/sites/ait.getstrategic.vip/config/nginx/custom/user.conf
docker network ls | grep ait.getstrategic   # this name goes in AIT_PROXY_NETWORK
ee site reload ait.getstrategic.vip
```
If crm.getstrategic.vip proxies Twenty differently, follow that pattern instead.

## 3. Build, migrate, start
```sh
cd /opt/ait/src && export AIT_TAG=$(git rev-parse --short HEAD) AIT_PROXY_NETWORK=<from step 2>
C="docker compose -f deploy/docker-compose.yml --project-directory /opt/ait"
$C build app tools
$C up -d db
$C run --rm tools npm run db:migrate
$C up -d app
curl -fsS https://ait.getstrategic.vip/api/health
$C run --rm tools npm run admin:create -- --email celliott@platinuminsgroup.com --name "Colton Elliott"
```
The admin password prints once. Give it to Colton directly; he changes it at first sign-in.

## 4. Twenty
1. In Twenty (Life CRM) Settings > APIs & Webhooks, create the API key "Platinum AIT dashboard".
2. Create a webhook to `https://n8n.getstrategic.vip/webhook/<TWENTY_WEBHOOK_PATH>` for platinumAit events and copy its secret.

## 5. n8n
1. Create an n8n API key (Settings > n8n API).
2. Fill `/opt/ait/n8n-install.env` from `deploy/n8n/n8n-install.env.example` (chmod 600). Use the Gmail app password; delete any local copy afterwards.
3. `node deploy/n8n/install.mjs /opt/ait/n8n-install.env --activate`. Momentum and backfill stay inactive.
4. Remove `n8n-install.env` once it succeeds, or keep it chmod 600 for re-runs.

## 6. Smoke test
- Create a test Platinum AIT record in Twenty with an email you control and a U.S. phone number. Confirm the account appears, the welcome email arrives, the starter password works once and must be changed.
- Delete the test record and archive the recruit afterwards.

## 7. Backups
`crontab -e`: `30 2 * * * /opt/ait/src/deploy/backup.sh >> /opt/ait/backups/backup.log 2>&1`. Test `deploy/restore.sh` against the demo instance, not production.

## Rollback
Images are tagged by commit. Set `AIT_TAG` to the previous tag and `up -d app`. Migrations only add tables and columns, so the old version keeps working. Restore from backup only if data itself is wrong.

## Demo instance
`docker compose -f deploy/docker-compose.demo.yml --project-directory /opt/ait up -d`, with `/opt/ait/demo.env` (`APP_ENV=demo`, its own secrets, `APP_URL=http://<tailscale ip>:3101`). Then `run --rm tools npm run db:migrate` and `npm run seed:demo`. It's reachable only over Tailscale.
