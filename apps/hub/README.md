# Bouvio hub

The always-on server for shared workspaces: accounts, invites, roles, the realtime relay between members and the runner that hosts a workspace, people chat and presence. It never calls an AI model. One small binary with a SQLite file; a €4 VPS is plenty.

## Self-host

```bash
cd apps/hub
BOUVIO_HUB_PUBLIC_URL=http://your-server:8787 docker compose up -d
```

Without SMTP, login codes are written to the log:

```bash
docker compose logs hub | grep "login code"
```

For HTTPS, point a domain at the server, uncomment the `caddy` service in `compose.yml`, and set `HUB_DOMAIN=hub.example.com` and `BOUVIO_HUB_PUBLIC_URL=https://hub.example.com`.

Without Docker: `cargo run --release -p bouvio-hub`.

## Configuration

| Variable | Default | |
|---|---|---|
| `BOUVIO_HUB_ADDR` | `0.0.0.0:8787` | listen address |
| `BOUVIO_HUB_DB` | `sqlite://data/hub.db` | SQLite file (created, migrated at startup) |
| `BOUVIO_HUB_PUBLIC_URL` | `http://localhost:8787` | used in invite links and OAuth callbacks |
| `SMTP_URL` | none | e.g. `smtps://user:pass@smtp.example.com:465` or `smtp://user:pass@host:587?tls=required` |
| `SMTP_FROM` | `Bouvio <bouvio@localhost>` | sender of login mails |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | none | enables GitHub sign-in |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | none | enables Google sign-in |
| `TURN_URLS`, `TURN_SECRET` | none | TURN relay for huddles (coturn `use-auth-secret`); see `compose.yml` |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | STUN servers for huddles, comma-separated; empty for none |
| `BOUVIO_HUB_WEB_DIR` | none (`/srv/web` in Docker) | serve the web client from this folder under `/app/` |
| `RUST_LOG` | `info` | log filter |
| `BOUVIO_HUB_DEV_CODES` | off | **dev only**: `1` makes `/auth/email/start` return the code in its response. Never set this on a reachable server. |

Endpoints for a provider that is not configured answer `501` with a message saying so.

### OAuth apps

- **GitHub**: Settings → Developer settings → OAuth Apps → New. Callback URL: `${BOUVIO_HUB_PUBLIC_URL}/auth/github/callback`.
- **Google**: Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application). Authorized redirect URI: `${BOUVIO_HUB_PUBLIC_URL}/auth/google/callback`.

The app opens `/auth/{github|google}/start` in the browser. After sign-in the browser shows an 8-character code; the person pastes it into Bouvio, which trades it for a token with `POST /auth/exchange`.

## Huddles, forms and the web client

- **Huddles** are WebRTC between members; the hub only relays the signalling and hands out ICE servers at `GET /ice`. With `TURN_URLS` and `TURN_SECRET` set, it adds short-lived TURN credentials (12 h) in coturn's REST format. The commented `coturn` service in `compose.yml` runs one on the same server.
- **Public forms** live at `/f/<workspace>/<form>`. The hub asks the runner hosting the workspace for the form and passes the answers back; nothing is stored on the hub. Requests are rate-limited per IP.
- **The web client** is built into the Docker image and served at `/app/`.

## Tests

```bash
cargo test -p bouvio-hub
```

The tests start real hubs on random ports with temporary databases and talk to them over HTTP and WebSocket.
