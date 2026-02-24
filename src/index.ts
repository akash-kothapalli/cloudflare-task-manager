// =============================================================================
// index.ts  — Cloudflare Worker entry point
//
//  Clean pipeline, each concern separated:
//
//   Request arrives
//       ↓
//   withErrorHandling  — catches any AppError or unexpected throw
//       ↓
//   detectMaliciousInput — WAF: SQLi / XSS / path traversal scan
//       ↓
//   handleCors           — OPTIONS preflight → 204, or continue
//       ↓
//   checkRateLimit       — 60 req/min/IP via KV → 429, or continue
//       ↓
//   logWithTiming        — records method/path/status/duration
//       ↓
//   router               — routes to correct controller
//       ↓
//   addSecurityHeaders   — wraps response with all security headers
//       ↓
//   Response sent
// =============================================================================

import { withErrorHandling }     from "./middleware/error-handler";
import { logWithTiming }         from "./middleware/logger";
import {
  addSecurityHeaders,
  handleCors,
  checkRateLimit,
  detectMaliciousInput,
}                                from "./middleware/security";
import { router }                from "./routes/index";
import type { Env }              from "./types/env.types";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return withErrorHandling(async () => {

      // 1. WAF — block obvious injection attempts before any processing
      const wafBlock = detectMaliciousInput(request);
      if (wafBlock) return addSecurityHeaders(wafBlock);

      // 2. CORS preflight — OPTIONS must return 204 before rate limit check
      //    (browsers send OPTIONS before every cross-origin request)
      const corsResponse = handleCors(request);
      if (corsResponse) return addSecurityHeaders(corsResponse);

      // 3. Rate limiting — check KV counter for this IP
      const rateLimitResponse = await checkRateLimit(request, env.CACHE);
      if (rateLimitResponse) return addSecurityHeaders(rateLimitResponse);

      // 4. Log + route — timing wraps the actual handler
      const response = await logWithTiming(request, () => router(request, env));

      // 5. Security headers — applied to every response that reaches the client
      return addSecurityHeaders(response);
    });
  },
};
