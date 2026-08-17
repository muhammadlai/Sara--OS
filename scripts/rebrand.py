#!/usr/bin/env python3
# One-off migration transform (kept in repo history for provenance).
# Rebrands user-facing identity: B2B SDR Agent Template -> AITZAZ AI 2070 (owner: Aitzaz)
import re, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OLD_REPO = "iPythoning/b2b-sdr-agent-template"
NEW_REPO = "muhammadlai/Sara--OS"

def rw(path, fn):
    p = ROOT / path
    t = p.read_text(encoding="utf-8")
    t2 = fn(t, path)
    if t2 != t:
        p.write_text(t2, encoding="utf-8")
        print(f"UPDATED {path}")
    else:
        print(f"  same  {path}")

def drop_bmc(t):
    # remove buymeacoffee marker blocks (3 lines each)
    t = re.sub(r"<!-- bmc:\w+ -->\n(?:<p align=\"center\">.*?</p>\n)?<!-- /bmc:\w+ -->\n", "", t, flags=re.S)
    return t

def common(t, path):
    t = t.replace(OLD_REPO, NEW_REPO)
    t = t.replace("https://github.com/iPythoning/b2b-sdr-hermes-skill", "https://github.com/" + NEW_REPO)
    t = drop_bmc(t)
    return t

# ---------- README.md: deep, hand-shaped edits ----------
def readme_main(t, path):
    t = common(t, path)
    # Title
    t = t.replace("# B2B SDR Agent Template\n",
                  "# AITZAZ AI 2070\n\n**A futuristic AI Operating System for B2B sales — owner: Aitzaz.**\n\n", 1)
    # Product Hunt embed + announcement line + <br clear>
    t = re.sub(r'<a href="https://www\.producthunt\.com.*?</a>\n', "", t, flags=re.S)
    t = re.sub(r"\*\*We're live on Product Hunt!\*\*.*\n", "", t)
    t = t.replace("<br clear=\"left\" />\n\n", "")
    # WhatsApp add-on: drop external release-notes link, neutralize PulseAgent wording
    t = t.replace("pulls .txt files straight from PulseAgent.",
                  "pulls .txt files straight from the connected account.")
    t = re.sub(r" \[Release notes →\]\(https://github\.com/[^)]+\)\n", "\n", t)
    # Quick Start Option A -> one-line installer from THIS repo; drop ClawHub marketplace promo
    t = re.sub(
        r"### Option A: OpenClaw Users \(1 Command\)\n\n.*?(?=### Option A2)",
        "### Option A: One-Line Installer\n\n```bash\ncurl -fsSL https://raw.githubusercontent.com/" + NEW_REPO + "/main/install.sh | bash\n```\n\nThe installer checks prerequisites, installs [OpenClaw](https://openclaw.dev), clones this repository, and walks you through configuration.\n\n> Publishing AITZAZ AI 2070 as an installable ClawHub skill is planned for a future phase.\n\n",
        t, flags=re.S)
    # Drop Option A2 Hermes block (upstream cross-promo) up to Option B
    t = re.sub(r"### Option A2: Hermes Agent Users.*?(?=### Option B)", "", t, flags=re.S)
    # Managed PulseAgent section -> AITZAZ dashboard section
    t = re.sub(
        r"Don't want to self-host\? \*\*\[PulseAgent\].*?(?=\n## |\n### )",
        "**Dashboard:** AITZAZ AI 2070 ships with a futuristic AI-OS control dashboard. "
        "Generate its live data and open it:\n\n```bash\nnpm run dashboard\ncat dashboard/index.html  # serve or open in a browser\n```\n\n",
        t, flags=re.S)
    # Community links: fix X / Product Hunt / blog lines
    t = re.sub(r"- \[X / Twitter\]\(https://x\.com/[^)]*\).*\n", "", t)
    t = re.sub(r"- \[Product Hunt\]\(https://www\.producthunt\.com/[^)]*\).*\n", "", t)
    t = re.sub(r"- \[PulseAgent Blog\]\([^)]*\).*\n", "", t)
    # Footer
    t = t.replace('Built with ❤️ by <a href="https://pulseagent.io/app">PulseAgent</a>',
                  'AITZAZ AI 2070 — owner: Aitzaz<br/>\n  Built upon the open-source B2B SDR Agent Template (MIT — see LICENSE)')
    return t

