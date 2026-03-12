#!/usr/bin/env bash

# post_inline_comment.sh
# Adds an inline comment to a specific line in a PR via the GitHub API.
# Usage: ./post_inline_comment.sh <PR_NUMBER> <FILE_PATH> <LINE_NUMBER> <COMMENT_BODY>

if [ "$#" -lt 4 ]; then
  echo "Usage: $0 <PR_NUMBER> <FILE_PATH> <LINE_NUMBER> <COMMENT_BODY>"
  exit 1
fi

PR_NUMBER="$1"
FILE_PATH="$2"
LINE="$3"
BODY="$4"

# Ensure gh cli is installed
if ! command -v gh &> /dev/null; then
    echo "Error: gh CLI could not be found. Please install and authenticate."
    exit 1
fi

# Get the current repository (e.g., angular/angular)
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

echo "Posting inline comment to PR #${PR_NUMBER} on ${FILE_PATH}:${LINE}..."

# Post the comment using the GitHub Pull Request Reviews API
gh api \
  --method POST \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "/repos/${REPO}/pulls/${PR_NUMBER}/reviews" \
  -f event="COMMENT" \
  -f comments[][path]="${FILE_PATH}" \
  -F comments[][line]="${LINE}" \
  -f comments[][body]="${BODY}"

if [ $? -eq 0 ]; then
  echo "Comment posted successfully!"
else
  echo "Failed to post comment."
  exit 1
fi
