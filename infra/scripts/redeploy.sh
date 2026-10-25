#!/usr/bin/env bash
# Rolls out new code to the EC2 host without replacing it (Postgres data stays).
# Run after `terraform apply`, which rebuilds and pushes images whose sources changed.
# It uploads the current compose file, then pulls the new images and restarts
# what changed, through SSM Run Command (no SSH).
set -euo pipefail
cd "$(dirname "$0")/.."

region=$(terraform output -raw region)
instance=$(terraform output -raw instance_id)
compose_b64=$(terraform output -raw compose_file | base64 | tr -d '\n')

command_id=$(aws ssm send-command \
  --region "$region" \
  --instance-ids "$instance" \
  --document-name AWS-RunShellScript \
  --comment "redeploy onboarding" \
  --parameters "commands=[\"echo $compose_b64 | base64 -d > /opt/onboarding/docker-compose.yml\",\"/opt/onboarding/deploy.sh\"]" \
  --query Command.CommandId --output text)

echo "Deploying (SSM command $command_id)..."
aws ssm wait command-executed --region "$region" --command-id "$command_id" --instance-id "$instance" || true
aws ssm get-command-invocation --region "$region" --command-id "$command_id" --instance-id "$instance" \
  --query '{Status:Status,Output:StandardOutputContent,Errors:StandardErrorContent}' --output yaml
