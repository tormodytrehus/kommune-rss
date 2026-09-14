import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const SKAUN_TENANT = "939865942_PROD-939865942-SKAUN";
const SKAUN_BASE = "https://prod01.elementscloud.no/publikum";

const OPEN_GOV = [
  { slug: "rindal", name: "Rindal" },
  { slug: "heim", name: "Heim" },
  { slug: "orkland", name: "Orkland" },
];

const repository = process.env.GITHUB_REPOSITORY || "";
const [repositoryOwner, repositoryName] = repository.split("/");
const publishedStateUrl =
  process.env.STATE_URL ||
  (repositoryOwner && repositoryName
    ? `https://${repositoryOwner}.github.io/${repositoryName}/state.json`
    : null);

const normalize = (value = "") => value.replace(/\s+/g, " ").trim();

const escapeXml = (value = "") =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const decodeHtml = (value = "") =>
  value
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) =>
      String.fromCodePoint(Number.parseInt(number, 16))
    )
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");

async function fetchChecked(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(60_000),
    headers: {
      Accept: "text/html,application/json",
      "User-Agent": "kommune-rss/3.0 (+public RSS generator)",
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`${response.status} fra ${url}`);
  return response;
}

async function fetchText(url, options) {
  return (await fetchChecked(url, options)).text();
}

async function fetchJson(url, options) {
  return (await fetchChecked(url, options)).json();
}

async function mapLimit(values, limit, worker) {
  const output = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        output[index] = await worker(values[index], index);
      }
    })
  );
  return output;
}

function uniqueBy(items, key) {
  return [...new Map(items.map((item) => [item[key], item])).values()];
}

function revisionGuid(prefix, meetingKey, documentKeys) {
  const revision = createHash("sha256")
    .update([...documentKeys].sort().join("\n"))
    .digest("hex")
    .slice(0, 16);
  return `${prefix}-${meetingKey}-${revision}`;
}

function shortDocumentList(titles, maximum = 5) {
  const cleaned = [...new Set(titles.map(normalize).filter(Boolean))];
  const shown = cleaned.slice(0, maximum).map((title) =>
    title.length > 100 ? `${title.slice(0, 97)}...` : title
  );
  const remainder = cleaned.length - shown.length;
  return `${shown.join("; ")}${remainder > 0 ? ` (+${remainder} flere)` : ""}`;
}

function toRfc822(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toUTCString();
}

