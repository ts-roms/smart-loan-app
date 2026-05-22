import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

import { createPrismaClient } from "./client";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

interface Options {
  databaseUrl?: string;
}

export const fastifyPrisma = fp<Options>(
  async (app: FastifyInstance, opts) => {
    const prisma = createPrismaClient(opts.databaseUrl);
    await prisma.$connect();
    app.decorate("prisma", prisma);
    app.addHook("onClose", async () => {
      await prisma.$disconnect();
    });
  },
  { name: "fastify-prisma" },
);
