import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../src/config.js';
import { HermesBackendClient } from '../../src/services/hermes/hermesBackendClient.js';

const config = await loadConfig();
const client = new HermesBackendClient(config.agent.hermes);
if (!client.configured()) {
  throw new Error('Dedicated Hermes client is not configured.');
}

await client.assertReady(AbortSignal.timeout(10_000));
const identity = client.sessionIdentity('dangbot-live-preflight', randomUUID(), 0);
let toolCalls = 0;
const result = await client.run(
  {
    input: 'Reply with exactly DANGBOT_HERMES_LIVE_OK and nothing else.',
    instructions:
      'This is a dedicated backend connectivity check. Do not call tools. Return the exact requested text.',
    sessionId: identity.sessionId,
    sessionKey: identity.sessionKey,
    model: 'deepseek-v4-flash',
    onEvent: (event) => {
      if (event.event === 'tool.started') toolCalls += 1;
    }
  },
  AbortSignal.timeout(180_000)
);

if (result.status !== 'completed') {
  throw new Error(`Dedicated Hermes preflight ended with status ${result.status}.`);
}
if (!result.output.includes('DANGBOT_HERMES_LIVE_OK')) {
  throw new Error('Dedicated Hermes returned an unexpected live preflight response.');
}
if (toolCalls !== 0) {
  throw new Error(`Dedicated Hermes unexpectedly invoked ${toolCalls} tool(s) during preflight.`);
}

process.stdout.write(
  `Live Hermes preflight passed: model=deepseek-v4-flash status=completed tools=${toolCalls}\n`
);
