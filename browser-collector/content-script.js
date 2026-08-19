const VERSION = "0.5.1";

function text(selector) {
  const node = document.querySelector(selector);
  return node?.textContent?.trim() || "";
}

function attr(selector, name) {
  const node = document.querySelector(selector);
  return node?.getAttribute(name)?.trim() || "";
}

function meta(name) {
  return (
    document.querySelector(`meta[property="${name}"]`)?.getAttribute("content") ||
    document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ||
    ""
  ).trim();
}

function bodyText(limit = 16000) {
  return (document.body?.innerText || "").slice(0, limit);
}

function parseCount(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim().replace(/\u00a0/g, " ");
  if (!raw) return null;
  const chinese = raw.match(/([\d,.]+)\s*(万|亿)/);
  if (chinese) {
    const number = Number(chinese[1].replace(/,/g, ""));
    if (!Number.isFinite(number)) return null;
    return Math.round(number * (chinese[2] === "亿" ? 100000000 : 10000));
  }
  const compact = raw.match(/([\d,.]+)\s*([KMBT])/i);
  if (compact) {
    const number = Number(compact[1].replace(/,/g, ""));
    if (!Number.isFinite(number)) return null;
    const multiplier = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[compact[2].toUpperCase()] || 1;
    return Math.round(number * multiplier);
  }
  const plain = raw.match(/\d[\d,.\s]*/);
  if (!plain) return null;
  const cleaned = plain[0].replace(/[\s,]/g, "");
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function countNear(source, labels) {
  const suffix = "(?:[KMBT]|万|亿)?";
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const before = source.match(new RegExp(`([\\d,.]+\\s*${suffix})\\s*${escaped}`, "i"));
    if (before) {
      const value = parseCount(before[1]);
      if (value !== null) return value;
    }
    const after = source.match(new RegExp(`${escaped}\\s*[:：]?\\s*([\\d,.]+\\s*${suffix})`, "i"));
    if (after) {
      const value = parseCount(after[1]);
      if (value !== null) return value;
    }
  }
  return null;
}

function cleanTitle(value) {
  return (value || "").replace(/\s*[|·-]\s*(YouTube|Instagram|Facebook|Pinterest)\s*$/i, "").trim();
}

function absoluteUrl(href) {
  if (!href) return "";
  try {
    return new URL(href, location.origin).href;
  } catch {
    return "";
  }
}

function uniqueLinks(nodes, accept, limit = 80) {
  const found = [];
  const seen = new Set();
  for (const node of nodes) {
    const full = absoluteUrl(node.getAttribute("href") || "");
    if (!full || seen.has(full)) continue;
    try {
      if (!accept(full)) continue;
    } catch {
      continue;
    }
    seen.add(full);
    found.push(full);
    if (found.length >= limit) break;
  }
  return found;
}

function feedSettled(minMs = 18000) {
  return performance.now() >= minMs;
}

function youtubeDiscoveredLinks() {
  return uniqueLinks(
    document.querySelectorAll('a[href^="/watch?v="], a[href^="/shorts/"]'),
    (value) => {
      const url = new URL(value);
      return url.hostname.endsWith("youtube.com") && (url.pathname === "/watch" || url.pathname.startsWith("/shorts/"));
    },
    100
  );
}

function instagramDiscoveredLinks() {
  return uniqueLinks(
    document.querySelectorAll('a[href^="/p/"], a[href^="/reel/"], a[href^="/tv/"]'),
    (value) => {
      const url = new URL(value);
      return url.hostname.endsWith("instagram.com") && ["/p/", "/reel/", "/tv/"].some((prefix) => url.pathname.startsWith(prefix));
    },
    90
  );
}

function facebookDiscoveredLinks() {
  return uniqueLinks(
    document.querySelectorAll('a[href*="/reel/"], a[href*="/videos/"], a[href*="/posts/"], a[href*="story_fbid="], a[href*="fbid="], a[href*="/watch"]'),
    (value) => {
      const url = new URL(value);
      if (!url.hostname.endsWith("facebook.com")) return false;
      return /\/(reel|videos|posts|watch|photo|permalink)\b/i.test(url.pathname) || url.searchParams.has("story_fbid") || url.searchParams.has("fbid");
    },
    90
  );
}

