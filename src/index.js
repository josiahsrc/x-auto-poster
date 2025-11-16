const core = require('@actions/core');
const { execSync } = require('child_process');

const MODELS_ENDPOINT = 'https://models.github.ai/inference/chat/completions';
const DEFAULT_SYSTEM_PROMPT =
  'You are a social media copywriter who crafts concise, engaging posts for X (formerly Twitter). Stay under 280 characters in a single post and highlight what matters to users.';

function escapeShellArg(value) {
  const text = String(value);
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function runCommand(command, options = {}) {
  core.debug(`Executing: ${command}`);
  return execSync(command, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function resolveCommit(ref) {
  try {
    return runCommand(`git rev-parse ${ref}`).trim();
  } catch (error) {
    throw new Error(`Failed to resolve commit reference "${ref}": ${error.message}`);
  }
}

function listCommitsInRange(fromSha, toSha) {
  try {
    const output = runCommand(`git rev-list --reverse ${fromSha}..${toSha}`).trim();
    if (!output) {
      return [];
    }
    return output.split('\n').filter(Boolean);
  } catch (error) {
    throw new Error(`Failed to list commits between ${fromSha} and ${toSha}: ${error.message}`);
  }
}

function readCommitTitle(sha) {
  return runCommand(`git show -s --format=%s ${sha}`).trim();
}

function readCommitBody(sha) {
  return runCommand(`git show -s --format=%b ${sha}`).trim();
}

function readCommitDiff(sha, diffPaths = []) {
  const pathClause =
    diffPaths && diffPaths.length
      ? ` -- ${diffPaths.map((path) => escapeShellArg(path)).join(' ')}`
      : '';
  return runCommand(`git show ${sha} --format= ${pathClause}`);
}

function truncateContent(content, limit) {
  if (!limit || limit <= 0) {
    return { text: content, truncated: false };
  }

  if (content.length <= limit) {
    return { text: content, truncated: false };
  }

  const sliced = content.slice(0, limit);
  const text = `${sliced}\n\n[Diff truncated to the first ${limit} characters]`;
  return { text, truncated: true };
}

function buildCommitSummary(commit, maxDiffChars, diffPaths = []) {
  const title = readCommitTitle(commit);
  const body = readCommitBody(commit);
  const diff = readCommitDiff(commit, diffPaths);
  const truncatedDiff = truncateContent(diff, maxDiffChars);

  const sections = [`Commit: ${commit}`, `Title: ${title}`];

  if (body) {
    sections.push(`Body:\n${body}`);
  }

  if (truncatedDiff.text.trim()) {
    sections.push(`Diff preview:\n${truncatedDiff.text}`);
  }

  return sections.join('\n\n');
}

function buildPrompt({
  customPrompt,
  fromSha,
  toSha,
  commitSummaries,
  community,
  tone,
  hashtags,
  callToAction,
  extraInstructions,
}) {
  if (customPrompt) {
    return customPrompt;
  }

  const parts = [
    'You are a concise social media writer for X. Compose a single post (no thread) under 280 characters.',
    `Summarize ${commitSummaries.length} commit(s) between ${fromSha} and ${toSha} with a focus on what users will notice.`,
    community ? `This message will share with the "${community}" community.` : 'This message will post to the main timeline.',
  ];

  if (tone) {
    parts.push(`Adopt a ${tone} tone.`);
  }

  if (hashtags && hashtags.length) {
    parts.push(`Incorporate these hashtags: ${hashtags.join(' ')}`);
  }

  if (callToAction) {
    parts.push(`Finish with: ${callToAction}`);
  }

  parts.push('Commit context:');
  parts.push(commitSummaries.join('\n\n---\n\n'));

  if (extraInstructions) {
    parts.push(`Additional instructions: ${extraInstructions}`);
  }

  parts.push('Stay actionable, friendly, and avoid overly technical jargon.');

  return parts.join('\n\n');
}

async function callModel({ token, model, temperature, maxTokens, systemPrompt, prompt }) {
  const response = await fetch(MODELS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Model request failed with status ${response.status}: ${text}`);
  }

  const data = await response.json();
  const choice = data.choices && data.choices[0];
  const content = choice?.message?.content;

  if (!content) {
    throw new Error('Model response did not include any content.');
  }

  return content.trim();
}

async function postToX({ text, bearerToken, communityId }) {
  const endpoint = communityId
    ? `https://api.twitter.com/2/communities/${encodeURIComponent(communityId)}/posts`
    : 'https://api.twitter.com/2/tweets';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });

  const data = await response.json();

  if (!response.ok) {
    const errorMessage =
      data?.errors?.map((error) => error?.message).filter(Boolean).join(', ') ||
      data?.title ||
      response.statusText;
    throw new Error(`X API request failed (${response.status}): ${errorMessage}`);
  }

  return data;
}

async function run() {
  try {
    const startRef = core.getInput('from', { required: true }).trim();
    const endRefInput = core.getInput('to').trim();
    const includeStartCommit = core.getBooleanInput('include_start_commit');
    const maxDiffCharsInput = core.getInput('max_diff_chars') || '2000';
    const maxOutputTokensInput = core.getInput('max_output_tokens') || '400';
    const temperatureInput = core.getInput('temperature') || '0.2';
    const model = core.getInput('model') || 'openai/gpt-4o-mini';
    const systemPromptInput = core.getInput('system_prompt');
    const extraInstructions = core.getInput('extra_instructions');
    const customPrompt = core.getInput('prompt');
    const tone = core.getInput('tone');
    const callToAction = core.getInput('call_to_action');
    const communityInput = core.getInput('community').trim();
    const hashtagsInput = core.getInput('hashtags');
    const diffPathsInput = core.getMultilineInput('paths');

    const diffPaths = diffPathsInput
      .map((value) => value.trim())
      .filter(Boolean);

    const hashtags = (hashtagsInput || '')
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => (value.startsWith('#') ? value : `#${value}`));

    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken) {
      throw new Error('GITHUB_TOKEN environment variable is required to call GitHub Models API.');
    }

    const xBearerToken = process.env.X_BEARER_TOKEN;
    if (!xBearerToken) {
      throw new Error('X_BEARER_TOKEN environment variable is required to post to X.');
    }

    const maxDiffChars = Number.parseInt(maxDiffCharsInput, 10);
    if (Number.isNaN(maxDiffChars) || maxDiffChars < 0) {
      throw new Error(`"max_diff_chars" must be a non-negative integer. Received "${maxDiffCharsInput}".`);
    }

    const maxOutputTokens = Number.parseInt(maxOutputTokensInput, 10);
    if (Number.isNaN(maxOutputTokens) || maxOutputTokens <= 0) {
      throw new Error(`"max_output_tokens" must be a positive integer. Received "${maxOutputTokensInput}".`);
    }

    const temperature = Number.parseFloat(temperatureInput);
    if (Number.isNaN(temperature) || temperature < 0 || temperature > 2) {
      throw new Error(`"temperature" must be a number between 0 and 2. Received "${temperatureInput}".`);
    }

    const endRef = endRefInput || 'HEAD';
    const fromSha = resolveCommit(startRef);
    const toSha = resolveCommit(endRef);

    const commitsInRange = listCommitsInRange(fromSha, toSha);
    const commitOrder = includeStartCommit ? [fromSha, ...commitsInRange] : commitsInRange;

    if (commitOrder.length === 0) {
      core.notice(`No commits found between ${fromSha} and ${toSha}. Skipping X post.`);
      core.setOutput('generated-post', '');
      core.setOutput('post-id', '');
      core.setOutput('post-url', '');
      core.setOutput('community-id', communityInput);
      return;
    }

    const commitSummaries = commitOrder.map((sha, index) => {
      core.info(`Collecting commit ${index + 1}/${commitOrder.length}: ${sha}`);
      return buildCommitSummary(sha, maxDiffChars, diffPaths);
    });

    const prompt = buildPrompt({
      customPrompt,
      fromSha,
      toSha,
      commitSummaries,
      community: communityInput,
      tone,
      hashtags,
      callToAction,
      extraInstructions,
    });

    const systemPrompt = systemPromptInput || DEFAULT_SYSTEM_PROMPT;

    core.info(`Requesting post copy from model "${model}"...`);
    const generatedPost = await callModel({
      token: githubToken,
      model,
      temperature,
      maxTokens: maxOutputTokens,
      systemPrompt,
      prompt,
    });

    core.info('Publishing generated post to X...');
    const xResponse = await postToX({
      text: generatedPost,
      bearerToken: xBearerToken,
      communityId: communityInput || undefined,
    });

    const postId = xResponse?.data?.id || '';
    const postUrl = postId ? `https://x.com/i/web/status/${postId}` : '';

    core.setOutput('generated-post', generatedPost);
    core.setOutput('post-id', postId);
    core.setOutput('post-url', postUrl);
    core.setOutput('community-id', communityInput);

    await core.summary
      .addRaw('## AI generated X post\n')
      .addRaw(`${generatedPost}\n`)
      .addRaw(postUrl ? `Posted at ${postUrl}` : 'Publication succeeded without a retrievable URL.')
      .write();

    core.info('Post published successfully.');
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
