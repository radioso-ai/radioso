import type { SkillOutputContract, SkillOutputFieldRole } from "@radioso/conversation-contract";

import type { RecordPresentHead } from "./recordPresentHead.js";

/** The list output a skill's cards come from, and which of its fields fills each card role. */
interface CardRoles {
  list: string;
  fields: Partial<Record<SkillOutputFieldRole, string>>;
}

const pointerTo = (field: string): string => `/${field.replace(/~/g, "~0").replace(/\//g, "~1")}`;

/**
 * The first list output whose contract gives its fields card roles and which came back with items.
 * Cards built from it take each role's field deterministically; without one, the model names them.
 */
export const cardRolesFor = (
  contract: SkillOutputContract | undefined,
  outputs: Readonly<Record<string, unknown>> | undefined,
): CardRoles | null => {
  for (const [name, entry] of Object.entries(contract ?? {})) {
    if (entry.type !== "list") continue;
    const value = outputs?.[name];
    if (!Array.isArray(value) || value.length === 0) continue;
    const fields: CardRoles["fields"] = {};
    for (const [fieldName, field] of Object.entries(entry.fields)) {
      if (field.role) fields[field.role] = fieldName;
    }
    if (Object.keys(fields).length > 0) return { list: name, fields };
  }
  return null;
};

/** The model's card fields with every role the contract sets put in its place. */
export const withRoleFields = (fields: RecordPresentHead["fields"], roles: CardRoles): RecordPresentHead["fields"] => ({
  title: roles.fields.title ? pointerTo(roles.fields.title) : fields.title,
  subtitle: roles.fields.subtitle ? pointerTo(roles.fields.subtitle) : fields.subtitle,
  image: roles.fields.image ? pointerTo(roles.fields.image) : fields.image,
  link: roles.fields.link ? pointerTo(roles.fields.link) : fields.link,
});
