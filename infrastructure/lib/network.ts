import { Stack, StackProps } from 'aws-cdk-lib';
import { AclCidr, AclTraffic, Action, GatewayVpcEndpointAwsService, InterfaceVpcEndpointAwsService, NetworkAcl, SubnetType, TrafficDirection, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class NetworkStack extends Stack {

  public readonly vpc: Vpc;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    this.vpc = new Vpc(this, 'vpc', {

      vpcName: 'vpc-app',
      maxAzs: 2,
      subnetConfiguration: [
        {
          subnetType: SubnetType.PUBLIC,
          mapPublicIpOnLaunch: false,
          cidrMask: 26,
          name: 'Ingress',
        },
        {
          subnetType: SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
          name: 'App',
        },
      ],
    });

    this.vpc.addInterfaceEndpoint('EcrEndpoint', {
      service: InterfaceVpcEndpointAwsService.ECR,
      subnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
    });
    this.vpc.addInterfaceEndpoint('EcrDockerEndpoint', {
      service: InterfaceVpcEndpointAwsService.ECR_DOCKER,
      subnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
    });
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: SubnetType.PRIVATE_ISOLATED }],
    });
    this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service: InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      subnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
    });
    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
    });
    this.vpc.addInterfaceEndpoint('KmsEndpoint', {
      service: InterfaceVpcEndpointAwsService.KMS,
      subnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
    });

    const defaultNacl = NetworkAcl.fromNetworkAclId(this, 'DefaultNacl', this.vpc.vpcDefaultNetworkAcl);

    defaultNacl.addEntry('DenySshAccess', {
      direction: TrafficDirection.INGRESS,
      ruleAction: Action.DENY,
      cidr: AclCidr.anyIpv4(),
      traffic: AclTraffic.tcpPort(22),
      ruleNumber: 98,
    });
    defaultNacl.addEntry('DenyRdpAccess', {
      direction: TrafficDirection.INGRESS,
      ruleAction: Action.DENY,
      cidr: AclCidr.anyIpv4(),
      traffic: AclTraffic.tcpPort(3389),
      ruleNumber: 99,
    });
  }
}