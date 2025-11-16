# X Commit Poster

Generate a concise X thread (single post) that summarizes a range of commits, then publish it to the main timeline or an X community via GitHub Actions.

## Quick Start

```yaml
name: Publish X post from commits

on:
  workflow_dispatch:
    inputs:
      from:
        description: Starting commit (inclusive)
        required: true

jobs:
  x-post:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      models: read
    steps:
      - uses: actions/checkout@v4
      - name: Publish summary on X
        uses: ./action
        with:
          from: ${{ github.event.inputs.from }}
          to: ${{ github.sha }}
          community: my-community-id
          tone: friendly and confident
          hashtags: release,updates,journey
        env:
          X_BEARER_TOKEN: ${{ secrets.X_BEARER_TOKEN }}
```

## Inputs

See `action.yml` for the full input list. Key inputs include:

- `from`, `to`, `include_start_commit`, and `paths`: control which commits and diffs feed the prompt.
- `model`, `temperature`, `max_output_tokens`, and `system_prompt`: tune the GitHub Models request that writes the post.
- `community`: optionally targets an X community (`community_id` or slug). Leave blank to post to the main timeline.
- `hashtags`, `tone`, `call_to_action`, `extra_instructions`: steer the generated style, key phrases, and concluding callouts.

## Outputs

- `generated-post`: the text sent to X.
- `post-id`/`post-url`: identifiers and links returned by the X API.
- `community-id`: reiterates which community (if any) was targeted.

## Requirements

- The workflow must run with `contents: read` and `models: read` permissions.
- A `X_BEARER_TOKEN` secret is required, and it must have write access to publish posts (or communities) via `https://api.twitter.com/2`.
- The default `GITHUB_TOKEN` is used for contacting GitHub Models; no extra secrets are needed for the model request.

## Prompt Guidance

If you prefer total control, supply a `prompt` input. Otherwise, the action builds a prompt that:

- Cites the commit range and diff snippets.
- Instructs the model to stay under 280 characters.
- Honors the provided tone, hashtags, and call to action.

Use `extra_instructions` to layer on final caveats such as “call out the bugfix” or “avoid internal tooling names.”
