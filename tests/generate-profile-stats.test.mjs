import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  CONTRIBUTIONS_QUERY,
  CONTRIBUTION_REPOSITORY_CAP,
  LANGUAGES_QUERY,
  REPOSITORIES_QUERY,
  buildOutputs,
  buildStats,
  collectStats,
  createGitHubClient,
  makePeriod,
  renderStatsSvg,
  writeGeneratedOutputs,
} from '../scripts/generate-profile-stats.mjs';

const NOW = new Date('2026-09-09T12:00:00.000Z');

test('API failures and incomplete payloads fail instead of publishing zero statistics', async () => {
  for (const fixture of [
    {ok: false, status: 403, payload: {message: 'Forbidden'}},
    {ok: true, status: 200, payload: {errors: [{message: 'Query failed'}], data: {}}},
    {ok: true, status: 200, payload: {}},
  ]) {
    const client = createGitHubClient({
      token: 'fixture-token',
      fetchImpl: async () => ({...fixture, text: async () => JSON.stringify(fixture.payload)}),
    });
    await assert.rejects(() => client.query('query { viewer { login } }', {}));
  }
  const client = {query: async (query) => query === REPOSITORIES_QUERY
    ? {user: {repositories: {nodes: [], pageInfo: {hasNextPage: false}}}}
    : {user: {contributionsCollection: {}}}};
  await assert.rejects(() => collectStats({client, now: NOW}), /no contribution list/);
});

function repository({
  nameWithOwner,
  isPrivate = false,
  isFork = false,
  isArchived = false,
  stargazerCount = 0,
  languageEdges = [],
  languagePageInfo = {hasNextPage: false, endCursor: null},
} = {}) {
  return {
    nameWithOwner,
    isPrivate,
    isFork,
    isArchived,
    stargazerCount,
    languages: {edges: languageEdges, pageInfo: languagePageInfo},
  };
}

function languageEdge(name, size, color = '#2563eb') {
  return {size, node: {name, color}};
}

function contributionGroup({
  isPrivate = false,
  isFork = false,
  isArchived = false,
  commitCount = 0,
  totalCount = 1,
  hasNextPage = false,
  nameWithOwner,
} = {}) {
  return {
    repository: {isPrivate, isFork, isArchived, ...(nameWithOwner ? {nameWithOwner} : {})},
    contributions: {
      nodes: [{commitCount, isRestricted: false}],
      totalCount,
      pageInfo: {hasNextPage, endCursor: hasNextPage ? 'day-cursor' : null},
    },
  };
}

function fixtureClient({repositoryPages, languagePages = {}, contributions = []}) {
  const calls = [];
  return {
    calls,
    async query(query, variables) {
      calls.push({query, variables});
      if (query === REPOSITORIES_QUERY) {
        const index = variables.after ? 1 : 0;
        return {
          user: {
            repositories: repositoryPages[index] || {
              nodes: [],
              pageInfo: {hasNextPage: false, endCursor: null},
            },
          },
        };
      }
      if (query === LANGUAGES_QUERY) {
        const key = `${variables.owner}/${variables.name}`;
        const page = languagePages[key];
        assert.ok(page, `unexpected language pagination request for ${key}`);
        return {repository: {languages: page}};
      }
      if (query === CONTRIBUTIONS_QUERY) {
        return {user: {contributionsCollection: {commitContributionsByRepository: contributions}}};
      }
      throw new Error('unexpected query');
    },
  };
}

