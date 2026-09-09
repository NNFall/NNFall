import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const REPOSITORY_PAGE_SIZE = 100;
export const LANGUAGE_PAGE_SIZE = 100;
export const CONTRIBUTION_REPOSITORY_CAP = 100;
export const CONTRIBUTION_PAGE_SIZE = 100;

export const REPOSITORIES_QUERY = /* GraphQL */ `
  query ProfileStatsRepositories($login: String!, $after: String) {
    user(login: $login) {
      repositories(
        first: 100
        after: $after
        ownerAffiliations: OWNER
        privacy: PUBLIC
        isFork: false
        isArchived: false
      ) {
        nodes {
          nameWithOwner
          isPrivate
          isFork
          isArchived
          stargazerCount
          languages(first: 100) {
            edges {
              size
              node {
                name
                color
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const LANGUAGES_QUERY = /* GraphQL */ `
  query ProfileStatsLanguages($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      languages(first: 100, after: $after) {
        edges {
          size
          node {
            name
            color
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

// Only privacy and repository-shape flags are requested here. In particular,
// this query never asks for names, URLs, IDs, owners, or other private metadata.
export const CONTRIBUTIONS_QUERY = /* GraphQL */ `
  query ProfileStatsContributions(
    $login: String!
    $from: DateTime!
    $to: DateTime!
  ) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        commitContributionsByRepository(maxRepositories: 100) {
          repository {
            isPrivate
            isFork
            isArchived
          }
          contributions(first: 100) {
            nodes {
              commitCount
              isRestricted
            }
            totalCount
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  }
`;

const OUTPUT_FILES = Object.freeze({
  lightSvg: 'profile-stats-light.svg',
  darkSvg: 'profile-stats-dark.svg',
  json: 'stats.json',
});

const FALLBACK_COLORS = [
  '#2563eb',
  '#0f766e',
  '#c2410c',
  '#7c3aed',
  '#be185d',
  '#4d7c0f',
  '#0369a1',
  '#a16207',
];

function assertFiniteNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function normalizeHexColor(color, index = 0) {
  if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
    return color.toLowerCase();
  }
  return FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

function asDateString(date) {
  return date.toISOString().slice(0, 10);
}

export function makePeriod(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('now must be a valid Date');
  }
  const asOf = asDateString(now);
  const end = new Date(`${asOf}T23:59:59.000Z`);
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  start.setUTCHours(0, 0, 0, 0);
  return {
    kind: 'last12months',
    from: start.toISOString(),
    to: end.toISOString(),
    asOf,
  };
}

function splitRepositoryName(nameWithOwner) {
  if (typeof nameWithOwner !== 'string') return null;
  const separator = nameWithOwner.indexOf('/');
  if (separator <= 0 || separator === nameWithOwner.length - 1) return null;
  return {
    owner: nameWithOwner.slice(0, separator),
    name: nameWithOwner.slice(separator + 1),
  };
}

function isEligiblePublicRepository(repository, profileRepository) {
  return Boolean(
    repository &&
      repository.isPrivate === false &&
      repository.isFork === false &&
      repository.isArchived === false &&
      typeof repository.nameWithOwner === 'string' &&
      repository.nameWithOwner.toLowerCase() !== profileRepository.toLowerCase(),
  );
}

function addLanguageBytes(languageBytes, edge) {
  const name = edge?.node?.name;
  if (typeof name !== 'string' || name.length === 0) return;
  const bytes = assertFiniteNonNegativeInteger(edge.size, `language ${name} byte size`);
  const existing = languageBytes.get(name) || {name, color: edge.node.color, bytes: 0};
  existing.bytes += bytes;
  if (!existing.color && edge.node.color) existing.color = edge.node.color;
  languageBytes.set(name, existing);
}

function normalizeLanguageList(languageBytes) {
  const entries = [...languageBytes.values()]
    .sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name))
    .map((entry, index) => ({
      name: entry.name,
      bytes: entry.bytes,
      color: normalizeHexColor(entry.color, index),
    }));
  const totalBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  return entries.map((entry) => ({
    ...entry,
    percent: totalBytes === 0 ? 0 : Number(((entry.bytes / totalBytes) * 100).toFixed(2)),
  }));
}

function publicContributionGroup(group) {
  const repository = group?.repository;
  return Boolean(
    repository &&
      repository.isPrivate === false &&
      repository.isFork === false &&
      repository.isArchived === false,
  );
}

function collectContributionSummary(groups) {
  let count = 0;
  let hasNestedCap = false;
  let includedGroups = 0;

  for (const group of Array.isArray(groups) ? groups : []) {
    if (!publicContributionGroup(group)) continue;
    includedGroups += 1;
    const contributions = group.contributions || {};
    if (contributions.pageInfo?.hasNextPage || contributions.totalCount > CONTRIBUTION_PAGE_SIZE) {
      hasNestedCap = true;
    }
    for (const node of Array.isArray(contributions.nodes) ? contributions.nodes : []) {
      if (node?.isRestricted === true) continue;
      count += assertFiniteNonNegativeInteger(node?.commitCount, 'commit contribution count');
    }
  }

  const rawGroupCount = Array.isArray(groups) ? groups.length : 0;
  const capped = rawGroupCount >= CONTRIBUTION_REPOSITORY_CAP;
  return {
    count,
    status: capped || hasNestedCap ? 'partial' : 'complete',
    repositoryCap: CONTRIBUTION_REPOSITORY_CAP,
    repositoriesIncluded: includedGroups,
    repositoryListCapped: capped,
    contributionDaysCapped: hasNestedCap,
  };
}

export function buildStats({
  login,
  profileRepository,
  period,
  repositories = [],
  contributionGroups = [],
}) {
  const languageBytes = new Map();
  let stars = 0;
  for (const repository of repositories) {
    if (!isEligiblePublicRepository(repository, profileRepository)) continue;
    stars += assertFiniteNonNegativeInteger(repository.stargazerCount || 0, 'star count');
    for (const edge of repository.languageEdges || []) addLanguageBytes(languageBytes, edge);
  }

  const languages = normalizeLanguageList(languageBytes);
  const contributionSummary = collectContributionSummary(contributionGroups);
  const stats = {
    schemaVersion: 1,
    generatedAt: period.asOf,
    period: {
      kind: period.kind,
      from: period.from.slice(0, 10),
      to: period.to.slice(0, 10),
    },
    scope: {
      account: login,
      repositories: 'public owned non-fork non-archived repositories',
      profileRepositoryExcluded: true,
      privateRepositoriesExcluded: true,
      languageUnit: 'bytes',
      languageMeaning: 'GitHub-detected language bytes; not lines and not authorship',
      contributions: 'public non-fork non-archived commit contributions',
      privateContributionMetadataRequested: false,
    },
    publicRepoCount: repositories.filter((repository) =>
      isEligiblePublicRepository(repository, profileRepository),
    ).length,
    stars,
    languages,
    publicCommitContributions: contributionSummary,
  };

  return stats;
}

function responseData(payload, operationName) {
  if (payload?.errors?.length) {
    const messages = payload.errors
      .map((error) => (typeof error?.message === 'string' ? error.message : 'unknown error'))
      .join('; ');
    throw new Error(`${operationName} GraphQL error: ${messages}`);
  }
  if (!payload || typeof payload !== 'object' || !payload.data) {
    throw new Error(`${operationName} returned no data`);
  }
  return payload.data;
}

export function createGitHubClient({token, fetchImpl = globalThis.fetch, endpoint = 'https://api.github.com/graphql'} = {}) {
  if (typeof token !== 'string' || token.length === 0) throw new Error('GITHUB_TOKEN is required');
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable');

  return {
    async query(query, variables, operationName = 'GitHub API request') {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'NNFall-profile-stats',
        },
        body: JSON.stringify({query, variables}),
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
      if (!response.ok) throw new Error(`${operationName} failed with HTTP ${response.status}`);
      return responseData(payload, operationName);
    },
  };
}

