import { describe, it, expect } from 'vitest';
import { makeAuthorizerHandler } from '@cdp/service-authorizer';
import { contextFromAuthorizer, enforceRoute, handleAdminAccess, RouteForbiddenError, } from '@cdp/service-api';
// Thin E2E wiring (§16A tier 3): authorizer → API request context → route
// enforcement, end to end, with JWKS/DB injected (no LocalStack/API GW needed
// for this slice). Guarded so it never requires external infra; the SQS/SES
// LocalStack flows belong to later phases (§17 phases 3+).
//
// This proves the contract BETWEEN the two services: the policy context the
// authorizer emits is exactly what the API middleware consumes.
const memberships = [
    { workspaceId: 'ws-a', role: 'marketer' },
];
function authEvent(jwt, isAdmin) {
    return {
        handler: makeAuthorizerHandler({
            verifyJwt: async () => jwt,
            loadMemberships: async () => (isAdmin ? [] : memberships),
            loadIsPlatformAdmin: async () => isAdmin,
        }),
        event: {
            type: 'TOKEN',
            methodArn: 'arn:aws:execute-api:us-east-1:1:api/prod/GET/things',
            authorizationToken: 'Bearer tok',
        },
    };
}
describe('E2E: authorizer policy → API middleware', () => {
    it('a marketer is allowed manage_content but forbidden manage_workspace_users', async () => {
        const { handler, event } = authEvent({ sub: 'u1', workspace_id: 'ws-a' }, false);
        const policy = await handler(event);
        expect(policy.policyDocument.Statement[0]?.Effect).toBe('Allow');
        // Feed the authorizer context into the API exactly as API GW would.
        const apiEvent = { requestContext: { authorizer: policy.context } };
        const ctx = contextFromAuthorizer(apiEvent);
        expect(ctx.role).toBe('marketer');
        expect(() => enforceRoute(ctx, 'manage_content')).not.toThrow();
        expect(() => enforceRoute(ctx, 'manage_workspace_users')).toThrow(RouteForbiddenError);
    });
    it('a platform admin crossing into another workspace is allowed and audited', async () => {
        const { handler, event } = authEvent({ sub: 'admin-1', workspace_id: 'ws-a' }, true);
        const policy = await handler(event);
        const ctx = contextFromAuthorizer({ requestContext: { authorizer: policy.context } });
        expect(ctx.isPlatformAdmin).toBe(true);
        const audited = [];
        await handleAdminAccess(ctx, 'ws-b', 'read_profiles', { n: 1 }, async (e) => {
            audited.push(e);
        });
        expect(audited).toHaveLength(1);
    });
    it('a forged active workspace (not a membership) is Denied at the gateway', async () => {
        const { handler, event } = authEvent({ sub: 'u1', workspace_id: 'ws-evil' }, false);
        const policy = await handler(event);
        expect(policy.policyDocument.Statement[0]?.Effect).toBe('Deny');
    });
});
//# sourceMappingURL=authorizer-api.e2e.test.js.map