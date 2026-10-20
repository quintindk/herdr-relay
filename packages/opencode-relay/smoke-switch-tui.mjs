// Disposable smoke-only plugin. Never included in normal runtime configuration.
import { Plugin } from '@opencode/plugin/tui';
import { existsSync, writeFileSync } from 'node:fs';

export default Plugin.define({
  id: 'herdr.relay.smoke.switch',
  async setup(ctx) {
    let busy = false;
    const timer = setInterval(async () => {
      if (busy || !existsSync(ctx.options.trigger)) return;
      busy = true;
      ctx.ui.router.navigate({ type: 'session', sessionID: ctx.options.otherSessionId });
      await new Promise(resolve => setTimeout(resolve, 250));
      ctx.ui.router.navigate({ type: 'session', sessionID: ctx.options.originalSessionId });
      writeFileSync(ctx.options.gate, 'switched');
    }, 100);
    return () => clearInterval(timer);
  },
});