function pinterestDiscoveredLinks() {
  return uniqueLinks(
    document.querySelectorAll('a[href^="/pin/"]'),
    (value) => {
      const url = new URL(value);
      return url.hostname.endsWith("pinterest.com") && url.pathname.startsWith("/pin/");
    },
    90
  );
}

function youtubeViewCount(videoId) {
  let value = parseCount(attr('meta[itemprop="interactionCount"]', "content"));
  if (value !== null) return value;
  for (const selector of ["ytd-watch-info-text span", "#info span", "#info-text span", "yt-formatted-string#info", "#view-count", "span.view-count"]) {
    for (const node of document.querySelectorAll(selector)) {
      const source = `${node.textContent || ""} ${node.getAttribute("aria-label") || ""}`;
      if (!/view|watch|观看|播放/i.test(source)) continue;
      value = parseCount(source);
      if (value !== null) return value;
    }
  }
  value = countNear([meta("description"), meta("og:description")].filter(Boolean).join(" "), ["views", "view", "次观看", "次播放", "观看次数"]);
  if (value !== null) return value;
  for (const script of document.querySelectorAll("script")) {
    const source = script.textContent || "";
    if (!source || (!source.includes('"viewCount"') && !source.includes('"userInteractionCount"'))) continue;
    const player = source.match(/"videoDetails"\s*:\s*\{[\s\S]{0,10000}?"viewCount"\s*:\s*"?(\d+)"?/);
    if (player) return parseCount(player[1]);
    if (videoId && source.includes(videoId)) {
      const generic = source.match(/"viewCount"\s*:\s*"?(\d+)"?/);
      if (generic) return parseCount(generic[1]);
    }
    const interaction = source.match(/"userInteractionCount"\s*:\s*"?([\d,]+)"?/);
    if (interaction) return parseCount(interaction[1]);
  }
  return countNear(bodyText(22000), ["views", "view", "次观看", "次播放", "观看次数"]);
}

function youtube() {
  const path = location.pathname;
  const host = location.hostname.replace(/^www\./, "").toLowerCase();
  const shortLink = host === "youtu.be";
  const isContent = shortLink || path === "/watch" || path.startsWith("/shorts/") || path.startsWith("/live/");
  const channelLink = document.querySelector('ytd-video-owner-renderer a[href^="/@"], #owner a[href^="/@"], ytd-channel-name a[href^="/@"]');
  const href = channelLink?.getAttribute("href") || "";
  let handle = href.startsWith("/@") ? href.slice(1).split("/")[0] : "";
  if (!handle && path.startsWith("/@")) handle = path.slice(1).split("/")[0];
  const accountName = text("ytd-channel-name a") || text("#channel-name #text") || text("#text-container #text");
  const profileUrl = href ? `${location.origin}${href.split("?")[0]}` : path.startsWith("/@") ? `${location.origin}/${handle}` : "";

  if (!isContent) {
    const source = [meta("description"), meta("og:description"), bodyText(12000)].filter(Boolean).join(" ");
    let followers = parseCount(text("#subscriber-count"));
    if (followers === null) followers = countNear(source, ["subscribers", "subscriber", "订阅者", "位订阅者"]);
    const contentCount = countNear(source, ["videos", "video", "视频"]);
    const discovered = youtubeDiscoveredLinks();
    const emptyText = /no videos|hasn['’]t uploaded|no shorts|暂无视频|没有视频|尚未上传/i.test(source);
    const empty = contentCount === 0 || emptyText;
    const ready = empty || (discovered.length > 0 && feedSettled(14000));
    return {
      platform: "youtube",
      page_type: "account",
      url: location.href,
      title: cleanTitle(document.title),
      account_name: accountName || cleanTitle(document.title),
      handle,
      profile_url: profileUrl || location.href,
      metrics: { followers, content_count: contentCount },
      discovered_urls: discovered,
      discovery_complete: ready,
      feed_empty: empty
    };
  }

  const videoId = shortLink
    ? path.split("/").filter(Boolean)[0] || ""
    : path === "/watch"
      ? new URL(location.href).searchParams.get("v") || ""
      : path.split("/").filter(Boolean).pop() || "";
  const views = youtubeViewCount(videoId);
  let likes = parseCount(text("#segmented-like-button button"));
  if (likes === null) {
    const button = document.querySelector('#segmented-like-button button, like-button-view-model button');
    likes = parseCount(button?.getAttribute("aria-label") || "");
  }
  let comments = parseCount(text("ytd-comments-header-renderer #count"));
  if (comments === null) comments = countNear(bodyText(18000), ["comments", "comment", "条评论", "评论"]);
  return {
    platform: "youtube",
    page_type: "content",
    url: location.href,
    title: text("h1 yt-formatted-string") || cleanTitle(meta("og:title")) || cleanTitle(document.title),
    account_name: accountName,
    handle,
    profile_url: profileUrl,
    content_external_id: videoId,
    content_type: path.startsWith("/shorts/") ? "short" : "video",
    metrics: { views, likes, comments }
  };
}

function instagram() {
  const segments = location.pathname.split("/").filter(Boolean);
  const isContent = ["p", "reel", "tv"].includes(segments[0]);
  const description = [meta("description"), meta("og:description")].filter(Boolean).join(" ");
  const ogTitle = meta("og:title") || document.title;
  let handle = "";
  if (!isContent && segments.length === 1) handle = segments[0];
  if (isContent) {
    const match = ogTitle.match(/@([A-Za-z0-9._]+)/) || description.match(/@([A-Za-z0-9._]+)/);
    if (match) handle = match[1];
  }

  if (!isContent) {
    const source = `${description} ${bodyText(10000)}`;
    const followers = countNear(source, ["followers", "follower", "粉丝"]);
    const posts = countNear(source, ["posts", "post", "帖子", "贴文"]);
    const discovered = instagramDiscoveredLinks();
    const emptyText = /no posts yet|no posts|还没有帖子|暂无帖子/i.test(source);
    const empty = posts === 0 || emptyText;
    const ready = empty || (discovered.length > 0 && feedSettled(18000));
    return {
      platform: "instagram",
      page_type: "account",
      url: location.href,
      title: cleanTitle(ogTitle),
      account_name: cleanTitle(ogTitle).replace(/^@/, ""),
      handle,
      profile_url: location.href,
      metrics: { followers, content_count: posts },
      discovered_urls: discovered,
      discovery_complete: ready,
      feed_empty: empty
    };
  }

  const source = `${description} ${bodyText(12000)}`;
  const likes = countNear(source, ["likes", "like", "赞"]);
  const comments = countNear(source, ["comments", "comment", "评论"]);
  const views = countNear(source, ["views", "plays", "view", "play", "次观看", "次播放"]);
  return {
    platform: "instagram",
    page_type: "content",
    url: location.href,
    title: cleanTitle(ogTitle),
    account_name: handle,
    handle,
    profile_url: handle ? `https://www.instagram.com/${handle}/` : "",
    content_external_id: segments[1] || "",
    content_type: segments[0] === "reel" ? "short" : "post",
    metrics: { views, likes, comments }
  };
}

function facebook() {
  const path = location.pathname;
  const host = location.hostname.replace(/^www\./, "").toLowerCase();
  const isContent = host === "fb.watch" || /\/(posts|videos|reel|watch|photo|permalink)\b/i.test(path) || /(?:story_fbid|fbid)=/.test(location.search);
  const source = [meta("description"), meta("og:description"), bodyText(16000)].filter(Boolean).join(" ");
  const title = cleanTitle(meta("og:title") || document.title);
  const firstSegment = path.split("/").filter(Boolean)[0] || "";
  const handle = ["watch", "reel", "photo.php", "story.php", "permalink.php"].includes(firstSegment) ? "" : firstSegment;

  if (!isContent) {
    const followers = countNear(source, ["followers", "follower", "粉丝"]);
    const posts = countNear(source, ["posts", "post", "videos", "reels", "帖子", "视频"]);
    const discovered = facebookDiscoveredLinks();
    const emptyText = /no posts yet|no posts available|暂无帖子|没有帖子/i.test(source);
    const empty = posts === 0 || emptyText;
    const ready = empty || (discovered.length > 0 && feedSettled(18000));
    return {
      platform: "facebook",
      page_type: "account",
      url: location.href,
      title,
      account_name: title,
      handle,
      profile_url: location.href,
      metrics: { followers, content_count: posts },
      discovered_urls: discovered,
      discovery_complete: ready,
      feed_empty: empty
    };
  }

  const views = countNear(source, ["views", "plays", "view", "play", "次观看", "次播放"]);
  const likes = countNear(source, ["reactions", "likes", "reaction", "like", "赞", "心情"]);
  const comments = countNear(source, ["comments", "comment", "评论"]);
  const shares = countNear(source, ["shares", "share", "分享"]);
  return {
    platform: "facebook",
    page_type: "content",
    url: location.href,
    title,
    account_name: title,
    handle,
    profile_url: handle ? `${location.origin}/${handle}` : "",
    content_external_id: new URL(location.href).searchParams.get("story_fbid") || new URL(location.href).searchParams.get("fbid") || "",
    content_type: /\/reel\b/i.test(path) ? "short" : /\/videos\b|\/watch\b/i.test(path) ? "video" : "post",
    metrics: { views, likes, comments, shares }
  };
}

function pinterest() {
  const host = location.hostname.replace(/^www\./, "").toLowerCase();
  const segments = location.pathname.split("/").filter(Boolean);
  const isContent = host === "pin.it" || segments[0] === "pin";
  const source = [meta("description"), meta("og:description"), bodyText(12000)].filter(Boolean).join(" ");
  const title = cleanTitle(meta("og:title") || document.title);
  const handle = !isContent && segments.length === 1 ? segments[0] : "";

  if (!isContent) {
    const followers = countNear(source, ["followers", "follower", "粉丝"]);
    const pins = countNear(source, ["pins", "pin", "图钉"]);
    const discovered = pinterestDiscoveredLinks();
    const emptyText = /no pins yet|no pins|暂无 pin|暂无图钉/i.test(source);
    const empty = pins === 0 || emptyText;
    const ready = empty || (discovered.length > 0 && feedSettled(18000));
    return {
      platform: "pinterest",
      page_type: "account",
      url: location.href,
      title,
      account_name: title,
      handle,
      profile_url: location.href,
      metrics: { followers, content_count: pins },
      discovered_urls: discovered,
      discovery_complete: ready,
      feed_empty: empty
    };
  }

  const saves = countNear(source, ["saves", "saved", "save", "保存"]);
  const comments = countNear(source, ["comments", "comment", "评论"]);
  return {
    platform: "pinterest",
    page_type: "content",
    url: location.href,
    title,
    account_name: "",
    handle: "",
    content_external_id: segments[1] || "",
    content_type: "pin",
    metrics: { saves, comments }
  };
}

function extract() {
  const host = location.hostname.replace(/^www\./, "").toLowerCase();
  if (host.endsWith("youtube.com") || host === "youtu.be") return youtube();
  if (host.endsWith("instagram.com")) return instagram();
  if (host.endsWith("facebook.com") || host === "fb.watch") return facebook();
  if (host.endsWith("pinterest.com") || host === "pin.it") return pinterest();
  return null;
}

function hasMetric(payload) {
  return Object.values(payload?.metrics || {}).some((value) => Number.isFinite(value));
}

function hasDiscovery(payload) {
  return Array.isArray(payload?.discovered_urls) && payload.discovered_urls.length > 0;
}

async function collect() {
  const payload = extract();
  if (!payload) return;
  const metricReady = hasMetric(payload);
  const discoveryReady = hasDiscovery(payload);
  if (payload.page_type === "account") {
    if (!payload.discovery_complete && !payload.feed_empty) return;
    if (!metricReady && !discoveryReady && !payload.feed_empty) return;
  } else if (!metricReady) {
    return;
  }

  payload.collector_version = VERSION;
  const fingerprint = JSON.stringify({
    platform: payload.platform,
    page_type: payload.page_type,
    url: location.href,
    metrics: payload.metrics,
    discovered_urls: payload.discovered_urls || [],
    discovery_complete: Boolean(payload.discovery_complete),
    feed_empty: Boolean(payload.feed_empty)
  });
  const key = "mediaOpsLastPublicMetrics";
  if (sessionStorage.getItem(key) === fingerprint) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: "PUBLIC_METRICS", payload });
    if (response?.ok) sessionStorage.setItem(key, fingerprint);
  } catch {
    // Do not interfere with the social media page if the collector is unavailable.
  }
}

let timer = null;
function schedule(delay = 4500) {
  clearTimeout(timer);
  timer = setTimeout(collect, delay);
}

schedule(6500);
setInterval(collect, 10 * 60 * 1000);
const observer = new MutationObserver(() => schedule(4500));
observer.observe(document.documentElement, { childList: true, subtree: true });
