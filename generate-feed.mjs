import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const SOURCE_URL =
  "https://prod01.elementscloud.no/publikum/939865942_PROD-939865942-SKAUN/";

const escapeXml = (value = "") =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const normalize = (value = "") => value.replace(/\s+/g, " ").trim();

function parseNorwegianDate(text) {
  const match = text.match(/Journaldato\s*(\d{2})\.(\d{2})\.(\d{4})/i);
  if (!match) return null;
  const [, day, month, year] = match;
  return new Date(`${year}-${month}-${day}T12:00:00+02:00`).toUTCString();
}

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({
    locale: "nb-NO",
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36",
  });
  page.setDefaultTimeout(10_000);

  await page.goto(SOURCE_URL, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });

  await page.waitForFunction(
    () => document.querySelectorAll(".insn-list .card").length > 0,
    { timeout: 90_000 }
  );

  // Les alle kort i én nettleseroperasjon. Dette unngår at en manglende
  // selektor kan gi 30 sekunders venting for hvert enkelt kort.
  const rawPosts = await page.locator(".insn-list .card").evaluateAll(
    (cards, sourceUrl) =>
      cards.slice(0, 50).map((card, index) => {
        const titleNode =
          card.querySelector(".card-title span.expanded-view-title") ||
          card.querySelector(".card-title span.font-weight-bold") ||
          card.querySelector(".card-title button");
        const linkNode = card.querySelector(
          '.card-title a[href*="/RegistryEntry/"]'
        );
        const title = (titleNode?.textContent || "").replace(/\s+/g, " ").trim();
        const rawHref = linkNode?.getAttribute("href");
        const link = rawHref ? new URL(rawHref, sourceUrl).href : sourceUrl;
        const fullText = (card.textContent || "").replace(/\s+/g, " ").trim();
        return { title, link, fullText, index };
      }),
    SOURCE_URL
  );

  const posts = rawPosts
    .filter((post) => post.title)
    .map((post) => ({
      title: post.title,
      link: post.link,
      description: post.fullText,
      published: parseNorwegianDate(post.fullText),
      guid: `${post.link}#rss-${post.index}`,
    }));

  if (posts.length === 0) {
    throw new Error("Fant ingen poster på Skaun-postlisten.");
  }

  const items = posts
    .map(
      (post) => `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${escapeXml(post.link)}</link>
      <guid isPermaLink="false">${escapeXml(post.guid)}</guid>
      ${post.published ? `<pubDate>${post.published}</pubDate>` : ""}
      <description>${escapeXml(post.description)}</description>
    </item>`
    )
    .join("\n");

  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Postliste Skaun</title>
    <link>${escapeXml(SOURCE_URL)}</link>
    <description>Offentlig postliste for Skaun kommune</description>
    <language>nb-no</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;

  await mkdir("public", { recursive: true });
  await writeFile("public/rss.xml", rss, "utf8");
  await writeFile(
    "public/index.html",
    '<!doctype html><html lang="nb"><meta charset="utf-8"><title>Postliste Skaun RSS</title><h1>Postliste Skaun</h1><p><a href="rss.xml">Åpne RSS-feeden</a></p></html>',
    "utf8"
  );

  console.log(`Skrev ${posts.length} poster til public/rss.xml`);
} finally {
  await browser.close();
}