# ---------- Translated READMEs: brand, strip promo ----------
def readme_i18n(t, path):
    t = common(t, path)
    # H1 -> prefix original localized title
    t = re.sub(r"^# (.+)$", r"# AITZAZ AI 2070 — \1", t, count=1, flags=re.M)
    # drop promo lines (product hunt / pulseagent promos / bmc leftovers)
    t = re.sub(r"^.*(producthunt\.com|buymeacoffee|ph-files\.imgix\.net).*\n", "", t, flags=re.M)
    # PulseAgent managed blurb paragraphs -> drop sentence-level lines that promote managed hosting
    t = re.sub(r"^.*\[PulseAgent\]\(https://pulseagent\.io[^\n]*\n", "", t, flags=re.M)
    t = re.sub(r"^.*https://x\.com/PulseAgentHQ[^\n]*\n", "", t, flags=re.M)
    t = re.sub(r"^.*pulseagent\.io/(en|zh)/blog[^\n]*\n", "", t, flags=re.M)
    # footer attribution lines
    t = re.sub(r'Built with ❤️ by <a href="https://pulseagent\.io[^"]*">PulseAgent</a>',
               'AITZAZ AI 2070 — owner: Aitzaz<br/>\n  Built upon the open-source B2B SDR Agent Template (MIT — see LICENSE)', t)
    return t

# ---------- SKILL.md ----------
def skill_md(t, path):
    t = common(t, path)
    t = t.replace("name: b2b-sdr-agent\n", "name: aitzaz-ai-2070\n")
    t = t.replace(
        'description: "Open-source B2B AI SDR template.',
        'description: "AITZAZ AI 2070 — B2B AI SDR system.')
    t = t.replace("# B2B SDR Agent — AI Sales Development Representative",
                  "# AITZAZ AI 2070 — AI Sales Development Representative")
    t = t.replace("## Links\n\n- [GitHub](https://github.com/" + NEW_REPO + ")\n- [PulseAgent (Managed)](https://pulseagent.io/app)\n",
                  "## Links\n\n- [GitHub](https://github.com/" + NEW_REPO + ")\n- [OpenClaw](https://openclaw.dev) — runtime platform\n")
    return t

# ---------- workspace identity ----------
def identity(t, path):
    t = t.replace("{{company_name}}", "AITZAZ AI 2070")
    t = t.replace("{{brand}}", "AITZAZ AI 2070")
    return t

def user_md(t, path):
    t = identity(t, path)
    t = t.replace("{{owner_name}}", "Aitzaz")
    return t

