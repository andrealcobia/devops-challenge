import { Duration, RemovalPolicy, Stack, StackProps, aws_ecs as ecs } from 'aws-cdk-lib';
import { IVpc } from 'aws-cdk-lib/aws-ec2';
import { Cluster, ContainerInsights, FargateService } from 'aws-cdk-lib/aws-ecs';
import { ApplicationListener, ApplicationListenerRule, ApplicationProtocol, ApplicationTargetGroup, ListenerAction, ListenerCondition, TargetType } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Key, KeySpec, KeyUsage } from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { AppService } from './components/app-service';

interface AppStackProps extends StackProps {
  vpc: IVpc;
  albListener: ApplicationListener;
}

export class AppStack extends Stack {
  readonly fargateService: FargateService;
  readonly clusterName: string;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const kmsKey = new Key(this, 'FargateKmsKey', {
      keySpec: KeySpec.SYMMETRIC_DEFAULT,
      keyUsage: KeyUsage.ENCRYPT_DECRYPT,
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow: Duration.days(7),
      enableKeyRotation: true,
      alias: 'fargateKmsKey',
      description: 'KMS Key for Fargate ephemeral storage encryption',
    });

    kmsKey.addToResourcePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      principals: [new ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
      actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
      resources: ['*'],
      conditions: {
        ArnLike: {
          'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:log-group:*`,
        },
      },
    }));

    const cluster = new Cluster(this, 'FargateCluster', {
      vpc: props.vpc,
      clusterName: 'FargateCluster',
      containerInsightsV2: ContainerInsights.DISABLED,
      managedStorageConfiguration: { fargateEphemeralStorageKmsKey: kmsKey },
    });
    this.clusterName = cluster.clusterName;

    const appService = new AppService(this, 'AppService', {
      cpu: 256,
      memoryLimitMiB: 512,
      cluster,
      vpcSubnets: props.vpc.selectSubnets({ subnetGroupName: 'App' }),
      vpc: props.vpc,
      kmsKey,
      desiredCount: 0,
    });
    this.fargateService = appService.service;

    const blueTg = new ApplicationTargetGroup(this, 'BlueTg', {
      vpc: props.vpc,
      port: 8080,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      healthCheck: {
        path: '/healthz',
        port: '8080',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        unhealthyThresholdCount: 5,
      },
      deregistrationDelay: Duration.seconds(60),
    });

    const greenTg = new ApplicationTargetGroup(this, 'GreenTg', {
      vpc: props.vpc,
      port: 8080,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      healthCheck: {
        path: '/healthz',
        port: '8080',
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
      },
      deregistrationDelay: Duration.seconds(60),
    });

    const mainRule = new ApplicationListenerRule(this, 'mainRule', {
      listener: props.albListener,
      priority: 101,
      conditions: [ListenerCondition.pathPatterns(['/*'])],
      action: ListenerAction.weightedForward([
        { targetGroup: blueTg, weight: 100 },
        { targetGroup: greenTg, weight: 0 },
      ]),
    });

    props.albListener.addAction('Default404Action', {
      action: ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Wrong place',
      }),
    });

    const elbChangeRole = new Role(this, 'elbChangeRole', {
      assumedBy: new ServicePrincipal('ecs.amazonaws.com'),
      description: 'Allows ECS to update ALB listener rules and target groups for blue/green',
    });

    elbChangeRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'elasticloadbalancing:CreateRule',
        'elasticloadbalancing:ModifyRule',
        'elasticloadbalancing:DeleteRule',
        'elasticloadbalancing:SetRulePriorities',
      ],
      resources: [props.albListener.listenerArn, mainRule.listenerRuleArn],
    }));

    elbChangeRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'elasticloadbalancing:RegisterTargets',
        'elasticloadbalancing:DeregisterTargets',
        'elasticloadbalancing:AddTags',
        'elasticloadbalancing:RemoveTags',
      ],
      resources: [blueTg.targetGroupArn, greenTg.targetGroupArn],
    }));

    elbChangeRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'elasticloadbalancing:DescribeListeners',
        'elasticloadbalancing:DescribeRules',
        'elasticloadbalancing:DescribeTargetGroups',
        'elasticloadbalancing:DescribeTargetHealth',
      ],
      resources: ['*'],
    }));

    const cfn = this.fargateService.node.defaultChild as ecs.CfnService;

    cfn.loadBalancers = [{
      containerName: appService.containerName,
      containerPort: appService.containerPort,
      targetGroupArn: blueTg.targetGroupArn,
      advancedConfiguration: {
        alternateTargetGroupArn: greenTg.targetGroupArn,
        productionListenerRule: mainRule.listenerRuleArn,
        roleArn: elbChangeRole.roleArn,
      },
    }];

    cfn.deploymentConfiguration = {
      strategy: 'BLUE_GREEN',
      bakeTimeInMinutes: 15,
      lifecycleHooks: [{
        hookTargetArn: appService.hookFn.functionArn,
        lifecycleStages: ['POST_TEST_TRAFFIC_SHIFT'],
        roleArn: appService.ecsHookRole.roleArn,
      }],
    };
  }
}
