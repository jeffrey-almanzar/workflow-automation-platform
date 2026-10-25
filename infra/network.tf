# Uses the account's default VPC: public subnets with an internet gateway, which
# the instance needs to pull images. Postgres and Temporal are never exposed.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

# Not every instance type is offered in every availability zone.
data "aws_ec2_instance_type_offerings" "app" {
  location_type = "availability-zone"
  filter {
    name   = "instance-type"
    values = [var.instance_type]
  }
}

data "aws_subnets" "app" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
  filter {
    name   = "availability-zone"
    values = data.aws_ec2_instance_type_offerings.app.locations
  }
}

data "http" "my_ip" {
  url = "https://checkip.amazonaws.com"
}

locals {
  allowed_cidrs = var.allowed_cidrs != null ? var.allowed_cidrs : ["${chomp(data.http.my_ip.response_body)}/32"]
}

resource "aws_security_group" "app" {
  name        = "${var.project}-app"
  description = "Onboarding EC2 host"
  vpc_id      = data.aws_vpc.default.id
}

resource "aws_vpc_security_group_ingress_rule" "api" {
  for_each          = toset(local.allowed_cidrs)
  security_group_id = aws_security_group.app.id
  description       = "API"
  ip_protocol       = "tcp"
  from_port         = 3000
  to_port           = 3000
  cidr_ipv4         = each.value
}

# Postgres on the host is reachable only from the vendors Lambda.
resource "aws_vpc_security_group_ingress_rule" "postgres_from_lambda" {
  security_group_id            = aws_security_group.app.id
  description                  = "Postgres from vendors Lambda"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.lambda.id
}

resource "aws_vpc_security_group_egress_rule" "app_all" {
  security_group_id = aws_security_group.app.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_security_group" "lambda" {
  name        = "${var.project}-vendors-lambda"
  description = "Vendors Lambda (outbound to Postgres only)"
  vpc_id      = data.aws_vpc.default.id
}

resource "aws_vpc_security_group_egress_rule" "lambda_to_postgres" {
  security_group_id            = aws_security_group.lambda.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.app.id
}
