# Deploying

| Option | Cost | Good for |
|---|---|---|
| **Render free** | ₹0 | Client demos. Sleeps after 15 min idle (about 1 min to wake) and has no disk, so data resets on restart. The demo store reloads itself. |
| **Oracle Cloud Always Free VM** | ₹0 | A real always-on server in Mumbai/Hyderabad. Fiddly signup, and free ARM capacity is often sold out. |
| **Hetzner VPS** | about €4–5/mo | Cheapest paid server with storage included. |
| **Fly.io** | about $2–3/mo + volume | Cheapest managed option; Mumbai region. |
| **Render Starter** (`render.yaml`) | about $7/mo + disk | Easiest managed option with a persistent disk. |

Prices change often, so check each provider before committing.

## A. Render free (demo in 5 minutes)
1. render.com → **New → Web Service** → pick this repo → Runtime **Docker** → Instance type **Free**.
2. Environment: `SEED_DEMO=1`, `INVITE_CODES=...`, `PLATFORM_ADMIN_KEY=<random>`.
3. Create. The site runs at `https://<name>.onrender.com/s/demo`.

## B. Your own server (Oracle Always Free or Hetzner) with GitHub Actions
1. **Create an Ubuntu 22.04/24.04 server.**
   - **Oracle:** Ampere A1, your home region (e.g. Mumbai). In the VCN *security list*, add ingress rules for TCP 80 and 443.
   - **Hetzner:** CX22 or similar. Ports are open by default.
2. **Point a domain at the server's IP** (an A record), or skip the domain and
   use `<ip-with-dashes>.sslip.io`, which works with HTTPS straight away.
3. **Let the server read the private repo:** on GitHub, create a fine-grained token
   with *Contents: read* for this repo only.
4. **On the server, run:**
   ```bash
   curl -fsSLO https://raw.githubusercontent.com/<you>/producttryon/main/deploy/setup-server.sh
   bash setup-server.sh https://<token>@github.com/<you>/producttryon.git <your-domain>
   ```
   This installs Docker, opens the firewall, creates `.env` with a random
   platform key, and starts the app behind Caddy (automatic HTTPS).
   The `raw.githubusercontent.com` download needs the repo to be public. For a
   private repo, copy the script over with `scp`.
5. **Automatic deploys:** in the GitHub repo, go to **Settings → Secrets and variables → Actions**:
   - Variables: `DEPLOY_TARGET` = `vps`; `VPS_APP_DIR` only if not `~/producttryon`.
   - Secrets:
     - `VPS_HOST`: the server IP
     - `VPS_USER`: `ubuntu` on Oracle, `root` on Hetzner
     - `VPS_SSH_KEY`: a private key whose public half is in the server's `~/.ssh/authorized_keys`

   From then on, every push to `main` runs the tests and, if they pass, SSHes in,
   pulls the code and rebuilds. The data in `./data` is kept.

## C. Render Starter with a disk
Use **New → Blueprint** (`render.yaml`); see the main README. To deploy only
after the tests pass:
1. Turn off *Auto-Deploy* in Render.
2. Copy the service's *Deploy Hook* URL into the secret `RENDER_DEPLOY_HOOK_URL`.
3. Set the variable `DEPLOY_TARGET` = `render`.

## GitHub Actions in this repo
- `.github/workflows/ci.yml`: every push and pull request runs the test suite and checks that the Docker image builds.
- `.github/workflows/deploy.yml`: pushes to `main` run CI, then deploy to `DEPLOY_TARGET`.

GitHub Actions and GitHub Pages can't host the site themselves. Actions jobs stop
after they finish, and Pages only serves static files, while this app needs a
running Python server.
