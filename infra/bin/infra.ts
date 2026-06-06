#!/usr/bin/env node
// CDK app entrypoint. Defines the CDP stack(s). See CDP-BUILD-SPEC.md §14.
// Scaffolding only: resources (Lambdas, REST API + usage plans, SQS FIFO + DLQ,
// SNS, S3 + CloudFront, EventBridge schedules, SES config sets, alarms) are added
// per build phase (§17).
import { App, type Environment } from 'aws-cdk-lib';
import { CdpStack } from '../lib/cdp-stack.js';

const app = new App();

const env: Environment = {
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  ...(process.env.CDK_DEFAULT_ACCOUNT ? { account: process.env.CDK_DEFAULT_ACCOUNT } : {}),
};

new CdpStack(app, 'CdpStack', { env });
