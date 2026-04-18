---
name: onboard-client
description: This skill should be used when the user asks to "onboard a new client", "set up a new client", "add a new account", "create a new avatar account", or "onboard" in the context of Website Avatar. Guides through the full client setup — Cloudflare KV config, CORS registration, Tampermonkey test script, ElevenLabs agent checklist, and smoke test.
version: 1.0.0
---

# Website Avatar — Client Onboarding Skill

Run this skill to onboard a new client end-to-end. It will ask questions, generate config, make the Cloudflare API calls, and produce ready-to-use scripts and checklists.

## Step 1 — Gather client details

Ask the user for the following, one block at a time. Do not proceed until each required field is confirmed.

**Required:**
- `clientName` — human-readable name, e.g. "Belgraves of London" (used for `businessName`)
- `accountId` — slug format, e.g. `acct_belgraves` (must start with `acct_`)
- `clientDomain` — full origin including protocol, no trailing slash, e.g. `https://belgravesoflondon.com`
- `agentName` — the avatar's display name, e.g. "James"
- `primaryColor` — hex colour, e.g. `#BC9B6A`
- `notifyEmail` — lead notification email address
- `textAgentId` — ElevenLabs agent ID for the text agent (format: `agent_xxx`)
- `avatarUrl` — full URL to the avatar image (webp preferred)

**Optional (ask, skip if not provided):**
- `voiceAgentId` — ElevenLabs agent ID for the voice agent (separate agent, different prompt)
- `notifyPhone` — SMS lead notification number in E.164 format, e.g. `+447468621246`
- `suggestedPrompts` — up to 3 suggested chat starters (comma-separated)
- `greetingBullets` — up to 3 value-prop bullets for the greeting card (comma-separated)
- `greetingHeadline` — large bold headline shown in the v6 greeting variant, e.g. `"I'm here to help!"` (falls back to that string if omitted)
- `ecomEnabled` — `true` if this is an ecommerce client
- `ecomPlatform` — `woocommerce` or `shopify` (only if ecomEnabled)

---

## Step 2 — Build and POST the config

Construct the config JSON from the gathered fields. Rules:
- Omit optional fields entirely if not provided — do not include nulls
- `greetingBullets` max 3 items
- `suggestedPrompts` max 3 items
- `loadingStyle` defaults to `"dots"`
- `debug` defaults to `false`

Example shape:
```json
{
  "accountId": "acct_belgraves",
  "agentName": "James",
  "businessName": "Belgraves of London",
  "dialogueAgentId": "agent_xxx",
  "allowedOrigin": "https://belgravesoflondon.com",
  "notifyEmails": ["jacob@poddigital.co.uk"],
  "avatar_url": "https://...",
  "primaryColor": "#BC9B6A",
  "loadingStyle": "dots",
  "debug": false,
  "suggestedPrompts": ["What chauffeur services do you offer?"],
  "greetingBullets": ["Expert knowledge beyond the website."],
  "greetingHeadline": "I'm here to help!"
}
```

Show the user the generated JSON and ask them to confirm before proceeding.

Once confirmed, run the `POST /config` call using the Bash tool:

```bash
curl -s -X POST "https://backend.jacob-e87.workers.dev/config?id=<accountId>" \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '<configJson>'
```

> **Important:** The `?id=<accountId>` query parameter is required — the endpoint will return `{"error":"Missing id"}` without it, even if `accountId` is present in the JSON body.

> `$ADMIN_SECRET` is a fixed Cloudflare Worker secret (not per-client). Add it permanently to `~/.zshrc` so it's always available:
> ```bash
> export ADMIN_SECRET=your_secret_here
> ```
> This means the Bash tool will always have it in scope without needing to set it each session.

Check the response. If successful (`200`), the full config JSON is echoed back. If it fails, show the error and stop.

---

## Step 3 — Verify CORS registration

The `POST /config` handler automatically updates `wa_cors_origins` in KV whenever `allowedOrigin` is set — no manual wrangler step needed.

Verify CORS is working by fetching the config with the client's Origin header:

```bash
curl -s "https://backend.jacob-e87.workers.dev/config?id=<accountId>" \
  -H "Origin: <clientDomain>"
```

A successful response (200 with config JSON) confirms CORS is registered. If you get a 503 or missing `Access-Control-Allow-Origin` header, the origin wasn't saved — re-run the POST from Step 2.

