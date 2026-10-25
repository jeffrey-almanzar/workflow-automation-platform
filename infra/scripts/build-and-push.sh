#!/usr/bin/env bash
# Builds an image for the target platform and pushes it to ECR with two tags:
# the source hash (immutable reference) and "latest" (what the EC2 host pulls).
# Called by terraform (images.tf) with REGION, REPOSITORY_URL, TAG, PLATFORM, CONTEXT.
set -euo pipefail

registry="${REPOSITORY_URL%%/*}"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$registry"

# --provenance=false: Lambda rejects the multi-manifest index that buildx
# produces by default when it attaches provenance attestations.
docker buildx build \
  --platform "$PLATFORM" \
  --provenance=false \
  --tag "$REPOSITORY_URL:$TAG" \
  --tag "$REPOSITORY_URL:latest" \
  --push \
  "$CONTEXT"
