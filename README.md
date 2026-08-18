# Social Media Operations Platform

A standalone company social media operations platform designed to remain neutral to company name, brand, product line, or content category.

## Platform scope

- YouTube
- Instagram
- Facebook
- Pinterest

## System boundary

This repository runs as its own standalone system.

- PostgreSQL database: `media_ops_hub`.
- Docker volumes use the `media_ops_hub_` prefix.
- Web, API, authentication, credential-encryption, OAuth tokens, runtime configuration, Codespace, and deployment are self-contained.
- Google, Meta, and Pinterest OAuth/API credentials must never be committed to Git.
- The application must not depend on or share data with any external project.

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

- YouTube: Data API Key fallback plus Google OAuth; channel metrics, single-video metrics, and recent upload import.
- Instagram: Meta official authorization for Professional accounts, account/media data, and recent media import.
- Facebook: Meta official authorization for managed Pages, Page/post data, and recent published post import.
- Pinterest: Pinterest OAuth, account/Pin data, and recent Pin import.

Manual metric snapshots remain available so historical data can still be recorded before all provider credentials are configured.

## Local ports

- Web: `3100`
- API: `8100`
- PostgreSQL host port: `55432`

## Runtime secrets

The `.env.example` file contains names/placeholders only. Real values must exist only in this repository's runtime environment.

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