> **Note:** `npx wrangler kv key get` requires active Cloudflare CLI auth and is unreliable in Claude's shell context. Use the HTTP verification above instead.

---

## Step 4 — Generate Tampermonkey test script

Output a ready-to-paste Tampermonkey script using the collected details. The user installs this in Tampermonkey to test the widget before the client adds the script tag to their theme.

```javascript
// ==UserScript==
// @name         <clientName> Website Avatar Loader
// @match        <clientDomain>/*
// @grant        none
// @run-at       document-end
// @inject-into  page
// ==/UserScript==
(function() {
  const s = document.createElement('script');
  s.src = 'https://jacobpoddigital.github.io/website-avatar/website-avatar.js';
  s.setAttribute('data-account-id', '<accountId>');
  document.head.appendChild(s);
})();
```

Also show the production script tag the client should add to their theme:
```html
<script
  src="https://jacobpoddigital.github.io/website-avatar/website-avatar.js"
  data-account-id="<accountId>"
></script>
```

---

## Step 5 — ElevenLabs agent setup checklist

Print this checklist with the client's values filled in. The user completes these steps manually in the ElevenLabs dashboard.

### Text agent (`dialogueAgentId`)
- [ ] Create a new **text** agent in ElevenLabs
- [ ] Set agent name: `<agentName> — <clientName> (Text)`
- [ ] Add system prompt (see template below)
- [ ] Wire up dynamic variables:
  - `authenticated_user_id` — from session
  - `user_id` — visitor UUID fallback
  - `page_title` — current page
  - `page_url` — current URL
  - `ecom_platform` — if ecom enabled
  - `cart_item_count` — if ecom enabled
- [ ] Set post-call webhook URL: `https://backend.jacob-e87.workers.dev/webhook/call-complete`
- [ ] Copy the agent ID and confirm it matches: `<textAgentId>`

### Voice agent (`voiceAgentId`) — if applicable
- [ ] Create a separate **voice** agent in ElevenLabs
- [ ] Set agent name: `<agentName> — <clientName> (Voice)`
- [ ] Use a shorter, more conversational system prompt (no form-fill or action instructions)
- [ ] Same dynamic variables and webhook as the text agent
- [ ] Copy the agent ID and confirm it matches: `<voiceAgentId>`

### System prompt template (text agent)
```
You are <agentName>, an AI assistant for <clientName>.

Your role is to help visitors to the website find information, answer questions about <clientName>'s services, and guide them through the next steps.

You have access to the following information about the current visitor:
- Page they are on: {{page_title}} ({{page_url}})
- Authenticated user ID: {{authenticated_user_id}}
- Visitor ID: {{user_id}}

Guidelines:
- Be warm, professional and concise
- Never make up information — if you don't know, say so and offer to connect them with the team
- If a visitor provides contact details (name, email, phone), acknowledge receipt naturally
- Do not re-greet if the conversation has already started
- Refer to yourself as <agentName>, never as an AI model or by any vendor name
```

---

## Step 6 — Smoke test checklist

Once the Tampermonkey script is installed and the page is open, verify the following:

- [ ] Widget loads — no CORS error in Network tab
- [ ] Config is fetched — `GET /config?id=<accountId>` returns 200
- [ ] Greeting card appears with correct agent name and colour
- [ ] Chat panel opens and text conversation works
- [ ] If `voiceAgentId` set — Speak button is visible; voice session starts
- [ ] Auth magic link flow: trigger email request in chat, receive email, click link, verify redirect with `#wa_auth=` token
- [ ] Webhook fires on call completion — check Worker logs in Cloudflare dashboard for `[Webhook]` entries
- [ ] Lead notification email received at `<notifyEmail>`

---

## Summary output

At the end of the onboarding, print a summary:

```
✅ <clientName> onboarded successfully

Account ID:     <accountId>
Domain:         <clientDomain>
Text Agent ID:  <textAgentId>
Voice Agent ID: <voiceAgentId or "not configured">
Notify Email:   <notifyEmail>

Next steps:
1. Complete ElevenLabs agent setup (Step 5 checklist above)
2. Run smoke test (Step 6 checklist above)
3. Share production script tag with client to add to their theme
4. Set debug: false in config once live testing is complete
```
