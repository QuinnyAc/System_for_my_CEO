// Load the existing queue worker first, then tighten the account-metric
// completion rule for YouTube. Channel feed pages often expose video counts
// before subscriber counts. Treating content_count as sufficient caused the
// queue tab to close before youtube-account-metrics.js could upload followers.
importScripts("service-worker.js");

payloadHasAccountMetrics = function payloadHasAccountMetrics(payload) {
  const metrics = payload?.metrics || {};
  if (payload?.platform === "youtube" && payload?.page_type === "account") {
    return Number.isFinite(metrics.followers);
  }
  return [metrics.followers, metrics.account_views, metrics.content_count].some((value) => Number.isFinite(value));
};
