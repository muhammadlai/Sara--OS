# Pending GitHub Actions workflow

`validate.yml` is the project's CI workflow (runs `npm test` on every push/PR
to `main`). It is **ready but not yet active**.

When activated it passes repository secret `JINA_API_KEY` into the job env.
GitHub Secrets are **not** available to a local `node worker/cli.mjs` process.
A local unset key is `NOT_CONFIGURED`, not CONNECTED.

## Why it is here and not in `.github/workflows/`

The push token used for the 2026-08-17 migration is a **GitHub App** token.
GitHub refused to create the workflow file with:

```
refusing to allow a GitHub App to create or update workflow
`.github/workflows/validate.yml` without `workflows` permission
```

## Exact permission required to activate

Grant the GitHub App (or token) used for pushing one of:

- **GitHub App**: Repository permissions → **Workflows → Read and write**
- **OAuth/PAT token**: the **`workflow`** scope

(per-repository: Settings → GitHub Apps / Integrations, or regenerate the
token with the `workflow` scope)

## How to activate (after the permission is granted)

```bash
mkdir -p .github/workflows
mv scripts/pending/validate.yml .github/workflows/validate.yml

# also restore the validator requirement — edit scripts/validate-template.sh
# and move ".github/workflows/validate.yml" back into the require_file list
# (currently commented there as PENDING-WORKFLOW)

git add .github/workflows/validate.yml scripts/validate-template.sh scripts/pending
git commit -m "ci: activate validate.yml (workflows permission granted)"
git push
```

Do not work around this by renaming jobs or smuggling the file through build
steps — that would bypass GitHub security. Wait for the permission.
