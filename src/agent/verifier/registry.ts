import type { Verifier } from "./types";
import { goBackendVerifier } from "./verifiers/goBackend";
import { nodeBackendVerifier } from "./verifiers/nodeBackend";
import { frontendVerifier } from "./verifiers/frontend";
import { iosVerifier, androidVerifier } from "./verifiers/mobile";
import { runtimeBootVerifier } from "./verifiers/runtimeBoot";

export const builtinVerifiers: Verifier[] = [
  goBackendVerifier,
  nodeBackendVerifier,
  frontendVerifier,
  iosVerifier,
  androidVerifier,
  runtimeBootVerifier,
];
