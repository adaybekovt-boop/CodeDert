import { describe, expect, it } from 'vitest';
import { containsSecret, detectSecret } from '../electron/services/brain-secrets';

describe('brain-secrets', () => {
  it.each([
    'export ANTHROPIC_KEY=sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKK',
    'OPENAI_KEY=sk-proj-AAAABBBBCCCCDDDDEEEEFFFF',
    'use this github token: ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII',
    'slack: xoxb-1234567890-abcdef-XYZ12',
    'aws key AKIAIOSFODNN7EXAMPLE here',
    `stripe ${'sk_live_'}AAAABBBBCCCCDDDDEEEEFFFF`,
    'maps key AIzaSyA-aaaabbbbccccddddeeeeffffggggh',
    'jwt: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'PASSWORD=hunter2hunter2',
    'API_KEY: abcd1234efgh5678',
    'we keep secrets in .env',
    'check the id_rsa file in ~/.ssh',
    'cert is /etc/ssl/server.pem',
  ])('flags secret-bearing text: %s', (text) => {
    expect(containsSecret(text)).toBe(true);
  });

  it.each([
    'just talking about authentication in general',
    'we use BCrypt for password hashing',
    'the commit hash is 9f8e1a2b3c4d5e',
    'TODO: add password reset flow',
    'the function name is generateApiKey() but it has no value',
  ])('does not flag benign text: %s', (text) => {
    expect(containsSecret(text)).toBe(false);
  });

  it('returns reason metadata for credentials', () => {
    const r = detectSecret('ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII');
    expect(r.hit).toBe(true);
    expect(r.reason).toBeDefined();
    expect(r.preview).toBeDefined();
  });
});
