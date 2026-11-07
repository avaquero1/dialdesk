/**
 * Schemas owned by Rust: the engine's plan, input, result and receipt (`engine --schema`) and sandbox-manager's API
 * (`sandbox-manager --schema`). `npm run gen` copies them to schema/rust/*.json and generates the TypeScript types
 * in src/generated/. Never edit those by hand: change the Rust types and run `npm run gen` (make check fails when
 * they're stale). Runtime validators are built from the same JSON Schema with zod's fromJSONSchema.
 */
import { z } from 'zod';
import engineSchemas from '../schema/rust/engine.json' with { type: 'json' };
import managerSchema from '../schema/rust/sandbox-manager.json' with { type: 'json' };
import type * as E from './generated/engine.ts';
import type * as M from './generated/sandbox-manager.ts';

type JsonSchema = Parameters<typeof z.fromJSONSchema>[0];

function fromRust<T>(schema: unknown): z.ZodType<T> {
  return z.fromJSONSchema(schema as JsonSchema) as unknown as z.ZodType<T>;
}

/** A sub-schema of a schemars root: keep the root's $defs so $refs resolve. */
function defOf<T>(root: { $defs?: Record<string, unknown> }, name: string): z.ZodType<T> {
  const def = root.$defs?.[name];
  if (!def) throw new Error(`no $defs.${name} in a Rust schema`);
  return fromRust<T>({ ...(def as object), $defs: root.$defs });
}

export type EnginePlan = E.Plan;
export type EngineInput = E.EngineInput;
export type EngineResult = E.EngineResult;
export type EngineReceipt = E.Receipt;
export type EngineNumber = E.NumberOut;

export const EnginePlan = fromRust<EnginePlan>(engineSchemas.plan);
export const EngineInput = fromRust<EngineInput>(engineSchemas.input);
export const EngineResult = fromRust<EngineResult>(engineSchemas.result);
export const EngineReceipt = fromRust<EngineReceipt>(engineSchemas.receipt);
export const EngineNumber = defOf<EngineNumber>(engineSchemas.result, 'NumberOut');

export type SbxJobRequest = M.JobRequest;
export type SbxJobStatus = M.JobStatus;
export type SbxKillRequest = M.KillRequest;
export type SbxSandboxList = M.SandboxList;
export type SbxBusy = M.Busy;

const sm = managerSchema.schemas as Record<string, unknown>;
export const SbxJobRequest = fromRust<SbxJobRequest>(sm.JobRequest);
export const SbxJobStatus = fromRust<SbxJobStatus>(sm.JobStatus);
export const SbxKillRequest = fromRust<SbxKillRequest>(sm.KillRequest);
export const SbxSandboxList = fromRust<SbxSandboxList>(sm.SandboxList);
export const SbxBusy = fromRust<SbxBusy>(sm.Busy);

/** sandbox-manager's paths, as the crate prints them. */
export const SANDBOX_MANAGER_PATHS = managerSchema.paths as unknown as Array<{
  method: string;
  path: string;
  request: string | null;
  responses: Record<string, string>;
}>;
