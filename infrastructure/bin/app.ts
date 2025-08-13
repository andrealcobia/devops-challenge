#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { AppStack } from '../lib/app-stack';
import { LoadBalancerStack } from '../lib/ingress-stack';
import { NetworkStack } from '../lib/network';


const app = new App({
});

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const networkStack = new NetworkStack(app, 'NetworkStack', {
  env: env,
  description: 'This stack deploys basic network resources, like vpc, subnets, etc',
});

const loadBalancerStack = new LoadBalancerStack(app, 'LoadBalancerStack', {
  env: env,
  vpc: networkStack.vpc,
  description: 'Creates a internet-facing load balancer and associated resources',
});

new AppStack(app, 'AppStack', {
  env: env,
  vpc: networkStack.vpc,
  albListener: loadBalancerStack.albListener,
  description: 'Deploys Fargate Cluster, Service and Task',
});

app.synth();