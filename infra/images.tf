# Container images live in ECR. They are built and pushed from this machine
# during `terraform apply`, rebuilt only when their sources change.

locals {
  root = abspath("${path.module}/..")

  arch            = contains(data.aws_ec2_instance_type.app.supported_architectures, "arm64") ? "arm64" : "x86_64"
  docker_platform = local.arch == "arm64" ? "linux/arm64" : "linux/amd64"

  app_files = sort(concat(
    tolist(fileset(local.root, "src/**")),
    ["package.json", "package-lock.json", "tsconfig.json", "nest-cli.json", "Dockerfile"],
  ))
  app_tag = substr(sha1(join("", [for f in local.app_files : filesha1("${local.root}/${f}")])), 0, 12)

  vendors_files = ["index.ts", "local-server.ts", "package.json", "package-lock.json", "tsconfig.json", "Dockerfile"]
  vendors_tag   = substr(sha1(join("", [for f in local.vendors_files : filesha1("${local.root}/lambdas/vendors/${f}")])), 0, 12)
}

data "aws_ec2_instance_type" "app" {
  instance_type = var.instance_type
}

resource "aws_ecr_repository" "app" {
  name                 = "${var.project}-app"
  image_tag_mutability = "MUTABLE" # "latest" moves with each deploy
  force_delete         = true      # let `terraform destroy` remove pushed images

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_repository" "vendors" {
  name                 = "${var.project}-vendors"
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

# Keep storage (and cost) bounded.
resource "aws_ecr_lifecycle_policy" "keep_recent" {
  for_each   = { app = aws_ecr_repository.app.name, vendors = aws_ecr_repository.vendors.name }
  repository = each.value
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 3 most recent images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 3 }
      action       = { type = "expire" }
    }]
  })
}

resource "terraform_data" "app_image" {
  triggers_replace = [local.app_tag, aws_ecr_repository.app.repository_url, local.docker_platform]

  provisioner "local-exec" {
    command = "${path.module}/scripts/build-and-push.sh"
    environment = {
      REGION         = var.region
      REPOSITORY_URL = aws_ecr_repository.app.repository_url
      TAG            = local.app_tag
      PLATFORM       = local.docker_platform
      CONTEXT        = local.root
    }
  }
}

resource "terraform_data" "vendors_image" {
  triggers_replace = [local.vendors_tag, aws_ecr_repository.vendors.repository_url]

  # Build one image at a time: two concurrent `docker login`s to the same
  # registry collide in the macOS Keychain ("item already exists").
  depends_on = [terraform_data.app_image]

  provisioner "local-exec" {
    command = "${path.module}/scripts/build-and-push.sh"
    environment = {
      REGION         = var.region
      REPOSITORY_URL = aws_ecr_repository.vendors.repository_url
      TAG            = local.vendors_tag
      PLATFORM       = "linux/arm64" # matches the Lambda's architecture below
      CONTEXT        = "${local.root}/lambdas/vendors"
    }
  }
}
