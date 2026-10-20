import type { DataSubjectExportValue } from "../../../../shared/domain/dataSubjectAccess.js";
import { COMPLETION_NOTIFY_ACTION_TYPE, CONTACT_SEND_ACTION_TYPE, HANDOFF_NOTIFY_ACTION_TYPE } from "../routines/contactRoutine.js";
import { WEBHOOK_SEND_ACTION_TYPE } from "./webhookSendActionHandler.js";

/** What one queued action carried about the person a conversation is with. */
interface SubjectActionValues {
  routineId: string | null;
  values: { readonly [field: string]: DataSubjectExportValue };
}

type Payload = Record<string, unknown>;

const recordOf = (value: unknown): Payload =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Payload) : {};

const textOf = (payload: Payload, field: string): string | null =>
  typeof payload[field] === "string" ? payload[field] : null;

const valuesOf = (payload: Payload): SubjectActionValues["values"] => payload as SubjectActionValues["values"];

/** The values a routine's ending handed to the team: its declared slots, without the authored notice. */
const routineEndingValues = (payload: Payload): SubjectActionValues => ({
  routineId: textOf(payload, "routineId"),
  values: valuesOf(recordOf(payload.collected)),
});

/**
 * The action types whose payload carries what the person said or gave, each reduced to just that:
 * a contact request as it was queued, since an authored routine's contact step carries every value
 * the routine collected and no producer adds the workspace's delivery settings to it; the slot
 * values a routine's ending handed to the team; the slot values a routine sent to a webhook. Every
 * other type carries the workspace's own workflow (a transfer between teammates, an internal Slack
 * post, an approval) or only ids.
 */
const PROJECTIONS: Readonly<Record<string, (payload: Payload) => SubjectActionValues>> = {
  [CONTACT_SEND_ACTION_TYPE]: (payload) => ({ routineId: null, values: valuesOf(payload) }),
  [HANDOFF_NOTIFY_ACTION_TYPE]: routineEndingValues,
  [COMPLETION_NOTIFY_ACTION_TYPE]: routineEndingValues,
  [WEBHOOK_SEND_ACTION_TYPE]: (payload) => ({
    routineId: textOf(recordOf(payload.source), "routineId"),
    values: valuesOf(recordOf(payload.data)),
  }),
};

/** The action types a data subject's export carries. */
export const SUBJECT_ACTION_TYPES: readonly string[] = Object.keys(PROJECTIONS);

/** The person's own values in one queued action, or null for a type that carries none. */
export const subjectActionValues = (type: string, payload: unknown): SubjectActionValues | null =>
  (Object.hasOwn(PROJECTIONS, type) ? PROJECTIONS[type](recordOf(payload)) : null);