async function collectLanguageEdges(client, repository) {
  const allEdges = [...(repository.languages?.edges || [])];
  let pageInfo = repository.languages?.pageInfo;
  const identity = splitRepositoryName(repository.nameWithOwner);
  while (pageInfo?.hasNextPage) {
    if (!identity || !pageInfo.endCursor) throw new Error(`Cannot paginate languages for ${repository.nameWithOwner}`);
    const data = await client.query(
      LANGUAGES_QUERY,
      {owner: identity.owner, name: identity.name, after: pageInfo.endCursor},
      'Language pagination',
    );
    const languages = data.repository?.languages;
    if (!languages) throw new Error(`Language pagination returned no repository for ${repository.nameWithOwner}`);
    allEdges.push(...(languages.edges || []));
    pageInfo = languages.pageInfo;
  }
  return allEdges;
}

async function collectRepositories(client, login, profileRepository) {
  const repositories = [];
  let after = null;
  do {
    const data = await client.query(
      REPOSITORIES_QUERY,
      {login, after},
      'Repository collection',
    );
    const connection = data.user?.repositories;
    if (!connection) throw new Error(`Repository collection returned no user for ${login}`);
    for (const repository of connection.nodes || []) {
      if (!isEligiblePublicRepository(repository, profileRepository)) continue;
      repositories.push({
        ...repository,
        languageEdges: await collectLanguageEdges(client, repository),
      });
    }
    if (!connection.pageInfo?.hasNextPage) break;
    if (!connection.pageInfo.endCursor) throw new Error('Repository pagination returned no cursor');
    after = connection.pageInfo.endCursor;
  } while (true);
  return repositories;
}

