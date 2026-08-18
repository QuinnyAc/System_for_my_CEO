# ZenoMinerals Social Operations Platform

An independent social media operations platform for ZenoMinerals.

## Platform scope

- YouTube
- Instagram
- Facebook
- Pinterest

## Isolation boundary

This repository is a standalone system.

- It does not import, reference, mount, query, or depend on any other Creator Ops repository.
- It uses its own PostgreSQL database: `zeno_social_ops`.
- It uses its own Docker volumes prefixed with `zeno_social_ops_`.
- It uses its own web/API ports and its own authentication secrets.
- OAuth/API credentials for Google, Meta, and Pinterest must be configured only for this repository and must never be committed to Git.
- No cross-project database, login, secret, Codespace, deployment, or runtime sharing is allowed.

## Product goal

Provide one place to manage ZenoMinerals social accounts, published content, and performance snapshots, then connect official APIs to synchronize account and post/video data.

## Initial modules

- Dashboard
- Social accounts
- Published content
- Account metrics
- Content metrics
- API connection status
- Settings

## Local ports

- Web: `3100`
- API: `8100`
- PostgreSQL host port: `55432`

These ports and all runtime names are intentionally independent.
