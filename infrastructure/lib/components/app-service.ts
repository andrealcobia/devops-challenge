import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { IVpc, Peer, Port, SecurityGroup, SubnetSelection } from 'aws-cdk-lib/aws-ec2';
import { Repository, RepositoryEncryption, TagMutability } from 'aws-cdk-lib/aws-ecr';
import {
  AwsLogDriver,
  ContainerImage,
  CpuArchitecture,
  DeploymentControllerType,
  FargateService,
  FargateTaskDefinition,
  ICluster,
  Protocol,
} from 'aws-cdk-lib/aws-ecs';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { IKey } from 'aws-cdk-lib/aws-kms';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface AppServiceProps {
  cpu: number;
  memoryLimitMiB: number;
  cluster: ICluster;
  vpcSubnets: SubnetSelection;
  kmsKey: IKey;
  desiredCount: number;
  vpc: IVpc;
}

export class AppService extends Construct {
  readonly service: FargateService;
  readonly hookFn: Function;
  readonly ecsHookRole: Role;
  readonly containerName: string;
  readonly containerPort: number;

  constructor(scope: Construct, id: string, props: AppServiceProps) {
    super(scope, id);

    const account = Stack.of(this).account;
    const region = Stack.of(this).region;

    const appName = 'aspnet-app';
    this.containerName = `${appName}-container`;
    this.containerPort = 8080;

    const taskDefinition = new FargateTaskDefinition(this, 'TaskDefinition', {
      family: `${appName}-task-definition`,
      cpu: props.cpu,
      memoryLimitMiB: props.memoryLimitMiB,
      runtimePlatform: { cpuArchitecture: CpuArchitecture.ARM64 },
    });

    const appLogGroup = new LogGroup(this, 'AppLogGroup', {
      logGroupName: `/ecs/${props.cluster.clusterName}/${this.containerName}`,
      retention: RetentionDays.ONE_WEEK,
      encryptionKey: props.kmsKey,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const repo = new Repository(this, 'Repo', {
      repositoryName: appName,
      imageTagMutability: TagMutability.IMMUTABLE,
      encryption: RepositoryEncryption.AES_256,
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    repo.addLifecycleRule({ description: 'Keep only the last 5 images.', maxImageCount: 5 });

    const imageTag = this.node.tryGetContext('imageTag') ?? 'latest';

    taskDefinition.addContainer('AppContainer', {
      containerName: this.containerName,
      image: ContainerImage.fromEcrRepository(repo, imageTag),
      readonlyRootFilesystem: false,
      logging: new AwsLogDriver({ streamPrefix: appName, logGroup: appLogGroup }),
      portMappings: [{ protocol: Protocol.TCP, containerPort: this.containerPort }],
      environment: {},
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8080/healthz || exit 1'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(30),
      },
    });

    const taskSg = new SecurityGroup(this, 'TaskSg', {
      vpc: props.vpc,
      allowAllOutbound: true,
      securityGroupName: 'ecs-fargate-task-sg',
    });
    taskSg.addIngressRule(Peer.ipv4(props.vpc.vpcCidrBlock), Port.tcp(this.containerPort));

    this.service = new FargateService(this, 'FargateService', {
      serviceName: `${appName}-service`,
      cluster: props.cluster,
      taskDefinition,
      securityGroups: [taskSg],
      vpcSubnets: props.vpcSubnets,
      desiredCount: props.desiredCount,
      minHealthyPercent: 50,
      enableExecuteCommand: true,
      circuitBreaker: { rollback: true },
      deploymentController: { type: DeploymentControllerType.ECS },
    });

    taskDefinition.addToTaskRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
        'ssm:UpdateInstanceInformation',
      ],
      resources: ['*'],
    }));

    taskDefinition.addToExecutionRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        `arn:aws:logs:${region}:${account}:log-group:${appLogGroup.logGroupName}:*`,
        `arn:aws:logs:${region}:${account}:log-group:/ecs/execute-command/${props.cluster.clusterName}*`,
      ],
    }));

    taskDefinition.addToTaskRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['logs:GetLogEvents', 'logs:DescribeLogGroups', 'logs:DescribeLogStreams'],
      resources: [
        `arn:aws:logs:${region}:${account}:log-group:${appLogGroup.logGroupName}:*`,
        `arn:aws:logs:${region}:${account}:log-group:/ecs/execute-command/${props.cluster.clusterName}*`,
      ],
    }));

    taskDefinition.addToExecutionRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['kms:Decrypt', 'kms:DescribeKey'],
      resources: [props.kmsKey.keyArn],
    }));

    taskDefinition.addToExecutionRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:BatchGetImage',
        'ecr:DescribeImages',
        'ecr:GetDownloadUrlForLayer',
      ],
      resources: [repo.repositoryArn],
    }));

    taskDefinition.addToExecutionRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    }));

    const lambdaSg = new SecurityGroup(this, 'LambdaSg', {
      description: 'Security group for lifecycle hook Lambda',
      securityGroupName: `lambda-sg-${appName}`,
      vpc: props.vpc,
      allowAllOutbound: true,
    });

    this.hookFn = new Function(this, 'BgHookFn', {
      functionName: `handler-${appName}`,
      description: 'Lambda function to handle Blue Green Deployment lifecycle hooks',
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      memorySize: 128,
      timeout: Duration.seconds(90),
      code: Code.fromInline(`
        exports.handler = async (event) => {
          console.log("ECS lifecycle payload:", JSON.stringify(event));
          return { hookStatus: "SUCCEEDED" };
        };
      `),
      vpc: props.vpc,
      securityGroups: [lambdaSg],
      vpcSubnets: { subnetGroupName: 'App' },
    });

    this.ecsHookRole = new Role(this, 'EcsLifecycleHookRole', {
      assumedBy: new ServicePrincipal('ecs.amazonaws.com'),
      description: 'Role ECS uses to invoke lifecycle hook Lambdas',
    });

    this.hookFn.grantInvoke(this.ecsHookRole);

  }
}
