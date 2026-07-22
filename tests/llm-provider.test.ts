// Provider wiring: how the platform decides which way to reach Claude (Vercel
// AI Gateway vs the Anthropic API directly), how it names models for each, and
// how it classifies an AI-call failure for the graceful-fallback log. Pure and
// network-free — no client is ever used, only resolved.
import { afterEach, describe, expect, it } from 'vitest';
import {
  aiConfigured,
  aiFailureReason,
  resolveProvider,
  toGatewayModel,
} from '../server/llm/provider';

const savedGateway = process.env.AI_GATEWAY_API_KEY;
const savedAnthropic = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  // Restore the ambient env so ordering never leaks between tests.
  savedGateway === undefined
    ? delete process.env.AI_GATEWAY_API_KEY
    : (process.env.AI_GATEWAY_API_KEY = savedGateway);
  savedAnthropic === undefined
    ? delete process.env.ANTHROPIC_API_KEY
    : (process.env.ANTHROPIC_API_KEY = savedAnthropic);
});

describe('toGatewayModel', () => {
  it('namespaces and dots the Anthropic id to the Vercel slug', () => {
    expect(toGatewayModel('claude-opus-4-8')).toBe('anthropic/claude-opus-4.8');
  });

  it('leaves single-number versions and already-namespaced ids alone', () => {
    expect(toGatewayModel('claude-sonnet-5')).toBe('anthropic/claude-sonnet-5');
    expect(toGatewayModel('anthropic/claude-opus-4.8')).toBe('anthropic/claude-opus-4.8');
  });
});

describe('aiConfigured / resolveProvider', () => {
  it('is unconfigured (null) when neither key is set', () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect(aiConfigured()).toBe(false);
    expect(resolveProvider()).toBeNull();
  });

  it('treats a blank/whitespace key as unset', () => {
    process.env.AI_GATEWAY_API_KEY = '   ';
    process.env.ANTHROPIC_API_KEY = '';
    expect(aiConfigured()).toBe(false);
    expect(resolveProvider()).toBeNull();
  });

  it('uses the direct Anthropic transport when only ANTHROPIC_API_KEY is set', () => {
    delete process.env.AI_GATEWAY_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const provider = resolveProvider();
    expect(provider?.transport).toBe('direct');
    // Direct transport leaves the model id untouched.
    expect(provider?.modelFor('claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it('prefers the gateway when both keys are set, and namespaces the model', () => {
    process.env.AI_GATEWAY_API_KEY = 'vk-test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const provider = resolveProvider();
    expect(provider?.transport).toBe('gateway');
    expect(provider?.modelFor('claude-opus-4-8')).toBe('anthropic/claude-opus-4.8');
  });
});

describe('aiFailureReason', () => {
  it('names the empty-balance / billing case explicitly', () => {
    expect(aiFailureReason({ status: 402, message: 'Payment Required' })).toMatch(/credit|billing/i);
    expect(aiFailureReason(new Error('insufficient credits on this account'))).toMatch(
      /credit|billing/i,
    );
  });

  it('classifies auth and rate-limit failures by status', () => {
    expect(aiFailureReason({ status: 401, message: 'bad key' })).toMatch(/auth/i);
    expect(aiFailureReason({ status: 429, message: 'slow down' })).toMatch(/rate limited/i);
  });
});