# ---------- install.sh ----------
def install_sh(t, path):
    t = common(t, path)
    t = t.replace('# B2B SDR Agent — One-Line Installer', '# AITZAZ AI 2070 — One-Line Installer')
    t = t.replace('INSTALL_DIR="${SDR_INSTALL_DIR:-$HOME/b2b-sdr-agent}"',
                  'INSTALL_DIR="${SDR_INSTALL_DIR:-$HOME/aitzaz-ai-2070}"')
    # neutralize analytics + managed URLs
    t = re.sub(r'PULSEAGENT_URL="[^"]*"\nSIGNUP_URL="[^"]*"\nPRICING_URL="[^"]*"\n', "", t)
    t = re.sub(r"track_event\(\) \{\n(?:.*\n)*?\}\n\nshow_comparison", "track_event() { :; }\n\nshow_comparison", t)
    # banner ascii art
    t = re.sub(r'  echo "  ____.*?echo " \|_|.*?"\n', """  echo "     _   ___ _____ _      _    _____  \"
  echo "    /_\\ |_ _|_   _| |    /_\\  /__  / \"
  echo "   / _ \\ | |  | | | |   / _ \\   / /  \"
  echo "  /_/ \\_\\___| |_| |_/  /_/ \\_\\ /___| \"
""", t, flags=re.S)
    t = t.replace('B2B SDR Agent Template — AI Sales Rep for Export Business',
                  'AITZAZ AI 2070 — AI Sales Operating System for Export Business')
    # comparison table: drop managed column
    t = re.sub(r"show_comparison\(\) \{\n(?:.*\n)*?\}\n", """show_comparison() {
  echo ""
  echo -e "${BOLD}  AITZAZ AI 2070 — self-hosted (free)${NC}"
  echo -e "  You manage the server · full data control · CLI dashboard"
  echo ""
}
""", t)
    # managed_path -> informational stub (no external SaaS)
    t = re.sub(r"managed_path\(\) \{\n(?:.*\n)*?\n\}\n", """managed_path() {
  echo -e "${YELLOW}Managed hosting is not offered by this repository.${NC}"
  echo "Run the self-hosted path instead:"
  echo "  curl -fsSL https://raw.githubusercontent.com/""" + NEW_REPO + """/main/install.sh | bash -s -- --self-hosted"
  exit 0
}
""", t)
    # deploy messages
    t = t.replace("Cloning B2B SDR Agent Template...", "Cloning AITZAZ AI 2070...")
    # no-server / no-apikey redirects -> guidance, no PulseAgent
    t = re.sub(r'  echo -e "\$\{YELLOW\}No server\? No problem\.\$\{NC\} PulseAgent manages everything for you:"\n'
               r'  echo -e "  \$\{CYAN\}\$\{SIGNUP_URL\}\$\{NC\}"\n'
               r'  echo ""\n'
               r'  track_event "no_server_redirect"\n',
               '  echo -e "${YELLOW}No server configured.${NC} Get any Ubuntu 22.04+ VPS, then re-run this installer."\n'
               '  echo "See deploy/UPGRADE.md and README.md for requirements."\n'
               '  echo ""\n', t)
    t = re.sub(r'  echo -e "\$\{YELLOW\}No API key\?\$\{NC\} PulseAgent includes AI credits — no key needed:"\n'
               r'  echo -e "  \$\{CYAN\}\$\{SIGNUP_URL\}\$\{NC\}"\n'
               r'  echo ""\n'
               r'  track_event "no_apikey_redirect"\n',
               '  echo -e "${YELLOW}No API key provided.${NC} Get a key from your model provider, then re-run this installer."\n'
               '  echo ""\n', t)
    # missing-deps footer
    t = re.sub(r'  echo -e "  \$\{CYAN\}\$\{SIGNUP_URL\}\$\{NC\}"\n'
               r'  echo ""\n'
               r'  echo -e "\$\{DIM\}Managed PulseAgent requires zero local dependencies — just a browser\.\$\{NC\}"\n',
               '  echo ""\n', t)
    # success CTA -> repo docs
    t = re.sub(r'  echo -e "\$\{BOLD\}━━━ Unlock More with PulseAgent Pro ━━━\$\{NC\}"(?:.*\n)*?  echo -e "\$\{DIM\}  Tip: Run \'openclaw\' to manage your agent\. Edit workspace/ files to customize\.\$\{NC\}"',
               """  echo -e "${BOLD}━━━ Next steps ━━━${NC}"
  echo ""
  echo -e "  ▸ Edit workspace/*.md to customize identity, ICP, and pipeline"
  echo -e "  ▸ Add your products to product-kb/catalog.json"
  echo -e "  ▸ Run deploy/doctor.sh for post-deploy health checks"
  echo -e "  ▸ Docs: https://github.com/""" + NEW_REPO + """"
  echo ""
  echo -e "${DIM}  Tip: Run 'openclaw' to manage your agent. Edit workspace/ files to customize.${NC}\"""", t)
    # menu option 2
    t = t.replace('echo -e "  ${BOLD}[2]${NC} ☁️  Managed on PulseAgent — 2 min setup, free trial then paid"',
                  'echo -e "  ${BOLD}[2]${NC} ☁️  Managed — not available in this repository"')
    return t

# ---------- misc small docs ----------
def anti_amnesia(t, path):
    return t.replace("# PulseAgent x OpenClaw B2B SDR Digital Worker",
                     "# AITZAZ AI 2070 x OpenClaw SDR Digital Worker")

def contributing(t, path):
    t = common(t, path)
    return t.replace("# Contributing to B2B SDR Agent Template", "# Contributing to AITZAZ AI 2070")

