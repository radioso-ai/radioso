# Data Model: Provider-Neutral Input Token Caching

## ReusableInputBoundary

Internal, never persisted: ordered role-preserving `stableSystemPrefix` followed by `dynamicSystemSuffix`, one contiguous breakpoint. Prefix is the exact leading candidate; suffix contains volatile steering, retrieval, user turns, tool results, and conversation data. Empty prefix means ordinary request. Concatenation must render to existing system content byte-for-byte.

## ProviderCacheCapability

Internal result for selected provider/model/API mode: `unsupported`, `implicit`, or `explicit_checkpoint`, with static pilot-safe constraints only. Ineligible/unresolved is unsupported.

## CacheAccounting

Internal normalized result: explicit `reported` or `unknown` state with independently optional finite non-negative `readTokens` and `writeTokens`. Reported zero is not inferred as a miss, and absent accounting stays unknown. Existing totals are not rewritten.

## ModelCallTiming

`provider_invocation_duration` spans adapter invocation through complete-call completion/error. `adapter_first_text_duration` spans same start through first yielded stream text. Both include serialization, transport, provider work, and buffering; neither is TTFT or user-visible latency.
