import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/**
 * Root CDP stack. Scaffolding only — no resources declared yet.
 *
 * Per CDP-BUILD-SPEC.md §14, this will define: Lambdas + least-privilege IAM;
 * the REST API (resources, request validators/models, per-workspace usage plans
 * + API keys, Lambda authorizer, WAF); SQS FIFO + DLQ + event-source mappings;
 * SNS topics/subscriptions; S3 + CloudFront + ACM; EventBridge schedules (batch
 * eval, soft-bounce retry, usage rollups); SES Configuration Set(s); and
 * CloudWatch alarms (account + per-workspace reputation, DLQ depth, Lambda
 * errors, SQS message age). Added phase by phase (§17).
 */
export class CdpStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    // Resources added per build phase.
  }
}
