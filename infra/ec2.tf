# One EC2 host running the stack with docker compose: Postgres, Temporal, the
# API and the worker. Shell access is through SSM Session Manager, so no SSH
# key or open port 22 is needed.

data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${local.arch}"
}

resource "random_password" "db" {
  length  = 32
  special = false # it is embedded in connection URLs
}

resource "aws_ssm_parameter" "db_password" {
  name  = "/${var.project}/db-password"
  type  = "SecureString"
  value = random_password.db.result
}

resource "aws_iam_role" "app" {
  name = "${var.project}-app-host"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "app_ssm" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "app_ecr" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# Only what the app needs: invoke the vendors Lambda, read the DB password.
resource "aws_iam_role_policy" "app" {
  name = "app"
  role = aws_iam_role.app.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = aws_lambda_function.vendors.arn
      },
      {
        Effect   = "Allow"
        Action   = "ssm:GetParameter"
        Resource = aws_ssm_parameter.db_password.arn
      },
    ]
  })
}

resource "aws_iam_instance_profile" "app" {
  name = "${var.project}-app-host"
  role = aws_iam_role.app.name
}

locals {
  lambda_function_name = "${var.project}-vendors"

  compose = templatefile("${path.module}/templates/docker-compose.yml.tftpl", {
    app_image            = "${aws_ecr_repository.app.repository_url}:latest"
    lambda_function_name = local.lambda_function_name
    region               = var.region
  })
}

resource "aws_instance" "app" {
  ami                         = data.aws_ssm_parameter.al2023_ami.value
  instance_type               = var.instance_type
  subnet_id                   = sort(data.aws_subnets.app.ids)[0]
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = aws_iam_instance_profile.app.name
  associate_public_ip_address = true

  metadata_options {
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 2          # containers are one hop away; they need it for the role's credentials
  }

  root_block_device {
    volume_size = var.root_volume_gb
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/templates/user-data.sh.tftpl", {
    compose           = local.compose
    region            = var.region
    registry          = split("/", aws_ecr_repository.app.repository_url)[0]
    db_password_param = aws_ssm_parameter.db_password.name
    compose_arch      = local.arch == "arm64" ? "aarch64" : "x86_64"
  })

  tags = {
    Name = "${var.project}-app"
  }

  lifecycle {
    # Replacing the instance would wipe Postgres. A newer AMI or edited boot
    # script should not do that silently; redeploy app code with scripts/redeploy.sh.
    ignore_changes = [ami, user_data]
  }

  # The first boot pulls the app image, so it must already be in ECR.
  depends_on = [terraform_data.app_image, aws_iam_role_policy_attachment.app_ecr]
}
