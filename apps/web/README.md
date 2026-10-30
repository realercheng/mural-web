# Mural Web voice prototype

A personal, single-user Progressive Web App that tests live voice conversation in mobile browsers. It is a prototype: one free conversation in English or Spanish, live transcripts, no saved history, no subtitles, word lookup or assessment.

## How it works

```text
Browser (PWA) ──cookie + microphone PCM over WebSocket──> gateway (server/) ──provider key──> GPT-Live WebSocket
```

- The browser captures the microphone, converts it to 24 kHz mono PCM16 (`public/pcm-capture.js`) and plays returned speech.
- The gateway signs in one user with an access code and an HttpOnly cookie. It alone holds the provider key, sends `session.start` with fixed model, voice and instructions, and forwards only `session.input_audio.append` and `session.close` from the browser.
- Instructions port `TeachingPolicy.voice` and `TeachingPolicy.greeting` for a free conversation. `server/src/languages.ts` is generated from the English and Spanish Swift modules.
- Client delegations receive the module's fixed "couldn't check that" reply; there is no lookup backend yet.
- One conversation runs at a time. Each ends at the earliest of `MAX_SESSION_SECONDS`, the daily and total limits, `IDLE_AUDIO_SECONDS` without microphone audio, or the learner's request. Provider-reported seconds are recorded in `DATA_DIR/usage.json`; a session closed without a final provider event is counted with its connected wall-clock time.
- Logs contain event names, durations and fixed reasons only, never audio, transcripts, cookies or keys.

The upstream is any endpoint that speaks the GPT-Live WebSocket protocol (`/v1/live/sessions`), such as Azure OpenAI or a gateway in front of it. Use a credential limited to the live model.

## Run locally

Use Node.js 22.19 or later.

```sh
cd apps/web
npm ci
cp .env.example .env    # fill in private values; never commit them
npm test                # gateway tests against a local fake provider; nothing is billed
npm run build
node --env-file=.env dist-server/main.js
```

Microphone access needs HTTPS, or `localhost` on the same machine. `npm run dev` serves the interface with Vite and proxies `/api` to a gateway on port 8080; set `PUBLIC_ORIGIN` to the Vite origin when doing this.

## Deploy

`Dockerfile` builds the interface and gateway, runs the tests and produces a non-root image that listens on port 8080 and stores usage in `/data`. Put it behind a TLS reverse proxy that forwards WebSocket upgrades and sets `X-Real-IP`, then set `TRUST_PROXY=true`.

## Limits of this prototype

- Mobile browsers can suspend or mute the microphone when the screen locks or the page moves to the background. The gateway then ends the conversation after `IDLE_AUDIO_SECONDS`. Native background audio is not available to web apps.
- Echo cancellation with speaker output depends on the browser and needs real-device checks.
- The usage ledger is a cost guard for one person, not a billing record. Check the provider's own usage reports.
