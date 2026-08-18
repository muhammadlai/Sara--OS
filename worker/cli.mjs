#!/usr/bin/env node
/**
 * Worker CLI — W2 research, W4 replies, W5 outreach, W6 daily worker.
 * Usage (from repo root):
 *   node worker/cli.mjs worker run|status|report|dry-run
 *   node worker/cli.mjs research --url https://example.com --lead acme
 *   node worker/cli.mjs search --query "importers Nigeria" --lead acme
 *   node worker/cli.mjs discover --query "fleet buyers UAE" [--apply]
 *   node worker/cli.mjs note --lead acme --text "Met at a trade show"
 *   node worker/cli.mjs ledger [--lead acme]
 */
import { createResearchEngine } from './research.mjs';
import { createDiscovery } from './discovery.mjs';
import { createReplyWorker } from './replies.mjs';
import { classifyReply } from './classifier.mjs';
import { createOutreach, selectChannel } from './outreach.mjs';
import { createDailyWorker } from './daily.mjs';
import { listWorkflows, resolveWorkflow, attachWorkflow } from './workflows.mjs';
import { probeJina } from './jina.mjs';

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
    case 'select': {
      const lead = engine.ledger.readLead(opts.lead);
      print(selectChannel(lead || {}, {
        email: Boolean(process.env.EMAIL_ADAPTER_URL || process.env.GMAIL_SEND_URL),
        teams: Boolean(process.env.TEAMS_ACCESS_TOKEN),
        linkedin: Boolean(process.env.LINKEDIN_ACCESS_TOKEN || process.env.LINKEDIN_ADAPTER_URL),
      }));
      break;
    }
    case 'prepare': {
      const out = createOutreach({ home: opts.home });
      print(out.prepare({ leadId: opts.lead, channel: opts.channel || 'email', text: opts.text }));
      break;
    }
    case 'approve-outreach': {
      const out = createOutreach({ home: opts.home });
      print(out.approve(opts.lead, opts.fingerprint));
      break;
    }
    case 'reject-outreach': {
      const out = createOutreach({ home: opts.home });
      print(out.reject(opts.lead, opts.fingerprint, opts.reason || 'rejected'));
      break;
    }
    case 'send': {
      const out = createOutreach({ home: opts.home });
      print(await out.send({ leadId: opts.lead, channel: opts.channel, fingerprint: opts.fingerprint }));
      break;
    }
    case 'outreach-status':
      print(createOutreach({ home: opts.home }).summarize());
      break;
    case 'run':
    case 'worker-run':
      print(await createDailyWorker({ home: opts.home }).execute({
        dryRun: false,
        force: opts.force === true,
      }));
      break;
    case 'dry-run':
    case 'worker-dry-run':
      print(await createDailyWorker({ home: opts.home }).execute({
        dryRun: true,
        force: opts.force === true,
      }));
      break;
    case 'status':
    case 'worker-status':
      print(createDailyWorker({ home: opts.home }).status());
      break;
    case 'report':
    case 'worker-report':
      print(createDailyWorker({ home: opts.home }).report());
      break;
    case 'jina-health':
    case 'jina':
      print(await probeJina({
        probeQuery: opts.query || 'example.com',
        probeUrl: opts.url || 'https://example.com',
      }));
      break;
    case 'workflows':
      print({ workflows: listWorkflows() });
      break;
    case 'workflow': {
      const id = opts.workflow || opts._[1];
      const leadId = opts.lead;
      if (leadId) {
        const lead = engine.ledger.readLead(leadId);
        if (!lead) { print({ status: 'FAILED', reason: 'lead_not_found' }); break; }
        const next = engine.ledger.writeLead(attachWorkflow(lead, id));
        print({ status: 'WORKFLOW_ATTACHED', lead: next, workflow: resolveWorkflow(next).id });
      } else {
        print(resolveWorkflow({}, id));
      }
      break;
    }
    case 'worker': {
      const sub = opts._[1] || 'help';
      const daily = createDailyWorker({ home: opts.home });
      if (sub === 'run') print(await daily.execute({ dryRun: false, force: opts.force === true }));
      else if (sub === 'dry-run') print(await daily.execute({ dryRun: true, force: opts.force === true }));
      else if (sub === 'status') print(daily.status());
      else if (sub === 'report') print(daily.report());
      else {
        print({
          usage: 'node worker/cli.mjs worker <run|status|report|dry-run>',
          note: 'dry-run never sends',
        });
      }
      break;
    }
    default:
      print({
        usage: 'node worker/cli.mjs <research|search|discover|jina-health|note|ledger|lead|classify|replies|replies-status|select|prepare|approve-outreach|send|outreach-status|run|status|report|dry-run|worker>',
        dry_run: 'discover is dry-run unless --apply; worker dry-run never sends',
        env: ['JINA_API_KEY', 'GMAIL_ADAPTER_URL', 'NOTIFY_WEBHOOK_URL', 'EMAIL_ADAPTER_URL', 'TEAMS_ACCESS_TOKEN', 'LINKEDIN_ACCESS_TOKEN', 'WORKER_TZ', 'WORKER_HOUR', 'WORKER_MINUTE'],
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
