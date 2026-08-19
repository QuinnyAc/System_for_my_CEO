export type Platform = { id: string; slug: string; name: string };
export type SocialAccount = {
  id: string;
  platform_id: string;
  group_id: string | null;
  name: string;
  handle: string | null;
  external_id: string | null;
  profile_url: string | null;
  baseline_at: string | null;
  created_at: string;
};
export type AccountMetric = {
  id: string;
  account_id: string;
  captured_at: string;
  followers: number;
  views: number;
  impressions: number;
  reach: number;
  engagements: number;
  content_count: number;
  extra_metrics: Record<string, unknown>;
};
export type PublishedContent = {
  id: string;
  account_id: string;
  title: string;
  content_type: string;
  external_id: string | null;
  url: string | null;
  published_at: string | null;
  created_at: string;
};
export type ContentMetric = {
  id: string;
  content_id: string;
  captured_at: string;
  views: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
  impressions: number;
  reach: number;
  extra_metrics: Record<string, unknown>;
};
export type ConnectionStatus = {
  account_id: string;
  platform_slug: string;
  configured: boolean;
  connected: boolean;
  status: string;
  scopes: string[];
  expires_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  callback_url: string | null;
};
export type ProviderStatus = {
  youtube: { api_key: boolean; oauth: boolean; callback_url: string };
  instagram: { oauth: boolean; callback_url: string };
  facebook: { oauth: boolean; callback_url: string };
  pinterest: { oauth: boolean; callback_url: string };
};
export type AuthorizeUrl = { url: string; callback_url: string };
export type ImportResult = { created: number; updated: number; skipped: number };
export type SyncLog = {
  id: string;
  provider: string;
  target_type: string;
  target_id: string;
  status: string;
  message: string | null;
  details: Record<string, unknown>;
  created_at: string;
};
export type SyncAllResult = {
  accounts_ok: number;
  accounts_error: number;
  content_ok: number;
  content_error: number;
};
