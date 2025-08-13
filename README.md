# DevOps Challenge

This repository contains:
- A sample **ASP.NET Core web application** (`aspnetapp/`).
- An **AWS CDK** infrastructure definition (`infrastructure/`).
- **GitHub Actions** workflows for CI/CD (`.github/workflows/`).
---

## 📦 Deploying to AWS

### Install dependencies
```bash
cd infrastructure
npm install
```
### Bootstrap CDK (only needed once per AWS account/region)
```bash
cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
```
### Synthesize CloudFormation
```bash
cdk synth
```
### Deploy the stack
```bash
cdk deploy
```