#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// How long the actor run itself is allowed to take, in seconds. One value for
// every Mamba Labs wrapper, set 2026-10-05: start and poll exists so a long run
// survives, and a shorter limit would end the long runs it was built for. Past
// this limit the run ends TIMED-OUT and the caller is told so, with the run id.
// The actor's own default is 3600 s; a run capped at 100 rows across all 18
// sources measured 280 s on 2026-10-01.
const ACTOR_RUN_TIMEOUT_SECS = 1800;

// How long this wrapper waits for that run, in milliseconds. The actor's own
// timeout plus two minutes, so the run's own TIMED-OUT status is what the
// caller sees rather than the wrapper giving up first and reporting nothing.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = 3000;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoints carry a platform
// ceiling of 300 seconds on the HTTP wait itself and answer 408 past it whatever
// the timeout parameter says, so a long run reads as a timeout even though the
// actor goes on to finish. Starting the run, polling it to a terminal status and
// then reading the dataset is the only way to wait as long as the actor needs.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success. Surfacing it here is what keeps a crashed run from reading
  // as "no results found".
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message
      ? `${asObj.error.message}`
      : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const SPECIALTIES = [
  "medicine.psychiatry",
  "medicine.psychiatry.forensic",
  "medicine.psychology",
  "medicine.psychology.neuropsychology",
  "medicine.orthopaedics",
  "medicine.neurology",
  "medicine.neurosurgery",
  "medicine.occupational",
  "medicine.rehabilitation",
  "medicine.pain",
  "medicine.general_practice",
  "medicine.emergency",
  "medicine.general_surgery",
  "medicine.plastic_surgery",
  "medicine.ophthalmology",
  "medicine.ent",
  "medicine.cardiology",
  "medicine.obstetrics_gynaecology",
  "medicine.radiology",
  "medicine.pathology",
  "medicine.anaesthesia",
  "medicine.dermatology",
  "medicine.rheumatology",
  "medicine.urology",
  "medicine.paediatrics",
  "medicine.internal",
  "medicine.toxicology",
  "medicine.nursing",
  "medicine.dentistry",
  "medicine.physiotherapy",
  "medicine.occupational_therapy",
  "medicine.podiatry",
  "medicine.chiropractic",
  "medicine.pharmacy",
  "medicine.other",
  "engineering.structural",
  "engineering.civil",
  "engineering.mechanical",
  "engineering.electrical",
  "engineering.fire",
  "engineering.accident_reconstruction",
  "engineering.other",
  "property.surveying",
  "property.construction",
  "finance.forensic_accounting",
  "finance.valuation",
  "finance.economics",
  "insurance.claims",
  "technology.digital_forensics",
  "technology.software",
  "science.forensic",
  "science.handwriting",
  "employment.vocational",
  "care.life_care_planning",
  "other",
] as const;

// Every source the live input schema offers. Only the 18 named in the `sources`
// description are implemented; the actor skips the rest and names them in its RUN_SUMMARY record.
const SOURCES = [
  "abime",
  "lacourt-panels",
  "sfbar",
  "cccba",
  "isba",
  "lsba",
  "aaimco",
  "medilaw",
  "lexmedicus",
  "aushub",
  "medicolegal-specialists",
  "index-medicolegal",
  "themis",
  "integrityml",
  "vmls",
  "lime",
  "mag-directory",
  "workcover-wa",
  "lacba-expert4law",
  "lexvisio",
  "lawcom-experts",
  "expertpages",
  "jurispro",
  "experts-com",
  "trialsmith",
  "seak",
  "expert-institute",
  "aapl",
  "specialists-medicolegal-australia",
  "medibytes",
  "nsw-pic",
  "ranzcp",
  "sira-nsw",
  "worksafe-qld",
  "worksafe-tas",
] as const;

const server = new McpServer({
  name: "mamba-expert-witness-directory",
  version: pkg.version,
});

// Expert Witness Directory (immutable actor ID LIpwlgfE3LaQBaXd4)
server.registerTool(
  "find_expert_witnesses",
  {
    title: "Find Expert Witnesses in the US and Australia",
    description:
      "Find expert witnesses and medico-legal assessors in the United States and Australia. Reads 18 public directories, merges the same person across directories into one record, and maps every source's specialty tags to one taxonomy. Each row carries name, specialty, state or region, country, firm, practice site, phone, listing URL, and the sources that list the person. Coverage is the United States and Australia only: the public actor refuses a UK or Canadian request. published_email is filled only when a source page printed an address; the actor never guesses one. Several sources restrict automated collection or solicitation in their terms; the actor README lists each source's posture, and the use decision is yours. Use it to shortlist experts by specialty and region, or run mode feed on a schedule to see new, changed, and removed listings. Requires an APIFY_TOKEN; charges per expert record, per published email, and per NPPES check, as the README pricing table lists. Writes only to the named key-value store in your own Apify account.",
    annotations: {
      title: "Find Expert Witnesses in the US and Australia",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
    specialty: z.array(z.enum(SPECIALTIES)).optional().describe("Taxonomy codes. A parent code also matches its children: medicine.psychiatry includes medicine.psychiatry.forensic. Empty returns every specialty."),
    region: z.array(z.string()).optional().describe("State or region as the source prints it, for example Queensland, California, New South Wales. Case and accents are ignored. Empty returns every region."),
    // US and AU only. The public actor refuses GB and CA, so they are not offered here.
    country: z.array(z.enum(["US", "AU"])).optional().describe("US, AU, or both. Empty returns both. United States and Australia only: the public actor refuses a UK or Canadian request and stops the run with an error, so no other value is accepted."),
    sources: z.array(z.enum(SOURCES)).optional().describe("Directories to read. Empty reads every implemented source. Sources that are not implemented yet, or that the actor does not cover, are skipped and named in the RUN_SUMMARY record. The 18 implemented sources are abime, lacourt-panels, sfbar, cccba, isba, lsba, aaimco, medilaw, lexmedicus, aushub, medicolegal-specialists, index-medicolegal, themis, integrityml, vmls, lime, mag-directory, workcover-wa."),
    mode: z.enum(["list", "feed"]).optional().describe("list returns every matching expert. feed returns only experts that are new, changed, or returned since the last run on the same persistent store, plus removed rows; unchanged experts are not emitted and cost nothing. A listing counts as removed after 2 complete, unfiltered runs miss it. Default: list."),
    verifyNppes: z.boolean().optional().describe("Check each US record against the free NPPES monthly file (name, state, and specialty). Adds npi and nppes_status. NPPES carries no email. Charged per checked record. Default: false."),
    maxItems: z.number().int().min(0).optional().describe("Stop after this many output rows (one row per deduplicated expert). 0 means no cap. A capped run never marks listings as removed. Default: 100."),
    persistStoreName: z.string().optional().describe("Named key-value store in your account that keeps expert records between runs. Reuse the same name for feed mode. Default: expert-witness-directory-store."),
    },
  },
  async (args) =>
    runActor("LIpwlgfE3LaQBaXd4", "Expert Witness Directory", compact(args as Record<string, unknown>)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
