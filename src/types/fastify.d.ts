/**
 * fastify.d.ts
 *
 * Module augmentation for Fastify decorators and JWT payload shape.
 * The payload matches what verifyChallenge signs in
 * src/modules/auth/auth.service.ts (sub, wallet, slug).
 */

import "fastify";
import "@fastify/jwt";

declare module "fastify" {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      sub: string;
      wallet: string;
      slug: string;
    };
    user: {
      sub: string;
      wallet: string;
      slug: string;
    };
  }
}
