# DevOps Challenge

A sample project that deploys a minimal **ASP.NET Core** app to **AWS Fargate** behind an **Application Load Balancer**, using **AWS CDK (TypeScript)** and **GitHub Actions** for CI/CD.

---

## 🧱 Repository layout

```
aspnetapp/                 # .NET 8 sample web app
  Dockerfile
  aspnetapp/*.cs
infrastructure/            # AWS CDK (TypeScript)
  bin/app.ts               # entrypoint
  lib/network.ts           # VPC, subnets, security groups
  lib/ingress-stack.ts     # ALB + listener(s)
  lib/components/app-service.ts  # ECS task, service, logging
  lib/app-stack.ts         # wires everything together
.github/workflows/
  github-build-deploy.yml  # build, push to ECR, CDK deploy
  github-actions-stale.yml # housekeeping
```

---

## 🔎 What this stack creates

- VPC with public/private subnets
- ECS **Fargate** cluster and service
- Application Load Balancer with listener rules
- ECR image deployment (tag provided via CDK context: `-c imageTag=<tag>`)
- CloudWatch log group and container health check

---

## ▶️ Run locally (Docker)

```bash
cd aspnetapp
# build image
docker build -t aspnetapp:dev .
# run
docker run --rm -p 8080:8080 aspnetapp:dev
# then open http://localhost:8080
```

**Health check:** `GET /healthz`  
**Env probe:** `GET /env` (returns CPU/memory/env info)

---

## ☁️ Deploy to AWS with CDK

### Prerequisites
- Node.js 18+ and npm
- AWS CLI configured with credentials
- CDK v2 (`npm i -g aws-cdk`)
- An ECR repo (default used by the workflow): **`aspnet-app`**

### One‑time: bootstrap CDK
```bash
cd infrastructure
npm ci || npm install
cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
```

### Build & push your app image
```bash
# tag the image that Fargate will run
aws ecr get-login-password --region <REGION> |   docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com

docker build -t aspnet-app:latest ./aspnetapp

docker tag aspnet-app:latest <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/aspnet-app:latest
docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/aspnet-app:latest
```

### Synthesize & deploy
```bash
cd infrastructure
npm run build
cdk synth
cdk diff
# NOTE: imageTag must match the tag you pushed to ECR
cdk deploy --require-approval never --all -c imageTag=latest
```

When the deployment finishes, CDK will output the **ALB DNS name**. Visit `http://<alb-dns>`.

---

## 🤖 CI/CD with GitHub Actions

The workflow **`.github/workflows/github-build-deploy.yml`** does the following on pushes to `main`:

1. Build the Docker image
2. Authenticate to AWS (OIDC)
3. Push the image to ECR (`aspnet-app` with tag `latest` by default)
4. Run `cdk synth`, `cdk diff`, and `cdk deploy -c imageTag=${ env.IMAGE_TAG }`

### Setup steps

1. **Configure OIDC** in your AWS account for GitHub Actions and create an IAM role that trusts:
   - Issuer: `token.actions.githubusercontent.com`
   - Audience: `sts.amazonaws.com`
   - Repo condition: your `<owner>/<repo>:ref:refs/heads/main` (or broader as needed)

2. **Attach permissions** to the role (minimal example):
   - ECR: `ecr:BatchCheckLayerAvailability`, `ecr:CompleteLayerUpload`, `ecr:UploadLayerPart`, `ecr:InitiateLayerUpload`, `ecr:PutImage`
   - STS: `sts:AssumeRoleWithWebIdentity`
   - CDK deploy permissions for ECS, EC2, IAM PassRole, CloudFormation, Logs, ELBv2, etc. (or use an administrator role in a sandbox account).

3. **Set repository variables/secrets** if you diverge from defaults:
   - `ECR_REPOSITORY` (default: `aspnet-app`)
   - `IMAGE_TAG` (default: `latest`)
   - Optional: `AWS_REGION` if your repo is multi‑region.

---

## 🔧 Configuration & endpoints

- Container listens on **:8080** (mapped by the service/ALB).
- Health check command is defined in CDK `curl -f http://localhost:8080/healthz || exit 1`.
- Useful paths:
  - `/` — sample page
  - `/healthz` — liveness
  - `/env` — environment info

---

## 🧪 Local testing tips

```bash
# Hit endpoints
curl -s http://localhost:8080/healthz
curl -s http://localhost:8080/env | jq
```

---

## 🛠 Troubleshooting

- **Service unhealthy:** Ensure the container port in CDK matches the app (`8080`) and the health check points at `/healthz`.

---

## 🧹 Cleanup

```bash
cd infrastructure
cdk destroy --all
# Optionally delete the ECR images/repository afterwards
```

