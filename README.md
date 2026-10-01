# Expert Witness Directory MCP Server

[![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dcom.mambabuilt%252Fmcp-expert-witness-directory%26limit%3D1&query=%24.servers%5B0%5D._meta%5B%22io.modelcontextprotocol.registry%2Fofficial%22%5D.status&label=mcp%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.mambabuilt/mcp-expert-witness-directory&limit=1) [![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-expert-witness-directory)](https://www.npmjs.com/package/@mambalabsdev/mcp-expert-witness-directory) [![npm downloads](https://img.shields.io/npm/dm/@mambalabsdev/mcp-expert-witness-directory)](https://www.npmjs.com/package/@mambalabsdev/mcp-expert-witness-directory)

MCP server for the Mamba Labs [Expert Witness Directory](https://apify.com/mambalabs/expert-witness-directory) actor on Apify.

Expert witness and medico-legal directory records for the United States and Australia, one deduplicated record per person, with specialties mapped to one taxonomy.

## Install

```bash
npx -y @mambalabsdev/mcp-expert-witness-directory
```

### Claude Desktop

```json
{
  "mcpServers": {
    "mamba-expert-witness-directory": {
      "command": "npx",
      "args": ["-y", "@mambalabsdev/mcp-expert-witness-directory"],
      "env": { "APIFY_TOKEN": "your-apify-token" }
    }
  }
}
```

Get an Apify token at [console.apify.com/account/integrations](https://console.apify.com/account/integrations).

## Coverage

- The actor returns records for the **United States** and **Australia** only.
- It reads 18 public sources: 7 in the US and 11 in Australia, counting ABIME once in the US. ABIME lists experts in several countries; the actor keeps only its US and Australian records.
- UK and Canadian records are not offered. The `country` input accepts `US` and `AU` only, because the public actor refuses any other country and stops the run with an error.
- The same person on several directories comes back as one record listing every source.
- Every source's own specialty tags map to one taxonomy, so "Forensic Psychiatry" and "Psychiatrist, general adult" filter together.
- Australian panel sources print the panel's contact details, not the doctor's, so those records carry a name, specialty, and state but no email.

## Emails

The actor never guesses an email. `published_email` is empty unless a source page printed an address, and `email_source` names the page.

## Source terms

Several sources publish terms that restrict automated collection, reproduction, commercial use, or soliciting the people they list. The [actor README](https://apify.com/mambalabs/expert-witness-directory) gives the terms posture of each source as it was published when the actor was built. The actor reports the terms; it does not decide for you. Make your own call for your use case, and take legal advice where it matters.

## Tool

### `find_expert_witnesses`

Find expert witnesses and medico-legal assessors in the United States and Australia, filtered by specialty, region, country, and source.

| Input | Type | Required | Notes |
| --- | --- | --- | --- |
| `specialty` | array | no | Taxonomy codes, for example `medicine.psychiatry` or `engineering.structural`. A parent code also matches its children: `medicine.psychiatry` includes `medicine.psychiatry.forensic`. Empty returns every specialty. 55 codes. |
| `region` | array | no | State or region as the source prints it, for example Queensland, California, New South Wales. Case and accents are ignored. Empty returns every region. |
| `country` | array | no | `US`, `AU`, or both. Empty returns both. No other value is accepted: the public actor refuses a UK or Canadian request and stops the run. |
| `sources` | array | no | Directories to read. Empty reads the 18 implemented sources: `abime`, `lacourt-panels`, `sfbar`, `cccba`, `isba`, `lsba`, `aaimco`, `medilaw`, `lexmedicus`, `aushub`, `medicolegal-specialists`, `index-medicolegal`, `themis`, `integrityml`, `vmls`, `lime`, `mag-directory`, `workcover-wa`. The other 17 values the actor offers are planned or not covered; the actor skips them and names them in its `RUN_SUMMARY` record. |
| `mode` | string | no | `list` (default) returns every matching expert. `feed` returns only experts that are new, changed, or returned since the last run on the same persistent store, plus removed rows. Unchanged experts are not emitted and cost nothing. |
| `verifyNppes` | boolean | no | Off by default. Checks each US record against the free NPPES monthly file and adds `npi` and `nppes_status`. NPPES carries no email. |
| `maxItems` | integer | no | Stop after this many output rows. Default 100. `0` means no cap. A capped run never marks listings as removed. |
| `persistStoreName` | string | no | Named key-value store in your Apify account that keeps expert records between runs. Default `expert-witness-directory-store`. Reuse the same name for feed mode. |

Nothing is required. A call with no inputs reads all 18 sources and returns up to 100 experts.

A run with `maxItems: 0` reads every listing on every source at one request per 2 seconds per host. It has not been timed, and it may pass the 3,600 second run timeout this wrapper sets. Set `maxItems` for an interactive call.

## Pricing

Expert Witness Directory is pay per event on Apify. Four events are billed.

| Event | Charged for | Price | Fires when |
| --- | --- | ---: | --- |
| `expert-record` | Expert record | $0.004 | Once per deduplicated expert row written to the dataset. In feed mode, once per new, changed, returned, or removed row; unchanged experts are not emitted and cost nothing. |
| `email-found` | Email returned | $0.01 | Once per row that carries a published email a source page printed. Removed rows never charge it. |
| `npi-verified` | NPPES check | $0.002 | Once per US row checked against the NPPES monthly file. Only when `verifyNppes` is on. |
| `apify-actor-start` | Actor start | $0.00005 | Charged by Apify when the run starts, one event per GB of memory. One event at the 1024 MB default. |

## Actor

Actor ID `LIpwlgfE3LaQBaXd4`. The wrapper calls the actor by that immutable ID rather than by its Store slug, so a Store rename never breaks it.

Built by [Mamba Labs](https://mambabuilt.com).
