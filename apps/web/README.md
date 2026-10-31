# Mural Web voice prototype

A personal, single-user Progressive Web App that tests live voice conversation in mobile browsers. It has a free adult conversation in English or Spanish, a kid English speaking mode, and a conversation history with Chinese subtitles, word lookup, typed replies and JSON backup. There is no assessment or vocabulary review yet.

## How it works

```text
Browser (PWA) ──cookie + mu-law speech over WebSocket──> gateway (server/) ──provider key, base64 PCM16──> GPT-Live WebSocket
```

- The browser captures the microphone, converts it to 24 kHz mono PCM16 (`public/pcm-capture.js`) and plays returned speech.
- The browser link carries binary frames defined in `server/src/wire.ts`: G.711 mu-law audio at 24 kHz, plus a one-byte heartbeat. The browser sends only speech (a level gate with pre-roll and hangover); the gateway feeds GPT-Live 100 ms of silence whenever no speech arrived for 300 ms, because the provider expires sessions without continuous input. GPT-Live streams digital silence between turns; the gateway drops it and labels each speech frame with its position on the provider timeline. The browser plays speech on that timeline behind a jitter buffer (0.25 s, growing by 0.1 s up to 0.8 s after each late frame), so network stalls do not chop words together. Compared with base64 PCM16 in JSON both ways, this reduces traffic on the learner's network by roughly 5–10 times, which matters on long international paths.
- The gateway signs in one user with an access code and an HttpOnly cookie. It alone holds the provider key, sends `session.start` with fixed model, voice and instructions, and accepts only microphone audio, `session.close`, `mural.wrap_up` and `mural.typed` from the browser.
- Instructions port `TeachingPolicy.voice` and `TeachingPolicy.greeting` for a free conversation. `server/src/languages.ts` is generated from the English and Spanish Swift modules.
- Client delegations receive the module's fixed "couldn't check that" reply; there is no lookup backend yet.
- One conversation runs at a time. Each ends at the earliest of `MAX_SESSION_SECONDS`, the daily, monthly and total limits, the time the page asked for, `IDLE_AUDIO_SECONDS` without speech or heartbeat from the page, or the learner's request. The end-of-call log records traffic in each direction and the largest backlog waiting for the browser. Provider-reported seconds are recorded in `DATA_DIR/usage.json`; a session closed without a final provider event is counted with its connected wall-clock time.
- Logs contain event names, durations and fixed reasons only, never audio, transcripts, cookies or keys.

## Kid speaking mode

- `server/src/kids.ts` holds 23 topics in three groups (daily life, beyond school, news) and the kid instructions. Topics are not tied to a textbook or school grade. A difficulty level from 1 to 4, set per child by a parent, decides sentence length (3–6, 8, 10 or 12 words) and question style, so the same topic grows with the child.
- The instructions ask for slow speech, one question per turn, "say, fix, repeat, reuse" correction with at most two repeats, one short Chinese hint when the learner is stuck, games, an opening review of up to three words from the last report, a closing "teach Mural a word" and privacy rules. They include today's date for the "this month" topic. The news topics let the child tell news they heard; Mural has no news source and is told not to add facts.
- Azure's content filter stopped sessions when the instructions put a child's age next to lists of personal details or unsuitable themes. The wording is now neutral ("learner", no ages). After any change to the kid instructions, start each topic once with real GPT-Live before deploying.
- The page opens `/api/live?language=en&mode=kid&scenario=<id>&level=<1-4>` with an optional nickname, review words and `seconds`. The server accepts only known topic IDs and levels, a nickname of letters and digits, and plain English review words, so none of them can carry instructions.
- When the child taps "说再见", or a minute before the time limit, the gateway asks Mural to wrap up; the call ends a minute later.
- For kid conversations only, the gateway keeps the transcript in memory. After the call the page posts the session ID to `/api/kid/report`; the gateway sends the transcript once to the text model (`TEXT_UPSTREAM_URL`, OpenAI Responses API with a JSON schema) and returns a Chinese parent report: words, sentences, corrections, successful repeats, the taught word and suggestions, including whether to change the level. The transcript is dropped once the report succeeds or after 30 minutes and is never written to disk. Without `TEXT_UPSTREAM_URL`, reports and stars are off.
- The browser keeps profiles (nickname and level), stars, stickers (one per five stars) and each child's daily minutes in `localStorage`; each conversation with its report is a history record (below). A parent password, stored as a PBKDF2 hash, protects profiles, levels, daily minutes and reports. The per-child limit is enforced by the page; the server's daily and monthly limits still apply.

## History, subtitles, word lookup, typed replies and backup