function rssXml({ title, link, description, items }) {
  const body = items
    .slice(0, 100)
    .map(
      (item) => `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <guid isPermaLink="false">${escapeXml(item.guid)}</guid>
      ${item.date ? `<pubDate>${escapeXml(item.date)}</pubDate>` : ""}
      <description>${escapeXml(item.description || "")}</description>
    </item>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(link)}</link>
    <description>${escapeXml(description)}</description>
    <language>nb-no</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${body}
  </channel>
</rss>
`;
}

async function writeFeed(filename, options) {
  await writeFile(`public/${filename}`, rssXml(options), "utf8");
  console.log(`${filename}: ${options.items.length} poster`);
}

async function loadPreviousState() {
  if (!publishedStateUrl) return null;
  try {
    let stateUrl = publishedStateUrl;
    if (/^https?:/i.test(stateUrl)) {
      const url = new URL(stateUrl);
      url.searchParams.set("t", Date.now());
      stateUrl = url.href;
    }
    return await fetchJson(stateUrl);
  } catch {
    return null;
  }
}

async function buildSkaunPostlist() {
  const source = `${SKAUN_BASE}/${SKAUN_TENANT}/`;
  const data = await fetchJson(
    `${SKAUN_BASE}/api/PredefinedQuery/CasesAndRegistryEntries`,
    { headers: { Tenant: SKAUN_TENANT } }
  );
  const rows = Array.isArray(data) ? data : data.Items || [];
  const items = rows.slice(0, 100).map((row) => ({
    title: normalize(row.JP_INNHOLD_G) || `Journalpost ${row.JP_ID}`,
    link: `${SKAUN_BASE}/${SKAUN_TENANT}/RegistryEntry/${row.JP_ID}`,
    guid: `skaun-journalpost-${row.JP_ID}`,
    date: toRfc822(row.JP_JDATO),
    description: normalize(
      [row.ND_BETEGN, row.SA_SAKSNR_XX && `sak ${row.SA_SAKSNR_XX}`]
        .filter(Boolean)
        .join(" – ")
    ),
  }));
  return {
    title: "Postliste Skaun",
    link: source,
    description: "Nye journalposter fra Skaun kommune",
    items,
  };
}

function extractMeetingLinks(html, source, slug) {
  const pattern = new RegExp(
    `href=["']([^"']*/Meetings/${slug}/Meetings/Details/\\d+)["']`,
    "gi"
  );
  return [
    ...new Set(
      [...html.matchAll(pattern)].map((match) =>
        new URL(decodeHtml(match[1]), source).href
      )
    ),
  ].slice(0, 15);
}

function extractOpenGovMeeting(html, meetingUrl, slug, municipality) {
  const titleMatch = html.match(
    /class=["'][^"']*meetingTitleHeaderText[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i
  );
  const meetingTitle = normalize(
    decodeHtml((titleMatch?.[1] || municipality).replace(/<[^>]+>/g, " "))
  );
  const hrefPattern = /href=["']([^"']*\/File\/Details\/[^"']+)["']/gi;
  const documents = [];

  for (const match of html.matchAll(hrefPattern)) {
    const link = new URL(decodeHtml(match[1]), meetingUrl);
    const fallback = decodeURIComponent(link.pathname.split("/").pop() || "Dokument");
    const documentTitle = normalize(link.searchParams.get("fileName") || fallback);
    documents.push({ title: documentTitle, key: link.href });
  }

  const uniqueDocuments = uniqueBy(documents, "key");
  const meetingKey = meetingUrl.split("/").filter(Boolean).at(-1);
  return {
    key: `${slug}:${meetingKey}`,
    municipality,
    title: meetingTitle,
    link: meetingUrl,
    papers: uniqueDocuments,
  };
}

async function buildOpenGovMeetings({ slug, name }) {
  const source = `https://opengov.360online.com/Meetings/${slug}`;
  const indexHtml = await fetchText(source);
  const meetingLinks = extractMeetingLinks(indexHtml, source, slug);
  const meetings = await mapLimit(meetingLinks, 4, async (url) =>
    extractOpenGovMeeting(await fetchText(url), url, slug, name)
  );
  return {
    name,
    source,
    meetings,
  };
}

async function buildSkaunMeetings() {
  const headers = { Tenant: SKAUN_TENANT };
  const now = new Date();
  const years = [now.getUTCFullYear() - 1, now.getUTCFullYear(), now.getUTCFullYear() + 1];
  const meetingLists = await Promise.all(
    years.map((year) =>
      fetchJson(`${SKAUN_BASE}/api/PredefinedQuery/DmbMeetings?year=${year}&dmbName=`, {
        headers,
      })
    )
  );
  const allMeetings = uniqueBy(meetingLists.flat(), "MO_ID");
  const lower = now.valueOf() - 60 * 24 * 60 * 60 * 1000;
  const upper = now.valueOf() + 400 * 24 * 60 * 60 * 1000;
  const meetings = allMeetings
    .filter((meeting) => {
      const date = new Date(meeting.MO_START).valueOf();
      return date >= lower && date <= upper;
    })
    .sort((a, b) => new Date(b.MO_START) - new Date(a.MO_START))
    .slice(0, 40);

  const results = await mapLimit(meetings, 5, async (meeting) => {
    const [details, handlings] = await Promise.all([
      fetchJson(`${SKAUN_BASE}/api/Meetings/${meeting.MO_ID}`, { headers }),
      fetchJson(`${SKAUN_BASE}/api/DmbHandlings/GetByMeetingId/${meeting.MO_ID}`, {
        headers,
      }),
    ]);
    const meetingLink = `${SKAUN_BASE}/${SKAUN_TENANT}/DmbMeeting/${meeting.MO_ID}`;
    const meetingDate = new Date(meeting.MO_START).toLocaleDateString("nb-NO", {
      timeZone: "Europe/Oslo",
    });
    const context = `${meeting.UT_NAVN} ${meetingDate}`;
    const meetingDocs = (details.MeetingDocuments || []).map((document) => ({
      title: normalize(document.Title) || "Møtedokument",
      key: `dokument-${document.Id}`,
    }));
    const agendaItems = (handlings || []).map((handling) => ({
      title: normalize(handling.Title) || `Sak ${handling.Id}`,
      key: `sak-${handling.Id}`,
    }));
    return {
      key: `skaun:${meeting.MO_ID}`,
      municipality: "Skaun",
      title: context,
      link: meetingLink,
      papers: [...meetingDocs, ...agendaItems],
    };
  });

  return {
    name: "Skaun",
    source: `${SKAUN_BASE}/${SKAUN_TENANT}/Dmb`,
    meetings: results,
  };
}

function eventDescription(prefix, papers) {
  if (!papers.length) return "Møtet er lagt inn i møtekalenderen.";
  return `${prefix}: ${shortDocumentList(papers.map((paper) => paper.title))}`;
}

function buildMeetingEvents(sources, previousState) {
  const now = new Date().toUTCString();
  const previousMeetings = previousState?.meetings || {};
  const currentMeetings = sources.flatMap((source) => source.meetings);
  const nextMeetings = { ...previousMeetings };
  const newEvents = [];

  for (const meeting of currentMeetings) {
    const previous = previousMeetings[meeting.key];
    const currentPaperKeys = meeting.papers.map((paper) => paper.key);
    nextMeetings[meeting.key] = {
      municipality: meeting.municipality,
      title: meeting.title,
      link: meeting.link,
      papers: meeting.papers,
    };

    // Første kjøring oppretter bare et utgangspunkt og sender ingen gamle varsler.
    if (!previousState) continue;

    if (!previous) {
      newEvents.push({
        municipality: meeting.municipality,
        title: `Nytt møte: ${meeting.title}`,
        link: meeting.link,
        guid: `nytt-mote-${meeting.key}`,
        description: eventDescription("Saker/dokumenter", meeting.papers),
        date: now,
      });
      continue;
    }

    const previousKeys = new Set((previous.papers || []).map((paper) => paper.key));
    const addedPapers = meeting.papers.filter((paper) => !previousKeys.has(paper.key));
    if (addedPapers.length) {
      newEvents.push({
        municipality: meeting.municipality,
        title: `Nye sakspapirer: ${meeting.title}`,
        link: meeting.link,
        guid: revisionGuid(
          "nye-sakspapirer",
          meeting.key,
          currentPaperKeys
        ),
        description: eventDescription("Nye saker/dokumenter", addedPapers),
        date: now,
      });
    }
  }

  const events = uniqueBy(
    [...newEvents, ...(previousState?.events || [])],
    "guid"
  ).slice(0, 100);
  return {
    state: { version: 1, meetings: nextMeetings, events },
    events,
    newEventCount: newEvents.length,
  };
}

await mkdir("public", { recursive: true });

const [previousState, skaunPostlist, skaunMeetings, ...openGovMeetings] = await Promise.all([
  loadPreviousState(),
  buildSkaunPostlist(),
  buildSkaunMeetings(),
  ...OPEN_GOV.map(buildOpenGovMeetings),
]);

await writeFeed("skaun-postliste.xml", skaunPostlist);
const meetingSources = [skaunMeetings, ...openGovMeetings];
const { state, events, newEventCount } = buildMeetingEvents(
  meetingSources,
  previousState
);
console.log(
  previousState
    ? `${newEventCount} nye møte-/sakspapirvarsler`
    : "Første kjøring: lagret utgangspunkt uten å varsle om gamle møter"
);

const municipalityFeeds = [
  { slug: "skaun", name: "Skaun", source: skaunMeetings.source },
  ...OPEN_GOV.map((municipality, index) => ({
    ...municipality,
    source: openGovMeetings[index].source,
  })),
];

for (const municipality of municipalityFeeds) {
  await writeFeed(`${municipality.slug}-sakspapirer.xml`, {
    title: `Møter og nye sakspapirer ${municipality.name}`,
    link: municipality.source,
    description: `Nye møter og sakspapirer fra ${municipality.name}`,
    items: events.filter(
      (event) => event.municipality === municipality.name
    ),
  });
}

await writeFeed("alle-sakspapirer.xml", {
  title: "Nye møter og sakspapirer – alle kommuner",
  link: skaunMeetings.source,
  description: "Nye politiske møter og sakspapirer fra Skaun, Rindal, Heim og Orkland",
  items: events.map((event) => ({
    ...event,
    title: `[${event.municipality}] ${event.title}`,
  })),
});

await writeFile("public/state.json", JSON.stringify(state, null, 2), "utf8");

await writeFile(
  "public/index.html",
  `<!doctype html><html lang="nb"><meta charset="utf-8"><title>Kommunale RSS-feeder</title>
  <h1>Kommunale RSS-feeder</h1><ul>
  <li><a href="skaun-postliste.xml">Postliste Skaun</a></li>
  <li><a href="skaun-sakspapirer.xml">Sakspapirer Skaun</a></li>
  <li><a href="rindal-sakspapirer.xml">Sakspapirer Rindal</a></li>
  <li><a href="heim-sakspapirer.xml">Sakspapirer Heim</a></li>
  <li><a href="orkland-sakspapirer.xml">Sakspapirer Orkland</a></li>
  <li><a href="alle-sakspapirer.xml">Alle sakspapirer samlet</a></li>
  </ul></html>`,
  "utf8"
);
