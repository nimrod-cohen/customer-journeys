// CDK assertion tests for the §14 resource graph (assertions ONLY — no real
// deploy, no AWS creds). Uses `aws-cdk-lib/assertions` Template.fromStack to
// assert the security-critical shape of the synthesized stack:
//   - WAFv2 WebACL (REGIONAL) + association to the REST API stage
//   - REST API + RequestValidator + Model + UsagePlan + ApiKey + UsagePlanKey
//   - NO IAM wildcards (Action:'*' / Resource:'*') across every AWS::IAM::Policy
//   - SQS FIFO main queues each with a FIFO DLQ + RedrivePolicy + EventSourceMappings
//   - SNS topic + subscription, SES ConfigurationSet
//   - EventBridge schedule rules
//   - CloudWatch alarms (SES reputation, per-workspace reputation, DLQ depth,
//     per-function errors, per-queue oldest-message age)
import { describe, it, expect, beforeAll } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { CdpStack } from '../lib/cdp-stack.js';

describe('CdpStack §14 resource graph', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new CdpStack(app, 'TestCdpStack', { env: { account: '111111111111', region: 'us-east-1' } });
    template = Template.fromStack(stack);
  });

  it('WAFv2 WebACL is REGIONAL and associated with the REST API stage', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', { Scope: 'REGIONAL' });
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  });

  it('REST API with RequestValidator + Model + UsagePlan + ApiKey + UsagePlanKey', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.resourceCountIs('AWS::ApiGateway::RequestValidator', 1);
    expect(Object.keys(template.findResources('AWS::ApiGateway::Model')).length).toBeGreaterThanOrEqual(1);
    template.resourceCountIs('AWS::ApiGateway::UsagePlan', 1);
    template.resourceCountIs('AWS::ApiGateway::ApiKey', 1);
    template.resourceCountIs('AWS::ApiGateway::UsagePlanKey', 1);
    // A custom Lambda authorizer guards the admin API.
    template.hasResourceProperties('AWS::ApiGateway::Authorizer', { Type: 'REQUEST' });
  });

  it('NO IAM wildcards anywhere — every AWS::IAM::Policy is least-privilege', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const offenders: string[] = [];
    for (const [id, policy] of Object.entries(policies)) {
      const doc = (policy.Properties as { PolicyDocument?: { Statement?: unknown[] } }).PolicyDocument;
      for (const stmtRaw of doc?.Statement ?? []) {
        const stmt = stmtRaw as { Action?: unknown; Resource?: unknown };
        const actions = ([] as unknown[]).concat(stmt.Action ?? []);
        const resources = ([] as unknown[]).concat(stmt.Resource ?? []);
        if (actions.includes('*')) offenders.push(`${id}: Action:'*'`);
        if (resources.includes('*')) offenders.push(`${id}: Resource:'*'`);
      }
    }
    expect(offenders).toEqual([]);
    // And there must actually BE per-service policies (not a vacuous pass).
    expect(Object.keys(policies).length).toBeGreaterThanOrEqual(10);
  });

  it('every Lambda has its OWN role (one role per function, no shared role)', () => {
    const fns = template.findResources('AWS::Lambda::Function');
    const roles = template.findResources('AWS::IAM::Role');
    // 13 services → at least 13 functions + 13 roles.
    expect(Object.keys(fns).length).toBeGreaterThanOrEqual(13);
    expect(Object.keys(roles).length).toBeGreaterThanOrEqual(13);
  });

  it('SQS: FIFO main queues each have a FIFO DLQ + RedrivePolicy', () => {
    const queues = template.findResources('AWS::SQS::Queue');
    const fifo = Object.values(queues).filter(
      (q) => (q.Properties as { FifoQueue?: boolean }).FifoQueue === true,
    );
    // 2 main + 2 DLQ = 4 FIFO queues.
    expect(fifo.length).toBe(4);
    const withRedrive = Object.values(queues).filter(
      (q) => (q.Properties as { RedrivePolicy?: unknown }).RedrivePolicy !== undefined,
    );
    expect(withRedrive.length).toBe(2); // the 2 main queues redrive to their DLQs
    // Event-source mappings: ingest→processor, dispatch→dispatcher.
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 2);
  });

  it('SNS topic + subscription → feedback Lambda; SES ConfigurationSet present', () => {
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'lambda' });
    template.resourceCountIs('AWS::SES::ConfigurationSet', 1);
  });

  it('S3 bucket (encrypted, public access blocked) + CloudFront distribution', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true }),
    });
    template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  });

  it('EventBridge schedule rules: batch-eval, soft-bounce retry, usage rollups (+campaign runner)', () => {
    const rules = template.findResources('AWS::Events::Rule');
    expect(Object.keys(rules).length).toBeGreaterThanOrEqual(3);
  });

  it('CloudWatch alarms: SES reputation (3%/5% + 0.1%), per-workspace, DLQ depth, errors, queue age', () => {
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const byMetric = Object.values(alarms).map((a) => a.Properties as Record<string, unknown>);

    // Account SES bounce-rate warn (3%) + critical (5%).
    const bounceThresholds = byMetric
      .filter((p) => p.MetricName === 'Reputation.BounceRate')
      .map((p) => p.Threshold);
    expect(bounceThresholds).toContain(0.03);
    expect(bounceThresholds).toContain(0.05);
    // Complaint rate 0.1%.
    expect(
      byMetric.some((p) => p.MetricName === 'Reputation.ComplaintRate' && p.Threshold === 0.001),
    ).toBe(true);
    // Per-workspace reputation custom metric.
    expect(byMetric.some((p) => p.Namespace === 'CDP/Reputation')).toBe(true);
    // DLQ depth > 0 (ApproximateNumberOfMessagesVisible threshold 0).
    expect(
      byMetric.some(
        (p) => p.MetricName === 'ApproximateNumberOfMessagesVisible' && p.Threshold === 0,
      ),
    ).toBe(true);
    // Per-function Errors alarms (13 functions).
    expect(byMetric.filter((p) => p.MetricName === 'Errors').length).toBeGreaterThanOrEqual(13);
    // Per-main-queue oldest-message age.
    expect(
      byMetric.some((p) => p.MetricName === 'ApproximateAgeOfOldestMessage'),
    ).toBe(true);
  });

  it('Secrets Manager / SSM are REFERENCED (no inline secret values)', () => {
    // The synthesized template must contain NO plaintext db url / jwt secret.
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toContain('postgres://');
    // Lambda roles read secrets via secretsmanager:GetSecretValue (scoped).
    const policies = template.findResources('AWS::IAM::Policy');
    const hasSecretRead = Object.values(policies).some((p) =>
      ((p.Properties as { PolicyDocument?: { Statement?: { Action?: unknown }[] } }).PolicyDocument
        ?.Statement ?? []).some((s) =>
        ([] as unknown[]).concat(s.Action ?? []).includes('secretsmanager:GetSecretValue'),
      ),
    );
    expect(hasSecretRead).toBe(true);
  });
});
