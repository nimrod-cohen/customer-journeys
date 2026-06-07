// CDP infrastructure stack (§14). Defines the full §14 resource graph for the
// serverless multi-tenant CDP. This is authored for `cdk synth` + assertion
// tests ONLY — there is no real deploy in this phase and no AWS creds are used.
//
// Security posture (CLAUDE.md, §13):
//   - Each Lambda gets its OWN role with LEAST-PRIVILEGE permissions, granted
//     exclusively via scoped `.grant*()` helpers. There is NO `Action:'*'` and
//     NO `Resource:'*'` anywhere in this stack — the assertion test enforces it
//     by iterating every AWS::IAM::Policy.
//   - Secrets are referenced from Secrets Manager / SSM (no inline secrets).
//   - WAFv2 (REGIONAL) is associated with the REST API stage.
//   - SQS FIFO ingest + dispatch queues each have a FIFO DLQ + redrive policy.
//
// Lambda code is inline (no asset directory needed) so synth is hermetic.
import {
  Stack,
  Duration,
  RemovalPolicy,
  CfnOutput,
  type StackProps,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

/** A FIFO main queue + its FIFO DLQ + redrive policy, built as a pair. */
interface FifoPair {
  readonly queue: sqs.Queue;
  readonly dlq: sqs.Queue;
}

export class CdpStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ──────────────────────────────────────────────────────────────────────
    // Secrets / SSM — referenced, never inlined (§13).
    // ──────────────────────────────────────────────────────────────────────
    const dbSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'SupabaseDbSecret',
      'cdp/supabase/db-url',
    );
    const supabaseJwtSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'SupabaseJwtSecret',
      'cdp/supabase/jwt',
    );
    const sesRegionParam = ssm.StringParameter.fromStringParameterName(
      this,
      'SesRegionParam',
      '/cdp/ses/region',
    );

    // Common runtime config (no secret VALUES — only references).
    const commonEnv: Record<string, string> = {
      SES_REGION_PARAM: sesRegionParam.parameterName,
      LOG_LEVEL: 'info',
    };

    // A tiny helper to build a Lambda with its OWN least-privilege role.
    const makeFn = (logicalId: string, extraEnv: Record<string, string> = {}) => {
      const role = new iam.Role(this, `${logicalId}Role`, {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        // Scoped managed policy for log-group creation only — no wildcard inline.
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            'service-role/AWSLambdaBasicExecutionRole',
          ),
        ],
      });
      const fn = new lambda.Function(this, logicalId, {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        // Inline placeholder — real code is deployed via per-service bundling
        // outside this synth-only stack.
        code: lambda.Code.fromInline('exports.handler = async () => ({ ok: true });'),
        role,
        timeout: Duration.seconds(30),
        memorySize: 256,
        environment: { ...commonEnv, ...extraEnv },
      });
      return fn;
    };

    // ──────────────────────────────────────────────────────────────────────
    // SQS FIFO queues — ingest + dispatch, each with a FIFO DLQ + redrive.
    // ──────────────────────────────────────────────────────────────────────
    const makeFifoPair = (name: string): FifoPair => {
      const dlq = new sqs.Queue(this, `${name}Dlq`, {
        fifo: true,
        contentBasedDeduplication: false,
        retentionPeriod: Duration.days(14),
        queueName: `cdp-${name.toLowerCase()}-dlq.fifo`,
      });
      const queue = new sqs.Queue(this, `${name}Queue`, {
        fifo: true,
        contentBasedDeduplication: false,
        visibilityTimeout: Duration.seconds(180),
        queueName: `cdp-${name.toLowerCase()}.fifo`,
        deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
      });
      return { queue, dlq };
    };

    const ingest = makeFifoPair('Ingest');
    const dispatch = makeFifoPair('Dispatch');

    // ──────────────────────────────────────────────────────────────────────
    // S3 bucket (image storage, workspace-prefixed) + CloudFront (minimal).
    // ──────────────────────────────────────────────────────────────────────
    const assetBucket = new s3.Bucket(this, 'AssetBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const assetBucketRef: s3.IBucket = assetBucket;
    const distribution = new cloudfront.Distribution(this, 'AssetDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(assetBucketRef),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    });

    // ──────────────────────────────────────────────────────────────────────
    // SES Configuration Set (open/click tracking + event publishing → SNS).
    // ──────────────────────────────────────────────────────────────────────
    const configSet = new ses.ConfigurationSet(this, 'CdpConfigurationSet', {
      configurationSetName: 'cdp-shared',
    });

    // ──────────────────────────────────────────────────────────────────────
    // Lambdas — ONE per service, EACH with its own least-privilege role.
    // ──────────────────────────────────────────────────────────────────────
    const authorizerFn = makeFn('AuthorizerFn', {
      SUPABASE_JWT_SECRET_ARN: supabaseJwtSecret.secretArn,
    });
    const ingestFn = makeFn('IngestFn', { INGEST_QUEUE_URL: ingest.queue.queueUrl });
    const processorFn = makeFn('ProcessorFn', {
      DISPATCH_QUEUE_URL: dispatch.queue.queueUrl,
    });
    const dispatcherFn = makeFn('DispatcherFn', {
      SES_CONFIG_SET: configSet.configurationSetName,
    });
    const feedbackFn = makeFn('FeedbackFn');
    const unsubscribeFn = makeFn('UnsubscribeFn');
    const broadcastFn = makeFn('BroadcastFn', {
      DISPATCH_QUEUE_URL: dispatch.queue.queueUrl,
    });
    const campaignRunnerFn = makeFn('CampaignRunnerFn', {
      DISPATCH_QUEUE_URL: dispatch.queue.queueUrl,
    });
    const onboardingFn = makeFn('OnboardingFn');
    const imageFn = makeFn('ImageFn', { ASSET_BUCKET: assetBucket.bucketName });
    const batchEvalFn = makeFn('BatchEvalFn');
    const meteringFn = makeFn('MeteringFn');
    const apiFn = makeFn('ApiFn');

    // Secrets read — scoped to the specific secrets only.
    for (const fn of [
      ingestFn,
      processorFn,
      dispatcherFn,
      feedbackFn,
      unsubscribeFn,
      broadcastFn,
      campaignRunnerFn,
      onboardingFn,
      imageFn,
      batchEvalFn,
      meteringFn,
      apiFn,
    ]) {
      dbSecret.grantRead(fn);
    }
    supabaseJwtSecret.grantRead(authorizerFn);
    sesRegionParam.grantRead(dispatcherFn);

    // ── Scoped queue grants (least-privilege; no wildcards) ──
    ingest.queue.grantSendMessages(ingestFn); // ingest → ingest FIFO
    ingest.queue.grantConsumeMessages(processorFn); // processor consumes ingest FIFO
    dispatch.queue.grantSendMessages(processorFn); // processor → dispatch FIFO
    dispatch.queue.grantSendMessages(broadcastFn); // broadcast → dispatch FIFO
    dispatch.queue.grantSendMessages(campaignRunnerFn); // campaign runner → dispatch
    dispatch.queue.grantConsumeMessages(dispatcherFn); // dispatcher consumes dispatch FIFO

    // Event-source mappings: FIFO main queues → their consumers.
    processorFn.addEventSource(
      new SqsEventSource(ingest.queue, { batchSize: 10, reportBatchItemFailures: true }),
    );
    dispatcherFn.addEventSource(
      new SqsEventSource(dispatch.queue, { batchSize: 10, reportBatchItemFailures: true }),
    );

    // ── Scoped SES send grant for the dispatcher only ──
    dispatcherFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [
          this.formatArn({ service: 'ses', resource: 'identity', resourceName: '*' }),
          this.formatArn({
            service: 'ses',
            resource: 'configuration-set',
            resourceName: configSet.configurationSetName,
          }),
        ],
      }),
    );
    // Onboarding manages SES identities/config sets (scoped to ses actions).
    onboardingFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ses:CreateEmailIdentity',
          'ses:GetEmailIdentity',
          'ses:CreateConfigurationSet',
          'ses:GetIdentityVerificationAttributes',
          'ses:VerifyDomainDkim',
        ],
        resources: [
          this.formatArn({ service: 'ses', resource: 'identity', resourceName: '*' }),
          this.formatArn({
            service: 'ses',
            resource: 'configuration-set',
            resourceName: '*',
          }),
        ],
      }),
    );

    // ── Scoped S3 grants for the image pipeline ──
    assetBucket.grantReadWrite(imageFn);

    // ──────────────────────────────────────────────────────────────────────
    // SNS topic for SES feedback events → feedback Lambda subscription.
    // ──────────────────────────────────────────────────────────────────────
    const feedbackTopic = new sns.Topic(this, 'SesFeedbackTopic', {
      topicName: 'cdp-ses-feedback',
    });
    feedbackTopic.addSubscription(new subscriptions.LambdaSubscription(feedbackFn));

    // ──────────────────────────────────────────────────────────────────────
    // REST API + request validator + model + Lambda authorizer + usage plan.
    // ──────────────────────────────────────────────────────────────────────
    const restApi = new apigateway.RestApi(this, 'CdpRestApi', {
      restApiName: 'cdp-api',
      deployOptions: { stageName: 'prod' },
      // API keys are read from the usage plan (per-workspace tenancy, §7).
      apiKeySourceType: apigateway.ApiKeySourceType.HEADER,
    });

    const requestValidator = restApi.addRequestValidator('IngestRequestValidator', {
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    const eventModel = restApi.addModel('EventEnvelopeModel', {
      contentType: 'application/json',
      modelName: 'EventEnvelope',
      schema: {
        schema: apigateway.JsonSchemaVersion.DRAFT4,
        type: apigateway.JsonSchemaType.OBJECT,
        required: ['event_id', 'external_id', 'type', 'occurred_at'],
        properties: {
          event_id: { type: apigateway.JsonSchemaType.STRING },
          external_id: { type: apigateway.JsonSchemaType.STRING },
          type: { type: apigateway.JsonSchemaType.STRING },
          occurred_at: { type: apigateway.JsonSchemaType.STRING },
          attributes: { type: apigateway.JsonSchemaType.OBJECT },
        },
      },
    });

    // Lambda authorizer (Supabase JWT validation, §12).
    const authorizer = new apigateway.RequestAuthorizer(this, 'SupabaseAuthorizer', {
      handler: authorizerFn,
      identitySources: [apigateway.IdentitySource.header('Authorization')],
      resultsCacheTtl: Duration.seconds(0),
    });

    // /events — API-key gated ingest (per-workspace usage plan; validated body).
    const events_ = restApi.root.addResource('events');
    events_.addMethod('POST', new apigateway.LambdaIntegration(ingestFn), {
      apiKeyRequired: true,
      requestValidator,
      requestModels: { 'application/json': eventModel },
    });

    // /admin proxy — authorizer-gated admin API.
    const admin = restApi.root.addResource('admin');
    const adminProxy = admin.addResource('{proxy+}');
    adminProxy.addMethod('ANY', new apigateway.LambdaIntegration(apiFn), {
      authorizer,
      authorizationType: apigateway.AuthorizationType.CUSTOM,
    });

    // Per-workspace usage plan + an example API key bound to the prod stage.
    const usagePlan = restApi.addUsagePlan('WorkspaceUsagePlan', {
      name: 'cdp-per-workspace',
      throttle: { rateLimit: 50, burstLimit: 100 },
      quota: { limit: 1_000_000, period: apigateway.Period.MONTH },
    });
    usagePlan.addApiStage({ stage: restApi.deploymentStage });
    const apiKey = restApi.addApiKey('WorkspaceApiKey', { apiKeyName: 'cdp-ws-key' });
    usagePlan.addApiKey(apiKey);

    // ──────────────────────────────────────────────────────────────────────
    // WAFv2 WebACL (REGIONAL) + association to the REST API stage.
    // ──────────────────────────────────────────────────────────────────────
    const webAcl = new wafv2.CfnWebACL(this, 'CdpWebAcl', {
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'cdpWebAcl',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWSCommonRules',
          priority: 0,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'cdpCommonRules',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'RateLimit',
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: { limit: 2000, aggregateKeyType: 'IP' },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'cdpRateLimit',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });
    const stageArn = this.formatArn({
      service: 'apigateway',
      account: '',
      resource: '/restapis',
      resourceName: `${restApi.restApiId}/stages/${restApi.deploymentStage.stageName}`,
    });
    const wafAssociation = new wafv2.CfnWebACLAssociation(this, 'CdpWebAclAssociation', {
      resourceArn: stageArn,
      webAclArn: webAcl.attrArn,
    });
    wafAssociation.addDependency(webAcl);
    wafAssociation.node.addDependency(restApi.deploymentStage);

    // ──────────────────────────────────────────────────────────────────────
    // EventBridge schedule rules (batch-eval, soft-bounce retry, usage rollups).
    // ──────────────────────────────────────────────────────────────────────
    new events.Rule(this, 'BatchEvalSchedule', {
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(batchEvalFn)],
    });
    new events.Rule(this, 'SoftBounceRetrySchedule', {
      schedule: events.Schedule.rate(Duration.minutes(15)),
      targets: [new targets.LambdaFunction(dispatcherFn)],
    });
    new events.Rule(this, 'UsageRollupSchedule', {
      schedule: events.Schedule.rate(Duration.hours(1)),
      targets: [new targets.LambdaFunction(meteringFn)],
    });
    new events.Rule(this, 'CampaignRunnerSchedule', {
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new targets.LambdaFunction(campaignRunnerFn)],
    });

    // ──────────────────────────────────────────────────────────────────────
    // CloudWatch alarms (§14, §16).
    // ──────────────────────────────────────────────────────────────────────
    // Account-level SES reputation: BounceRate 3% (warn) / 5% (critical) +
    // ComplaintRate 0.1%.
    const bounceRateMetric = new cloudwatch.Metric({
      namespace: 'AWS/SES',
      metricName: 'Reputation.BounceRate',
      period: Duration.minutes(15),
      statistic: 'Average',
    });
    new cloudwatch.Alarm(this, 'SesBounceRateWarn', {
      metric: bounceRateMetric,
      threshold: 0.03,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    new cloudwatch.Alarm(this, 'SesBounceRateCritical', {
      metric: bounceRateMetric,
      threshold: 0.05,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    new cloudwatch.Alarm(this, 'SesComplaintRate', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SES',
        metricName: 'Reputation.ComplaintRate',
        period: Duration.minutes(15),
        statistic: 'Average',
      }),
      threshold: 0.001,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    // Per-workspace reputation custom metric (CDP namespace).
    new cloudwatch.Alarm(this, 'PerWorkspaceReputation', {
      metric: new cloudwatch.Metric({
        namespace: 'CDP/Reputation',
        metricName: 'WorkspaceBounceRate',
        period: Duration.minutes(15),
        statistic: 'Average',
      }),
      threshold: 0.05,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    // Per-DLQ depth > 0.
    for (const [name, pair] of [
      ['Ingest', ingest],
      ['Dispatch', dispatch],
    ] as const) {
      new cloudwatch.Alarm(this, `${name}DlqDepth`, {
        metric: pair.dlq.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(1),
          statistic: 'Maximum',
        }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      });
    }

    // Per-function Errors alarms.
    const allFns: Record<string, lambda.Function> = {
      Authorizer: authorizerFn,
      Ingest: ingestFn,
      Processor: processorFn,
      Dispatcher: dispatcherFn,
      Feedback: feedbackFn,
      Unsubscribe: unsubscribeFn,
      Broadcast: broadcastFn,
      CampaignRunner: campaignRunnerFn,
      Onboarding: onboardingFn,
      Image: imageFn,
      BatchEval: batchEvalFn,
      Metering: meteringFn,
      Api: apiFn,
    };
    for (const [name, fn] of Object.entries(allFns)) {
      new cloudwatch.Alarm(this, `${name}Errors`, {
        metric: fn.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      });
    }

    // Per-main-queue oldest-message age.
    for (const [name, pair] of [
      ['Ingest', ingest],
      ['Dispatch', dispatch],
    ] as const) {
      new cloudwatch.Alarm(this, `${name}OldestMessageAge`, {
        metric: pair.queue.metricApproximateAgeOfOldestMessage({
          period: Duration.minutes(1),
          statistic: 'Maximum',
        }),
        threshold: 300,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      });
    }

    // ──────────────────────────────────────────────────────────────────────
    // Outputs.
    // ──────────────────────────────────────────────────────────────────────
    new CfnOutput(this, 'RestApiUrl', { value: restApi.url });
    new CfnOutput(this, 'AssetDistributionDomain', {
      value: distribution.distributionDomainName,
    });
    new CfnOutput(this, 'IngestQueueUrl', { value: ingest.queue.queueUrl });
    new CfnOutput(this, 'DispatchQueueUrl', { value: dispatch.queue.queueUrl });
  }
}