test('repository pagination and strict public scope exclude profile, private, fork, and archived data', async () => {
  assert.match(REPOSITORIES_QUERY, /ownerAffiliations:\s*OWNER/);
  assert.match(REPOSITORIES_QUERY, /privacy:\s*PUBLIC/);
  assert.match(REPOSITORIES_QUERY, /isFork:\s*false/);
  assert.match(REPOSITORIES_QUERY, /isArchived:\s*false/);
  assert.doesNotMatch(CONTRIBUTIONS_QUERY, /nameWithOwner|resourcePath|url|owner\s*\{/);
  const client = fixtureClient({
    repositoryPages: [
      {
        nodes: [
          repository({nameWithOwner: 'NNFall/NNFall', stargazerCount: 999, languageEdges: [languageEdge('Secret', 9999)]}),
          repository({nameWithOwner: 'NNFall/public-one', stargazerCount: 3, languageEdges: [languageEdge('Python', 100)]}),
          repository({nameWithOwner: 'NNFall/private-secret', isPrivate: true, stargazerCount: 1000, languageEdges: [languageEdge('PrivateLang', 5000)]}),
          repository({nameWithOwner: 'NNFall/forked', isFork: true, languageEdges: [languageEdge('ForkLang', 5000)]}),
          repository({nameWithOwner: 'NNFall/archived', isArchived: true, languageEdges: [languageEdge('OldLang', 5000)]}),
        ],
        pageInfo: {hasNextPage: true, endCursor: 'repo-cursor'},
      },
      {
        nodes: [repository({nameWithOwner: 'NNFall/public-two', stargazerCount: 4, languageEdges: [languageEdge('TypeScript', 50)]})],
        pageInfo: {hasNextPage: false, endCursor: null},
      },
    ],
    contributions: [
      contributionGroup({commitCount: 3}),
      contributionGroup({isPrivate: true, commitCount: 99, nameWithOwner: 'NNFall/private-secret'}),
      contributionGroup({isFork: true, commitCount: 98}),
      contributionGroup({isArchived: true, commitCount: 97}),
    ],
  });

  const stats = await collectStats({client, now: NOW});
  const serialized = JSON.stringify(stats);
  assert.equal(stats.publicRepoCount, 2);
  assert.equal(stats.stars, 7);
  assert.deepEqual(stats.languages.map(({name, bytes}) => ({name, bytes})), [
    {name: 'Python', bytes: 100},
    {name: 'TypeScript', bytes: 50},
  ]);
  assert.equal(stats.publicCommitContributions.count, 3);
  assert.equal(stats.publicCommitContributions.status, 'complete');
  assert.doesNotMatch(serialized, /private-secret|PrivateLang|ForkLang|OldLang/);
  assert.doesNotMatch(serialized, /lineCount|additions|deletions/);
  assert.equal(client.calls.filter(({query}) => query === REPOSITORIES_QUERY).length, 2);
  assert.equal(client.calls[1].variables.after, 'repo-cursor');
});

test('language pagination aggregates GitHub byte sizes, never line counts', async () => {
  const client = fixtureClient({
    repositoryPages: [{
      nodes: [repository({
        nameWithOwner: 'NNFall/byte-repo',
        languageEdges: [languageEdge('Python', 100)],
        languagePageInfo: {hasNextPage: true, endCursor: 'language-cursor'},
      })],
      pageInfo: {hasNextPage: false, endCursor: null},
    }],
    languagePages: {
      'NNFall/byte-repo': {
        edges: [languageEdge('Python', 50), languageEdge('JavaScript', 25)],
        pageInfo: {hasNextPage: false, endCursor: null},
      },
    },
    contributions: [],
  });

  const stats = await collectStats({client, now: NOW});
  assert.deepEqual(stats.languages.map(({name, bytes}) => ({name, bytes})), [
    {name: 'Python', bytes: 150},
    {name: 'JavaScript', bytes: 25},
  ]);
  assert.equal(stats.languages[0].percent, 85.71);
  assert.equal(stats.scope.languageUnit, 'bytes');
  assert.match(client.calls.find(({query}) => query === LANGUAGES_QUERY).variables.after, /language-cursor/);
});

test('contribution repository cap and contribution-day cap are labeled partial', async () => {
  const groups = Array.from({length: CONTRIBUTION_REPOSITORY_CAP}, () => contributionGroup({commitCount: 1}));
  groups[0] = contributionGroup({commitCount: 1, totalCount: 101, hasNextPage: true});
  const client = fixtureClient({
    repositoryPages: [[{nodes: [], pageInfo: {hasNextPage: false, endCursor: null}}]],
    contributions: groups,
  });
  const stats = await collectStats({client, now: NOW});
  assert.equal(stats.publicCommitContributions.count, CONTRIBUTION_REPOSITORY_CAP);
  assert.equal(stats.publicCommitContributions.status, 'partial');
  assert.equal(stats.publicCommitContributions.repositoryListCapped, true);
  assert.equal(stats.publicCommitContributions.contributionDaysCapped, true);
  assert.equal(stats.publicCommitContributions.repositoryCap, 100);
});

test('SVG escapes untrusted language names and keeps compact readable dimensions', () => {
  const period = makePeriod(NOW);
  const stats = buildStats({
    login: 'NNFall',
    profileRepository: 'NNFall/NNFall',
    period,
    repositories: [{
      ...repository({nameWithOwner: 'NNFall/public'}),
      languageEdges: [languageEdge('<script>&"', 10, 'not-a-color')],
    }],
    contributionGroups: [],
  });
  const svg = renderStatsSvg(stats, 'dark');
  assert.match(svg, /width="760" height="230"/);
  assert.match(svg, /&lt;script&gt;&amp;&quot;/);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /Языки по объёму кода/);
  assert.match(svg, /байты GitHub, не строки/);
  assert.match(svg, /fill="#0d1117"/);
  assert.match(svg, /class="legend" fill="#ffffff"/);
});

