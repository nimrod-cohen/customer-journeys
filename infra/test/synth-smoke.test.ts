// Synth-smoke test: the stack must synthesize cleanly to a CloudFormation
// template (assertions tier, no AWS creds). This is the in-process equivalent of
// `cdk synth` succeeding — it catches construct-graph wiring errors fast.
import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CdpStack } from '../lib/cdp-stack.js';

describe('CdpStack synth smoke', () => {
  it('synthesizes to a non-empty CloudFormation template without throwing', () => {
    const app = new App();
    const stack = new CdpStack(app, 'SmokeCdpStack', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    const assembly = app.synth();
    const artifact = assembly.getStackByName('SmokeCdpStack');
    expect(artifact.template).toBeDefined();

    const template = Template.fromStack(stack);
    const resources = template.toJSON().Resources as Record<string, unknown>;
    // A meaningful graph — the §14 stack has 100+ resources.
    expect(Object.keys(resources).length).toBeGreaterThan(50);
  });
});
