const VERSION = "0.3.0";

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

function parseCount(value) {
  if (value === null || value === undefined) return null;
  let raw = String(value).trim();
  if (!raw) return null;
  raw = raw.replace(/\u00a0/g, " ");
  const chinese = raw.match(/([\d,.]+)\s*(万|亿)/);
  if (chinese) {
    const number = Number(chinese[1].replace(/,/g, ""));
    if (!Number.isFinite(number)) return null;
    return Math.round(number * (chinese[2] === "亿" ? 100000000 : 10000));
  }
  const compact = raw.match(/([\d,.]+)\s*([KMB])/i);
  if (compact) {
    const number = Number(compact[1].replace(/,/g, ""));
    if (!Number.isFinite(number)) return null;
    const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[compact[2].toUpperCase()] || 1;
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
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const before = source.match(new RegExp(`([\\d,.]+\\s*[KMB]?)\\s*${escaped}`, "i"));
    if (before) {
      const value = parseCount(before[1]);
      if (value !== null) return value;
    }
    const after = source.match(new RegExp(`${escaped}\\s*[:：]?\\s*([\\d,.]+\\s*[KMB]?)`, "i"));
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

function uniqueLinks(nodes, accept, limit = 60) {
  const found = [];
  const seen = new Set();
  for (const node of nodes) {
    const href = node.getAttribute("href") || "";
    const full = absoluteUrl(href);
    if (!full || !accept(full) || seen.has(full)) continue;
    seen.add(full);
    found.push(full);
    if (found.length >= limit) break;
  }
  return found;
}

function youtubeDiscoveredLinks() {
  const links = document.querySelectorAll('a[href^="/watch?v="], a[href^="/shorts/"]');
  return uniqueLinks(links, (value) => {
    const u = new URL(value);
    return u.hostname.endsWith("youtube.com") && (u.pathname === "/watch" || u.pathname.startsWith("/shorts/"));
  }, 80);
}

function instagramDiscoveredLinks() {
  const links = document.querySelectorAll('a[href^="/p/"], a[href^="/reel/"]');
  return uniqueLinks(links, (value) => {
    const u = new URL(value);
    return u.hostname.endsWith("instagram.com") && (u.pathname.startsWith("/p/") || u.pathname.startsWith("/reel/"));
  }, 60);
}

function facebookDiscoveredLinks() {
  const links = document.querySelectorAll('a[href*="/reel/"], a[href*="/videos/"], a[href*="/posts/"], a[href*="story_fbid="]');
  return uniqueLinks(links, (value) => {
    const u = new URL(value);
    return u.hostname.endsWith("facebook.com") && (/\/(reel|videos|posts)\//i.test(u.pathname) || u.searchParams.has("story_fbid"));
  }, 60);
}

function pinterestDiscoveredLinks() {
  const links = document.querySelectorAll('a[href^="/pin/"]');
  return uniqueLinks(links, (value) => {
    const u = new URL(value);
    return u.hostname.endsWith("pinterest.com") && u.pathname.startsWith("/pin/");
  }, 60);
}

function youtube() {
  const path = location.pathname;
  const content = path === "/watch" || path.startsWith("/shorts/") || path.startsWith("/live/");
  const channelLink = document.querySelector('ytd-video-owner-renderer a[href^="/@"], #owner a[href^="/@"], ytd-channel-name a[href^="/@"]');
  const href = channelLink?.getAttribute("href") || "";
  let handle = href.startsWith("/@") ? href.slice(1).split("/")[0] : "";
  if (!handle && path.startsWith("/@")) handle = path.slice(1).split("/")[0];
  const accountName = text("ytd-channel-name a") || text("#channel-name #text") || text("#text-container #text");
  const profileUrl = href ? `${location.origin}${href.split("?")[0]}` : (path.startsWith("/@") ? `${location.origin}/${handle}` : "");
  const followers = parseCount(text("#subscriber-count"));

  if (!content) {
    return {
      platform: "youtube",
      page_type: "account",
      url: location.href,
      title: cleanTitle(document.title),
      account_name: accountName || cleanTitle(document.title),
      handle,
      profile_url: profileUrl || location.href,
      metrics: { followers },
      discovered_urls: youtubeDiscoveredLinks()
    };
  }

  let views = parseCount(attr('meta[itemprop="interactionCount"]', "content"));
  if (views === null) {
    const candidates = [...document.querySelectorAll("ytd-watch-info-text span, #info span")];
    const node = candidates.find((el) => /view|观看|次观看|次播放/i.test(el.textContent || ""));
    views = parseCount(node?.textContent || "");
  }
  let likes = parseCount(text("#segmented-like-button button"));
  if (likes === null) {
    const likeButton = document.querySelector('#segmented-like-button button, like-button-view-model button');
    likes = parseCount(likeButton?.getAttribute("aria-label") || "");
  }
  const comments = parseCount(text("ytd-comments-header-renderer #count"));
  const videoId = path === "/watch" ? new URL(location.href).searchParams.get("v") || "" : path.split("/").filter(Boolean).pop() || "";
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
    metrics: { views, likes, comments, followers }
  };
}

function instagram() {
  const path = location.pathname;
  const segments = path.split("/").filter(Boolean);
  const content = ["p", "reel", "tv"].includes(segments[0]);
  const description = meta("description") || meta("og:description") || "";
  const ogTitle = meta("og:title") || document.title;
  let handle = "";
  if (!content && segments.length === 1) handle = segments[0];
  if (content) {
    const titleMatch = ogTitle.match(/@([A-Za-z0-9._]+)/) || description.match(/@([A-Za-z0-9._]+)/);
    if (titleMatch) handle = titleMatch[1];
  }
  const followers = countNear(description, ["followers", "粉丝"]);
  const posts = countNear(description, ["posts", "帖子", "贴文"]);
  if (!content) {
    return {
      platform: "instagram",
      page_type: "account",
      url: location.href,
      title: cleanTitle(ogTitle),
      account_name: cleanTitle(ogTitle).replace(/^@/, ""),
      handle,
      profile_url: location.href,
      metrics: { followers, content_count: posts },
      discovered_urls: instagramDiscoveredLinks()
    };
  }
  const likes = countNear(description, ["likes", "like", "赞"]);
  const comments = countNear(description, ["comments", "comment", "评论"]);
  const body = document.body?.innerText || "";
  const views = countNear(body.slice(0, 8000), ["views", "plays", "次观看", "次播放"]);
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
    metrics: { views, likes, comments, followers }
  };
}

function facebook() {
  const path = location.pathname;
  const content = /\/(posts|videos|reel|watch|photo|permalink)\b/i.test(path) || /story_fbid=/.test(location.search);
  const description = [meta("description"), meta("og:description"), document.body?.innerText?.slice(0, 12000) || ""].filter(Boolean).join(" ");
  const title = cleanTitle(meta("og:title") || document.title);
  const firstSegment = path.split("/").filter(Boolean)[0] || "";
  const handle = ["watch", "reel", "photo.php", "story.php"].includes(firstSegment) ? "" : firstSegment;
  const followers = countNear(description, ["followers", "粉丝"]);
  if (!content) {
    return {
      platform: "facebook",
      page_type: "account",
      url: location.href,
      title,
      account_name: title,
      handle,
      profile_url: location.href,
      metrics: { followers },
      discovered_urls: facebookDiscoveredLinks()
    };
  }
  const views = countNear(description, ["views", "plays", "次观看", "次播放"]);
  const likes = countNear(description, ["reactions", "likes", "赞", "心情"]);
  const comments = countNear(description, ["comments", "评论"]);
  const shares = countNear(description, ["shares", "分享"]);
  return {
    platform: "facebook",
    page_type: "content",
    url: location.href,
    title,
    account_name: title,
    handle,
    profile_url: handle ? `${location.origin}/${handle}` : "",
    content_type: /\/reel\b/i.test(path) ? "short" : "post",
    metrics: { views, likes, comments, shares, followers }
  };
}

function pinterest() {
  const path = location.pathname;
  const segments = path.split("/").filter(Boolean);
  const content = segments[0] === "pin";
  const description = [meta("description"), meta("og:description"), document.body?.innerText?.slice(0, 8000) || ""].filter(Boolean).join(" ");
  const title = cleanTitle(meta("og:title") || document.title);
  const handle = !content && segments.length === 1 ? segments[0] : "";
  const followers = countNear(description, ["followers", "粉丝"]);
  if (!content) {
    return {
      platform: "pinterest",
      page_type: "account",
      url: location.href,
      title,
      account_name: title,
      handle,
      profile_url: location.href,
      metrics: { followers },
      discovered_urls: pinterestDiscoveredLinks()
    };
  }
  const saves = countNear(description, ["saves", "saved", "保存"]);
  const comments = countNear(description, ["comments", "评论"]);
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
  if (host.endsWith("facebook.com")) return facebook();
  if (host.endsWith("pinterest.com")) return pinterest();
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
  if (payload.page_type === "account" && !discoveryReady && performance.now() < 25000) return;
  if (!metricReady && !discoveryReady) return;
  payload.collector_version = VERSION;
  const fingerprint = JSON.stringify({
    platform: payload.platform,
    page_type: payload.page_type,
    url: location.href,
    metrics: payload.metrics,
    discovered_urls: payload.discovered_urls || []
  });
  const key = "mediaOpsLastPublicMetrics";
  if (sessionStorage.getItem(key) === fingerprint) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: "PUBLIC_METRICS", payload });
    if (response?.ok) sessionStorage.setItem(key, fingerprint);
  } catch {
    // Never interfere with the social media page if the collector is unavailable.
  }
}

let timer = null;
function schedule(delay = 5000) {
  clearTimeout(timer);
  timer = setTimeout(collect, delay);
}

schedule(7000);
setInterval(collect, 10 * 60 * 1000);
const observer = new MutationObserver(() => schedule(5000));
observer.observe(document.documentElement, { childList: true, subtree: true });
