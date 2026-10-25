variable "region" {
  description = "AWS region. This account's organization only allows us-east-2."
  type        = string
  default     = "us-east-2"
}

variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "onboarding"
}

variable "instance_type" {
  description = "EC2 instance type. ARM (t4g) and x86 types both work; the image architecture follows it."
  type        = string
  default     = "t4g.small"
}

variable "root_volume_gb" {
  description = "Root EBS volume size, holding Docker images and Postgres data."
  type        = number
  default     = 20
}

variable "allowed_cidrs" {
  description = "CIDRs allowed to reach the API on port 3000. Defaults to your current public IP only."
  type        = list(string)
  default     = null
}

variable "alert_email" {
  description = "Email address that receives budget alerts."
  type        = string
}

variable "real_charges_alert_usd" {
  description = "Alert when charges NOT covered by credits exceed this amount in a month."
  type        = number
  default     = 1
}

variable "credit_burn_alert_usd" {
  description = "Alert when gross monthly usage (before credits) is forecast to exceed this amount."
  type        = number
  default     = 25
}
