output "api_url" {
  description = "Base URL of the API (reachable from allowed_cidrs only)."
  value       = "http://${aws_instance.app.public_ip}:3000"
}

output "instance_id" {
  value = aws_instance.app.id
}

output "vendors_lambda" {
  value = aws_lambda_function.vendors.function_name
}

output "shell" {
  description = "Open a shell on the host (needs the session-manager-plugin)."
  value       = "aws ssm start-session --region ${var.region} --target ${aws_instance.app.id}"
}

output "temporal_ui_tunnel" {
  description = "Forward the Temporal UI to http://localhost:8088."
  value       = "aws ssm start-session --region ${var.region} --target ${aws_instance.app.id} --document-name AWS-StartPortForwardingSession --parameters portNumber=8080,localPortNumber=8088"
}

output "boot_log" {
  description = "Follow the first-boot setup."
  value       = "aws ssm start-session --region ${var.region} --target ${aws_instance.app.id} then: sudo tail -f /var/log/cloud-init-output.log"
}

output "region" {
  value = var.region
}

output "compose_file" {
  description = "Rendered compose file; used by scripts/redeploy.sh."
  value       = local.compose
}
