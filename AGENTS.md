# DangBot maintenance notes

- `CAPABILITIES.md` is the bot's local self-capability memory and is injected into its system prompt at startup.
- Whenever a user-facing feature is added, removed, disabled, or materially changed, update `CAPABILITIES.md` in the same change.
- Capability descriptions must stay truthful, mention important availability limits, and use Xiao Dang's natural cat voice without sacrificing clarity.
- Do not put API keys, tokens, passwords, private identifiers, or other secrets in capability memory.