test('zero-data output has stable paths and no undefined values', async () => {
  const period = makePeriod(NOW);
  const stats = buildStats({
    login: 'NNFall',
    profileRepository: 'NNFall/NNFall',
    period,
    repositories: [],
    contributionGroups: [],
  });
  const outputs = buildOutputs(stats);
  const outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-stats-test-'));
  try {
    await writeGeneratedOutputs(outputDirectory, outputs);
    assert.deepEqual((await fs.readdir(outputDirectory)).sort(), [
      'profile-stats-dark.svg',
      'profile-stats-light.svg',
      'stats.json',
    ]);
    assert.equal(stats.publicRepoCount, 0);
    assert.equal(stats.stars, 0);
    assert.equal(stats.languages.length, 0);
    assert.match(outputs['profile-stats-light.svg'], /Публичные данные о языках не возвращены/);
    assert.match(outputs['profile-stats-dark.svg'], /class="legend" fill="#aab7c9"/);
    assert.doesNotMatch(outputs['profile-stats-light.svg'], /undefined|null/);

    const rewritten = {...outputs, 'profile-stats-light.svg': outputs['profile-stats-light.svg'].replace('2026-09-09', '2026-09-10')};
    await writeGeneratedOutputs(outputDirectory, rewritten);
    assert.deepEqual((await fs.readdir(outputDirectory)).sort(), [
      'profile-stats-dark.svg',
      'profile-stats-light.svg',
      'stats.json',
    ]);
    assert.equal((await fs.readdir(outputDirectory)).some((name) => name.includes('.previous')), false);
  } finally {
    await fs.rm(outputDirectory, {recursive: true, force: true});
  }
});

test('workflow stages all three generated files before checking the cached diff', async () => {
  const workflowPath = fileURLToPath(new URL('../.github/workflows/profile-stats.yml', import.meta.url));
  const workflow = await fs.readFile(workflowPath, 'utf8');
  const addIndex = workflow.indexOf('git add -- assets/generated/profile-stats-light.svg assets/generated/profile-stats-dark.svg assets/generated/stats.json');
  const cachedCheckIndex = workflow.indexOf('git diff --cached --quiet -- assets/generated');
  assert.ok(addIndex >= 0);
  assert.ok(cachedCheckIndex > addIndex);
  assert.match(workflow, /actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(workflow, /secrets\.[A-Z_]+/);
});