async function collectContributions(client, login, period) {
  const data = await client.query(
    CONTRIBUTIONS_QUERY,
    {login, from: period.from, to: period.to},
    'Contribution collection',
  );
  const collection = data.user?.contributionsCollection;
  if (!collection) throw new Error(`Contribution collection returned no user for ${login}`);
  if (!Array.isArray(collection.commitContributionsByRepository)) {
    throw new Error('Contribution collection returned no contribution list');
  }
  return collection.commitContributionsByRepository;
}

export async function collectStats({
  client,
  login = 'NNFall',
  profileRepository = `${login}/NNFall`,
  now = new Date(),
}) {
  if (!client || typeof client.query !== 'function') throw new Error('client.query is required');
  const period = makePeriod(now);
  const repositories = await collectRepositories(client, login, profileRepository);
  const contributionGroups = await collectContributions(client, login, period);
  return buildStats({login, profileRepository, period, repositories, contributionGroups});
}

function formatCount(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function renderStatValue(value, label, fill) {
  return [
    `<text x="20" y="${value.y}" class="stat-value" fill="${fill}">${escapeXml(value.text)}</text>`,
    `<text x="20" y="${label.y}" class="stat-label" fill="${fill}">${escapeXml(label.text)}</text>`,
  ].join('');
}

export function renderStatsSvg(stats, theme = 'light') {
  const dark = theme === 'dark';
  const background = dark ? '#0d1117' : '#ffffff';
  const foreground = dark ? '#ffffff' : '#0d1117';
  const muted = dark ? '#aab7c9' : '#526176';
  const border = dark ? '#334155' : '#d7dee8';
  const stripBackground = dark ? '#263244' : '#e8edf3';
  const languages = Array.isArray(stats.languages) ? stats.languages : [];
  const totalBytes = languages.reduce((total, language) => total + (language.bytes || 0), 0);
  const topLanguages = languages.slice(0, 6);
  const otherBytes = languages.slice(6).reduce((total, language) => total + (language.bytes || 0), 0);
  if (otherBytes > 0) topLanguages.push({name: 'Other', bytes: otherBytes, color: '#94a3b8'});

  const segments = [];
  let x = 20;
  const stripWidth = 720;
  for (const [index, language] of topLanguages.entries()) {
    const width = totalBytes === 0 ? 0 : (language.bytes / totalBytes) * stripWidth;
    if (width <= 0) continue;
    segments.push(
      `<rect x="${x.toFixed(2)}" y="126" width="${width.toFixed(2)}" height="18" fill="${normalizeHexColor(language.color, index)}"/>`,
    );
    x += width;
  }

  const legend = topLanguages.map((language, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const legendX = 20 + column * 240;
    const legendY = 174 + row * 24;
    const percent = totalBytes === 0 ? 0 : (language.bytes / totalBytes) * 100;
    return [
      `<rect x="${legendX}" y="${legendY - 11}" width="10" height="10" rx="2" fill="${normalizeHexColor(language.color, index)}"/>`,
      `<text x="${legendX + 18}" y="${legendY}" class="legend" fill="${foreground}">${escapeXml(language.name)} ${percent.toFixed(1)}%</text>`,
    ].join('');
  }).join('');

  const contribution = stats.publicCommitContributions;
  const contributionValue = contribution?.status === 'omitted'
    ? 'n/a'
    : formatCount(contribution?.count || 0);
  const languageFooter = languages.length === 0
    ? `<text x="20" y="172" class="legend" fill="${muted}">Публичные данные о языках не возвращены</text>`
    : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="230" viewBox="0 0 760 230" role="img" aria-labelledby="title desc">`,
    `<title id="title">NNFall: публичная активность на GitHub</title>`,
    `<desc id="desc">Публичные проекты, коммиты за 12 месяцев и языки по объёму кода в байтах GitHub.</desc>`,
    `<style>text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}.title{font-size:18px;font-weight:650}.meta,.stat-label{font-size:14px}.stat-value{font-size:25px;font-weight:700}.legend{font-size:14px}</style>`,
    `<rect width="760" height="230" fill="${background}"/>`,
    `<rect x="0.5" y="0.5" width="759" height="229" rx="8" fill="none" stroke="${border}"/>`,
    `<text x="20" y="29" class="title" fill="${foreground}">NNFall · публичная активность</text>`,
    `<text x="740" y="29" text-anchor="end" class="meta" fill="${muted}">${escapeXml(stats.generatedAt || '')}</text>`,
    `<line x1="380" y1="48" x2="380" y2="96" stroke="${border}"/>`,
    renderStatValue({text: formatCount(stats.publicRepoCount || 0), y: 73}, {text: 'Публичные проекты', y: 93}, foreground),
    `<text x="400" y="73" class="stat-value" fill="${foreground}">${escapeXml(contributionValue)}</text>`,
    `<text x="400" y="93" class="stat-label" fill="${muted}">Коммиты за 12 месяцев${contribution?.status === 'partial' ? ' · частичный охват' : ''}</text>`,
    `<text x="20" y="116" class="meta" fill="${muted}">Языки по объёму кода · байты GitHub, не строки</text>`,
    `<rect x="20" y="126" width="720" height="18" rx="4" fill="${stripBackground}"/>`,
    segments.join(''),
    languageFooter,
    legend,
    `<text x="740" y="220" text-anchor="end" class="meta" fill="${muted}">Данные: GitHub GraphQL API</text>`,
    `</svg>`,
  ].join('');
}

export function serializeStats(stats) {
  return `${JSON.stringify(stats, null, 2)}\n`;
}

function validateOutputName(name) {
  if (typeof name !== 'string' || name.length === 0 || path.basename(name) !== name || name.includes('..')) {
    throw new Error(`Invalid generated output name: ${name}`);
  }
}

export async function writeGeneratedOutputs(outputDirectory, outputs) {
  await fs.mkdir(outputDirectory, {recursive: true});
  const temporaryDirectory = await fs.mkdtemp(path.join(outputDirectory, '.profile-stats-'));
  const moved = [];
  let installationComplete = false;
  let rollbackFailed = false;
  try {
    for (const [name, content] of Object.entries(outputs)) {
      validateOutputName(name);
      await fs.writeFile(path.join(temporaryDirectory, name), content, 'utf8');
    }
    for (const name of Object.keys(outputs)) {
      const target = path.join(outputDirectory, name);
      const backup = path.join(temporaryDirectory, `${name}.previous`);
      const record = {target, backup, installed: false};
      moved.push(record);
      try {
        await fs.rename(target, backup);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await fs.rename(path.join(temporaryDirectory, name), target);
      record.installed = true;
    }
    installationComplete = true;
  } catch (error) {
    for (const {target, backup, installed} of [...moved].reverse()) {
      try {
        if (installed) await fs.rm(target, {force: true});
        await fs.rename(backup, target);
      } catch (restoreError) {
        if (restoreError.code !== 'ENOENT') rollbackFailed = true;
      }
    }
    if (rollbackFailed) {
      throw new Error(`Output replacement failed; recovery copies retained in ${temporaryDirectory}`, {cause: error});
    }
    throw error;
  } finally {
    if (installationComplete) {
      for (const {backup} of moved) {
        try {
          await fs.rm(backup, {force: true});
        } catch {
          // Cleanup must not roll back outputs that were installed successfully.
        }
      }
    }
    if (!rollbackFailed) {
      try {
        await fs.rm(temporaryDirectory, {recursive: true, force: true});
      } catch {
        // Keep any temporary files when cleanup is unavailable.
      }
    }
  }
}

export function buildOutputs(stats) {
  return {
    [OUTPUT_FILES.lightSvg]: renderStatsSvg(stats, 'light'),
    [OUTPUT_FILES.darkSvg]: renderStatsSvg(stats, 'dark'),
    [OUTPUT_FILES.json]: serializeStats(stats),
  };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const login = process.env.GITHUB_LOGIN || 'NNFall';
  const profileRepository = process.env.PROFILE_REPOSITORY || `${login}/NNFall`;
  const outputDirectory = process.env.STATS_OUTPUT_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'generated');
  const client = createGitHubClient({token});
  const stats = await collectStats({client, login, profileRepository});
  await writeGeneratedOutputs(outputDirectory, buildOutputs(stats));
  process.stdout.write(`${JSON.stringify({generatedAt: stats.generatedAt, publicRepoCount: stats.publicRepoCount, publicCommitContributions: stats.publicCommitContributions}, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
