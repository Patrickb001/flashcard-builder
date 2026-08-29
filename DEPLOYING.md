# Deploying Flashcard Forge

Three drafting modes, and which one you pick determines what you need to deploy.

| Mode | Who needs an API key | Backend needed | Cost |
|---|---|---|---|
| **Rules only** | nobody | none | free |
| **AI with my own key** | each user, pasted into their browser | none | each user pays |
| **AI drafting** (hosted) | you, once, as a server env var | Netlify function | **you pay for everyone** |

Rules-only works as a pure static site. Read the cost note at the bottom before turning on hosted AI.

---

## 1. Put it on GitHub

From the project folder:

```bash
git init
git add .
git commit -m "Flashcard Forge"
```

Create an empty repo on GitHub (no README, no .gitignore — you already have one), then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/flashcard-forge.git
git branch -M main
git push -u origin main
```

`.gitignore` already excludes `node_modules`, `dist`, and `*.local`. **Never commit an API key.** If you ever paste one into a file for testing, remove it before committing — rotate the key if it has already been pushed, since deleting it in a later commit does not remove it from history.

## 2. Deploy on Netlify

1. Go to [app.netlify.com](https://app.netlify.com) → **Add new site** → **Import an existing project**.
2. Pick GitHub and authorise it, then choose your repo.
3. Netlify reads `netlify.toml`, so the build command (`npm run build`), publish directory (`dist`), and the SPA redirect are already set. Leave them as detected.
4. Click **Deploy**.

You now have a working site on a `*.netlify.app` URL, in rules-only mode. Nothing else is required if you stop here.

## 3. Turn on hosted AI drafting (optional)

The serverless function at `netlify/functions/generate.mts` is deployed automatically and answers at `/api/generate`. It needs a key:

1. Get a key at [console.anthropic.com](https://console.anthropic.com) → **API Keys**.
2. In Netlify: **Site configuration** → **Environment variables** → **Add a variable**.
   - Key: `ANTHROPIC_API_KEY`
   - Value: your `sk-ant-...` key
   - Scope: leave as all scopes
3. Optionally add `ANTHROPIC_MODEL` to override the default (`claude-sonnet-5`).
4. **Deploys** → **Trigger deploy** → **Clear cache and deploy site**. Environment variables are only picked up on a fresh deploy.

Users can now choose "AI drafting" and never see a key. The key stays on the server and is never sent to the browser.

### Testing AI drafting locally

No extra CLI needed. Put the key in a `.env` file in the project root:

```
ANTHROPIC_API_KEY=sk-ant-...
```

then:

```bash
npm run dev
```

The Vite dev server serves `/api/generate` itself (see `apiDevServer` in `vite.config.ts`), reading the key from `.env` in the Node process. The key never reaches the browser, which is the same guarantee the deployed function gives.

Restart the dev server after editing `.env` — it is read once at startup.

The Netlify CLI is optional. If you want to exercise the real function before deploying, `npm install -g netlify-cli && netlify dev` also works, but note it serves on port 8888 rather than 5173.

## 4. The page reader

`netlify/functions/fetch-page.mts` deploys alongside the drafting function and answers at `/api/fetch-page`. It needs no key and no configuration: it fetches the address the user pasted and hands the HTML back to the browser, which does the parsing.

It is worth knowing what this endpoint is, though. Anything that fetches a URL on request can be pointed at addresses only your server can reach — the classic target is a cloud provider's metadata service. `src/lib/fetchPage.ts` refuses private, loopback, link-local and metadata addresses, re-checks every redirect hop, caps the response at 3 MB, times out at 15 seconds, and the function rate-limits to 10 pages per minute per IP.

One limit remains: the guard reads the address as written, so a public hostname that *resolves* to a private IP is not caught. That needs a DNS lookup with the connection pinned to the address that was checked, which is not something a Netlify function can do cleanly. For a personal site this is a reasonable trade-off. If you make yours public and this matters to you, put the fetch behind an egress proxy that enforces the same rules, or drop `netlify/functions/fetch-page.mts` — the rest of the app works without it, and files still open normally.

## 5. Custom domain (optional)

**Domain management** → **Add a domain**. Netlify provisions HTTPS automatically. Point your registrar's nameservers at Netlify, or add the CNAME it shows you.

---

## Cost and abuse, before you go public

With `ANTHROPIC_API_KEY` set, **every visitor spends your money**. A shared link that ends up somewhere public can run up a bill quickly. Before publicising the URL:

- **Set a spend limit** in the Anthropic console. This is the only hard stop; everything else below is a speed bump.
- The function includes a crude in-memory rate limit (20 requests/minute/IP). Serverless instances are recycled and IPs are shared, so treat it as friction, not protection.
- For anything beyond friends and classmates, add real auth (Netlify Identity, or a shared password checked in the function) or leave hosted mode off and let users bring their own keys.
- Netlify's free tier includes 125k function invocations/month. Each document uses roughly one invocation per four pages.

A reasonable default for a personal project: deploy in rules-only mode, and keep "AI with my own key" available for yourself.
