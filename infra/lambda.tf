# The vendors Lambda: the same container image used locally, now running on
# real AWS Lambda. It lives in the VPC so it can reach Postgres on the EC2 host
# (it needs no internet access).

data "aws_ecr_image" "vendors" {
  repository_name = aws_ecr_repository.vendors.name
  image_tag       = local.vendors_tag
  depends_on      = [terraform_data.vendors_image]
}

resource "aws_iam_role" "vendors_lambda" {
  name = "${var.project}-vendors-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Logs plus the network interfaces a VPC-attached Lambda needs.
resource "aws_iam_role_policy_attachment" "vendors_lambda_vpc" {
  role       = aws_iam_role.vendors_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_cloudwatch_log_group" "vendors" {
  name              = "/aws/lambda/${var.project}-vendors"
  retention_in_days = 7
}

resource "aws_lambda_function" "vendors" {
  function_name = "${var.project}-vendors"
  role          = aws_iam_role.vendors_lambda.arn
  package_type  = "Image"
  # Pinned by digest, so a new image (new source hash) always updates the function.
  image_uri     = "${aws_ecr_repository.vendors.repository_url}@${data.aws_ecr_image.vendors.image_digest}"
  architectures = ["arm64"]
  memory_size   = 256
  timeout       = 15

  vpc_config {
    subnet_ids         = data.aws_subnets.default.ids
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      DATABASE_URL = "postgres://onboarding:${random_password.db.result}@${aws_instance.app.private_ip}:5432/workflows"
      PG_POOL_MAX  = "2" # one request per instance at a time on real Lambda
    }
  }

  depends_on = [aws_iam_role_policy_attachment.vendors_lambda_vpc, aws_cloudwatch_log_group.vendors]
}
