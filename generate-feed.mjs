import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const SKAUN_TENANT = "939865942_PROD-939865942-SKAUN";
const SKAUN_BASE = "https://prod01.elementscloud.no/publikum";
const TRONDELAG_BASE = "https://opengov.360online.com/Meetings/TRONDELAG";
const execFileAsync = promisify(execFile);

const COUNTY_TERMS = {
  Orkland: ["Orkland", "Orkland videregående skole", "Orkland vgs"],
  Skaun: ["Skaun"],
  Heim: ["Heim kommune", "Heim", "Kyrksæterøra videregående skole", "Kyrksæterøra vgs"],
  Rindal: ["Rindal"],
};

const OPEN_GOV = [
  { slug: "rindal", name: "Rindal" },
  { slug: "heim", name: "Heim" },
  { slug: "orkland", name: "Orkland" },
];

const CONTROL_COMMITTEES = [
  {
    slug: "orkland-kontrollutvalg",
    name: "Orkland kontrollutvalg",
    source: "https://www.konsek.no/kontrollutvalg/orkland/",
    type: "konsek",
  },
  {
    slug: "skaun-kontrollutvalg",
    name: "Skaun kontrollutvalg",
    source: "https://www.konsek.no/kontrollutvalg/skaun/",
    type: "konsek",
  },
  {
    slug: "heim-kontrollutvalg",
    name: "Heim kontrollutvalg",
    source: "https://www.konsek.no/kontrollutvalg/heim/",
    type: "konsek",
  },
  {
    slug: "rindal-kontrollutvalg",
    name: "Rindal kontrollutvalg",
    source: "https://opengov.360online.com/Meetings/rindal/Boards/Details/208126",
    siteSlug: "rindal",
    type: "opengov",
  },
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

function stripHtml(value = "") {
  return normalize(decodeHtml(value.replace(/<[^>]+>/g, " ")));
}

function exactWord(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const letters = "A-Za-zÆØÅæøå";
  return new RegExp(`(^|[^${letters}])${escaped}([^${letters}]|$)`, "i").test(text);
}

function municipalityMatches(text = "") {
  const matches = [];
  for (const [municipality, terms] of Object.entries(COUNTY_TERMS)) {
    if (terms.some((term) => exactWord(text, term))) matches.push(municipality);
  }
  return matches;
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

function monthParameters() {
  const now = new Date();
  return [-1, 0, 1, 2].map((offset) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    return { month: date.getUTCMonth() + 1, year: date.getUTCFullYear() };
  });
}

function extractCountyAgendaItems(html, meetingUrl) {
  const meetingTitle = stripHtml(
    html.match(/class=["'][^"']*meetingTitleHeaderText[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i)?.[1] ||
      "Politisk møte i Trøndelag fylkeskommune"
  );
  const items = [];
  const pattern = /id=["']agendaItem_(\d+)["'][\s\S]*?<h5\s+class=["'][^"']*accordionTitleText[^"']*["'][^>]*>([\s\S]*?)<\/h5>/gi;
  for (const match of html.matchAll(pattern)) {
    const agendaItemId = match[1];
    items.push({
      key: `trondelag:${agendaItemId}`,
      agendaItemId,
      meetingTitle,
      title: stripHtml(match[2]),
      link: `${meetingUrl}?agendaItemId=${agendaItemId}`,
    });
  }
  return items;
}

function extractCountyDocuments(html) {
  const documents = [];
  const pattern = /href=["']([^"']*\/File\/Details\/[^"']+\.pdf[^"']*)["'][\s\S]*?<div\s+class=["']fileNameDetail["']>([\s\S]*?)<\/div>/gi;
  for (const match of html.matchAll(pattern)) {
    const link = new URL(decodeHtml(match[1]), TRONDELAG_BASE);
    documents.push({
      key: link.pathname,
      title: stripHtml(match[2]) || normalize(link.searchParams.get("fileName")) || "Dokument",
      link: link.href,
      size: Number(link.searchParams.get("fileSize")) || 0,
    });
  }
  return uniqueBy(documents, "key");
}

async function extractPdfText(document, directory) {
  if (document.size > 25_000_000) return "";
  const response = await fetchChecked(document.link, {
    headers: { Accept: "application/pdf" },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 25_000_000) return "";
  const filename = `${document.key.split("/").at(-1).replace(/[^a-z0-9.-]/gi, "_")}`;
  const path = `${directory}/${filename}`;
  await writeFile(path, bytes);
  const { stdout } = await execFileAsync("pdftotext", ["-layout", path, "-"], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

async function buildCountyCases(previousState) {
  const previousCases = previousState?.countyCases || {};
  const initialCountyRun = !previousState?.countyMonitored;
  const monthPages = await mapLimit(monthParameters(), 2, ({ month, year }) =>
    fetchText(`${TRONDELAG_BASE}/Meetings?month=${month}&year=${year}`)
  );
  const meetingLinks = uniqueBy(
    monthPages.flatMap((html) =>
      extractMeetingLinks(html, TRONDELAG_BASE, "TRONDELAG", 100).map((link) => ({ link }))
    ),
    "link"
  ).map(({ link }) => link);
  const agendaItems = uniqueBy(
    (
      await mapLimit(meetingLinks, 4, async (meetingUrl) =>
        extractCountyAgendaItems(await fetchText(meetingUrl), meetingUrl)
      )
    ).flat(),
    "key"
  );

  const cases = await mapLimit(agendaItems, 5, async (item) => {
    const detailHtml = await fetchText(
      `${TRONDELAG_BASE}/Meetings/LoadAgendaItemDetail/${item.agendaItemId}`
    );
    return { ...item, documents: extractCountyDocuments(detailHtml) };
  });

  const temporaryRoot = process.env.RUNNER_TEMP || "public";
  const directory = await mkdtemp(`${temporaryRoot}/kommune-rss-`);
  let remainingPdfScans = Number(process.env.MAX_PDF_SCANS || 80);
  try {
    for (const item of cases) {
      const previousDocuments = new Map(
        (previousCases[item.key]?.documents || []).map((document) => [document.key, document])
      );
      for (const document of item.documents) {
        const previous = previousDocuments.get(document.key);
        if (previous?.scanned) {
          document.scanned = true;
          document.matches = previous.matches || [];
          continue;
        }
        const directMatches = municipalityMatches(`${item.title} ${document.title}`);
        if (directMatches.length || initialCountyRun || remainingPdfScans <= 0) {
          // På første kjøring registreres gamle dokumenter som utgangspunkt.
          // Fulltekstlesing brukes på dokumenter som kommer til etterpå.
          document.scanned = directMatches.length > 0 || initialCountyRun;
          document.matches = directMatches;
          continue;
        }
        remainingPdfScans -= 1;
        try {
          document.matches = municipalityMatches(await extractPdfText(document, directory));
          document.scanned = true;
        } catch (error) {
          console.warn(`Kunne ikke lese ${document.title}: ${error.message}`);
          document.matches = [];
          document.attempts = (previous?.attempts || 0) + 1;
          document.scanned = document.attempts >= 3;
        }
      }
      item.municipalities = [
        ...new Set([
          ...municipalityMatches(item.title),
          ...item.documents.flatMap((document) => document.matches || []),
        ]),
      ];
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return cases;
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

function extractMeetingLinks(html, source, slug, limit = 15) {
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
  ].slice(0, limit);
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

async function buildOpenGovMeetings({ slug, name, source: configuredSource, siteSlug }) {
  const source = configuredSource || `https://opengov.360online.com/Meetings/${slug}`;
  const indexHtml = await fetchText(source);
  const meetingLinks = extractMeetingLinks(indexHtml, source, siteSlug || slug);
  const meetings = await mapLimit(meetingLinks, 4, async (url) =>
    extractOpenGovMeeting(await fetchText(url), url, slug, name)
  );
  return {
    sourceKey: slug,
    name,
    source,
    meetings,
  };
}

function parseNorwegianDate(value) {
  const match = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  return new Date(`${match[3]}-${match[2]}-${match[1]}T12:00:00Z`);
}

function extractKonsekMeetings(html, { slug, name, source }) {
  const now = new Date();
  const lower = now.valueOf() - 90 * 24 * 60 * 60 * 1000;
  const upper = now.valueOf() + 400 * 24 * 60 * 60 * 1000;
  const sections = [];
  const sectionPattern = /<section\s+class=["'][^"']*\bmote\b[^"']*["']\s+id=["']m-(\d+)["'][^>]*>([\s\S]*?)<\/section>/gi;

  for (const match of html.matchAll(sectionPattern)) {
    const id = match[1];
    const section = match[2];
    const dateText = section.match(/fa-calendar[^>]*><\/i>\s*(\d{2}\.\d{2}\.\d{4})/i)?.[1];
    const date = dateText ? parseNorwegianDate(dateText) : null;
    if (!date || date.valueOf() < lower || date.valueOf() > upper) continue;

    const papers = [];
    const pdfPattern = /href=["']([^"']+\.pdf(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi;
    for (const pdf of section.matchAll(pdfPattern)) {
      const link = new URL(decodeHtml(pdf[1]), source).href;
      const title = normalize(decodeHtml(pdf[2].replace(/<[^>]+>/g, " ")));
      papers.push({ key: link, title: title || "Dokument" });
    }

    sections.push({
      key: `${slug}:${id}`,
      municipality: name,
      title: `Kontrollutvalget ${name.replace(" kontrollutvalg", "")} ${dateText}`,
      link: `${source}#m-${id}`,
      papers: uniqueBy(papers, "key"),
    });
  }
  return sections;
}

async function buildKonsekMeetings(configuration) {
  return {
    sourceKey: configuration.slug,
    name: configuration.name,
    source: configuration.source,
    meetings: extractKonsekMeetings(
      await fetchText(configuration.source),
      configuration
    ),
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
    sourceKey: "skaun",
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
  const inferredSources = new Set(
    Object.keys(previousMeetings).map((key) => key.split(":")[0])
  );
  const monitoredSources = new Set(
    previousState?.monitoredSources || inferredSources
  );
  const newEvents = [];

  for (const meeting of currentMeetings) {
    const previous = previousMeetings[meeting.key];
    const sourceKey = meeting.key.split(":")[0];
    const currentPaperKeys = meeting.papers.map((paper) => paper.key);
    nextMeetings[meeting.key] = {
      municipality: meeting.municipality,
      title: meeting.title,
      link: meeting.link,
      papers: meeting.papers,
    };

    // Første kjøring oppretter bare et utgangspunkt og sender ingen gamle varsler.
    if (!previousState || !monitoredSources.has(sourceKey)) continue;

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
    state: {
      version: 2,
      monitoredSources: [
        ...new Set([
          ...monitoredSources,
          ...sources.map((source) => source.sourceKey),
        ]),
      ],
      meetings: nextMeetings,
      events,
    },
    events,
    newEventCount: newEvents.length,
  };
}

function buildCountyEvents(cases, previousState, meetingState) {
  const now = new Date().toUTCString();
  const previousCases = previousState?.countyCases || {};
  const nextCases = { ...previousCases };
  const newEvents = [];

  for (const item of cases) {
    const previous = previousCases[item.key];
    nextCases[item.key] = item;
    if (!previousState?.countyMonitored || !item.municipalities.length) continue;

    const previousMunicipalities = previous?.municipalities || [];
    const municipalityLabel = item.municipalities.join(", ");
    if (!previous || !previousMunicipalities.length) {
      newEvents.push({
        title: `[${municipalityLabel}] Ny fylkessak: ${item.title}`,
        link: item.link,
        guid: `ny-fylkessak-${item.key}`,
        date: now,
        description: `${item.meetingTitle}. Treff på: ${municipalityLabel}.`,
      });
      continue;
    }

    const previousKeys = new Set((previous.documents || []).map((document) => document.key));
    const addedDocuments = item.documents.filter((document) => !previousKeys.has(document.key));
    if (addedDocuments.length) {
      newEvents.push({
        title: `[${municipalityLabel}] Nye dokumenter: ${item.title}`,
        link: item.link,
        guid: revisionGuid(
          "nye-fylkesdokumenter",
          item.key,
          item.documents.map((document) => document.key)
        ),
        date: now,
        description: `${item.meetingTitle}. Nye dokumenter: ${shortDocumentList(
          addedDocuments.map((document) => document.title),
          4
        )}`,
      });
    }
  }

  const countyEvents = uniqueBy(
    [...newEvents, ...(previousState?.countyEvents || [])],
    "guid"
  ).slice(0, 100);
  return {
    state: {
      ...meetingState,
      version: 3,
      countyMonitored: true,
      countyCases: nextCases,
      countyEvents,
    },
    events: countyEvents,
    newEventCount: newEvents.length,
  };
}

await mkdir("public", { recursive: true });

const controlSources = CONTROL_COMMITTEES.map((committee) =>
  committee.type === "konsek"
    ? buildKonsekMeetings(committee)
    : buildOpenGovMeetings(committee)
);

const previousState = await loadPreviousState();
const [skaunPostlist, skaunMeetings, openGovMeetings, controlMeetings, countyCases] = await Promise.all([
  buildSkaunPostlist(),
  buildSkaunMeetings(),
  Promise.all(OPEN_GOV.map(buildOpenGovMeetings)),
  Promise.all(controlSources),
  buildCountyCases(previousState),
]);

await writeFeed("skaun-postliste.xml", skaunPostlist);
const meetingSources = [skaunMeetings, ...openGovMeetings, ...controlMeetings];
const { state: meetingState, events, newEventCount } = buildMeetingEvents(
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

for (let index = 0; index < CONTROL_COMMITTEES.length; index += 1) {
  const committee = CONTROL_COMMITTEES[index];
  await writeFeed(`${committee.slug}.xml`, {
    title: `Møter og nye sakspapirer ${committee.name}`,
    link: committee.source,
    description: `Nye møter og sakspapirer fra ${committee.name}`,
    items: events.filter((event) => event.municipality === committee.name),
  });
}

const controlNames = new Set(CONTROL_COMMITTEES.map((committee) => committee.name));
await writeFeed("alle-kontrollutvalg.xml", {
  title: "Nye møter og sakspapirer – alle kontrollutvalg",
  link: CONTROL_COMMITTEES[0].source,
  description: "Nye kontrollutvalgsmøter og sakspapirer fra fire kommuner",
  items: events
    .filter((event) => controlNames.has(event.municipality))
    .map((event) => ({ ...event, title: `[${event.municipality}] ${event.title}` })),
});

await writeFeed("alle-sakspapirer.xml", {
  title: "Nye møter og sakspapirer – alle kommuner",
  link: skaunMeetings.source,
  description: "Nye politiske møter og sakspapirer fra Skaun, Rindal, Heim og Orkland",
  items: events.map((event) => ({
    ...event,
    title: `[${event.municipality}] ${event.title}`,
  })),
});

const countyResult = buildCountyEvents(countyCases, previousState, meetingState);
console.log(
  previousState?.countyMonitored
    ? `${countyResult.newEventCount} nye relevante fylkessaker/-dokumenter`
    : "Første fylkeskjøring: lagret utgangspunkt uten å varsle om gamle saker"
);
await writeFeed("trondelag-kommunesaker.xml", {
  title: "Fylkessaker som gjelder Orkland, Skaun, Heim eller Rindal",
  link: TRONDELAG_BASE,
  description: "Nye fylkessaker og dokumenter som omtaler en av de fire kommunene",
  items: countyResult.events,
});

await writeFile("public/state.json", JSON.stringify(countyResult.state, null, 2), "utf8");

await writeFile(
  "public/index.html",
  `<!doctype html><html lang="nb"><meta charset="utf-8"><title>Kommunale RSS-feeder</title>
  <h1>Kommunale RSS-feeder</h1><ul>
  <li><a href="skaun-postliste.xml">Postliste Skaun</a></li>
  <li><a href="skaun-sakspapirer.xml">Sakspapirer Skaun</a></li>
  <li><a href="rindal-sakspapirer.xml">Sakspapirer Rindal</a></li>
  <li><a href="heim-sakspapirer.xml">Sakspapirer Heim</a></li>
  <li><a href="orkland-sakspapirer.xml">Sakspapirer Orkland</a></li>
  <li><a href="skaun-kontrollutvalg.xml">Kontrollutvalget Skaun</a></li>
  <li><a href="rindal-kontrollutvalg.xml">Kontrollutvalget Rindal</a></li>
  <li><a href="heim-kontrollutvalg.xml">Kontrollutvalget Heim</a></li>
  <li><a href="orkland-kontrollutvalg.xml">Kontrollutvalget Orkland</a></li>
  <li><a href="alle-kontrollutvalg.xml">Alle kontrollutvalg samlet</a></li>
  <li><a href="alle-sakspapirer.xml">Alle sakspapirer samlet</a></li>
  <li><a href="trondelag-kommunesaker.xml">Relevante saker i Trøndelag fylkeskommune</a></li>
  </ul></html>`,
  "utf8"
);
