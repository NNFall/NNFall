# Profile Stats Methodology

This package generates the small statistics block intended for the lower part of `NNFall/NNFall` README. It is a read-only public snapshot; it does not change GitHub metadata and it does not publish repository names.

## Scope

The repository inventory is requested through GitHub GraphQL with these server-side filters:

- owner affiliation: `OWNER`;
- visibility: `PUBLIC`;
- `isFork: false`;
- `isArchived: false`.

The generator applies the same checks again to every returned node and excludes `NNFall/NNFall` before counting repositories, stars, or language bytes. Private, forked, archived, and profile-repository data cannot contribute to that inventory.

The contribution query covers the last twelve months. It requests only `isPrivate`, `isFork`, `isArchived`, and per-day `commitCount` from each contribution group. It deliberately does not request repository names, URLs, IDs, owners, file paths, additions, or deletions. Only groups with all three flags set to `false` are aggregated. `stats.json` contains public aggregates and scope fields only; it contains no token and no private repository metadata.

`commitContributionsByRepository` accepts a `maxRepositories` limit rather than a cursor. The generator uses the documented cap of 100. It also checks the nested contribution-day connection. `publicCommitContributions.status` is `partial` when either cap may have truncated the result; otherwise it is `complete`. A partial value is shown with a short `частичный охват` label in the SVG. The repository inventory exclusion is exact; the public contribution aggregate intentionally does not request repository names, so it is not a per-repository ownership report.

An API error or missing contribution list fails the refresh rather than replacing valid statistics with zeros. The language and public-repository figures are not inferred from commit counts.

## Language semantics

`Repository.languages.edges.size` is the number of bytes of code detected by GitHub for a language. The generator paginates the language connection for every eligible public repository and sums these byte sizes by language. The SVG says `байты GitHub, не строки`; it does not present a line count, authorship claim, productivity score, grade, streak, or ranking. Byte volume cannot establish who authored a file and cannot be converted to a rigorous lines-of-code statistic.

Stars are retained as a public aggregate in `stats.json` for auditability, but are intentionally not displayed as a scoreboard in the compact SVG.

## Outputs

The generator writes exactly these files under `assets/generated/`:

- `profile-stats-light.svg` - light README image;
- `profile-stats-dark.svg` - dark README image;
- `stats.json` - sanitized data snapshot.

The SVG viewBox is `760 x 230` with text at 14px or larger except for the larger headline/value styles. The visible figures are public project count, public commits for the last twelve months, and a horizontal language distribution.

## Refresh and failure behavior

`.github/workflows/profile-stats.yml` supports `workflow_dispatch` and a daily schedule. It uses the ephemeral built-in `GITHUB_TOKEN`, with only the `contents: write` job permission needed for the generated files. The token is passed to the Node process as `GITHUB_TOKEN`; no custom PAT, external data service, or `gh` authentication is used in Actions.

The generator collects and renders all outputs before replacing existing files. Each API request has a 30-second timeout. Replacement is staged in the same directory and attempts to roll back completed replacements if a filesystem error occurs; if recovery is blocked by the filesystem, recovery copies are retained. A GitHub API or rendering failure exits non-zero before a commit, preserving the previous generated assets. The workflow checks for changes before committing and only stages the three named generated files.

Commits are created locally in the runner as `github-actions[bot]` with repository-local config. A no-change refresh exits without a commit.

## Official references

- [GitHub GraphQL repository reference](https://docs.github.com/en/graphql/reference/repos) - repository filters, language connection, language edge byte size, and `stargazerCount`.
- [GitHub GraphQL user reference](https://docs.github.com/en/graphql/reference/users) - `contributionsCollection`, `commitContributionsByRepository`, and contribution-day `commitCount`.
- [Profile contributions reference](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference) - contribution visibility and criteria.
- [Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) - `workflow_dispatch`, schedule, and permissions.
- [Use `GITHUB_TOKEN` for authentication](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token) - ephemeral workflow token and least-privilege guidance.
- [Official `actions/checkout` v6.0.2 release](https://github.com/actions/checkout/releases/tag/v6.0.2) - the workflow pins `actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd`.
