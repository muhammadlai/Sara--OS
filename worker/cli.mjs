#!/usr/bin/env node
/**
 * W2 CLI — research / discover / note / ledger
 * Usage (from repo root):
 *   node worker/cli.mjs research --url https://example.com --lead acme
 *   node worker/cli.mjs search --query "importers Nigeria" --lead acme
 *   node worker/cli.mjs discover --query "fleet buyers UAE" [--apply]
 *   node worker/cli.mjs note --lead acme --text "Met at a trade show"
 *   node worker/cli.mjs ledger [--lead acme]
 */
import { createResearchEngine } from './research.mjs';
import { createDiscovery } from './discovery.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(a);
  }
  return out;
}

function print(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const cmd = opts._[0] || 'help';
  const engine = createResearchEngine({ home: opts.home });
  const discovery = createDiscovery({ engine, dryRun: opts.apply !== true });

  switch (cmd) {
    case 'research':
      print(await engine.researchUrl({
        url: opts.url,
        leadId: opts.lead,
        company: opts.company,
      }));
      break;
    case 'search':
      print(await engine.search({
        query: opts.query || opts._.slice(1).join(' '),
        leadId: opts.lead,
        company: opts.company,
      }));
      break;
    case 'discover': {
      const queries = []
        .concat(opts.query || [])
        .concat(opts.queries ? String(opts.queries).split('|') : [])
        .concat(opts._.slice(1));
      print(await discovery.discover({
        queries,
        leadId: opts.lead,
        dryRun: opts.apply !== true,
      }));
      break;
    }
    case 'note':
      print(engine.addManualNote({
        leadId: opts.lead,
        company: opts.company,
        text: opts.text || '',
      }));
      break;
    case 'ledger':
      print(engine.ledger.listEvents({ leadId: opts.lead, limit: Number(opts.limit) || 50 }));
      break;
    case 'lead':
      print(engine.ledger.readLead(opts.lead || opts._[1]));
      break;
    case 'classify':
      print(classifyReply({
        subject: opts.subject || '',
        body: opts.text || opts.body || opts._.slice(1).join(' '),
      }));
      break;
    case 'replies': {
      const replies = createReplyWorker({ home: opts.home });
      print(await replies.checkInbox({ since: opts.since }));
      break;
    }
    case 'replies-status':
      print(createReplyWorker({ home: opts.home }).summarize());
      break;
    default:
      print({
        usage: 'node worker/cli.mjs <research|search|discover|note|ledger|lead|classify|replies|replies-status>',
        dry_run: 'discover is dry-run unless --apply',
        env: ['JINA_API_KEY', 'GMAIL_ADAPTER_URL', 'NOTIFY_WEBHOOK_URL'],
      });
  }
}

const invoked = process.argv[1] && process.argv[1].endsWith('cli.mjs');
if (invoked) {
  main().catch((err) => {
    console.error(JSON.stringify({ status: 'RESEARCH_FAILED', reason: err.message }, null, 2));
    process.exit(1);
  });
}
