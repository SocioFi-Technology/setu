/* Generates openapi.json from the Zod contracts. Routes register themselves here as they are added. */
import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import * as C from "../src/index.js";

extendZodWithOpenApi(z);
const r = new OpenAPIRegistry();
r.registerPath({ method: "get", path: "/health", responses: { 200: { description: "liveness", content: { "application/json": { schema: C.Health } } } } });
r.registerPath({ method: "post", path: "/v1/auth/login", request: { body: { content: { "application/json": { schema: C.LoginRequest } } } }, responses: { 200: { description: "session", content: { "application/json": { schema: C.Me } } }, 401: { description: "bad credentials", content: { "application/json": { schema: C.ApiError } } } } });
r.registerPath({ method: "get", path: "/v1/me", responses: { 200: { description: "current session", content: { "application/json": { schema: C.Me } } } } });
r.registerPath({ method: "get", path: "/v1/me/capabilities", responses: { 200: { description: "nav", content: { "application/json": { schema: C.Capabilities } } } } });
r.registerPath({ method: "post", path: "/v1/auth/pin/verify", request: { body: { content: { "application/json": { schema: C.PinVerifyRequest } } } }, responses: { 200: { description: "result", content: { "application/json": { schema: C.PinVerifyResponse } } } } });
const doc = new OpenApiGeneratorV31(r.definitions).generateDocument({ openapi: "3.1.0", info: { title: "Setu Health API", version: "0.0.1" }, servers: [{ url: "/" }] });
writeFileSync(new URL("../openapi.json", import.meta.url), JSON.stringify(doc, null, 2));
console.log("wrote packages/contracts/openapi.json");