def security_md(t, path):
    t = t.replace("**Email**: security@pulseagent.io\n\n**Do NOT** open a public GitHub issue for security vulnerabilities.",
                  "**Report**: Open a private [GitHub Security Advisory](https://github.com/" + NEW_REPO + "/security/advisories/new) on this repository (owner: Aitzaz).\n\n**Do NOT** open a public GitHub issue for security vulnerabilities.")
    return t

def upgrade_md(t, path):
    t = common(t, path)
    return t.replace("cd b2b-sdr-agent-template/deploy", "cd Sara--OS/deploy")

def daily_sync(t, path):
    t = common(t, path)
    return t.replace("1. Adapt changes to b2b-sdr-agent-template workspace/deploy/skills",
                     "1. Adapt changes to AITZAZ AI 2070 (Sara--OS) workspace/deploy/skills")

def social_preview(t, path):
    t = common(t, path)
    t = t.replace("<h1>B2B SDR<br>Agent Template</h1>", "<h1>AITZAZ AI<br>2 0 7 0</h1>")
    t = t.replace("AI-powered sales automation for B2B export. Full pipeline from lead capture to deal closing.",
                  "Futuristic AI Operating System for B2B sales. Full pipeline from lead capture to deal closing.")
    t = re.sub(r'<div class="footer-text">.*?</div>', '<div class="footer-text">Owner: Aitzaz</div>', t)
    m = re.search(r"https://github\.com/[^\"'< ]*", t)
    return t

targets = {
    "README.md": readme_main,
    "README.zh-CN.md": readme_i18n, "README.es.md": readme_i18n, "README.fr.md": readme_i18n,
    "README.ja.md": readme_i18n, "README.pt-BR.md": readme_i18n, "README.ru.md": readme_i18n,
    "README.ar.md": readme_i18n,
    "SKILL.md": skill_md,
    "workspace/IDENTITY.md": identity,
    "workspace/AGENTS.md": identity,
    "workspace/USER.md": user_md,
    "install.sh": install_sh,
    "ANTI-AMNESIA.md": anti_amnesia,
    "CONTRIBUTING.md": contributing,
    "SECURITY.md": security_md,
    "deploy/UPGRADE.md": upgrade_md,
    "scripts/daily-sync.sh": daily_sync,
    "social-preview.html": social_preview,
    "deploy/config.sh.example": lambda t, p: t.replace("#  B2B SDR Agent — Configuration", "#  AITZAZ AI 2070 — Configuration"),
    "deploy/deploy.sh": lambda t, p: t.replace("#  B2B SDR Agent — One-Click Deploy", "#  AITZAZ AI 2070 — One-Click Deploy").replace('echo "  B2B SDR Agent Deploy — $CLIENT_NAME"', 'echo "  AITZAZ AI 2070 Deploy — $CLIENT_NAME"'),
    "deploy/doctor.sh": lambda t, p: t.replace("# B2B SDR Agent — Post-deploy health checks", "# AITZAZ AI 2070 — Post-deploy health checks").replace('echo "B2B SDR Agent Doctor"', 'echo "AITZAZ AI 2070 Doctor"'),
    "deploy/skill-profiles.sh": lambda t, p: t.replace("#  B2B SDR Agent — Skill Profiles", "#  AITZAZ AI 2070 — Skill Profiles"),
    "deploy/generate-config.sh": lambda t, p: t.replace("B2B SDR Agent", "AITZAZ AI 2070"),
    "deploy/ip-isolate.sh": lambda t, p: t.replace("B2B SDR Agent", "AITZAZ AI 2070"),
}

import json
# product-kb company
cat = ROOT / "product-kb/catalog.json"
data = json.loads(cat.read_text(encoding="utf-8"))
data["company"] = "AITZAZ AI 2070"
data["last_updated"] = "2026-08-17"
cat.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print("UPDATED product-kb/catalog.json")

for path, fn in targets.items():
    rw(path, fn)

# FUNDING.yml -> no third-party funding links
(ROOT / ".github/FUNDING.yml").write_text(
    "# AITZAZ AI 2070 — no external funding links configured.\n"
    "# Add your own here, e.g.:\n"
    "# github: [your-username]\n"
    "# custom: [\"https://your-link\"]\n", encoding="utf-8")
print("UPDATED .github/FUNDING.yml")
print("DONE")
