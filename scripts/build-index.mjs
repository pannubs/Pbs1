import fs from "node:fs/promises";
import path from "node:path";

// ============================================================
// 1. SITE REGISTRY
// ============================================================
const SITES = [
  {
    id: "s1",
    origin: "https://new1.bollyflix.tours",
    sitemap: "https://new1.bollyflix.tours/sitemap_index.xml",
  },
  {
    id: "s2",
    origin: "https://filmyfly.kred",
    sitemap: "https://filmyfly.kred/post-sitemap.xml",
  },
  {
    id: "s3",
    origin: "https://www.filmywap.archi",
    sitemap: "https://www.filmywap.archi/sitemap.xml",
  },
];

const STATIC_EXT_RE =
  /\.(css|js|mjs|jpg|jpeg|png|gif|webp|avif|svg|ico|woff|woff2|ttf|eot|pdf|mp4|webm|mp3|json|xml)$/i;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CHILD_BATCH_SIZE = 5;

function getRootDomain(hostname) {
  const parts = hostname.toLowerCase().replace(/^www\./, "").split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : hostname.toLowerCase();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/xml,text/xml,text/plain,*/*",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, finalUrl: res.url, text };
}

async function discoverFromRobots(originBase) {
  try {
    const res = await fetchText(`${originBase}/robots.txt`);
    if (!res.ok) return [];
    return [...res.text.matchAll(/^sitemap:\s*(https?:\/\/\S+)/gim)].map((m) =>
      m[1].trim()
    );
  } catch {
    return [];
  }
}

async function fetchSitemapUrls(sitemapUrl, depth, stat) {
  if (depth > 2) return [];

  const res = await fetchText(sitemapUrl);
  if (depth === 0) {
    stat.httpStatus = res.status;
    stat.finalUrl = res.finalUrl;
  }

  if (!res.ok) {
    if (depth === 0) stat.error = `HTTP ${res.status}`;
    else stat.childErrors++;
    return [];
  }

  const locs = [
    ...res.text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/loc>/gi),
  ].map((m) => m[1].trim());

  if (depth === 0 && locs.length === 0) {
    stat.error = "No <loc> tags found (not an XML sitemap)";
    return [];
  }

  // Handle multi-part sitemap indexes (fetches all post sitemaps in batches)
  if (res.text.includes("<sitemapindex")) {
    const children = locs.filter(
      (u) => !/(author|category|tag|page-sitemap|video-sitemap)/i.test(u)
    );
    stat.childrenFound += children.length;

    const allNested = [];
    for (let i = 0; i < children.length; i += CHILD_BATCH_SIZE) {
      const batch = children.slice(i, i + CHILD_BATCH_SIZE);
      const nested = await Promise.all(
        batch.map((child) =>
          fetchSitemapUrls(child, depth + 1, stat).catch(() => {
            stat.childErrors++;
            return [];
          })
        )
      );
      for (const list of nested) allNested.push(...list);
    }
    return allNested;
  }

  return locs;
}

async function main() {
  const sitesMeta = [];
  const stats = [];
  const items = []; // Compact format: [siteIndex, "/post-path/"]

  for (let siteIndex = 0; siteIndex < SITES.length; siteIndex++) {
    const site = SITES[siteIndex];
    const originBase = site.origin.replace(/\/+$/, "");
    sitesMeta.push({ id: site.id, origin: originBase });

    const stat = {
      id: site.id,
      httpStatus: null,
      finalUrl: null,
      childrenFound: 0,
      childErrors: 0,
      indexed: 0,
      error: null,
    };

    try {
      let urls = await fetchSitemapUrls(site.sitemap, 0, stat);

      // Fallback: check robots.txt and common sitemap paths if primary URL returns 0 URLs
      if (urls.length === 0) {
        const discovered = await discoverFromRobots(originBase);
        const fallbacks = [
          ...discovered,
          `${originBase}/sitemap.xml`,
          `${originBase}/sitemap_index.xml`,
        ];

        for (const candidate of fallbacks) {
          if (candidate === site.sitemap) continue;
          const attempt = await fetchSitemapUrls(candidate, 0, stat);
          if (attempt.length > 0) {
            urls = attempt;
            stat.error = null;
            break;
          }
        }
      }

      const allowedRoots = new Set([getRootDomain(new URL(originBase).hostname)]);
      if (stat.finalUrl) {
        try {
          allowedRoots.add(getRootDomain(new URL(stat.finalUrl).hostname));
        } catch {}
      }

      const seen = new Set();
      for (const rawUrl of urls) {
        try {
          const parsed = new URL(rawUrl);
          if (!allowedRoots.has(getRootDomain(parsed.hostname))) continue;
          if (STATIC_EXT_RE.test(parsed.pathname)) continue;
          if (parsed.pathname === "/" || parsed.pathname === "") continue;
          if (seen.has(parsed.pathname)) continue;

          seen.add(parsed.pathname);
          items.push([siteIndex, parsed.pathname]);
          stat.indexed++;
        } catch {
          // Skip invalid URLs
        }
      }
    } catch (err) {
      stat.error = err.message;
    }

    stats.push(stat);
    console.log(
      `[${site.id}] indexed=${stat.indexed} children=${stat.childrenFound} error=${stat.error || "none"}`
    );
  }

  const output = {
    updatedAt: new Date().toISOString(),
    sites: sitesMeta,
    stats,
    items,
  };

  await fs.mkdir("docs", { recursive: true });
  const outPath = path.join("docs", "index.json");
  await fs.writeFile(outPath, JSON.stringify(output), "utf8");

  const sizeKb = (Buffer.byteLength(JSON.stringify(output)) / 1024).toFixed(1);
  console.log(`Wrote ${items.length} total items to ${outPath} (${sizeKb} KB raw)`);
}

main();
