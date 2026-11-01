# Deploying antigravity-proxy with Docker Compose

Production layout: one host, one Compose project, public traffic through a
Cloudflare Tunnel. Nothing is published on the host; the tunnel connector
reaches the container over the Compose network.

```
Internet ──> Cloudflare edge ──> cloudflared ──> agyproxy_default ──> proxy:3000
```

## 1. Host prerequisites

Docker Engine + Compose v2. The image is built from `oven/bun:alpine`, which is
multi-arch, so it builds and runs natively on both amd64 and arm64.

## 2. Layout

```bash
sudo mkdir -p /opt/agyproxy
# copy the repo here (or clone it), then:
cd /opt/agyproxy
sudo cp .env.example .env
sudo chmod 600 .env
```

`.env` keys used in production:

| Key | Purpose |
|---|---|
| `BASE_URL` | Public origin, e.g. `https://agyproxy.example.com` (used in OAuth redirects/links) |
| `ACCOUNTS_FILE`, `CONFIG_FILE` | Keep the defaults (`/app/data/...`); the Compose file sets them |
| `API_KEY` / `API_KEYS` | Bearer token(s) for the `/v1/*` OpenAI-compatible endpoints |
| `WEB_PASSWORD` | Password for the web dashboard |
| `OPENCODE_API_KEY` | Only if the OpenCode provider is enabled |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Only if Google OAuth is enabled |
| `SAFETY_THRESHOLD` | Upstream safety filter (default `BLOCK_NONE`) |

State lives in `./data/` (`antigravity-accounts.json`, `config.json`). Back it
up; it is the only thing that must survive a redeploy.

## 3. Build & run

```bash
cd /opt/agyproxy
sudo docker compose build
sudo docker compose up -d
sudo docker compose ps
sudo docker compose logs -f proxy
```

Update after a `git pull`:

```bash
sudo docker compose build --pull
sudo docker compose up -d
```

## 4. Cloudflare Tunnel

The host runs a single shared tunnel connector. Attach it to this project's
network so the dashboard route can use the service name:

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run --token ${TUNNEL_TOKEN}
    networks:
      - default
      - agyproxy

networks:
  agyproxy:
    external: true
    name: agyproxy_default
```

Public hostname route:

| Public hostname          | Path | Service URL        |
|--------------------------|------|--------------------|
| `agyproxy.example.com`   | —    | `http://proxy:3000` |

Update `BASE_URL` to the same hostname (including scheme) and recreate the
container so links and OAuth redirects stay correct:

```bash
sudo sed -i 's|^BASE_URL=.*|BASE_URL=https://agyproxy.example.com|' .env
sudo docker compose up -d
```

## 5. Verify

```bash
# From inside the project network
docker run --rm --network agyproxy_default curlimages/curl \
  -s -o /dev/null -w '%{http_code}\n' http://proxy:3000/

# Bearer-protected API
curl -s -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3000/v1/models | head
```

A `302` on `/` is expected when `WEB_PASSWORD` is set (redirect to the login
screen).

## 6. Backup / restore

```bash
tar -czf agyproxy-data-$(date +%F).tar.gz -C /opt/agyproxy data
# restore
tar -xzf agyproxy-data-2026-11-01.tar.gz -C /opt/agyproxy
sudo docker compose up -d
```

## Troubleshooting

- **Permission errors on `./data`** — the container runs as the `bun` user
  (uid 1000). The `:z` mount option handles SELinux; on a non-SELinux host make
  sure the directory is writable by uid 1000.
- **502 from Cloudflare** — the connector is not attached to
  `agyproxy_default`, or the route points at the wrong name/port. Test with the
  curl command in §5.
- **Login loop / wrong redirect URI** — `BASE_URL` does not match the public
  hostname (scheme included).
