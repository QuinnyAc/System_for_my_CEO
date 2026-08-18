# ZenoMinerals Social Operations Platform

Standalone social media operations platform for ZenoMinerals.

## Platform scope

- YouTube
- Instagram
- Facebook
- Pinterest

## Hard isolation boundary

This repository is a standalone system.

- It does not import, reference, mount, query, or depend on any other Creator Ops repository.
- It uses its own PostgreSQL database: `zeno_social_ops`.
- It uses its own Docker volumes prefixed with `zeno_social_ops_`.
- It uses its own web/API ports and its own authentication + credential-encryption secrets.
- Google, Meta, and Pinterest OAuth/API credentials belong only to this repository and must never be committed to Git.
- No cross-project database, login, cookie, secret, OAuth token, Codespace, deployment, runtime, or data sharing is allowed.

## Product modules

- Dashboard
- Social accounts
- Published content
- Synchronization center
- Account metrics
- Content metrics
- Analytics
- API connection status
- Sync logs
- Settings

## Data synchronization design

Each social account owns an independent API connection record. OAuth tokens are encrypted before they are stored in PostgreSQL.

- YouTube: public Data API Key fallback plus Google OAuth for the actual channel; channel metrics, single-video metrics, and recent upload import.
- Instagram: Meta official authorization for Professional accounts, account/media data, and recent media import.
- Facebook: Meta official authorization for managed Pages, Page/post data, and recent published post import.
- Pinterest: Pinterest OAuth, account/Pin data, and recent Pin import.

The application also keeps manual metric snapshot endpoints so historical data can still be recorded before all provider credentials are configured.

## Local ports

- Web: `3100`
- API: `8100`
- PostgreSQL host port: `55432`

## Runtime secrets

The `.env.example` file contains names/placeholders only. Real values must exist only in the runtime environment for this repository.

Required application secrets:

- `APP_PASSWORD`
- `SESSION_SECRET`
- `CREDENTIALS_SECRET`

Provider variables:

- `YOUTUBE_API_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `META_APP_ID`
- `META_APP_SECRET`
- `META_GRAPH_VERSION`
- `PINTEREST_APP_ID`
- `PINTEREST_APP_SECRET`
