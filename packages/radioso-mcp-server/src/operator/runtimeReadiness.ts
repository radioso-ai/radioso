import type { OperatorRequestReadiness } from "./requestHandler.js";

interface OperatorMcpReadiness extends OperatorRequestReadiness {
  setReady(ready: boolean): void;
}

export const createOperatorMcpReadiness = (initialReady = true): OperatorMcpReadiness => {
  let ready = initialReady;
  return {
    isReady: () => ready,
    setReady(value) { ready = value; },
  };
};