- **History** (`src/history.ts`): every finished conversation, adult or kid, is saved in the browser's IndexedDB as one record, with its text, typed lines, subtitles and, for kid mode, the report and stars. The history screen lists, opens and deletes one or all records. Nothing is sent to the server. The first kid-mode version kept conversations in `localStorage` (`mural.kids.v1` `reports`); on start the page copies them into IndexedDB and removes them from `localStorage` only after the IndexedDB transaction has committed. If IndexedDB is unavailable, those records stay readable from `localStorage` and new conversations are not saved.
- **Backup format** (`src/archive.ts`): records use the apps' `Archive` format, `schemaVersion: 2` from `apps/ios/Core/Models.swift`, with dates in seconds since 2001-01-01. A web record stores one fragment per transcript line and subtitles under `translations` as `Chinese (Simplified)::<fragment>:<revision>`. Web-only details (adult or kid, child profile, report, stars) are in a `web` member, and the backup adds `web.kids.profiles`; the apps ignore both. The parent password is not exported. Import ports `Archive.decode`, the version 1 migration and `merging`: the whole file is checked first (30 MB, 10,000 sessions, known languages, unique IDs, field types and ranges), then new sessions are added in one IndexedDB transaction, so a failed import changes nothing. Sessions already on the device are skipped. Records from the apps are shown grouped into passages as the apps show them. `server/tests/archive.test.ts` runs the shared `archive.json` and `archive-expected.json` fixtures; copies sit in `server/tests/fixtures` because the Docker build sees only `apps/web`, and a test checks that they match `shared/fixtures/cross-platform`. Assessments are kept as they are; the learner projection in `archive-expected.json` belongs to the learning-core stage.
- **Helpers** (`server/src/helpers.ts`): subtitles (`POST /api/meaning`), word lookup (`POST /api/lookup`) and typed replies use the text model (`TEXT_UPSTREAM_URL`). As in `services/api/src/hosted-helpers.ts`, only an allowlist of purposes exists (`meaning`, `lookup`, `typed_reply`), each with fixed server-side instructions ported from `TeachingPolicy.translation`, `TeachingPolicy.lookup` and `TeachingPolicy.typedReply`, an input limit and an output limit. The browser sends only the language and the text. All three share `HELPER_PER_MINUTE` (default 12) and `HELPER_DAILY_LIMIT` (default 600 calls per day in `USAGE_TIME_ZONE`) and at most two calls at a time; parent reports are not counted. The counters are in memory and restart with the server.
- **Subtitles** follow `MeaningController`: a Mural line is translated once it has settled (a later line exists, the call has ended, or 1.2–3 s without change), one request at a time. They are saved with the record; opening a record fetches missing ones. The “中文字幕” switch is remembered on the device.
- **Word lookup**: tapping a word in any transcript shows its meaning in that sentence, in Chinese. Chinese text is not tappable.
- **Typed replies** follow the apps' `sendTyped`: the page sends `{"type":"mural.typed","text":…}` on the live socket. The gateway accepts letters, digits, punctuation and spaces up to 300 characters, asks the text model for Mural's reply with the plan's fixed instructions (`typedReplyInstructions`, or `kidTypedReply` with the child's level and correction rule), then sends GPT-Live `session.thinking.append` (“The learner typed (data): …”) and `session.commentary.append` with the reply, which Mural speaks. The typed text never becomes an instruction. Typed lines are marked in the transcript and in the parent report input and do not earn stars.

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

`Dockerfile` builds the interface and gateway, runs the tests and produces a non-root image that listens on port 8080 and stores usage in `/data`. Put it behind a TLS reverse proxy that forwards WebSocket upgrades and sets `X-Real-IP`, then set `TRUST_PROXY=true`. `PUBLIC_ORIGIN` accepts a comma-separated list, so a regional front proxy near the learner (for example `https://mural-hk.example.com`) can serve the same gateway; requests from any other origin are rejected.

## Limits of this prototype

- Mobile browsers can suspend or mute the microphone when the screen locks or the page moves to the background. The gateway then ends the conversation after `IDLE_AUDIO_SECONDS`. Native background audio is not available to web apps.
- Echo cancellation with speaker output depends on the browser and needs real-device checks.
- The usage ledger is a cost guard for one person, not a billing record. Check the provider's own usage reports.
- History and kid-mode records live in one browser on one device. Clearing site data deletes them, and they do not sync between devices; use export and import to move them. Safari can delete a website's stored data after seven days of browser use without a visit to the site; an app added to the home screen is exempt. Export a backup regularly.
- Stars and reports depend on speech recognition of a child's voice and on the text model's reading of it; both can be wrong.
