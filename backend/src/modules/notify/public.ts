// Public entrypoint for the notify module. App wiring and the skills capability registry import
// the adapter key and executor from here rather than reaching into module internals.
export {
  NOTIFY_SKILLS_ADAPTER,
  NotifyExecutor,
  type NotifyOutboxPort,
} from "./notifyExecutor.js";
