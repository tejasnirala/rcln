# Infrastructure/

The consolidated view is [`../10_Deployment_Guide.md`](../10_Deployment_Guide.md).

**What exists** — `infra/` in the repository root:

| Path                                              | Purpose                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `infra/docker/Dockerfile.dev`                     | The shared development image used by api, web and worker                                                                  |
| `infra/docker/dev-entrypoint.sh`                  | Reconciles dependencies, generates the Prisma client, waits for Postgres                                                  |
| `infra/postgres/init/01-roles-and-extensions.sql` | Creates the `rcln_owner` / `rcln_app` role split and the required extensions. CI replays this file to reproduce the split |
| `docker-compose.yml`                              | api · web · worker · postgres · redis · mailpit, with hot reload                                                          |
| `apps/*/Dockerfile`                               | Production images for each app. The api image is 476 MB and has been smoke-tested                                         |
| `.github/workflows/ci.yml`                        | Two jobs — static, and migrations + tenant isolation                                                                      |

**What does not exist.** There is **no Terraform**, no deployed environment, no
staging, and nothing has been pushed to the remote.
[`../Architecture/architecture.md`](../Architecture/architecture.md) §12
specifies AWS `ap-south-1` on ECS Fargate with RDS Multi-AZ, PgBouncer,
ElastiCache, S3 + CloudFront and Cloudflare in front. Read it as a target.

Files will be added here as infrastructure is actually provisioned.
