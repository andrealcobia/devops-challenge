import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import { IVpc, Peer, Port, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { ApplicationListener, ApplicationLoadBalancer, ApplicationProtocol, ListenerAction } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';


export interface LoadBalancerStackProps extends StackProps {
  vpc: IVpc;
}

export class LoadBalancerStack extends Stack {
  public readonly alb: ApplicationLoadBalancer;
  public readonly albListener: ApplicationListener;
  public readonly securityGroup: SecurityGroup;
  public readonly logBucket: Bucket;

  constructor(scope: Construct, id: string, props: LoadBalancerStackProps) {
    super(scope, id, props);


    this.logBucket = new Bucket(this, 'AlbLogBucket', {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          id: 'CleanupRule',
          expiration: Duration.days(3),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
          enabled: true,
        },
      ],
    });

    this.logBucket.applyRemovalPolicy(RemovalPolicy.DESTROY);

    this.securityGroup = new SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      allowAllOutbound: true,
    });

    this.securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(80));

    this.alb = new ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc: props.vpc,
      securityGroup: this.securityGroup,
      dropInvalidHeaderFields: true,
      http2Enabled: true,
      internetFacing: true,
      idleTimeout: Duration.seconds(10),
      deletionProtection: true,
    });

    Tags.of(this.alb).add('StackName', this.stackName);

    this.alb.logAccessLogs(this.logBucket, 'access-logs');

    this.albListener = this.alb.addListener('Listener443', {
      port: 80,
      protocol: ApplicationProtocol.HTTP,

      defaultAction: ListenerAction.fixedResponse(404),
    });

    new CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
    });

  }
}