export type Platform = { id: string; slug: string; name: string };
export type SocialAccount = {
  id: string;
  platform_id: string;
  name: string;
  handle: string | null;
  external_id: string | null;
  profile_url: string | null;
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
